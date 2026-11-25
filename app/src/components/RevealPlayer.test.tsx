import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Path } from "../../../shared/score";
import { score } from "../../../shared/score";
import { RevealPlayer } from "./RevealPlayer";

const T = 100;
const REAL: Path = [
  { close: 40, high: 70, low: -5 },
  { close: 10, high: 50, low: 0 },
  { close: 60, high: 85, low: 5 },
];
const HUMAN: Path = [
  { close: 50, high: 80, low: -10 },
  { close: 20, high: 60, low: 10 },
  { close: 70, high: 90, low: 15 },
];
const AGENT: Path = [
  { close: 30, high: 60, low: 0 },
  { close: 0, high: 40, low: -10 },
  { close: 50, high: 70, low: -20 },
];

function html(step: number, extra: Partial<Parameters<typeof RevealPlayer>[0]> = {}): string {
  return renderToStaticMarkup(
    <RevealPlayer real={REAL} human={HUMAN} agent={AGENT} T={T} initialStep={step} autoPlay={false} {...extra} />,
  );
}

/** The real-candle groups in the markup: their `data-candle` and `data-close` attributes. */
function realGroups(s: string): { candle: string; close: string }[] {
  const tags = s.match(/<g[^>]*data-series="real"[^>]*>/g) ?? [];
  return tags.map((t) => ({
    candle: /data-candle="(\d+)"/.exec(t)?.[1] ?? "",
    close: /data-close="(-?\d+)"/.exec(t)?.[1] ?? "",
  }));
}

describe("RevealPlayer", () => {
  it("RevealPlayer shows candle n only after n steps", () => {
    for (let n = 0; n <= 3; n++) {
      const groups = realGroups(html(n));
      expect(groups.map((g) => g.candle)).toEqual(["1", "2", "3"].slice(0, n));
    }
  });

  it("does not put an unrevealed real value in the markup", () => {
    const out = html(1);
    // The closes of candles 2 and 3 (10 bp, 60 bp) are not rendered before their step.
    expect(realGroups(out)).toEqual([{ candle: "1", close: "40" }]);
    expect(out).not.toMatch(/data-close="10"/);
    expect(out).not.toMatch(/data-close="60"/);
  });

  it("shows the live score computed by the shared score() after the last candle", () => {
    const out = html(3);
    expect(out).toContain(`data-score-human="${score(HUMAN, REAL, T)}"`);
    expect(out).toContain(`data-score-agent="${score(AGENT, REAL, T)}"`);
  });

  it("shows no score before the first candle", () => {
    const out = html(0);
    expect(out).not.toMatch(/data-score-human="\d/);
    expect(out).not.toMatch(/data-score-agent="\d/);
  });

  it("labels the partial score honestly and says which side is missing", () => {
    const out = html(2, { agent: null });
    expect(out).toMatch(/score so far/i);
    expect(out).toMatch(/no agent consensus/i);
  });

  it("flags a mismatch with the on-chain scores", () => {
    const h = score(HUMAN, REAL, T);
    const a = score(AGENT, REAL, T);
    const ok = html(3, { onchain: { human: h, agent: a, humanPresent: true, agentPresent: true } });
    expect(ok).toMatch(/matches the on-chain/i);
    const bad = html(3, { onchain: { human: h + 1, agent: a, humanPresent: true, agentPresent: true } });
    expect(bad).toMatch(/does not match/i);
  });
});
