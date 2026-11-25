import { useEffect, useMemo } from "react";
import { useBlock, useReadContract, useReadContracts } from "wagmi";
import { hexToString, type Hex } from "viem";
import { addresses, arenaAbi, BASE_SEPOLIA_CHAIN_ID } from "./chain";

export type Phase = "commit" | "reveal" | "market" | "play" | "settled" | "void";

/** Mirrors Arena.RoundParams. Times are unix seconds (block time), kept as bigint. */
export type RoundParams = {
  ticker: Hex;
  p0: bigint;
  T: number;
  commitEnd: bigint;
  revealEnd: bigint;
  marketEnd: bigint;
  candleSec: number;
  settleDeadline: bigint;
  entryStake: bigint;
};

/** On-chain status flags read from the Arena views `settled` and `isVoid`. */
export type RoundStatus = { settled: boolean; isVoid: boolean };

const NO_STATUS: RoundStatus = { settled: false, isVoid: false };

/** Candles can only be posted from `marketEnd + 3 * candleSec`; the play phase lasts until then. */
function playEnd(p: RoundParams): bigint {
  return p.marketEnd + 3n * BigInt(p.candleSec);
}

/**
 * Phase of a round at block time `now` (unix seconds). Mirrors the contract windows:
 * commit while now < commitEnd, reveal while now < revealEnd, market while now < marketEnd,
 * then play until the keeper settles. `isVoid` is the contract `isVoid()` view and is
 * authoritative (it also covers a round nobody settled by `settleDeadline`); the clock alone
 * never yields "void".
 */
export function phaseAt(p: RoundParams, now: bigint, status: RoundStatus = NO_STATUS): Phase {
  if (status.isVoid) return "void";
  if (status.settled) return "settled";
  if (now < p.commitEnd) return "commit";
  if (now < p.revealEnd) return "reveal";
  if (now < p.marketEnd) return "market";
  return "play";
}

/** Whole seconds until the current phase ends (0 in terminal phases or once the boundary passed). */
export function countdownAt(p: RoundParams, now: bigint, phase: Phase): number {
  let end: bigint;
  switch (phase) {
    case "commit":
      end = p.commitEnd;
      break;
    case "reveal":
      end = p.revealEnd;
      break;
    case "market":
      end = p.marketEnd;
      break;
    case "play":
      end = playEnd(p);
      break;
    default:
      return 0;
  }
  const left = end - now;
  return left > 0n ? Number(left) : 0;
}

/** Decodes the bytes32 ticker for display. Chain data is untrusted: keep only a safe character set. */
export function tickerLabel(ticker: Hex): string {
  let raw: string;
  try {
    raw = hexToString(ticker, { size: 32 });
  } catch {
    return "?";
  }
  const clean = raw.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 16);
  return clean.length > 0 ? clean : "?";
}

const isBig = (v: unknown): v is bigint => typeof v === "bigint";
const isU32 = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xffffffff;

/** Validates a `getRound` result. Returns null for anything malformed or with inconsistent timing. */
export function parseRoundParams(raw: unknown): RoundParams | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const { ticker, p0, T, commitEnd, revealEnd, marketEnd, candleSec, settleDeadline, entryStake } = r;
  if (typeof ticker !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(ticker)) return null;
  if (!isBig(p0) || !isU32(T) || !isU32(candleSec) || !isBig(entryStake)) return null;
  if (!isBig(commitEnd) || !isBig(revealEnd) || !isBig(marketEnd) || !isBig(settleDeadline)) return null;
  if (T === 0 || candleSec === 0) return null;
  // The contract enforces this ordering at openRound; a violation means the data is not a round.
  if (!(commitEnd < revealEnd && revealEnd < marketEnd)) return null;
  if (settleDeadline <= marketEnd + 3n * BigInt(candleSec)) return null;
  return { ticker: ticker as Hex, p0, T, commitEnd, revealEnd, marketEnd, candleSec, settleDeadline, entryStake };
}

export type PhaseAction = { label: string; hint: string };

/** The phase-appropriate call to action shown on screen 1. */
export function actionFor(phase: Phase): PhaseAction {
  switch (phase) {
    case "commit":
      return { label: "Draw your path", hint: "Set 3 candles (close, high, low) before the commit window closes." };
    case "reveal":
      return { label: "Reveal your path", hint: "Reveal the path you committed, or the entry is forfeited." };
    case "market":
      return { label: "Open the market", hint: "Market window: bets open only if both sides reached the 3-reveal quorum." };
    case "play":
      return { label: "Watch the candles", hint: "Real candles arrive after the last candle closes." };
    case "settled":
      return { label: "See your result", hint: "Scores are final. Claim your points." };
    case "void":
      return { label: "Claim your refund", hint: "This round did not settle. Your entry stake is refundable." };
  }
}

/** Seconds before a phase boundary at which the UI warns that the window is about to close. */
export const CLOSING_THRESHOLD_SEC = 6;

/**
 * True in a timed phase (commit, reveal, market) when `countdownSec` is at or below the threshold.
 * The clock is the latest block while a transaction lands in a later block (~2s on Base), so an
 * action started in the last seconds can still revert with a closed-window error.
 */
export function isClosing(phase: Phase, countdownSec: number): boolean {
  if (phase !== "commit" && phase !== "reveal" && phase !== "market") return false;
  return countdownSec <= CLOSING_THRESHOLD_SEC;
}

/** Validates the `settled` and `isVoid` view results. Returns null unless both are booleans. */
export function parseStatus(settled: unknown, isVoid: unknown): RoundStatus | null {
  if (typeof settled !== "boolean" || typeof isVoid !== "boolean") return null;
  return { settled, isVoid };
}

export type RoundView = {
  status: "unconfigured" | "loading" | "error" | "ready";
  params: RoundParams | undefined;
  phase: Phase | undefined;
  countdownSec: number | undefined;
  /** True when the current timed phase ends within `CLOSING_THRESHOLD_SEC`. */
  closing: boolean;
  /** Latest block timestamp (unix seconds): the clock source. */
  blockTime: bigint | undefined;
};

/**
 * Pure derivation of the round view from the three raw reads (`getRound`, `settled`, `isVoid`) and the
 * latest block time. Returns "loading" without data and "error" for malformed chain data.
 */
export function deriveRound(
  reads: readonly [unknown, unknown, unknown] | undefined,
  blockTime: bigint | undefined,
): RoundView {
  const none = { params: undefined, phase: undefined, countdownSec: undefined, closing: false, blockTime };
  if (!reads || blockTime === undefined) return { status: "loading", ...none };
  const params = parseRoundParams(reads[0]);
  const flags = parseStatus(reads[1], reads[2]);
  if (params === null || flags === null) return { status: "error", ...none };
  const phase = phaseAt(params, blockTime, flags);
  const countdownSec = countdownAt(params, blockTime, phase);
  return { status: "ready", params, phase, countdownSec, closing: isClosing(phase, countdownSec), blockTime };
}

const arena = addresses.arena;
const chainId = BASE_SEPOLIA_CHAIN_ID;

/** Latest round id (`roundCount`), or undefined while loading or when there is no round yet. */
export function useLatestRoundId(): { id: bigint | undefined; loading: boolean; unconfigured: boolean } {
  const q = useReadContract({
    address: arena,
    abi: arenaAbi,
    functionName: "roundCount",
    chainId,
    query: { enabled: arena !== undefined, refetchInterval: 10_000 },
  });
  const count = typeof q.data === "bigint" ? q.data : undefined;
  return {
    id: count !== undefined && count > 0n ? count : undefined,
    loading: arena !== undefined && q.isPending,
    unconfigured: arena === undefined,
  };
}

/**
 * Round state for screen 1. The clock is the latest block timestamp, not `Date.now()`. A transaction
 * lands in a later block (~2s on Base Sepolia), so the phase shown can lag the phase the contract
 * applies at execution; `closing` flags the last seconds of a window for that reason. Status flags
 * come from the contract views `settled(id)` and `isVoid(id)`. Cached data wins over a transient
 * refetch error: the error status is shown only when there is nothing to display.
 */
export function useRound(id: bigint | undefined): RoundView {
  const enabled = arena !== undefined && id !== undefined;
  const block = useBlock({ chainId, watch: true, query: { enabled: arena !== undefined } });
  const reads = useReadContracts({
    allowFailure: false,
    contracts: [
      { address: arena, abi: arenaAbi, functionName: "getRound", args: [id ?? 0n], chainId },
      { address: arena, abi: arenaAbi, functionName: "settled", args: [id ?? 0n], chainId },
      { address: arena, abi: arenaAbi, functionName: "isVoid", args: [id ?? 0n], chainId },
    ],
    query: { enabled },
  });

  // Re-read the status flags whenever a new block arrives.
  const blockNumber = block.data?.number;
  const { refetch } = reads;
  useEffect(() => {
    if (enabled && blockNumber !== undefined) void refetch();
  }, [enabled, blockNumber, refetch]);

  const blockTime = block.data?.timestamp;
  const readsData = reads.data as readonly [unknown, unknown, unknown] | undefined;
  const failed = reads.isError || block.isError;

  return useMemo<RoundView>(() => {
    if (arena === undefined) {
      return {
        status: "unconfigured",
        params: undefined,
        phase: undefined,
        countdownSec: undefined,
        closing: false,
        blockTime,
      };
    }
    const view = deriveRound(readsData, blockTime);
    // Prefer cached data; surface a read error only when there is nothing to show.
    if (view.status === "loading" && failed) return { ...view, status: "error" };
    return view;
  }, [failed, readsData, blockTime]);
}

/** Formats whole seconds as H:MM:SS (or M:SS under an hour). */
export function formatCountdown(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

export const PHASES: readonly Phase[] = ["commit", "reveal", "market", "play", "settled"];
