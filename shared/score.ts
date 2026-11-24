// Integer scoring of a predicted 3-candle path against a real one.
// Mirrors contracts/src/ScoreLib.sol operation for operation (bigint only, no float).
// The two implementations are tied by contracts/test/vectors/score.json.

/** One candle in int32 basis points relative to P0. The open is implicit: open_1 = 0, open_i = close_(i-1). */
export interface Candle {
  readonly close: number;
  readonly high: number;
  readonly low: number;
}

export type Path = readonly [Candle, Candle, Candle];

const ONE = 10000n;

function abs(x: bigint): bigint {
  return x >= 0n ? x : -x;
}

/** 10000 - min(10000, x) */
function complement(x: bigint): bigint {
  return x >= ONE ? 0n : ONE - x;
}

function sign(x: bigint): bigint {
  return x > 0n ? 1n : x < 0n ? -1n : 0n;
}

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

function isInt32(x: unknown): boolean {
  return typeof x === "number" && Number.isInteger(x) && x >= INT32_MIN && x <= INT32_MAX;
}

/** Runtime shape check: exactly 3 candles, every field an integer within int32 (what ScoreLib can receive). */
function isWellFormed(p: readonly Candle[]): boolean {
  if (!Array.isArray(p) || p.length !== 3) return false;
  // Explicit indices, not `every`: `every` skips holes, so `new Array(3)` would pass and later throw a TypeError.
  for (let i = 0; i < 3; i++) {
    const c = p[i];
    if (c === null || c === undefined || typeof c !== "object") return false;
    if (!isInt32(c.close) || !isInt32(c.high) || !isInt32(c.low)) return false;
  }
  return true;
}

/**
 * True iff every candle satisfies low <= min(open, close) and high >= max(open, close).
 * Also false for anything ScoreLib could not be given: not exactly 3 candles, or a field outside int32.
 */
export function isValid(p: Path): boolean {
  if (!isWellFormed(p)) return false;
  let open = 0n;
  for (const c of p) {
    const close = BigInt(c.close);
    const high = BigInt(c.high);
    const low = BigInt(c.low);
    if (low > open || low > close) return false;
    if (high < open || high < close) return false;
    open = close;
  }
  return true;
}

/** s = 5*C + 2*R + 3*D for one candle. */
function candleScore(p: Candle, r: Candle, pOpen: bigint, rOpen: bigint, T: bigint): bigint {
  const c = complement((abs(BigInt(p.close) - BigInt(r.close)) * ONE) / T);
  const range = abs(BigInt(p.high) - BigInt(r.high)) + abs(BigInt(p.low) - BigInt(r.low));
  const rr = complement((range * ONE) / (2n * T));
  const ps = sign(BigInt(p.close) - pOpen);
  const rs = sign(BigInt(r.close) - rOpen);
  const d = ps === rs ? ONE : ps === 0n || rs === 0n ? ONE / 2n : 0n;
  return 5n * c + 2n * rr + 3n * d;
}

/** Integer score 0..100, normalised by T bp. Throws if T is not a positive uint32, or a path is not 3 int32 candles. */
export function score(pred: Path, real: Path, T: number): number {
  if (!isWellFormed(pred) || !isWellFormed(real)) throw new Error("path must be exactly 3 candles with int32 fields");
  // ScoreLib takes T as uint32: reject zero and anything above uint32.max.
  if (!Number.isInteger(T) || T <= 0 || T > 4294967295) throw new Error("T must be an integer in 1..2^32-1");
  const t = BigInt(T);
  let sum = 0n;
  let pOpen = 0n;
  let rOpen = 0n;
  for (let i = 0; i < 3; i++) {
    const p = pred[i] as Candle;
    const r = real[i] as Candle;
    sum += candleScore(p, r, pOpen, rOpen, t);
    pOpen = BigInt(p.close);
    rOpen = BigInt(r.close);
  }
  return Number((sum * 100n) / 300000n);
}
