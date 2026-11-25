// Demo timing (README §3), the p0 scale, bars -> candles and the replay wrapper.
import { describe, expect, it } from "vitest";
import { validateRoundConfig } from "../src/rounds";
import { isValid } from "../../shared/score";
import {
  DEMO_CANDLE_SEC,
  DEMO_COMMIT_SEC,
  DEMO_MARKET_SEC,
  DEMO_REVEAL_SEC,
  demoTemplate,
} from "../src/demo";
import {
  DataError,
  barsToCandles,
  closesPerInterval,
  p0ToFloat,
  planRound,
  priceToP0,
  replayFeed,
  roundTimes,
  sourceUrlFor,
  tickerFromBytes32,
  type PriceFeed,
} from "../src/source";
import type { Bar } from "../src/candles";
import { stringToHex } from "viem";

const NOW = 1_800_000_000; // divisible by 60 and 300
const flat = (t: number, p: number): Bar => ({ t, open: p, high: p, low: p, close: p });

function feedOf(bars: Bar[], calls: { from: number; to: number }[] = []): PriceFeed {
  return {
    mode: "live",
    attributionBase: "https://alpaca.markets/data",
    attributionParams: { feed: "iex" },
    async bars(_t, from, to) {
      calls.push({ from, to });
      return bars.filter((b) => b.t >= from && b.t < to);
    },
  };
}

describe("demo round timing (README section 3)", () => {
  it("uses 5-minute candles and the windows commit 90 s, reveal 30 s, market 60 s", () => {
    expect([DEMO_CANDLE_SEC, DEMO_COMMIT_SEC, DEMO_REVEAL_SEC, DEMO_MARKET_SEC]).toEqual([300, 90, 30, 60]);
    const t = demoTemplate({ leadSec: 0 });
    expect(t.candleSec).toBe(300);
    const r = roundTimes(t, NOW);
    expect(r.commitEnd - NOW).toBe(90);
    expect(r.revealEnd - r.commitEnd).toBe(30);
    expect(r.marketEnd - r.revealEnd).toBe(60);
    // candle 1 opens at marketEnd, about 3 minutes after the open
    expect(r.marketEnd - NOW).toBe(180);
  });

  it("settleDeadline is strictly after marketEnd + 3*candleSec and the whole config passes the keeper checks", () => {
    const t = demoTemplate();
    const r = roundTimes(t, NOW);
    expect(r.settleDeadline).toBeGreaterThan(r.marketEnd + 3 * 300);
    validateRoundConfig(
      { ticker: "AAPL", p0: 123_456_700n, T: 15, candleSec: 300, entryStake: 10n, ...r },
      NOW,
    );
  });

  it("marketEnd lands on the minute grid by lengthening the commit window; reveal and market keep their exact length", () => {
    for (let lead = 0; lead < 120; lead += 7) {
      const t = demoTemplate({ leadSec: lead });
      const r = roundTimes(t, NOW + 13); // an unaligned "now" on purpose
      expect(r.marketEnd % 60).toBe(0);
      expect(r.revealEnd - r.commitEnd).toBe(30);
      expect(r.marketEnd - r.revealEnd).toBe(60);
      const commitWindow = r.commitEnd - (NOW + 13) - lead;
      expect(commitWindow).toBeGreaterThanOrEqual(90);
      expect(commitWindow).toBeLessThanOrEqual(90 + 59);
    }
  });

  it("an already aligned start is not padded", () => {
    expect(roundTimes(demoTemplate({ leadSec: 0 }), NOW).commitEnd - NOW).toBe(90);
  });

  it("timestamps are seconds, never milliseconds", () => {
    const r = roundTimes(demoTemplate(), NOW);
    for (const v of Object.values(r)) expect(v).toBeLessThan(10_000_000_000);
  });
});

describe("p0 scale and ticker", () => {
  it("on-chain p0 = round(price * 1e6) and converts back to the float toBps takes", () => {
    expect(priceToP0(123.4567)).toBe(123_456_700n);
    expect(p0ToFloat(123_456_700n)).toBeCloseTo(123.4567, 10);
    expect(priceToP0(0.000001)).toBe(1n);
  });

  it.each([0, -1, NaN, Infinity, 1e300])("priceToP0 rejects %s", (p) => {
    expect(() => priceToP0(p)).toThrow(DataError);
  });

  it("p0ToFloat rejects 0 and values that a float cannot hold exactly", () => {
    expect(() => p0ToFloat(0n)).toThrow(DataError);
    expect(() => p0ToFloat(2n ** 60n)).toThrow(DataError);
  });

  it("tickerFromBytes32 is the inverse of the bytes32 encoding used by openRound", () => {
    expect(tickerFromBytes32(stringToHex("AAPL", { size: 32 }))).toBe("AAPL");
    expect(() => tickerFromBytes32("0x1234")).toThrow();
  });
});

describe("barsToCandles", () => {
  const start = NOW + 180;
  const p0 = 123_456_700n; // 123.4567
  const L = [123.5802, 123.7654, 123.6419]; // +10, +25, +15 bp of p0
  const bars = (): Bar[] => {
    const out: Bar[] = [];
    for (let i = 0; i < 15; i++) {
      const lvl = L[Math.floor(i / 5)] as number;
      out.push({ t: start + i * 60, open: lvl, high: i === 6 ? lvl + 0.1235 : lvl, low: lvl, close: lvl });
    }
    return out;
  };

  it("builds three valid candles in bp relative to P0 and widens high/low with the bar extremes", () => {
    const path = barsToCandles(bars(), p0, start, 300);
    expect(isValid(path)).toBe(true);
    expect(path.map((c) => c.close)).toEqual([10, 25, 15]);
    // candle 1: open 0, close 10
    expect(path[0]).toEqual({ close: 10, high: 10, low: 0 });
    // candle 2: open 10 (previous close), bar 6 high = +10 bp above the level -> 35
    expect(path[1]).toEqual({ close: 25, high: 35, low: 10 });
    // candle 3: open 25, close 15
    expect(path[2]).toEqual({ close: 15, high: 25, low: 15 });
  });

  it("an interval with fewer than 5 bars is NO_DATA (nothing is invented or filled)", () => {
    const b = bars().filter((x) => x.t !== start + 7 * 60);
    expect(() => barsToCandles(b, p0, start, 300)).toThrow(expect.objectContaining({ code: "NO_DATA" }));
    expect(() => barsToCandles([], p0, start, 300)).toThrow(expect.objectContaining({ code: "NO_DATA" }));
  });

  it("a window that is not on the minute grid is BAD_DATA (4 whole bars per candle could never be enough)", () => {
    expect(() => barsToCandles(bars(), p0, start + 7, 300)).toThrow(expect.objectContaining({ code: "BAD_DATA" }));
    expect(() => barsToCandles(bars(), p0, start, 330 + 7)).toThrow(expect.objectContaining({ code: "BAD_DATA" }));
  });

  it("ignores bars outside the three intervals and a bar that straddles the end", () => {
    const extra = [flat(start - 60, 1), flat(start + 900, 999), flat(start + 870 + 30, 999)];
    const path = barsToCandles([...bars(), ...extra], p0, start, 300);
    expect(path.map((c) => c.close)).toEqual([10, 25, 15]);
  });

  it("rejects a bar whose high/low do not contain open and close", () => {
    const b = bars();
    b[3] = { t: b[3]!.t, open: 123.5, high: 123.4, low: 123.3, close: 123.5 };
    expect(() => barsToCandles(b, p0, start, 300)).toThrow(expect.objectContaining({ code: "BAD_DATA" }));
  });

  it("a price that is not a finite positive number is BAD_DATA", () => {
    const b = bars();
    b[0] = flat(b[0]!.t, Number.NaN);
    expect(() => barsToCandles(b, p0, start, 300)).toThrow(expect.objectContaining({ code: "BAD_DATA" }));
  });
});

describe("planRound", () => {
  const t = demoTemplate({ leadSec: 0 });
  const history = (price: (i: number) => number, newest = NOW - 60): Bar[] => {
    const out: Bar[] = [];
    for (let ts = NOW - 24 * 300; ts <= newest; ts += 60) out.push(flat(ts, price(ts)));
    return out;
  };

  it("takes P0 from the newest bar and T from the closes of complete 5-minute candles", async () => {
    // bar-by-bar a 0.1% zigzag each candle: the closes per 5-minute bucket alternate 100.00 / 100.10
    const bars = history((ts) => (Math.floor(ts / 300) % 2 === 0 ? 100.0 : 100.1));
    const cfg = await planRound(t, feedOf(bars), NOW);
    expect(cfg.ticker).toBe("AAPL");
    expect(cfg.candleSec).toBe(300);
    // newest bar is NOW-60 which lies in the (complete? no: NOW is a bucket boundary so NOW-60 is in a complete bucket) bucket
    const newest = Math.floor((NOW - 60) / 300) % 2 === 0 ? 100.0 : 100.1;
    expect(cfg.p0).toBe(priceToP0(newest));
    // |move| is 10 bp (or 9 bp the other way): median 10 or 9 -> T = ceil(1.5 * median)
    expect(cfg.T).toBeGreaterThanOrEqual(14);
    expect(cfg.T).toBeLessThanOrEqual(15);
    expect(cfg.commitEnd).toBe(NOW + 90);
    expect(cfg.entryStake).toBe(10n);
    validateRoundConfig(cfg, NOW);
  });

  it("uses only complete candles for T (the partial current bucket is ignored)", () => {
    const bars = [flat(NOW - 600, 100), flat(NOW - 300, 100), flat(NOW - 60, 100), flat(NOW, 500)];
    expect(closesPerInterval(bars, 300, NOW + 30)).toEqual([100, 100]);
  });

  it("no bars, a stale newest bar, or too few complete candles means no round", async () => {
    await expect(planRound(t, feedOf([]), NOW)).rejects.toMatchObject({ code: "NO_DATA" });
    const stale = history(() => 100, NOW - 3600);
    await expect(planRound(t, feedOf(stale), NOW)).rejects.toMatchObject({ code: "STALE" });
    const few = [flat(NOW - 120, 100), flat(NOW - 60, 100)];
    await expect(planRound(t, feedOf(few), NOW)).rejects.toMatchObject({ code: "NO_DATA" });
  });

  it("a flat market gives T = 1", async () => {
    const cfg = await planRound(t, feedOf(history(() => 100)), NOW);
    expect(cfg.T).toBe(1);
  });
});

describe("replayFeed", () => {
  it("answers [from, to) with the bars of [from - offset, to - offset), shifted forward, and labels the mode", async () => {
    const OFFSET = 86_400;
    const calls: { from: number; to: number }[] = [];
    const past = [flat(NOW - OFFSET + 60, 100), flat(NOW - OFFSET + 120, 101)];
    const f = replayFeed(feedOf(past, calls), OFFSET);
    const got = await f.bars("AAPL", NOW, NOW + 600, 60);
    expect(calls).toEqual([{ from: NOW - OFFSET, to: NOW + 600 - OFFSET }]);
    expect(got.map((b) => b.t)).toEqual([NOW + 60, NOW + 120]);
    expect(f.mode).toBe("replay");
    const url = sourceUrlFor(f, NOW, NOW + 600);
    expect(url).toContain("mode=replay");
    expect(url).toContain(`replay_offset=${OFFSET}`);
    expect(url).not.toMatch(/mode=live/);
  });

  it("rejects a zero, negative, fractional or off-grid offset", () => {
    for (const o of [0, -5, 1.5, Number.NaN, 86_401]) expect(() => replayFeed(feedOf([]), o)).toThrow();
  });
});
