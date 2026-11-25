// Pure helpers for the draw screen: 9 handles <-> a 3-candle path that is valid by construction.
//
// Units: every handle is an integer in basis points relative to P0 (int32). The open of candle 1 is
// P0 (0 bp) and the open of candle i is the close of candle i-1, so the path carries no opens.
// Handle index = candle * 3 + {0: close, 1: high, 2: low}.
//
// Nothing here is a scoring implementation: validity and score come from shared/score.ts. The only
// non-integer math is the pixel <-> bp mapping at the bottom, which is display geometry; it always
// returns integers before anything reaches handlesToPath, isValid or score.

import { isValid, type Candle, type Path } from "../../../shared/score";
import type { Phase } from "./round";

export type Handle = number;
/** Exactly 9 handles: close, high, low for each of the 3 candles. */
export type Handles = readonly Handle[];

/** Proposed value for a handle plus the chart bounds in bp (both inclusive, and min <= 0 <= max). */
export type HandleCtx = { value: number; min: number; max: number };

export type Field = "close" | "high" | "low";

export const HANDLE_COUNT = 9;
export const CANDLE_COUNT = 3;
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

export const FLAT_HANDLES: Handles = Object.freeze([0, 0, 0, 0, 0, 0, 0, 0, 0]);

const FIELD_OFFSET: Record<Field, number> = { close: 0, high: 1, low: 2 };

export function handleIndex(candle: number, field: Field): number {
  return candle * 3 + FIELD_OFFSET[field];
}

/** The flat baseline: the price stays at P0, so every field of every candle is 0 bp. */
export function flatBaseline(): Path {
  const flat: Candle = { close: 0, high: 0, low: 0 };
  return [{ ...flat }, { ...flat }, { ...flat }];
}

/** Rounds to an integer within int32. NaN becomes 0; +-Infinity saturates; never returns -0. */
function toInt32(v: number): number {
  if (Number.isNaN(v)) return 0;
  const r = Math.round(v);
  return (r > INT32_MAX ? INT32_MAX : r < INT32_MIN ? INT32_MIN : r) + 0;
}

function assertNine(h: Handles): void {
  if (!Array.isArray(h) || h.length !== HANDLE_COUNT) throw new Error("expected exactly 9 handles");
}

/**
 * Makes any 9 numbers a valid path: integers within int32, then each high is raised to at least
 * max(open, close) and each low lowered to at most min(open, close). Valid input is returned unchanged.
 */
export function normalizeHandles(h: Handles): number[] {
  assertNine(h);
  const out: number[] = new Array<number>(HANDLE_COUNT).fill(0);
  let open = 0;
  for (let c = 0; c < CANDLE_COUNT; c++) {
    const close = toInt32(h[c * 3] as number);
    const high = toInt32(h[c * 3 + 1] as number);
    const low = toInt32(h[c * 3 + 2] as number);
    out[c * 3] = close;
    out[c * 3 + 1] = Math.max(high, open, close);
    out[c * 3 + 2] = Math.min(low, open, close);
    open = close;
  }
  return out;
}

/** 9 handles -> 3 candles. The output always passes `isValid` (invalid raw handles are repaired). */
export function handlesToPath(h: Handles): Path {
  const n = normalizeHandles(h);
  const candle = (c: number): Candle => ({ close: n[c * 3] as number, high: n[c * 3 + 1] as number, low: n[c * 3 + 2] as number });
  return [candle(0), candle(1), candle(2)];
}

/** Integer bounds of the chart, validated: finite, within int32 and containing P0 (0 bp). */
function bounds(ctx: { min: number; max: number }): { lo: number; hi: number } {
  if (!Number.isFinite(ctx.min) || !Number.isFinite(ctx.max)) throw new Error("bounds must be finite");
  const lo = Math.max(INT32_MIN, Math.ceil(ctx.min));
  const hi = Math.min(INT32_MAX, Math.floor(ctx.max));
  if (!(lo <= 0 && 0 <= hi)) throw new Error("bounds must contain 0 bp");
  return { lo, hi };
}

/**
 * The value a handle may take when dragged to `ctx.value`, other handles fixed:
 * - close: anywhere in the chart bounds (moveHandle then widens the high/low that depend on it),
 * - high: at least max(open, close) of its candle,
 * - low: at most min(open, close) of its candle.
 * A non-finite proposal keeps the current value. The result is an integer within the bounds and int32.
 */
export function clampHandle(h: Handles, index: number, ctx: HandleCtx): number {
  assertNine(h);
  if (!Number.isInteger(index) || index < 0 || index >= HANDLE_COUNT) throw new Error("handle index out of range");
  const { lo, hi } = bounds(ctx);
  const n = normalizeHandles(h);
  const candle = Math.floor(index / 3);
  const open = candle === 0 ? 0 : (n[(candle - 1) * 3] as number);
  const close = n[candle * 3] as number;
  const field = index % 3;
  const proposed = Number.isFinite(ctx.value) ? toInt32(ctx.value) : (n[index] as number);

  let floor = lo;
  let ceil = hi;
  if (field === 1) floor = Math.max(lo, open, close);
  if (field === 2) ceil = Math.min(hi, open, close);
  // The validity bound wins if the chart bounds and the validity rule ever disagree.
  return (field === 2 ? Math.min(ceil, Math.max(proposed, lo)) : Math.max(floor, Math.min(proposed, ceil))) + 0;
}

/**
 * Applies a drag: sets the clamped value, then repairs the handles that depend on it. Moving a close
 * changes the next candle's open, so the highs/lows of that candle (and its own) are widened. The
 * result is always a valid, integer, in-bounds handle set.
 */
export function moveHandle(h: Handles, index: number, ctx: HandleCtx): number[] {
  const value = clampHandle(h, index, ctx);
  const next = normalizeHandles(h);
  next[index] = value;
  return normalizeHandles(next);
}

/** Chart half-range in bp: 5 * T, at least 1 and within int32. T is the round tolerance in bp. */
export function boundsForT(T: number): number {
  const t = Number.isFinite(T) && T > 0 ? Math.floor(T) : 0;
  return Math.min(INT32_MAX, Math.max(1, 5 * t));
}

export type CommitGuardInput = {
  path: Path;
  phase: Phase;
  closing: boolean;
  /** True for the practice round shown when no live round is readable. Never committable. */
  simulated: boolean;
  connected: boolean;
};

export type CommitGuard = { ok: true } | { ok: false; reason: string };

/** The single gate for the Commit button. `isValid` is the shared check, run on the exact path to be committed. */
export function commitGuard(i: CommitGuardInput): CommitGuard {
  if (i.simulated) return { ok: false, reason: "Practice mode: this is not a live round." };
  if (!isValid(i.path)) return { ok: false, reason: "The path is not valid." };
  if (i.phase !== "commit") return { ok: false, reason: "The commit window is not open." };
  if (i.closing) return { ok: false, reason: "The commit window is closing. A transaction would land too late." };
  if (!i.connected) return { ok: false, reason: "Connect your wallet to commit." };
  return { ok: true };
}

// ---- Display geometry (pixels <-> bp). Floats stay here; outputs are integers. ----

/** y pixel (0 = top) of a bp value for a chart `height` tall showing -bound..+bound. */
export function bpToY(bp: number, height: number, bound: number): number {
  return ((bound - bp) / (2 * bound)) * height;
}

/** Integer bp for a y pixel, clamped to -bound..+bound. */
export function yToBp(y: number, height: number, bound: number): number {
  if (!(height > 0) || !Number.isFinite(y)) return 0;
  const bp = Math.round(bound - (y / height) * 2 * bound);
  return Math.max(-bound, Math.min(bound, bp)) + 0;
}

/**
 * Shown when no live round is readable (no contract configured, loading, or an RPC error), so the
 * drawing tool can still be tried. It is simulated data: always labeled in the UI and never committable.
 */
export const PRACTICE_ROUND = { simulated: true, T: 100, phase: "commit", closing: false } as const;
