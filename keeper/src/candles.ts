// Real-candle builder. Pure integer arithmetic on samples that are already integer bp relative to P0.
import { isValid, type Candle, type Path } from "../../shared/score";

/** One OHLC bar from a market-data provider, in the provider's own price unit. Timestamps are SECONDS. */
export interface Bar {
  /** Bar open time, unix seconds. */
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * Adapter for an intraday market-data provider. The provider is an open decision (plan Task 0):
 * nothing in this repo implements it yet. All timestamps are unix SECONDS.
 */
export interface CandleSource {
  bars(ticker: string, fromTs: number, toTs: number, intervalSec: number): Promise<Bar[]>;
}

/** One price sample: `t` is unix SECONDS, `p` is an integer in bp relative to P0 (see `toBps`). */
export interface Sample {
  t: number;
  p: number;
}

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
/** Anything above this is certainly a millisecond timestamp (year 5138 in seconds). */
const MAX_SECONDS_TS = 100_000_000_000;
const MIN_LAST_SAMPLES = 5;

/**
 * Builds the 3 real candles from samples.
 *
 * `samples[].p` MUST already be integer bp relative to P0 (convert with `toBps(price, p0)` first, so the
 * conversion has exactly one place and this function never sees a float). Candle `i` (0-based) covers the
 * half-open interval `[startTs + i*intervalSec, startTs + (i+1)*intervalSec)`; samples outside the three
 * intervals are ignored.
 *
 * - `close` = round(mean of the last 5 samples of the interval, ordered by `t`). The sum is an integer and
 *   the divisor is 5, so the fraction is .0/.2/.4/.6/.8 and there is no rounding tie.
 * - `high`/`low` = max/min of the interval's samples, then WIDENED to include the candle's open and close,
 *   because `Arena.postCandles` requires `low <= min(open, close)` and `high >= max(open, close)`.
 *   `open_1 = P0 = 0 bp`; `open_i = close_(i-1)`. The mean of the last 5 samples of a candle can lie
 *   outside the next interval's sampled range, so widening is needed for every candle, not only the first.
 *
 * Throws (never silently produces a path) on: a non-integer, non-finite or non-int32 sample, a non-finite
 * `t`, a bad `startTs`/`intervalSec`, or an interval with fewer than 5 samples. Intervals are numbered
 * from 1 in error messages.
 */
export function buildCandles(samples: { t: number; p: number }[], startTs: number, intervalSec: number): Path {
  if (!Number.isSafeInteger(startTs) || startTs <= 0) throw new Error("buildCandles: startTs must be a positive integer");
  if (startTs > MAX_SECONDS_TS) throw new Error("buildCandles: startTs looks like milliseconds; timestamps are in seconds");
  if (!Number.isSafeInteger(intervalSec) || intervalSec <= 0) {
    throw new Error("buildCandles: intervalSec must be a positive integer (seconds)");
  }
  if (!Array.isArray(samples)) throw new Error("buildCandles: samples must be an array");
  for (const s of samples) {
    if (s === null || typeof s !== "object" || !Number.isFinite(s.t)) throw new Error("buildCandles: sample with a non-finite t");
    if (!Number.isSafeInteger(s.p) || s.p < INT32_MIN || s.p > INT32_MAX) {
      throw new Error("buildCandles: sample p must be an integer bp within int32 (convert with toBps first)");
    }
  }

  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const out: Candle[] = [];
  let open = 0; // open_1 = P0 = 0 bp
  for (let i = 0; i < 3; i++) {
    const from = startTs + i * intervalSec;
    const to = from + intervalSec;
    const inside = sorted.filter((s) => s.t >= from && s.t < to);
    if (inside.length < MIN_LAST_SAMPLES) {
      throw new Error(`buildCandles: interval ${i + 1} has ${inside.length} samples, need at least ${MIN_LAST_SAMPLES}`);
    }
    let sum = 0n;
    for (const s of inside.slice(-MIN_LAST_SAMPLES)) sum += BigInt(s.p);
    const close = Number(roundDiv(sum, BigInt(MIN_LAST_SAMPLES)));
    let high = Math.max(open, close);
    let low = Math.min(open, close);
    for (const s of inside) {
      if (s.p > high) high = s.p;
      if (s.p < low) low = s.p;
    }
    out.push({ close, high, low });
    open = close;
  }
  const path = [out[0] as Candle, out[1] as Candle, out[2] as Candle] as const;
  if (!isValid(path)) throw new Error("buildCandles: internal error, built candles are not valid");
  return path;
}

/** round-half-up of a / b for b > 0 (a may be negative), integer only. */
function roundDiv(a: bigint, b: bigint): bigint {
  const twice = 2n * a + b;
  const d = 2n * b;
  // floor(twice / d) with floor toward -infinity
  let q = twice / d;
  if (twice % d !== 0n && twice < 0n) q -= 1n;
  return q;
}
