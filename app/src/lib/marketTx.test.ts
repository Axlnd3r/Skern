import { ContractFunctionRevertedError, encodeErrorResult, type Address, type Hash } from "viem";
import { describe, expect, it } from "vitest";
import type { Path } from "../../../shared/score";
import { gapMarketCallAbi } from "./chain";
import { SIDE_CODE, type MarketData } from "./market";
import { awaitReceipt, isBusy, runBet, runClaim, type FreshState, type TxDeps, type TxState } from "./marketTx";
import type { Phase, RoundView } from "./round";

const WHO = "0x4444444444444444444444444444444444444444" as Address;
const HASH = `0x${"ab".repeat(32)}` as Hash;
const PATH: Path = [
  { close: 50, high: 80, low: -10 },
  { close: 20, high: 60, low: 10 },
  { close: 70, high: 90, low: 15 },
];

function market(over: Partial<MarketData> = {}): MarketData {
  return {
    status: 0,
    pools: { human: 100n, agent: 100n },
    stake: { human: 0n, agent: 0n },
    claimed: false,
    reveals: { human: 3n, agent: 3n },
    consensus: { human: { path: PATH, ready: true }, agent: { path: PATH, ready: true } },
    balance: 900n,
    cap: 200n,
    minReveals: 3n,
    ...over,
  };
}

function round(phase: Phase = "market", closing = false): RoundView {
  return { status: "ready", params: undefined, phase, countdownSec: 60, closing, blockTime: 1000n };
}

type Harness = {
  deps: TxDeps;
  log: string[];
  calls: { simulate: { functionName: string; args: readonly unknown[]; who: Address }[] };
  states: TxState[];
  setTx: (s: TxState) => void;
};

function harness(opts: {
  fresh?: FreshState;
  wait?: () => Promise<{ ok: boolean }>;
  simulate?: () => Promise<unknown>;
  account?: { address: Address | undefined; isConnected: boolean; chainId: number | undefined };
}): Harness {
  const log: string[] = [];
  const calls = { simulate: [] as Harness["calls"]["simulate"] };
  const states: TxState[] = [];
  const deps: TxDeps = {
    chainId: 84532,
    account: () => {
      log.push("account");
      return opts.account ?? { address: WHO, isConnected: true, chainId: 84532 };
    },
    readFresh: async () => {
      log.push("readFresh");
      return opts.fresh ?? { round: round(), data: market() };
    },
    simulate: async (call) => {
      log.push("simulate");
      calls.simulate.push(call);
      return opts.simulate ? opts.simulate() : { request: "prepared" };
    },
    write: async () => {
      log.push("write");
      return HASH;
    },
    waitReceipt: async () => {
      log.push("wait");
      return opts.wait ? opts.wait() : { ok: true };
    },
  };
  return { deps, log, calls, states, setTx: (s) => states.push(s) };
}

const last = (h: Harness) => h.states[h.states.length - 1] as TxState;

describe("a receipt error after the send is never shown as failed", () => {
  const rejects = () => Promise.reject(new Error("HTTP 429 Too Many Requests"));

  it("bet: unconfirmed, keeps the hash, stays busy", async () => {
    const h = harness({ wait: rejects });
    await runBet(h.deps, { id: 7n, side: "human", amountText: "100" }, h.setTx);
    const end = last(h);
    expect(end.step).toBe("unconfirmed");
    if (end.step === "unconfirmed") {
      expect(end.hash).toBe(HASH);
      expect(end.message).toMatch(/check/i);
    }
    expect(h.states.some((s) => s.step === "failed")).toBe(false);
    expect(isBusy(end)).toBe(true);
  });

  it("claim: unconfirmed, keeps the hash, stays busy", async () => {
    const h = harness({ fresh: { round: round("play"), data: market({ status: 1, stake: { human: 10n, agent: 0n } }) }, wait: rejects });
    await runClaim(h.deps, { id: 7n }, h.setTx);
    const end = last(h);
    expect(end.step).toBe("unconfirmed");
    if (end.step === "unconfirmed") expect(end.hash).toBe(HASH);
    expect(h.states.some((s) => s.step === "failed")).toBe(false);
    expect(isBusy(end)).toBe(true);
  });

  it("a later re-check can settle it either way", async () => {
    const ok = harness({});
    await awaitReceipt(ok.deps, "Bet", HASH, ok.setTx);
    expect(last(ok)).toEqual({ step: "confirmed", label: "Bet", hash: HASH });
    const bad = harness({ wait: rejects });
    await awaitReceipt(bad.deps, "Bet", HASH, bad.setTx);
    expect(last(bad).step).toBe("unconfirmed");
  });

  it("only a receipt that says reverted is failed, and it keeps the hash", async () => {
    const h = harness({ wait: async () => ({ ok: false }) });
    await runBet(h.deps, { id: 7n, side: "human", amountText: "10" }, h.setTx);
    const end = last(h);
    expect(end.step).toBe("failed");
    if (end.step === "failed") expect(end.hash).toBe(HASH);
  });

  it("a mined bet is confirmed", async () => {
    const h = harness({});
    await runBet(h.deps, { id: 7n, side: "human", amountText: "10" }, h.setTx);
    expect(last(h)).toMatchObject({ step: "confirmed", hash: HASH });
    expect(isBusy(last(h))).toBe(false);
  });
});

describe("bet click path", () => {
  it("maps Human to side 0 and Agent to side 1 in the transaction arguments", async () => {
    expect(SIDE_CODE).toEqual({ human: 0, agent: 1 });
    for (const [side, code] of [["human", 0], ["agent", 1]] as const) {
      const h = harness({});
      await runBet(h.deps, { id: 7n, side, amountText: "25" }, h.setTx);
      expect(h.calls.simulate).toEqual([{ functionName: "bet", args: [7n, code, 25n], who: WHO }]);
    }
  });

  it("reads fresh state, then dry-runs, then sends, then waits", async () => {
    const h = harness({});
    await runBet(h.deps, { id: 7n, side: "agent", amountText: "25" }, h.setTx);
    const order = h.log.filter((x) => x !== "account");
    expect(order).toEqual(["readFresh", "simulate", "write", "wait"]);
  });

  it("decides from the fresh read, not from what was rendered", async () => {
    // Fresh chain state: 190 already staked, so only 10 remain. A render-time 0 stake would allow 50.
    const h = harness({ fresh: { round: round(), data: market({ stake: { human: 100n, agent: 90n } }) } });
    await runBet(h.deps, { id: 7n, side: "human", amountText: "50" }, h.setTx);
    expect(last(h)).toMatchObject({ step: "failed" });
    expect(h.log).not.toContain("simulate");
    expect(h.log).not.toContain("write");
    const edge = harness({ fresh: { round: round(), data: market({ stake: { human: 100n, agent: 90n } }) } });
    await runBet(edge.deps, { id: 7n, side: "human", amountText: "10" }, edge.setTx);
    expect(edge.log).toContain("write");
  });

  it("does not send when the fresh clock says closing or the phase moved on", async () => {
    const closing = harness({ fresh: { round: round("market", true), data: market() } });
    await runBet(closing.deps, { id: 7n, side: "human", amountText: "10" }, closing.setTx);
    expect(closing.log).not.toContain("write");
    const late = harness({ fresh: { round: round("play"), data: market() } });
    await runBet(late.deps, { id: 7n, side: "human", amountText: "10" }, late.setTx);
    expect(late.log).not.toContain("write");
  });

  it("uses the wallet at click time", async () => {
    const off = harness({ account: { address: WHO, isConnected: false, chainId: 84532 } });
    await runBet(off.deps, { id: 7n, side: "human", amountText: "10" }, off.setTx);
    expect(off.log).not.toContain("write");
    const wrong = harness({ account: { address: WHO, isConnected: true, chainId: 1 } });
    await runBet(wrong.deps, { id: 7n, side: "human", amountText: "10" }, wrong.setTx);
    expect(wrong.log).not.toContain("write");
    const none = harness({ account: { address: undefined, isConnected: false, chainId: undefined } });
    await runBet(none.deps, { id: 7n, side: "human", amountText: "10" }, none.setTx);
    expect(none.log).not.toContain("readFresh");
  });

  it("explains a reverted dry run and never sends", async () => {
    const data = encodeErrorResult({ abi: gapMarketCallAbi, errorName: "BetCapExceeded" });
    const h = harness({
      simulate: () => Promise.reject(new ContractFunctionRevertedError({ abi: gapMarketCallAbi, data, functionName: "bet" })),
    });
    await runBet(h.deps, { id: 7n, side: "human", amountText: "10" }, h.setTx);
    const end = last(h);
    expect(end.step).toBe("failed");
    if (end.step === "failed") expect(end.message).toMatch(/cap/i);
    expect(h.log).not.toContain("write");
  });

  it("reports an unreadable market without sending", async () => {
    const h = harness({ fresh: { round: round(), data: null } });
    await runBet(h.deps, { id: 7n, side: "human", amountText: "10" }, h.setTx);
    expect(last(h)).toMatchObject({ step: "failed" });
    expect(h.log).not.toContain("simulate");
  });
});

describe("claim click path", () => {
  it("claims a refund on a cancelled market with the round id as the only argument", async () => {
    const h = harness({ fresh: { round: round("play"), data: market({ status: 1, stake: { human: 10n, agent: 0n } }) } });
    await runClaim(h.deps, { id: 7n }, h.setTx);
    expect(h.calls.simulate).toEqual([{ functionName: "claim", args: [7n], who: WHO }]);
    expect(last(h).step).toBe("confirmed");
  });

  it("does not send while a resolved market's winner cannot be read", async () => {
    const h = harness({ fresh: { round: round("settled"), data: market({ status: 2, stake: { human: 10n, agent: 0n } }) } });
    await runClaim(h.deps, { id: 7n }, h.setTx);
    const end = last(h);
    expect(end.step).toBe("failed");
    if (end.step === "failed") expect(end.message).toMatch(/reading the result/i);
    expect(h.log).not.toContain("write");
  });
});
