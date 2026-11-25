// Pure logic for the market screen: quorum, market state, bet cap arithmetic, guards for the bet and
// claim buttons, and validation of the contract reads (untrusted). No scoring lives here.
//
// Money is points only (testnet). Amounts are bigint; the 200-point cap comes from the contract.

import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError, type Address } from "viem";
import { type Addresses, arenaAbi, gapMarketAbi, pointsAbi } from "./chain";
import { isBig, parsePath, parseScores, successOf, type ConsensusScores } from "./chainData";
import type { Phase } from "./round";
import type { Path } from "../../../shared/score";

export { parsePath };

/** `Kind` enum of the contracts (None = 0). */
export const KIND_HUMAN = 1;
export const KIND_AGENT = 2;
/** `Side` enum of GapMarket. */
export const SIDE_HUMAN = 0;
export const SIDE_AGENT = 1;
export type Side = "human" | "agent";

export const SIDE_CODE: Record<Side, number> = { human: SIDE_HUMAN, agent: SIDE_AGENT };

// ---- Amounts and the per-address cap ----

/** Points an address may still stake in a round: `cap - held`, never negative. */
export function remainingAllowance(cap: bigint, heldHuman: bigint, heldAgent: bigint): bigint {
  const left = cap - heldHuman - heldAgent;
  return left > 0n ? left : 0n;
}

/** Whole-number text to bigint. No sign, no decimals, no exponent, at most 18 digits. Otherwise null. */
export function parseAmount(text: string): bigint | null {
  const t = text.trim();
  if (!/^\d{1,18}$/.test(t)) return null;
  return BigInt(t);
}

// ---- Quorum and market state ----

export type Quorum = { human: bigint; agent: bigint; min: bigint; met: boolean };

/** A market opens only if each side has at least `min` reveals. */
export function quorumOf(humanReveals: bigint, agentReveals: bigint, min: bigint): Quorum {
  return { human: humanReveals, agent: agentReveals, min, met: humanReveals >= min && agentReveals >= min };
}

/** GapMarket.status: 0 open, 1 cancelled, 2 resolved, 3 tie. */
export type MarketStatusCode = 0 | 1 | 2 | 3;

export function parseStatusCode(v: unknown): MarketStatusCode | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 3 ? (v as MarketStatusCode) : null;
}

export type MarketState =
  | "waiting"
  | "betting"
  | "awaiting-freeze"
  | "play"
  | "cancelled"
  | "tie"
  | "resolved"
  | "unknown";

export type CancelReason = "void" | "quorum" | "one-sided" | "other";

export type MarketView = {
  state: MarketState;
  cancelReason?: CancelReason;
  headline: string;
  detail: string;
};

export type MarketInput = {
  phase: Phase;
  status: MarketStatusCode;
  quorum: Quorum;
  ready: { human: boolean; agent: boolean };
  pools: { human: bigint; agent: bigint };
};

function cancelled(reason: CancelReason, min: bigint): MarketView {
  const detail: Record<CancelReason, string> = {
    void: "The round did not settle, so the market is cancelled. Every stake is refunded in full.",
    quorum: `Quorum missing: each side needs at least ${min} reveals. No bets are accepted and any stake is refunded in full (refund).`,
    "one-sided": "One side received no bets, so the market is cancelled. Every stake is refunded in full (refund).",
    other: "The contract reports this market as cancelled. Every stake is refunded in full (refund).",
  };
  return { state: "cancelled", cancelReason: reason, headline: "Market cancelled: refund", detail: detail[reason] };
}

/**
 * The market state shown to the user, from the chain's phase and `GapMarket.status`. The chain status
 * is authoritative; the quorum and pools are used only to explain it and to stay conservative when the
 * clock the status was computed with lags the phase shown (a missing quorum is never bettable).
 */
export function deriveMarket(i: MarketInput): MarketView {
  const min = i.quorum.min;
  if (i.phase === "void") return cancelled("void", min);
  if (i.status === 1) {
    const emptyPool = i.pools.human === 0n || i.pools.agent === 0n;
    return cancelled(!i.quorum.met ? "quorum" : emptyPool ? "one-sided" : "other", min);
  }
  if (i.status === 3) {
    return {
      state: "tie",
      headline: "Tie: refund",
      detail: "Both consensus paths scored the same. Every stake is refunded in full (refund).",
    };
  }
  if (i.status === 2) {
    return { state: "resolved", headline: "Market resolved", detail: "The higher-scoring consensus wins. Winners claim a share of the whole pool." };
  }
  // status 0 (open)
  switch (i.phase) {
    case "commit":
    case "reveal":
      return {
        state: "waiting",
        headline: "Market not open yet",
        detail: `Bets open after the reveal window closes. The market opens only if both sides have at least ${min} reveals.`,
      };
    case "market":
      if (!i.quorum.met) return cancelled("quorum", min);
      if (!i.ready.human || !i.ready.agent) {
        return {
          state: "awaiting-freeze",
          headline: "Waiting for the consensus freeze",
          detail: "Bets are accepted once both consensus paths are frozen on-chain. The keeper freezes them after the reveal window.",
        };
      }
      return {
        state: "betting",
        headline: "Market open",
        detail: "Bet on which consensus path scores higher against the real candles. Points only, no real money.",
      };
    case "play":
      if (!i.quorum.met) return cancelled("quorum", min);
      if (i.pools.human === 0n || i.pools.agent === 0n) return cancelled("one-sided", min);
      return { state: "play", headline: "Bets closed", detail: "Waiting for the real candles. The higher-scoring consensus decides the market." };
    default:
      return { state: "unknown", headline: "Market status unavailable", detail: "The chain reported a status that does not fit the round phase." };
  }
}

// ---- Guards (the single gate for each button) ----

export type BetGuardInput = {
  state: MarketState;
  /** `closing` from useRound: the last seconds of the market window. */
  closing: boolean;
  connected: boolean;
  correctChain: boolean;
  balance: bigint;
  remaining: bigint;
  amountText: string;
};

export type BetGuard = { ok: true; amount: bigint } | { ok: false; reason: string };

export function betGuard(i: BetGuardInput): BetGuard {
  if (i.state !== "betting") return { ok: false, reason: "Bets are not open." };
  if (i.closing) return { ok: false, reason: "The market window is closing. A transaction would land too late." };
  if (!i.connected) return { ok: false, reason: "Connect your wallet to bet." };
  if (!i.correctChain) return { ok: false, reason: "Switch to Base Sepolia." };
  const amount = parseAmount(i.amountText);
  if (amount === null) return { ok: false, reason: "Enter a whole number of points." };
  if (amount === 0n) return { ok: false, reason: "Enter at least 1 point." };
  if (amount > i.remaining) {
    return { ok: false, reason: `Over the per-address cap: you can stake ${i.remaining} more points in this round.` };
  }
  if (amount > i.balance) return { ok: false, reason: `Not enough points: your balance is ${i.balance}.` };
  return { ok: true, amount };
}

export type ClaimGuardInput = {
  state: MarketState;
  connected: boolean;
  correctChain: boolean;
  claimed: boolean;
  amount: bigint;
  /** False while a resolved market's winner cannot be read yet (the score read failed): the amount is then unknown. */
  resultKnown: boolean;
};

export type ClaimGuard = { ok: true } | { ok: false; reason: string };

export function claimGuard(i: ClaimGuardInput): ClaimGuard {
  if (i.state !== "cancelled" && i.state !== "tie" && i.state !== "resolved") {
    return { ok: false, reason: "Nothing to claim yet." };
  }
  if (!i.connected) return { ok: false, reason: "Connect your wallet to claim." };
  if (!i.correctChain) return { ok: false, reason: "Switch to Base Sepolia." };
  if (i.claimed) return { ok: false, reason: "Already claimed." };
  if (!i.resultKnown) return { ok: false, reason: "Reading the result of the market..." };
  if (i.amount <= 0n) return { ok: false, reason: "You have nothing to claim in this market." };
  return { ok: true };
}

/** The side whose consensus scored higher, or undefined on a tie or when scores are not readable. */
export function winnerOf(scores: ConsensusScores | undefined): Side | undefined {
  if (!scores) return undefined;
  if (scores.human === scores.agent) return undefined;
  return scores.human > scores.agent ? "human" : "agent";
}

/**
 * What `GapMarket.claim` would pay: the full stake over both sides when cancelled or tied, and for a
 * resolved market `winnerStake * totalPool / winnerPool` (floor), 0 for a loser. 0 whenever the market
 * is not final or the winner is not known.
 */
export function claimableAmount(i: {
  state: MarketState;
  winner?: Side;
  stake: { human: bigint; agent: bigint };
  pools: { human: bigint; agent: bigint };
}): bigint {
  if (i.state === "cancelled" || i.state === "tie") return i.stake.human + i.stake.agent;
  if (i.state !== "resolved" || i.winner === undefined) return 0n;
  const winnerStake = i.stake[i.winner];
  const winnerPool = i.pools[i.winner];
  if (winnerStake <= 0n || winnerPool <= 0n) return 0n;
  return (winnerStake * (i.pools.human + i.pools.agent)) / winnerPool;
}

// ---- Contract reads (untrusted) ----

export type ConsensusRead = { path: Path | null; ready: boolean };

export type MarketData = {
  status: MarketStatusCode;
  pools: { human: bigint; agent: bigint };
  stake: { human: bigint; agent: bigint };
  claimed: boolean;
  reveals: { human: bigint; agent: bigint };
  consensus: { human: ConsensusRead; agent: ConsensusRead };
  balance: bigint;
  cap: bigint;
  minReveals: bigint;
  /** Present only once the round is settled (the view reverts before). */
  scores?: ConsensusScores;
};

export type MarketAddresses = { arena: Address; gapMarket: Address; points: Address };

/** The three contracts the market screen reads, or null when any is not configured. */
export function marketAddresses(a: Addresses): MarketAddresses | null {
  return a.arena && a.gapMarket && a.points ? { arena: a.arena, gapMarket: a.gapMarket, points: a.points } : null;
}

/** The multicall for the market screen. Order is fixed: `parseMarketReads` indexes into it. */
export function marketContracts(addrs: MarketAddresses, id: bigint, who: Address) {
  const gap = { address: addrs.gapMarket, abi: gapMarketAbi } as const;
  const arena = { address: addrs.arena, abi: arenaAbi } as const;
  return [
    { ...gap, functionName: "status", args: [id] },
    { ...gap, functionName: "pools", args: [id] },
    { ...gap, functionName: "stakeOf", args: [id, who, SIDE_HUMAN] },
    { ...gap, functionName: "stakeOf", args: [id, who, SIDE_AGENT] },
    { ...gap, functionName: "isClaimed", args: [id, who] },
    { ...arena, functionName: "revealCount", args: [id, KIND_HUMAN] },
    { ...arena, functionName: "revealCount", args: [id, KIND_AGENT] },
    { ...arena, functionName: "consensus", args: [id, KIND_HUMAN] },
    { ...arena, functionName: "consensus", args: [id, KIND_AGENT] },
    { address: addrs.points, abi: pointsAbi, functionName: "balanceOf", args: [who] },
    { ...gap, functionName: "MAX_BET_PER_ADDRESS" },
    { ...gap, functionName: "MIN_REVEALS" },
    { ...arena, functionName: "consensusScores", args: [id] },
  ] as const;
}

function consensusRead(r: unknown): ConsensusRead {
  const s = successOf(r);
  if (s === null || !Array.isArray(s.result) || s.result.length !== 2) return { path: null, ready: false };
  const [rawPath, ready] = s.result as unknown[];
  const path = parsePath(rawPath);
  return { path, ready: path !== null && ready === true };
}

/** `uint256` pair (pools): both bigint, non-negative. */
function bigPair(v: unknown): { human: bigint; agent: bigint } | null {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const [a, b] = v as unknown[];
  return isBig(a) && isBig(b) && a >= 0n && b >= 0n ? { human: a, agent: b } : null;
}

/**
 * Validates the `marketContracts` multicall (`allowFailure: true` shape). Every essential field must
 * be present and in range or the whole read is rejected (null); consensus reads degrade to "not ready"
 * and the scores are optional (they revert before settlement).
 */
export function parseMarketReads(results: readonly unknown[] | undefined): MarketData | null {
  if (!results || results.length !== 13) return null;
  const val = (i: number): { result: unknown } | null => successOf(results[i]);
  const big = (i: number): bigint | null => {
    const s = val(i);
    return s !== null && isBig(s.result) && s.result >= 0n ? s.result : null;
  };

  const statusS = val(0);
  const status = statusS === null ? null : parseStatusCode(statusS.result);
  const poolsS = val(1);
  const pools = poolsS === null ? null : bigPair(poolsS.result);
  const stakeH = big(2);
  const stakeA = big(3);
  const claimedS = val(4);
  const revH = big(5);
  const revA = big(6);
  const balance = big(9);
  const cap = big(10);
  const minReveals = big(11);

  if (status === null || pools === null || stakeH === null || stakeA === null) return null;
  if (claimedS === null || typeof claimedS.result !== "boolean") return null;
  if (revH === null || revA === null || balance === null) return null;
  if (cap === null || cap === 0n || minReveals === null || minReveals === 0n) return null;

  const scoresS = val(12);
  const scores = scoresS === null ? null : parseScores(scoresS.result);

  return {
    status,
    pools,
    stake: { human: stakeH, agent: stakeA },
    claimed: claimedS.result,
    reveals: { human: revH, agent: revA },
    consensus: { human: consensusRead(results[7]), agent: consensusRead(results[8]) },
    balance,
    cap,
    minReveals,
    ...(scores !== null ? { scores } : {}),
  };
}

/** The market view for a phase and a validated read: the single place that feeds `deriveMarket`. */
export function viewOfData(phase: Phase, data: MarketData): MarketView {
  return deriveMarket({
    phase,
    status: data.status,
    quorum: quorumOf(data.reveals.human, data.reveals.agent, data.minReveals),
    ready: { human: data.consensus.human.ready, agent: data.consensus.agent.ready },
    pools: data.pools,
  });
}

// ---- Transaction errors ----

const TX_ERRORS: Record<string, string> = {
  BetCapExceeded: "Over the per-address cap of 200 points per round (both sides together).",
  OutsideBetWindow: "The bet window is closed: bets are accepted only between the reveal end and the market end.",
  MarketCancelled: "The market is cancelled because a side is below the reveal quorum. Nothing was spent.",
  ConsensusNotReady: "The consensus paths are not frozen yet. Try again in a moment.",
  ZeroAmount: "The amount must be at least 1 point.",
  InsufficientBalance: "Not enough points for this bet.",
  NotClaimable: "The market is not final yet, so there is nothing to claim.",
  AlreadyClaimed: "You already claimed in this market.",
  NothingToClaim: "You have nothing to claim in this market.",
  UnknownRound: "This round does not exist.",
  NotSpender: "The market contract is not allowed to spend points. This is a deployment problem.",
};

/** Plain text for a contract revert by error name; anything unknown is a generic failure. */
export function describeTxError(errorName: string | undefined): string {
  if (errorName !== undefined && Object.hasOwn(TX_ERRORS, errorName)) return TX_ERRORS[errorName] as string;
  return "The transaction failed.";
}

/**
 * User-facing text for anything a transaction step can throw. A decoded contract revert uses its
 * error name; a wallet rejection says so; anything else gets viem's short message (never the full
 * message, which can embed RPC URLs), capped in length.
 */
export function txErrorText(e: unknown): string {
  if (e instanceof BaseError) {
    if (e.walk((x) => x instanceof UserRejectedRequestError)) return "The request was rejected in your wallet. Nothing was sent.";
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName) {
      return describeTxError(revert.data.errorName);
    }
    return `${describeTxError(undefined)} ${e.shortMessage}`.slice(0, 200);
  }
  return describeTxError(undefined);
}
