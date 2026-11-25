import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ResultCard, type ResultCardProps } from "./ResultCard";

function html(extra: Partial<ResultCardProps> = {}): string {
  return renderToStaticMarkup(
    <ResultCard
      result={{ state: "ready", score: 87 }}
      humanScore={85}
      agentScore={90}
      baseline={60}
      roundId="12"
      ticker="AAPL"
      {...extra}
    />,
  );
}

describe("ResultCard", () => {
  it("shows the score, the near-miss line, the baseline and a share image", () => {
    const out = html();
    expect(out).toContain("87, 3 short of beating the Agent");
    expect(out).toContain("27 above the flat-path baseline (60)");
    expect(out).toContain('src="/api/card?me=87&amp;agent=90&amp;base=60&amp;round=12&amp;t=AAPL"');
  });

  it("shows a win line when the user beats the Agent consensus", () => {
    expect(html({ result: { state: "ready", score: 95 } })).toContain("95, beat the Agent by 5");
  });

  it("shows equal consensus scores as a refund tie", () => {
    const out = html({ humanScore: 90, agentScore: 90 });
    expect(out).toContain("Tie at 90: stakes are refunded.");
  });

  it("makes no card and no claim when the Agent consensus is missing", () => {
    const out = html({ agentScore: null });
    expect(out).not.toContain("/api/card");
    expect(out).not.toContain("short of beating");
    expect(out).toContain("No Agent consensus");
  });

  it("explains each state without a score", () => {
    for (const state of ["no-wallet", "loading", "error", "no-entry", "unrevealed", "agent-entry"] as const) {
      const out = html({ result: { state } });
      expect(out).not.toContain("/api/card");
      expect(out).toContain('data-result-state="' + state + '"');
    }
  });

  it("keeps the points-only and house labels visible and shows no raw prices", () => {
    const out = html();
    expect(out).toContain("points only");
    expect(out).toContain("house");
    expect(out).not.toMatch(/\$\d/);
  });
});
