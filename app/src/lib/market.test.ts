import { ContractFunctionRevertedError, UserRejectedRequestError, encodeErrorResult } from "viem";
import { describe, expect, it } from "vitest";
import { gapMarketAbi, gapMarketCallAbi } from "./chain";
import { isValid, type Path } from "../../../shared/score";
import {
  KIND_AGENT,
  KIND_HUMAN,
  betGuard,
  claimGuard,
  claimableAmount,
  deriveMarket,
  describeTxError,
  marketAddresses,
  marketContracts,
  parseAmount,
  parseMarketReads,
  parsePath,
  parseStatusCode,
  quorumOf,
  remainingAllowance,
  txErrorText,
  viewOfData,
  type MarketData,
} from "./market";

const GOOD: Path = [
  { close: 50, high: 80, low: -10 },
  { close: 20, high: 60, low: 10 },
  { close: 70, high: 90, low: 15 },
];
const OK = (result: unknown) => ({ status: "success", result });
const FAIL = { status: "failure", error: new Error("revert") };

describe("remainingAllowance", () => {
  it("is the cap minus what the address already holds over both sides", () => {
    expect(remainingAllowance(200n, 0n, 0n)).toBe(200n);
    expect(remainingAllowance(200n, 100n, 50n)).toBe(50n);
    expect(remainingAllowance(200n, 150n, 50n)).toBe(0n);
  });
  it("never goes negative on inconsistent data", () => {
    expect(remainingAllowance(200n, 300n, 0n)).toBe(0n);
  });
});

describe("parseAmount", () => {
  it("accepts whole non-negative integers only", () => {
    expect(parseAmount("5")).toBe(5n);
    expect(parseAmount(" 42 ")).toBe(42n);
    expect(parseAmount("007")).toBe(7n);
    expect(parseAmount("0")).toBe(0n);
  });
  it("rejects empty, signed, fractional, exponent and oversized input", () => {
    for (const s of ["", " ", "-1", "+1", "1.5", "1e3", "0x10", "abc", "1,000", "1".repeat(19)]) {
      expect(parseAmount(s)).toBeNull();
    }
  });
});

describe("quorumOf", () => {
  it("needs the minimum on each side", () => {
    expect(quorumOf(3n, 3n, 3n).met).toBe(true);
    expect(quorumOf(2n, 9n, 3n).met).toBe(false);
    expect(quorumOf(9n, 2n, 3n).met).toBe(false);
    expect(quorumOf(0n, 0n, 3n).met).toBe(false);
  });
});

describe("parseStatusCode", () => {
  it("accepts only 0..3", () => {
    expect(parseStatusCode(0)).toBe(0);
    expect(parseStatusCode(3)).toBe(3);
    for (const v of [4, -1, 1.5, "1", 1n, null, undefined, NaN]) expect(parseStatusCode(v)).toBeNull();
  });
});

describe("deriveMarket", () => {
  const met = quorumOf(3n, 3n, 3n);
  const lacking = quorumOf(3n, 1n, 3n);
  const ready = { human: true, agent: true };
  const pools = { human: 10n, agent: 10n };
  const base = { phase: "market" as const, status: 0 as const, quorum: met, ready, pools };

  it("is waiting before the market window", () => {
    expect(deriveMarket({ ...base, phase: "commit" }).state).toBe("waiting");
    expect(deriveMarket({ ...base, phase: "reveal" }).state).toBe("waiting");
  });
  it("is betting in the window with quorum and both consensus paths frozen", () => {
    expect(deriveMarket(base).state).toBe("betting");
  });
  it("waits for the consensus freeze when a path is not ready", () => {
    expect(deriveMarket({ ...base, ready: { human: true, agent: false } }).state).toBe("awaiting-freeze");
  });
  it("is cancelled with a refund when quorum is missing", () => {
    const v = deriveMarket({ ...base, quorum: lacking, status: 1 });
    expect(v.state).toBe("cancelled");
    expect(v.cancelReason).toBe("quorum");
    expect(v.headline).toMatch(/cancel/i);
    expect(v.detail).toMatch(/refund/i);
    // Even if the chain status still reads open (clock lag), a missing quorum is never bettable.
    expect(deriveMarket({ ...base, quorum: lacking }).state).toBe("cancelled");
    expect(deriveMarket({ ...base, quorum: lacking, phase: "play" }).state).toBe("cancelled");
  });
  it("is cancelled when one side has no bets after the window", () => {
    const v = deriveMarket({ ...base, phase: "play", status: 1, pools: { human: 5n, agent: 0n } });
    expect(v.state).toBe("cancelled");
    expect(v.cancelReason).toBe("one-sided");
    expect(deriveMarket({ ...base, phase: "play", pools: { human: 5n, agent: 0n } }).state).toBe("cancelled");
  });
  it("does not blame an empty pool when the cancelled market has quorum and both pools are funded", () => {
    const v = deriveMarket({ ...base, phase: "play", status: 1 });
    expect(v.state).toBe("cancelled");
    expect(v.cancelReason).toBe("other");
    expect(v.detail).not.toMatch(/no bets/i);
    expect(v.detail).toMatch(/refund/i);
  });
  it("a void round is cancelled whatever the status says", () => {
    const v = deriveMarket({ ...base, phase: "void", status: 0 });
    expect(v.state).toBe("cancelled");
    expect(v.cancelReason).toBe("void");
  });
  it("is play after the window while candles are pending", () => {
    expect(deriveMarket({ ...base, phase: "play" }).state).toBe("play");
  });
  it("reports tie and resolved from the settled status", () => {
    expect(deriveMarket({ ...base, phase: "settled", status: 3 }).state).toBe("tie");
    expect(deriveMarket({ ...base, phase: "settled", status: 2 }).state).toBe("resolved");
    expect(deriveMarket({ ...base, phase: "settled", status: 3 }).detail).toMatch(/refund/i);
  });
  it("does not pretend when the data is inconsistent", () => {
    expect(deriveMarket({ ...base, phase: "settled", status: 0 }).state).toBe("unknown");
  });
});

describe("betGuard", () => {
  const ok = {
    state: "betting" as const,
    closing: false,
    connected: true,
    correctChain: true,
    balance: 1000n,
    remaining: 200n,
    amountText: "50",
  };
  it("accepts a valid bet", () => {
    expect(betGuard(ok)).toEqual({ ok: true, amount: 50n });
  });
  it("allows exactly the remaining allowance and rejects one more", () => {
    expect(betGuard({ ...ok, amountText: "200" })).toEqual({ ok: true, amount: 200n });
    expect(betGuard({ ...ok, amountText: "201" }).ok).toBe(false);
    expect(betGuard({ ...ok, remaining: 50n, amountText: "51" }).ok).toBe(false);
    expect(betGuard({ ...ok, remaining: 0n, amountText: "1" }).ok).toBe(false);
  });
  it("is disabled in the closing window", () => {
    const g = betGuard({ ...ok, closing: true });
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toMatch(/closing/i);
  });
  it("is disabled outside the betting state", () => {
    for (const state of ["waiting", "awaiting-freeze", "play", "cancelled", "tie", "resolved", "unknown"] as const) {
      expect(betGuard({ ...ok, state }).ok).toBe(false);
    }
  });
  it("needs a wallet on Base Sepolia", () => {
    expect(betGuard({ ...ok, connected: false }).ok).toBe(false);
    expect(betGuard({ ...ok, correctChain: false }).ok).toBe(false);
  });
  it("rejects zero, malformed amounts and amounts above the balance", () => {
    expect(betGuard({ ...ok, amountText: "0" }).ok).toBe(false);
    expect(betGuard({ ...ok, amountText: "1.5" }).ok).toBe(false);
    expect(betGuard({ ...ok, amountText: "" }).ok).toBe(false);
    expect(betGuard({ ...ok, balance: 10n, amountText: "11" }).ok).toBe(false);
    expect(betGuard({ ...ok, balance: 10n, amountText: "10" }).ok).toBe(true);
  });
});

describe("claimableAmount", () => {
  const pools = { human: 100n, agent: 50n };
  it("refunds the whole stake when cancelled or tied", () => {
    expect(claimableAmount({ state: "cancelled", stake: { human: 10n, agent: 5n }, pools })).toBe(15n);
    expect(claimableAmount({ state: "tie", stake: { human: 10n, agent: 5n }, pools })).toBe(15n);
  });
  it("pays the winning-side share of the whole pool, floored, when resolved", () => {
    // 30 * 150 / 100 = 45
    expect(claimableAmount({ state: "resolved", winner: "human", stake: { human: 30n, agent: 7n }, pools })).toBe(45n);
    // 7 * 150 / 50 = 21
    expect(claimableAmount({ state: "resolved", winner: "agent", stake: { human: 30n, agent: 7n }, pools })).toBe(21n);
    // floor: 1 * 150 / 100 = 1
    expect(claimableAmount({ state: "resolved", winner: "human", stake: { human: 1n, agent: 0n }, pools })).toBe(1n);
  });
  it("is 0 for a loser, an unknown winner or an open market", () => {
    expect(claimableAmount({ state: "resolved", winner: "human", stake: { human: 0n, agent: 9n }, pools })).toBe(0n);
    expect(claimableAmount({ state: "resolved", stake: { human: 9n, agent: 9n }, pools })).toBe(0n);
    expect(claimableAmount({ state: "betting", stake: { human: 9n, agent: 9n }, pools })).toBe(0n);
  });
});

describe("claimGuard", () => {
  it("needs a wallet, a settled market, no earlier claim and something to claim", () => {
    const ok = { state: "cancelled" as const, connected: true, correctChain: true, claimed: false, amount: 15n, resultKnown: true };
    expect(claimGuard(ok).ok).toBe(true);
    expect(claimGuard({ ...ok, connected: false }).ok).toBe(false);
    expect(claimGuard({ ...ok, correctChain: false }).ok).toBe(false);
    expect(claimGuard({ ...ok, claimed: true }).ok).toBe(false);
    expect(claimGuard({ ...ok, amount: 0n }).ok).toBe(false);
    expect(claimGuard({ ...ok, state: "betting" }).ok).toBe(false);
    expect(claimGuard({ ...ok, state: "play" }).ok).toBe(false);
    // Resolved but the winner is not readable yet: neutral reason, never "nothing to claim".
    const unknown = claimGuard({ ...ok, state: "resolved", amount: 0n, resultKnown: false });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.reason).toMatch(/reading the result/i);
    expect(claimGuard({ ...ok, state: "resolved", amount: 0n, resultKnown: true }).ok).toBe(false);
  });
});

describe("parsePath (untrusted chain data)", () => {
  it("accepts a valid 3-candle path", () => {
    expect(parsePath(GOOD)).toEqual(GOOD);
  });
  it("rejects wrong shapes, non-integers, out-of-range values and invalid candles", () => {
    expect(parsePath(undefined)).toBeNull();
    expect(parsePath([])).toBeNull();
    expect(parsePath([GOOD[0], GOOD[1]])).toBeNull();
    expect(parsePath([GOOD[0], GOOD[1], { close: 1.5, high: 2, low: 0 }])).toBeNull();
    expect(parsePath([GOOD[0], GOOD[1], { close: 5n, high: 5n, low: 5n }])).toBeNull();
    expect(parsePath([GOOD[0], GOOD[1], { close: 2 ** 31, high: 2 ** 31, low: 0 }])).toBeNull();
    expect(parsePath([GOOD[0], GOOD[1], { close: 1, high: 0, low: 0 }])).toBeNull(); // high < close
    expect(parsePath([GOOD[0], GOOD[1], null])).toBeNull();
    expect(parsePath(new Array(3))).toBeNull();
  });
  it("returns a path that passes isValid", () => {
    const p = parsePath(GOOD);
    expect(p !== null && isValid(p)).toBe(true);
  });
});

describe("parseMarketReads (untrusted chain data)", () => {
  const addrs = {
    arena: "0x1111111111111111111111111111111111111111",
    points: "0x2222222222222222222222222222222222222222",
    gapMarket: "0x3333333333333333333333333333333333333333",
  } as const;
  const who = "0x4444444444444444444444444444444444444444" as const;

  function results(over: Record<number, unknown> = {}): unknown[] {
    const base: unknown[] = [
      OK(0), // status
      OK([10n, 20n]), // pools
      OK(5n), // stake human
      OK(7n), // stake agent
      OK(false), // claimed
      OK(4n), // reveals human
      OK(3n), // reveals agent
      OK([GOOD, true]), // consensus human
      OK([GOOD, false]), // consensus agent
      OK(900n), // balance
      OK(200n), // cap
      OK(3n), // min reveals
      OK([60, 55, true, true]), // scores
    ];
    for (const [i, v] of Object.entries(over)) base[Number(i)] = v;
    return base;
  }

  it("builds one contract call per read, in the order parseMarketReads expects", () => {
    const calls = marketContracts(addrs, 7n, who);
    expect(calls).toHaveLength(13);
    expect(calls[7]).toMatchObject({ functionName: "consensus", args: [7n, KIND_HUMAN] });
    expect(calls[8]).toMatchObject({ functionName: "consensus", args: [7n, KIND_AGENT] });
    expect(calls[2]).toMatchObject({ functionName: "stakeOf", args: [7n, who, 0] });
    expect(calls[3]).toMatchObject({ functionName: "stakeOf", args: [7n, who, 1] });
    expect(calls[9]).toMatchObject({ functionName: "balanceOf", args: [who] });
  });

  it("marketAddresses needs arena, gapMarket and points", () => {
    expect(marketAddresses({ ...addrs, registry: undefined })).toEqual(addrs);
    expect(marketAddresses({ ...addrs, registry: undefined, points: undefined })).toBeNull();
    expect(marketAddresses({ arena: undefined, points: addrs.points, registry: undefined, gapMarket: addrs.gapMarket })).toBeNull();
  });

  it("parses a well-formed multicall result", () => {
    const d = parseMarketReads(results()) as MarketData;
    expect(d.status).toBe(0);
    expect(d.pools).toEqual({ human: 10n, agent: 20n });
    expect(d.stake).toEqual({ human: 5n, agent: 7n });
    expect(d.claimed).toBe(false);
    expect(d.reveals).toEqual({ human: 4n, agent: 3n });
    expect(d.consensus.human).toEqual({ path: GOOD, ready: true });
    expect(d.consensus.agent).toEqual({ path: GOOD, ready: false });
    expect(d.balance).toBe(900n);
    expect(d.cap).toBe(200n);
    expect(d.minReveals).toBe(3n);
    expect(d.scores).toEqual({ human: 60, agent: 55, humanPresent: true, agentPresent: true });
  });

  it("treats scores that revert before settlement as absent, not as an error", () => {
    const d = parseMarketReads(results({ 12: FAIL })) as MarketData;
    expect(d.scores).toBeUndefined();
  });

  it("rejects the whole read when an essential field is malformed or failed", () => {
    expect(parseMarketReads(results({ 0: OK(9) }))).toBeNull(); // status out of range
    expect(parseMarketReads(results({ 0: FAIL }))).toBeNull();
    expect(parseMarketReads(results({ 1: OK([10, 20n]) }))).toBeNull(); // number instead of bigint
    expect(parseMarketReads(results({ 1: OK([-1n, 20n]) }))).toBeNull(); // negative pool
    expect(parseMarketReads(results({ 5: OK(4) }))).toBeNull();
    expect(parseMarketReads(results({ 10: OK(0n) }))).toBeNull(); // a cap of 0 is not a market
    expect(parseMarketReads(results({ 4: OK("false") }))).toBeNull();
    expect(parseMarketReads(results().slice(0, 5))).toBeNull();
    expect(parseMarketReads(undefined)).toBeNull();
  });

  it("drops a malformed consensus path instead of drawing it, and never calls it ready", () => {
    const bad = [{ close: 1, high: 0, low: 0 }, GOOD[1], GOOD[2]];
    const d = parseMarketReads(results({ 7: OK([bad, true]) })) as MarketData;
    expect(d.consensus.human).toEqual({ path: null, ready: false });
  });

  it("ignores scores out of the 0..100 range", () => {
    const d = parseMarketReads(results({ 12: OK([101, 55, true, true]) })) as MarketData;
    expect(d.scores).toBeUndefined();
  });
});

describe("describeTxError", () => {
  it("maps known GapMarket reverts to plain text", () => {
    expect(describeTxError("BetCapExceeded")).toMatch(/200|cap/i);
    expect(describeTxError("OutsideBetWindow")).toMatch(/window/i);
    expect(describeTxError("MarketCancelled")).toMatch(/quorum|cancel/i);
    expect(describeTxError("InsufficientBalance")).toMatch(/balance|points/i);
    expect(describeTxError("AlreadyClaimed")).toMatch(/already/i);
  });
  it("falls back to a generic message for unknown names", () => {
    expect(describeTxError("Whatever")).toMatch(/failed/i);
    expect(describeTxError(undefined)).toMatch(/failed/i);
  });
});

describe("txErrorText", () => {
  it("decodes Points and Arena errors raised during a GapMarket call", () => {
    const points = encodeErrorResult({ abi: gapMarketCallAbi, errorName: "InsufficientBalance", args: [1n, 2n] });
    const e1 = new ContractFunctionRevertedError({ abi: gapMarketCallAbi, data: points, functionName: "bet" });
    expect(txErrorText(e1)).toBe(describeTxError("InsufficientBalance"));
    expect(txErrorText(e1)).toMatch(/not enough points/i);
    const unknown = encodeErrorResult({ abi: gapMarketCallAbi, errorName: "UnknownRound" });
    const e2 = new ContractFunctionRevertedError({ abi: gapMarketCallAbi, data: unknown, functionName: "bet" });
    expect(txErrorText(e2)).toBe(describeTxError("UnknownRound"));
    // The plain GapMarket ABI cannot decode it: this is why the merged ABI is used.
    const e3 = new ContractFunctionRevertedError({ abi: gapMarketAbi, data: points, functionName: "bet" });
    expect(txErrorText(e3)).not.toMatch(/not enough points/i);
  });
  it("uses the decoded revert name", () => {
    const data = encodeErrorResult({ abi: gapMarketAbi, errorName: "BetCapExceeded" });
    const e = new ContractFunctionRevertedError({ abi: gapMarketAbi, data, functionName: "bet" });
    expect(txErrorText(e)).toBe(describeTxError("BetCapExceeded"));
  });
  it("reports a wallet rejection", () => {
    expect(txErrorText(new UserRejectedRequestError(new Error("no")))).toMatch(/rejected/i);
  });
  it("never throws on odd values and stays short", () => {
    expect(txErrorText("boom")).toMatch(/failed/i);
    expect(txErrorText(undefined)).toMatch(/failed/i);
    expect(txErrorText(new Error("x".repeat(5000)))).toMatch(/failed/i);
  });
});

describe("viewOfData", () => {
  const data = (over: Partial<MarketData> = {}): MarketData => ({
    status: 0,
    pools: { human: 0n, agent: 0n },
    stake: { human: 0n, agent: 0n },
    claimed: false,
    reveals: { human: 3n, agent: 3n },
    consensus: { human: { path: GOOD, ready: true }, agent: { path: GOOD, ready: true } },
    balance: 100n,
    cap: 200n,
    minReveals: 3n,
    ...over,
  });
  it("feeds the quorum from the chain minimum, not a hard-coded 3", () => {
    expect(viewOfData("market", data()).state).toBe("betting");
    expect(viewOfData("market", data({ minReveals: 4n })).state).toBe("cancelled");
    expect(viewOfData("market", data({ reveals: { human: 3n, agent: 2n } })).cancelReason).toBe("quorum");
  });
  it("is awaiting the freeze until both paths are ready", () => {
    const d = data({ consensus: { human: { path: GOOD, ready: true }, agent: { path: null, ready: false } } });
    expect(viewOfData("market", d).state).toBe("awaiting-freeze");
  });
});
