// Price feed plumbing between a market-data provider and the keeper: the one p0 scale, bars -> real candles,
// bars -> (P0, T) for a new round, a labeled replay wrapper, and the licence-safe source URL.
//
// P0 SCALE (the only one): the on-chain `p0` is `round(price * 1_000_000)` (price in micro-units of the quote
// currency, a plain uint256). `toBps` takes a float p0, so the keeper converts once with `p0ToFloat`
// (`Number(p0) / 1e6`) and everything after `toBps` is integer bp. The contract never interprets p0.
//
// Licensing: provider data may not be redistributed. Only integer bp moves relative to P0 leave this module
// (candles, T). Raw prices are never logged and never put into a source URL.
import { toBps, computeT } from "./t";
import { buildCandles, type Bar, type CandleSource } from "./candles";
import type { RoundConfig } from "./rounds";
import type { Path } from "../../shared/score";

export const P0_SCALE = 1_000_000n;
const P0_SCALE_NUM = 1_000_000;
/** Provider bars are one minute long; a sample is taken at the last second of the bar (its close). */
export const BAR_SEC = 60;
/** A newest bar older than this means the market is closed or the feed is stale: do not open a round on it. */
const MAX_STALE_SEC = 600;

export class DataError extends Error {
  constructor(
    readonly code: "NO_DATA" | "STALE" | "BAD_DATA",
    message: string,
  ) {
    super(message);
    this.name = "DataError";
  }
}

/** A provider behind `CandleSource`, plus what the keeper needs to label the data it posted. */
export interface PriceFeed extends CandleSource {
  /** "live" = candles of the real current session; "replay" = historical candles shifted into the present. */
  readonly mode: "live" | "replay";
  /** Generic attribution page of the provider (no symbol, no prices). */
  readonly attributionBase: string;
  /** Extra query parameters of the attribution URL (for example `feed=iex`). No prices, no symbols. */
  readonly attributionParams: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------------------------- p0 scale

/** Price (float, provider unit) -> on-chain p0. Throws on a non-finite or non-positive price. */
export function priceToP0(price: number): bigint {
  if (!Number.isFinite(price) || price <= 0) throw new DataError("BAD_DATA", "price must be finite and > 0");
  const scaled = Math.round(price * P0_SCALE_NUM);
  if (!Number.isSafeInteger(scaled) || scaled < 1) throw new DataError("BAD_DATA", "price out of range for the p0 scale");
  return BigInt(scaled);
}

/** On-chain p0 -> float for `toBps`. Throws if it cannot be represented exactly. */
export function p0ToFloat(p0: bigint): number {
  if (typeof p0 !== "bigint" || p0 < 1n || p0 > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DataError("BAD_DATA", "p0 must be a bigint in 1..2^53-1");
  }
  return Number(p0) / P0_SCALE_NUM;
}

/** `bytes32` ticker -> string (trailing zero bytes stripped), the inverse of `stringToHex(t, {size: 32})`. */
export function tickerFromBytes32(b: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(b)) throw new Error("ticker must be 32 bytes of hex");
  const bytes = Buffer.from(b.slice(2), "hex");
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return bytes.subarray(0, end).toString("utf8");
}

// ---------------------------------------------------------------------------------------------- bars -> candles

function checkBar(b: Bar): void {
  if (!Number.isSafeInteger(b.t) || b.t <= 0) throw new DataError("BAD_DATA", "bar with a bad timestamp");
  for (const v of [b.open, b.high, b.low, b.close]) {
    if (!Number.isFinite(v) || v <= 0) throw new DataError("BAD_DATA", "bar with a non-positive or non-finite price");
  }
  if (b.high < Math.max(b.open, b.close) || b.low > Math.min(b.open, b.close)) {
    throw new DataError("BAD_DATA", "bar whose high/low do not contain its open and close");
  }
}

/**
 * The three real candles of a round from one-minute bars. `p0` is the on-chain value of THIS round and
 * `startTs` its `marketEnd`: callers must take both from the same `getRound(id)` result.
 *
 * Each bar contributes one sample (its close, at the last second of the minute) to `buildCandles`, which
 * takes `close` = mean of the last 5 samples of the interval. The bar highs and lows then widen each
 * candle's high/low (widening keeps the path valid). An interval with fewer than 5 bars is NO_DATA: the
 * keeper never fills gaps or invents a candle.
 */
export function barsToCandles(bars: readonly Bar[], p0: bigint, startTs: number, intervalSec: number): Path {
  const p0f = p0ToFloat(p0);
  if (startTs % BAR_SEC !== 0 || intervalSec % BAR_SEC !== 0) {
    throw new DataError("BAD_DATA", "the candle window is not aligned to the one-minute bar grid");
  }
  const end = startTs + 3 * intervalSec;
  const inside = bars.filter((b) => b.t >= startTs && b.t + BAR_SEC <= end);
  for (const b of inside) checkBar(b);
  const samples = inside.map((b) => ({ t: b.t + BAR_SEC - 1, p: toBps(b.close, p0f) }));
  let path: Path;
  try {
    path = buildCandles(samples, startTs, intervalSec);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/^buildCandles: interval \d+ has \d+ samples/.test(msg)) throw new DataError("NO_DATA", msg);
    throw e;
  }
  const widened = path.map((c, i) => {
    const from = startTs + i * intervalSec;
    const to = from + intervalSec;
    let high = c.high;
    let low = c.low;
    for (const b of inside) {
      if (b.t < from || b.t >= to) continue;
      high = Math.max(high, toBps(b.high, p0f));
      low = Math.min(low, toBps(b.low, p0f));
    }
    return { close: c.close, high, low };
  });
  return [widened[0], widened[1], widened[2]] as unknown as Path;
}

/** Close of the last bar of every COMPLETE `intervalSec` bucket before `now`, oldest first. */
export function closesPerInterval(bars: readonly Bar[], intervalSec: number, now: number): number[] {
  const byBucket = new Map<number, Bar>();
  for (const b of [...bars].sort((x, y) => x.t - y.t)) {
    const start = Math.floor(b.t / intervalSec) * intervalSec;
    if (start + intervalSec > now) continue; // partial bucket
    byBucket.set(start, b);
  }
  return [...byBucket.keys()].sort((a, b) => a - b).map((k) => (byBucket.get(k) as Bar).close);
}

// ---------------------------------------------------------------------------------------------- planning a round

export interface RoundTemplate {
  ticker: string;
  candleSec: number;
  commitSec: number;
  revealSec: number;
  marketSec: number;
  /** Delay between `now` and the start of the commit window (the open transaction lands a block or two later). */
  leadSec: number;
  /** `marketEnd` is rounded up to a multiple of this (default 60, the bar length) by lengthening the commit window. */
  alignSec?: number;
  /** `settleDeadline = marketEnd + 3*candleSec + settleGraceSec`. */
  settleGraceSec: number;
  entryStake: bigint;
  /** How much history to fetch for T (default `24 * candleSec`). */
  historySec?: number;
  /** Fewest complete candle closes needed for T (default 4). */
  minCloses?: number;
}

/** The four absolute timestamps (unix seconds) of a round opened at chain time `now`. */
export function roundTimes(t: RoundTemplate, now: number): Pick<RoundConfig, "commitEnd" | "revealEnd" | "marketEnd" | "settleDeadline"> {
  let commitEnd = now + t.leadSec + t.commitSec;
  // Candle 1 opens at marketEnd and the provider's bars sit on a minute grid: unless marketEnd is a multiple of
  // the bar length, every candle would own one whole bar less (4 instead of 5 in a 5-minute candle) and could
  // never be built. The commit window absorbs the padding (so it lasts commitSec to commitSec + 59 s); the
  // reveal and market windows keep their exact length.
  const align = t.alignSec ?? BAR_SEC;
  const rem = (commitEnd + t.revealSec + t.marketSec) % align;
  if (rem !== 0) commitEnd += align - rem;
  const revealEnd = commitEnd + t.revealSec;
  const marketEnd = revealEnd + t.marketSec;
  return { commitEnd, revealEnd, marketEnd, settleDeadline: marketEnd + 3 * t.candleSec + t.settleGraceSec };
}

/**
 * Builds the config of the next round from recent bars: P0 = close of the newest bar (must be fresh),
 * T = `computeT` over the closes of the complete `candleSec` intervals. Throws `DataError` when there is no
 * usable data (nothing is opened then).
 */
export async function planRound(t: RoundTemplate, feed: PriceFeed, now: number): Promise<RoundConfig> {
  const history = t.historySec ?? 24 * t.candleSec;
  const bars = await feed.bars(t.ticker, now - history, now, BAR_SEC);
  if (bars.length === 0) throw new DataError("NO_DATA", "the feed returned no bars; not opening a round");
  for (const b of bars) checkBar(b);
  const sorted = [...bars].sort((a, b) => a.t - b.t);
  const newest = sorted[sorted.length - 1] as Bar;
  if (now - newest.t > MAX_STALE_SEC) throw new DataError("STALE", "the newest bar is too old (market closed?); not opening a round");
  const closes = closesPerInterval(sorted, t.candleSec, now);
  const need = t.minCloses ?? 4;
  if (closes.length < need) throw new DataError("NO_DATA", `only ${closes.length} complete candle closes, need ${need}; not opening a round`);
  return {
    ticker: t.ticker,
    p0: priceToP0(newest.close),
    T: computeT(closes),
    candleSec: t.candleSec,
    entryStake: t.entryStake,
    ...roundTimes(t, now),
  };
}

// ---------------------------------------------------------------------------------------------- source URL, replay

/**
 * The `sourceUrl` handed to `postCandles` (its keccak is the on-chain `sourceHash`). Generic attribution:
 * provider page, feed, mode and the time window; no symbol and no price, so no provider data is republished.
 */
export function sourceUrlFor(feed: PriceFeed, fromTs: number, toTs: number): string {
  const q = new URLSearchParams({ ...feed.attributionParams, mode: feed.mode, from: String(fromTs), to: String(toTs) });
  return `${feed.attributionBase}?${q.toString()}`;
}

/**
 * Serves historical bars as if they were current: a request for `[from, to)` is answered with the bars of
 * `[from - offsetSec, to - offsetSec)`, timestamps shifted forward by `offsetSec`. Used to run labeled "replay"
 * demo rounds outside the US session. The mode and the offset appear in `sourceUrlFor`.
 */
export function replayFeed(inner: PriceFeed, offsetSec: number): PriceFeed {
  if (!Number.isSafeInteger(offsetSec) || offsetSec <= 0 || offsetSec % BAR_SEC !== 0) {
    throw new Error("replay offset must be a positive whole number of minutes, in seconds (it must keep the bar grid)");
  }
  return {
    mode: "replay",
    attributionBase: inner.attributionBase,
    attributionParams: { ...inner.attributionParams, replay_offset: String(offsetSec) },
    async bars(ticker, fromTs, toTs, intervalSec) {
      const bars = await inner.bars(ticker, fromTs - offsetSec, toTs - offsetSec, intervalSec);
      return bars.map((b) => ({ ...b, t: b.t + offsetSec }));
    },
  };
}
