import { describe, expect, it } from "vitest";
import { isValid } from "../../shared/score";
import { buildCandles, type CandleSource } from "../src/candles";

const START = 1_800_000_000;
const IV = 300;

/** `values.length` samples spread evenly inside interval `i`. */
function interval(i: number, values: number[]): { t: number; p: number }[] {
  const step = Math.floor(IV / values.length);
  return values.map((p, k) => ({ t: START + i * IV + k * step, p }));
}

describe("buildCandles", () => {
  it("close = mean of the last 5 samples, high/low from the samples of the interval", () => {
    const samples = [
      ...interval(0, [1, 10, 12, 8, 11, 9, 10]), // last 5: 12 8 11 9 10 -> mean 10
      ...interval(1, [15, 20, 25, 18, 22, 21, 24]), // last 5: 25 18 22 21 24 -> 22
      ...interval(2, [20, 18, 16, 17, 15, 14, 13]), // last 5: 16 17 15 14 13 -> 15
    ];
    const real = buildCandles(samples, START, IV);
    expect(real.map((c) => c.close)).toEqual([10, 22, 15]);
    // candle 1: sampled [1, 12], open 0 -> high 12, low 0 (widened to include the open)
    expect(real[0]).toEqual({ close: 10, high: 12, low: 0 });
    // candle 2: sampled [15, 25], open 10 -> low widened to 10
    expect(real[1]).toEqual({ close: 22, high: 25, low: 10 });
    // candle 3: sampled [13, 20], open 22 -> high widened to 22
    expect(real[2]).toEqual({ close: 15, high: 22, low: 13 });
    expect(isValid(real)).toBe(true);
  });

  it("rounds the mean of the last 5 to integer bp", () => {
    const samples = [
      ...interval(0, [1, 1, 1, 1, 2]), // mean 1.2 -> 1
      ...interval(1, [1, 1, 1, 2, 2]), // mean 1.4 -> 1
      ...interval(2, [1, 1, 2, 2, 2]), // mean 1.6 -> 2
    ];
    expect(buildCandles(samples, START, IV).map((c) => c.close)).toEqual([1, 1, 2]);
  });

  it("widens candles of a trending series so the path is valid on chain (unwidened would not be)", () => {
    // Strong uptrend: each interval is sampled entirely above/below the previous close.
    const samples = [
      ...interval(0, [50, 50, 50, 50, 50, 50]), // sampled low = 50 > open 0
      ...interval(1, [100, 100, 100, 100, 100, 100]), // sampled low = 100 > open 50
      ...interval(2, [30, 30, 30, 30, 30, 30]), // sampled high = 30 < open 100
    ];
    const naive = [
      { close: 50, high: 50, low: 50 },
      { close: 100, high: 100, low: 100 },
      { close: 30, high: 30, low: 30 },
    ] as const;
    expect(isValid(naive)).toBe(false); // sanity: the unwidened candles are invalid
    const real = buildCandles(samples, START, IV);
    expect(real).toEqual([
      { close: 50, high: 50, low: 0 },
      { close: 100, high: 100, low: 50 },
      { close: 30, high: 100, low: 30 },
    ]);
    expect(isValid(real)).toBe(true);
  });

  it("candle 1 includes P0 (0 bp) even when every sample is negative", () => {
    const samples = [
      ...interval(0, [-30, -30, -30, -30, -30]),
      ...interval(1, [-30, -30, -30, -30, -30]),
      ...interval(2, [-30, -30, -30, -30, -30]),
    ];
    const real = buildCandles(samples, START, IV);
    expect(real[0]).toEqual({ close: -30, high: 0, low: -30 });
    expect(isValid(real)).toBe(true);
  });

  it("sorts unsorted input, uses half-open intervals and ignores samples outside the 3 intervals", () => {
    const base = [
      ...interval(0, [1, 2, 3, 4, 5]),
      ...interval(1, [1, 2, 3, 4, 5]),
      ...interval(2, [1, 2, 3, 4, 5]),
    ];
    const outside = [
      { t: START - 1, p: 9999 },
      { t: START + 3 * IV, p: 9999 }, // first instant after the 3rd interval
      { t: START + 3 * IV + 50, p: -9999 },
    ];
    const shuffled = [...outside, ...base].reverse();
    const real = buildCandles(shuffled, START, IV);
    expect(real.map((c) => c.close)).toEqual([3, 3, 3]);
    expect(real[0]).toEqual({ close: 3, high: 5, low: 0 });
  });

  it("the sample at the boundary belongs to the next interval", () => {
    const samples = [
      ...interval(0, [1, 1, 1, 1, 1]),
      { t: START + IV, p: 7 }, // belongs to interval 1
      ...interval(1, [7, 7, 7, 7]),
      ...interval(2, [1, 1, 1, 1, 1]),
    ];
    // interval 1 has 4 + 1 = 5 samples, all 7 -> close 7
    expect(buildCandles(samples, START, IV)[1]!.close).toBe(7);
  });

  it("throws for an interval with fewer than 5 samples", () => {
    const samples = [...interval(0, [1, 2, 3, 4, 5]), ...interval(1, [1, 2, 3, 4]), ...interval(2, [1, 2, 3, 4, 5])];
    expect(() => buildCandles(samples, START, IV)).toThrow(/interval 2/);
  });

  it("throws for a missing interval", () => {
    const samples = [...interval(0, [1, 2, 3, 4, 5]), ...interval(2, [1, 2, 3, 4, 5])];
    expect(() => buildCandles(samples, START, IV)).toThrow(/interval 2/);
  });

  it("throws for non-finite or non-integer samples and bad parameters", () => {
    const ok = [...interval(0, [1, 2, 3, 4, 5]), ...interval(1, [1, 2, 3, 4, 5]), ...interval(2, [1, 2, 3, 4, 5])];
    expect(() => buildCandles([...ok, { t: START + 1, p: NaN }], START, IV)).toThrow();
    expect(() => buildCandles([...ok, { t: START + 1, p: Infinity }], START, IV)).toThrow();
    expect(() => buildCandles([...ok, { t: START + 1, p: 1.5 }], START, IV)).toThrow(); // must be integer bp
    expect(() => buildCandles([...ok, { t: NaN, p: 1 }], START, IV)).toThrow();
    expect(() => buildCandles(ok, START, 0)).toThrow();
    expect(() => buildCandles(ok, START, 1.5)).toThrow();
    expect(() => buildCandles(ok, START * 1000, IV)).toThrow(/seconds/); // millisecond timestamp
    expect(() => buildCandles(ok.slice(0, 0), START, IV)).toThrow();
  });
});

describe("CandleSource", () => {
  it("is only an adapter interface (no provider is integrated)", async () => {
    const src: CandleSource = { bars: async () => [] };
    expect(await src.bars("AAPL", 0, 1, 300)).toEqual([]);
  });
});
