// Shared pieces of the three house agents: the round context, integer-only path construction, and the list of
// known house addresses.
//
// Units. Every number is an int32 in basis points (bp) relative to P0, the price at the round's open, exactly like
// a path on chain. A path field index is `candle*3 + {0: close, 1: high, 2: low}`; candle 1 opens at P0 (0 bp) and
// each later candle opens at the previous close.
//
// No float ever reaches `isValid`: every field leaves this module through `repairPath`, which rounds, clamps to a
// bound derived from T, saturates to int32, and widens high and low to cover open and close, so the result is valid
// by construction (and is checked again by the callers that matter).
//
// Identifying house agents. The `{"role":"house"}` metadata is self-declared and anybody can register the same
// string, so the app must NEVER decide "house" from the metadata URI. It matches the committing address against a
// known list, loaded by `houseAddresses()` from the environment variable HOUSE_AGENT_ADDRESSES (comma-separated)
// and/or the JSON file named by HOUSE_AGENTS_FILE (an array of addresses). The operator fills that list with the
// addresses of the three house wallets, and the app calls `isHouseAgent(address, list)`.
import { readFileSync } from "node:fs";
import { getAddress, isAddress, type Address } from "viem";
import type { Candle, Path } from "../../../shared/score";

export type { Candle, Path } from "../../../shared/score";

/** Metadata every house agent registers with (see the note above: informational only). */
export const HOUSE_METADATA_URI = '{"role":"house"}';

export const INT32_MIN = -2147483648;
export const INT32_MAX = 2147483647;

/**
 * What a house agent knows about a round. Plain data: the keeper/data feed (Alpaca) supplies the history later and
 * tests inject it directly.
 */
export interface RoundContext {
  /** Stock symbol, informational (it goes into the LLM prompt after sanitising). */
  ticker: string;
  /** Tolerance in bp, as read from the round (`T`). Integers below 1 are treated as 1. */
  T: number;
  /** Number of candles to predict. Must be 3. */
  candleCount: number;
  /**
   * Recent real candles, OLDEST FIRST, in int32 bp relative to P0 (the same unit as a path: P0 is the price when
   * the round opens, so the newest close is about 0). Each candle is `{close, high, low}`. Entries with a missing
   * or non-finite field are ignored; the rest is rounded and saturated. May be empty.
   */
  recentCandlesBp: readonly Candle[];
  /** Optional recent headlines for the LLM agent (untrusted text). */
  headlines?: readonly string[];
}

// ---------------------------------------------------------------------------------------------- integers

function sanitizeT(T: unknown): number {
  return typeof T === "number" && Number.isInteger(T) && T >= 1 ? T : 1;
}

/** Largest absolute value any predicted field may take for a round with tolerance T: 10 * T, saturated to int32. */
export function maxAbsBp(T: number): number {
  return Math.min(10 * sanitizeT(T), INT32_MAX);
}

/** Rounds to an integer and clamps to [-cap, cap]. -0 becomes 0. NaN is the caller's problem (check first). */
export function clampInt(x: number, cap: number): number {
  const r = Math.round(x);
  return r > cap ? cap : r < -cap ? -cap : r + 0;
}

/** Round-half-away-from-zero division of integers (b > 0), exact for any safe integer. */
export function divRound(a: number, b: number): number {
  const A = BigInt(a);
  const B = BigInt(b);
  const q = A >= 0n ? (2n * A + B) / (2n * B) : -((-2n * A + B) / (2n * B));
  return Number(q);
}

/** Integer mean (rounded half away from zero) of integers; 0 for none. */
export function meanInt(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let s = 0n;
  for (const v of values) s += BigInt(v);
  const n = BigInt(values.length);
  const q = s >= 0n ? (2n * s + n) / (2n * n) : -((-2n * s + n) / (2n * n));
  return Number(q);
}

/** The history entries that are usable (finite fields), as int32 integers, oldest first, at most the last 50. */
export function cleanHistory(ctx: RoundContext): Candle[] {
  const src: unknown = ctx.recentCandlesBp;
  if (!Array.isArray(src)) return [];
  const out: Candle[] = [];
  for (const c of src.slice(-50) as (Candle | null | undefined)[]) {
    if (c === null || c === undefined || typeof c !== "object") continue;
    const { close, high, low } = c;
    if (![close, high, low].every((v) => typeof v === "number" && Number.isFinite(v))) continue;
    out.push({ close: clampInt(close, INT32_MAX), high: clampInt(high, INT32_MAX), low: clampInt(low, INT32_MAX) });
  }
  return out;
}

/** Throws unless the context asks for exactly 3 candles. */
export function assertContext(ctx: RoundContext): void {
  if (ctx === null || typeof ctx !== "object" || ctx.candleCount !== 3) throw new Error("house agents predict exactly 3 candles (candleCount must be 3)");
}

/**
 * A typical wick for rule-based paths: a quarter of the mean high-low range of the last 5 history candles,
 * at most T (0 without history).
 */
export function typicalWick(history: readonly Candle[], T: number): number {
  const last = history.slice(-5);
  const ranges = last.map((c) => Math.max(0, c.high - c.low));
  return Math.min(sanitizeT(T), Math.max(0, divRound(meanInt(ranges), 4)));
}

/**
 * The 9 raw numbers `[close1, high1, low1, close2, ...]` to a valid path. Every field is rounded, clamped to
 * +-maxAbsBp(T), then high is raised to max(open, close, high) and low lowered to min(open, close, low), where
 * open_1 = 0 and open_i = close_(i-1). The result satisfies `isValid` for any finite or infinite input.
 */
export function repairPath(nums: readonly number[], T: number): Path {
  if (!Array.isArray(nums) || nums.length !== 9) throw new Error("repairPath needs exactly 9 numbers");
  const cap = maxAbsBp(T);
  const out: Candle[] = [];
  let open = 0;
  for (let i = 0; i < 3; i++) {
    const close = clampInt(nums[i * 3] as number, cap);
    const high = Math.max(clampInt(nums[i * 3 + 1] as number, cap), open, close);
    const low = Math.min(clampInt(nums[i * 3 + 2] as number, cap), open, close);
    out.push({ close, high, low });
    open = close;
  }
  return out as unknown as Path;
}

/** Closes plus one symmetric wick on every candle to a valid path. */
export function pathFromCloses(closes: readonly [number, number, number], wick: number, T: number): Path {
  const cap = maxAbsBp(T);
  const w = Math.max(0, clampInt(wick, cap));
  const nums: number[] = [];
  let open = 0;
  for (const raw of closes) {
    const close = clampInt(raw, cap);
    nums.push(close, Math.max(open, close) + w, Math.min(open, close) - w);
    open = close;
  }
  return repairPath(nums, T);
}

// ---------------------------------------------------------------------------------------------- house addresses

/**
 * The known house addresses (checksummed, de-duplicated, order of first appearance): HOUSE_AGENT_ADDRESSES
 * (comma-separated) followed by the entries of the JSON array file HOUSE_AGENTS_FILE. Anything malformed throws,
 * never silently dropped: a missing house label is a transparency bug.
 */
export function houseAddresses(env: Record<string, string | undefined> = process.env): Address[] {
  const out: Address[] = [];
  const add = (raw: unknown, source: string): void => {
    if (typeof raw !== "string" || !isAddress(raw.trim(), { strict: false })) throw new Error(`${source}: not a valid address`);
    const a = getAddress(raw.trim());
    if (!out.includes(a)) out.push(a);
  };
  const fromEnv = env.HOUSE_AGENT_ADDRESSES;
  if (fromEnv) {
    for (const part of fromEnv.split(",")) {
      if (part.trim() === "") continue;
      add(part, "HOUSE_AGENT_ADDRESSES");
    }
  }
  const file = env.HOUSE_AGENTS_FILE;
  if (file) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new Error(`HOUSE_AGENTS_FILE: cannot read a JSON array from ${file} (${e instanceof Error ? e.name : "error"})`);
    }
    if (!Array.isArray(parsed)) throw new Error("HOUSE_AGENTS_FILE: the file must hold a JSON array of addresses");
    for (const item of parsed) add(item, "HOUSE_AGENTS_FILE");
  }
  return out;
}

/** True iff `who` is in the known list (case-insensitive). The metadata URI is never consulted. */
export function isHouseAgent(who: string, list: readonly Address[]): boolean {
  if (typeof who !== "string" || !isAddress(who, { strict: false })) return false;
  const a = getAddress(who);
  return list.some((x) => x === a);
}
