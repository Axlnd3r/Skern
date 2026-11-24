// Tolerance T and price -> basis-point conversion for the keeper.
// Floats are used only to turn a price into an integer bp once (`toBps`). Everything after that
// (moves, median, x1.5, ceil) is exact integer arithmetic, so a result like 15 can never become 16
// through `ceil(15.000000000000002)`.

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const UINT32_MAX = 4294967295;

/**
 * round((price - p0) / p0 * 10000) as an integer bp. Rounds half toward +infinity (`Math.round`).
 * Throws on a non-finite input, p0 <= 0, or a result outside int32. Never returns -0.
 */
export function toBps(price: number, p0: number): number {
  if (!Number.isFinite(price) || !Number.isFinite(p0)) throw new Error("toBps: price and p0 must be finite");
  if (p0 <= 0) throw new Error("toBps: p0 must be > 0");
  const bps = Math.round(((price - p0) / p0) * 10000);
  if (!Number.isFinite(bps) || bps < INT32_MIN || bps > INT32_MAX) throw new Error("toBps: result outside int32");
  return bps === 0 ? 0 : bps; // normalise -0
}

/**
 * Tolerance T in bp: median of the absolute close-to-close moves, times 1.5, ceil, at least 1.
 *
 * - Each move is `|toBps(close[i], close[i-1])|`, an integer bp relative to the previous close.
 * - Odd number of moves: the median is the middle move m, T = ceil(3m / 2) = floor((3m + 1) / 2).
 * - Even number of moves: the median is the mean of the two middle moves a and b, which can be a half
 *   integer. It is NOT rounded before the x1.5: T = ceil(3(a+b) / 4) = floor((3(a+b) + 3) / 4).
 * - T = max(1, T); throws if T does not fit uint32 (what `Arena.openRound` takes).
 */
export function computeT(closes: number[]): number {
  if (!Array.isArray(closes) || closes.length < 2) throw new Error("computeT: need at least 2 closes");
  for (const c of closes) {
    if (!Number.isFinite(c) || c <= 0) throw new Error("computeT: closes must be finite and > 0");
  }
  const moves: bigint[] = [];
  for (let i = 1; i < closes.length; i++) {
    const m = toBps(closes[i] as number, closes[i - 1] as number);
    moves.push(BigInt(Math.abs(m)));
  }
  moves.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const n = moves.length;
  let t: bigint;
  if (n % 2 === 1) {
    const m = moves[(n - 1) / 2] as bigint;
    t = (3n * m + 1n) / 2n;
  } else {
    const a = moves[n / 2 - 1] as bigint;
    const b = moves[n / 2] as bigint;
    t = (3n * (a + b) + 3n) / 4n;
  }
  if (t < 1n) t = 1n;
  if (t > BigInt(UINT32_MAX)) throw new Error("computeT: T exceeds uint32");
  return Number(t);
}
