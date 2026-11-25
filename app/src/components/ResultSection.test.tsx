// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Path } from "../../../shared/score";
import type { EntryRead } from "@/lib/near";
import type { RevealReads } from "@/lib/reveal";
import { ResultSectionView, type ResultSectionViewProps } from "./ResultCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REAL: Path = [
  { close: 40, high: 70, low: -5 },
  { close: 10, high: 50, low: 0 },
  { close: 60, high: 85, low: 5 },
];
// Only candle 1 differs from REAL: 97 at T = 100 and 99 at T = 1000 (hand-computed in near.test.ts).
const MINE: Path = [{ close: 50, high: 80, low: -10 }, REAL[1], REAL[2]];
const ENTRY: EntryRead = { kind: 1, revealed: true, path: MINE };
const READS: RevealReads = {
  real: REAL,
  sourceHash: "0x" + "ab".repeat(32),
  human: null,
  agent: null,
  scores: { human: 85, agent: 90, humanPresent: true, agentPresent: true },
  baseline: 60,
};

let container: HTMLDivElement;
let root: Root;

function mount(over: Partial<ResultSectionViewProps> = {}) {
  act(() => {
    root.render(
      <ResultSectionView
        phase="settled"
        reads={READS}
        T={100}
        roundId={12n}
        ticker="aapl"
        connected
        entry={ENTRY}
        {...over}
      />,
    );
  });
}

const button = () => Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Show my result");
const myScore = () => container.querySelector("[data-my-score]")?.getAttribute("data-my-score");

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ResultSectionView", () => {
  it("renders nothing before the round is settled, whatever the reads are", () => {
    for (const phase of ["commit", "reveal", "market", "play", "void"] as const) {
      mount({ phase });
      expect(container.innerHTML, phase).toBe("");
    }
  });

  it("renders nothing while the settled reads are missing", () => {
    mount({ reads: undefined });
    expect(container.innerHTML).toBe("");
  });

  it("stays hidden behind the button until it is clicked", () => {
    mount();
    expect(button()).toBeDefined();
    expect(myScore()).toBeUndefined();
    expect(container.textContent).not.toContain("beat the Agent");
    act(() => button()?.click());
    expect(button()).toBeUndefined();
    expect(myScore()).toBe("97");
    expect(container.textContent).toContain("97, beat the Agent by 7");
    expect(container.textContent).toContain("37 above the flat-path baseline (60)");
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/api/card?me=97&agent=90&base=60&round=12&t=AAPL");
  });

  it("scores with the round's T and the posted real candles", () => {
    mount({ T: 1000 });
    act(() => button()?.click());
    expect(myScore()).toBe("99");

    const otherReal: Path = [
      { close: 90, high: 120, low: 0 },
      { close: 90, high: 120, low: 0 },
      { close: 90, high: 120, low: 0 },
    ];
    mount({ reads: { ...READS, real: otherReal } });
    expect(myScore()).not.toBe("99");
    expect(Number(myScore())).toBeLessThan(97);
  });

  it("shows a state message instead of a score when the wallet has no usable entry", () => {
    mount({ connected: false, entry: undefined });
    act(() => button()?.click());
    expect(myScore()).toBeUndefined();
    expect(container.querySelector("[data-result-state]")?.getAttribute("data-result-state")).toBe("no-wallet");
  });

  it("does not make up a result when the consensus scores are missing", () => {
    mount({ reads: { ...READS, scores: undefined } });
    act(() => button()?.click());
    expect(myScore()).toBeUndefined();
    expect(container.textContent).toContain("could not be read");
  });
});
