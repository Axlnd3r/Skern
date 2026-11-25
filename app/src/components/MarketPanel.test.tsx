import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Path } from "../../../shared/score";
import type { MarketData } from "@/lib/market";
import type { Phase } from "@/lib/round";
import { MarketPanelView, type MarketPanelViewProps } from "./MarketPanel";

const PATH: Path = [
  { close: 50, high: 80, low: -10 },
  { close: 20, high: 60, low: 10 },
  { close: 70, high: 90, low: 15 },
];

function data(over: Partial<MarketData> = {}): MarketData {
  return {
    status: 0,
    pools: { human: 100n, agent: 100n },
    stake: { human: 0n, agent: 0n },
    claimed: false,
    reveals: { human: 3n, agent: 4n },
    consensus: { human: { path: PATH, ready: true }, agent: { path: PATH, ready: true } },
    balance: 900n,
    cap: 200n,
    minReveals: 3n,
    ...over,
  };
}

function html(over: Partial<MarketPanelViewProps> = {}): string {
  const props: MarketPanelViewProps = {
    roundId: 7n,
    T: 100,
    phase: "market" as Phase,
    closing: false,
    data: data(),
    stale: false,
    connected: true,
    correctChain: true,
    tx: { step: "idle" },
    onBet: () => undefined,
    onClaim: () => undefined,
    onRecheck: () => undefined,
    ...over,
  };
  return renderToStaticMarkup(<MarketPanelView {...props} />);
}

const betButton = (s: string) => /<button[^>]*data-bet-submit[^>]*>/.exec(s)?.[0] ?? "";

describe("MarketPanelView", () => {
  it("shows both pools and the implied odds", () => {
    const out = html({ data: data({ pools: { human: 30n, agent: 70n } }) });
    expect(out).toMatch(/data-odds-human="30"/);
    expect(out).toMatch(/data-odds-agent="70"/);
    expect(out).toMatch(/data-pool-human="30"/);
    expect(out).toMatch(/data-pool-agent="70"/);
  });

  it("shows 50/50 for empty pools", () => {
    const out = html({ data: data({ pools: { human: 0n, agent: 0n } }) });
    expect(out).toMatch(/data-odds-human="50"/);
    expect(out).toMatch(/data-odds-agent="50"/);
  });

  it("offers a bet form with the remaining allowance when betting is open", () => {
    const out = html({ data: data({ stake: { human: 120n, agent: 30n } }) });
    expect(out).toContain("data-bet-form");
    expect(out).toMatch(/data-remaining="50"/);
    expect(out).toMatch(/cap of 200/i);
  });

  it("disables the bet button while the window is closing", () => {
    const out = html({ closing: true });
    expect(betButton(out)).toMatch(/disabled/);
    expect(out).toMatch(/closing/i);
  });

  it("disables the bet button when the wallet is not connected", () => {
    expect(betButton(html({ connected: false }))).toMatch(/disabled/);
  });

  it("shows cancelled with a refund and no bet form when the quorum is missing", () => {
    const out = html({ data: data({ status: 1, reveals: { human: 3n, agent: 1n } }) });
    expect(out).toMatch(/Market cancelled: refund/);
    expect(out).toMatch(/quorum/i);
    expect(out).not.toContain("data-bet-form");
  });

  it("shows the quorum status for each side", () => {
    const out = html({ data: data({ reveals: { human: 2n, agent: 4n } }) });
    expect(out).toMatch(/Human reveals<\/td><td>2 of 3/);
    expect(out).toMatch(/Agent reveals<\/td><td>4 of 3/);
  });

  it("draws the consensus overlay only for paths the chain says are ready", () => {
    const both = html();
    expect(both).toContain('data-series="human"');
    expect(both).toContain('data-series="agent"');
    const partial = html({
      data: data({ consensus: { human: { path: PATH, ready: true }, agent: { path: PATH, ready: false } } }),
    });
    expect(partial).toContain('data-series="human"');
    expect(partial).not.toContain('data-series="agent"');
    const none = html({
      data: data({ consensus: { human: { path: PATH, ready: false }, agent: { path: null, ready: false } } }),
    });
    expect(none).not.toContain("data-series=");
    expect(none).toMatch(/not frozen/i);
  });

  it("offers a refund claim on a cancelled market and a claimed one is shown as done", () => {
    const refund = html({
      phase: "play",
      data: data({ status: 1, stake: { human: 10n, agent: 5n }, reveals: { human: 1n, agent: 1n } }),
    });
    expect(refund).toMatch(/data-claim-amount="15"/);
    const claimTag = /<button[^>]*data-claim-submit[^>]*>/.exec(refund)?.[0];
    expect(claimTag).toBeTruthy();
    expect(claimTag).not.toMatch(/disabled/);
    const done = html({
      phase: "play",
      data: data({ status: 1, claimed: true, stake: { human: 10n, agent: 5n }, reveals: { human: 1n, agent: 1n } }),
    });
    expect(done).toMatch(/already claimed/i);
  });

  it("says a tie refunds everyone", () => {
    const out = html({ phase: "settled", data: data({ status: 3, scores: { human: 70, agent: 70, humanPresent: true, agentPresent: true } }) });
    expect(out).toMatch(/Tie: refund/);
  });

  it("shows pending and error transaction states", () => {
    expect(html({ tx: { step: "signing", label: "Bet 5 points on human" } })).toMatch(/Confirm in your wallet/i);
    expect(html({ tx: { step: "failed", message: "Over the per-address cap" } })).toMatch(/Over the per-address cap/);
    expect(betButton(html({ tx: { step: "pending", label: "Bet", hash: `0x${"ab".repeat(32)}` } }))).toMatch(/disabled/);
  });

  it("labels the market as points only and not a real-money market", () => {
    expect(html()).toMatch(/points only/i);
  });
});
