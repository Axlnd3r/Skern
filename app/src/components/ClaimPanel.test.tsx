// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Path } from "../../../shared/score";
import type { MarketData } from "@/lib/market";
import type { TxState } from "@/lib/marketTx";
import type { ClaimView } from "@/lib/player";
import { ArenaClaimView, MarketClaimView, type MarketClaimViewProps } from "./ClaimPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const click = (el: Element | null) => act(() => (el as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true })));
const q = (sel: string) => container.querySelector(sel) as HTMLButtonElement | null;

function mountArena(view: ClaimView, over: { correctChain?: boolean; tx?: TxState } = {}) {
  const f = { onClaim: vi.fn(), onRecheck: vi.fn() };
  act(() => {
    root.render(<ArenaClaimView view={view} correctChain={over.correctChain ?? true} tx={over.tx ?? { step: "idle" }} {...f} />);
  });
  return f;
}

describe("ArenaClaimView", () => {
  it("is hidden before the round is final", () => {
    mountArena({ state: "hidden" });
    expect(container.textContent).toBe("");
  });

  it("shows the reward as (score - baseline) x REWARD_PER_POINT, the stake, and claims on click", () => {
    const f = mountArena({ state: "claimable", mode: "settled", stake: 50n, score: 80, baseline: 50, rewardPerPoint: 2n, reward: 60n, total: 110n });
    expect(q("[data-claim-reward]")?.getAttribute("data-claim-reward")).toBe("60");
    expect(container.textContent).toMatch(/\(80 - 50\) x 2 = 60 points/);
    expect(q("[data-claim-total]")?.getAttribute("data-claim-total")).toBe("110");
    expect(q("[data-claim-submit]")?.textContent).toBe("Claim 110 points");
    click(q("[data-claim-submit]"));
    expect(f.onClaim).toHaveBeenCalledTimes(1);
  });

  it("shows no reward at or below the baseline but still returns the stake", () => {
    mountArena({ state: "claimable", mode: "settled", stake: 50n, score: 40, baseline: 50, rewardPerPoint: 1n, reward: 0n, total: 50n });
    expect(q("[data-claim-reward]")?.getAttribute("data-claim-reward")).toBe("0");
    expect(container.textContent).toMatch(/No reward/);
    expect(q("[data-claim-submit]")?.textContent).toBe("Claim 50 points");
  });

  it("a void round claims the stake only", () => {
    mountArena({ state: "claimable", mode: "void", stake: 50n, reward: 0n, total: 50n });
    expect(container.textContent).toMatch(/void/i);
    expect(q("[data-claim-total]")?.getAttribute("data-claim-total")).toBe("50");
  });

  it("already claimed: no button, clear state", () => {
    mountArena({ state: "claimed" });
    expect(q("[data-claimed]")?.textContent).toMatch(/Already claimed/);
    expect(q("[data-claim-submit]")).toBeNull();
  });

  it("states without anything to claim have no button", () => {
    for (const [state, re] of [
      ["no-wallet", /connect/i],
      ["loading", /reading/i],
      ["error", /could not read/i],
      ["no-entry", /no entry/i],
      ["unrevealed", /burned/i],
    ] as const) {
      mountArena({ state });
      expect(container.textContent, state).toMatch(re);
      expect(q("[data-claim-submit]"), state).toBeNull();
    }
  });

  it("is disabled on the wrong network and while a transaction is in progress; shows its status", () => {
    const view: ClaimView = { state: "claimable", mode: "void", stake: 50n, reward: 0n, total: 50n };
    mountArena(view, { correctChain: false });
    expect(q("[data-claim-submit]")?.disabled).toBe(true);
    mountArena(view, { tx: { step: "pending", label: "Claim your points", hash: `0x${"ab".repeat(32)}` } });
    expect(q("[data-claim-submit]")?.disabled).toBe(true);
    expect(container.textContent).toMatch(/Waiting for confirmation/);
  });
});

// ---- market claim ----

const PATH: Path = [
  { close: 50, high: 80, low: -10 },
  { close: 20, high: 60, low: 10 },
  { close: 70, high: 90, low: 15 },
];
function market(over: Partial<MarketData> = {}): MarketData {
  return {
    status: 2,
    pools: { human: 100n, agent: 300n },
    stake: { human: 10n, agent: 0n },
    claimed: false,
    reveals: { human: 3n, agent: 3n },
    consensus: { human: { path: PATH, ready: true }, agent: { path: PATH, ready: true } },
    balance: 900n,
    cap: 200n,
    minReveals: 3n,
    scores: { human: 80, agent: 60, humanPresent: true, agentPresent: true },
    ...over,
  };
}
function mountMarket(over: Partial<MarketClaimViewProps> = {}) {
  const f = { onClaim: vi.fn(), onRecheck: vi.fn() };
  act(() => {
    root.render(<MarketClaimView data={market()} phase="settled" connected correctChain tx={{ step: "idle" }} {...f} {...over} />);
  });
  return f;
}

describe("MarketClaimView", () => {
  it("shows the winnings of a resolved market and claims on click", () => {
    const f = mountMarket();
    // human won: 10 * (100 + 300) / 100 = 40
    expect(q("[data-market-claim-amount]")?.getAttribute("data-market-claim-amount")).toBe("40");
    click(q("[data-market-claim-submit]"));
    expect(f.onClaim).toHaveBeenCalledTimes(1);
  });
  it("a losing side has nothing to claim and the button is disabled", () => {
    mountMarket({ data: market({ scores: { human: 50, agent: 70, humanPresent: true, agentPresent: true } }) });
    expect(q("[data-market-claim-amount]")?.getAttribute("data-market-claim-amount")).toBe("0");
    expect(q("[data-market-claim-submit]")?.disabled).toBe(true);
  });
  it("already claimed is stated and the button is disabled", () => {
    mountMarket({ data: market({ claimed: true }) });
    expect(container.textContent).toMatch(/Already claimed/);
    expect(q("[data-market-claim-submit]")?.disabled).toBe(true);
  });
  it("a wallet without a bet sees that, with no button", () => {
    mountMarket({ data: market({ stake: { human: 0n, agent: 0n } }) });
    expect(container.textContent).toMatch(/no bet/i);
    expect(q("[data-market-claim-submit]")).toBeNull();
  });
  it("a cancelled market offers a refund of the stake", () => {
    mountMarket({ data: market({ status: 1, scores: undefined }) });
    expect(q("[data-market-claim-amount]")?.getAttribute("data-market-claim-amount")).toBe("10");
    expect(q("[data-market-claim-submit]")?.textContent).toBe("Claim refund");
  });
  it("is hidden while the market is not final", () => {
    mountMarket({ data: market({ status: 0, scores: undefined }), phase: "market" });
    expect(container.textContent).toBe("");
  });
  it("is disabled while a transaction is in progress", () => {
    mountMarket({ tx: { step: "signing", label: "Claim" } });
    expect(q("[data-market-claim-submit]")?.disabled).toBe(true);
  });
});
