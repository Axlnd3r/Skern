// Daily request budget of the adapter and the throttle that keeps the 5 s keeper loop inside it, with a fake clock.
import { describe, expect, it, vi } from "vitest";
import type { Bar } from "../src/candles";
import { DataError, planRound, type PriceFeed, type RoundTemplate } from "../src/source";
import { TwelveDataError, createTwelveDataSource, throttleFeed } from "../src/twelvedata";

const KEY = "td-TESTKEY-0123456789abcdef";
const DAY_MS = 86_400_000;
const T0 = Date.UTC(2027, 0, 15, 10, 0, 0); // 2027-01-15 10:00:00 UTC, a UTC day with room for a 3 h run
const FROM = 1_800_000_000;

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}
const dt = (t: number) => new Date(t * 1000).toISOString().slice(0, 19).replace("T", " ");
const row = (t: number, c = 100) => ({ datetime: dt(t), open: c.toFixed(2), high: (c + 0.1).toFixed(2), low: (c - 0.1).toFixed(2), close: c.toFixed(2), volume: "1" });
const ok = (values: unknown[]) => json({ meta: { symbol: "AAPL", interval: "1min" }, values, status: "ok" });
const noData = () => json({ code: 400, message: "No data is available on the specified dates. Try setting different start/end dates.", status: "error" }, { status: 400 });

function clockSource(fetchImpl: (url: string) => Promise<Response>, startMs: number, extra: Record<string, unknown> = {}) {
  const clock = { now: startMs };
  const fetchMock = vi.fn(fetchImpl);
  const source = createTwelveDataSource({
    apiKey: KEY,
    fetch: fetchMock as unknown as typeof fetch,
    nowMs: () => clock.now,
    sleep: async (ms: number) => {
      clock.now += ms;
    },
    ...extra,
  });
  return { source, fetchMock, clock };
}

describe("daily budget of the adapter", () => {
  it("refuses to send once the day's budget is spent, with a distinct QUOTA error", async () => {
    const { source, fetchMock } = clockSource(async () => ok([]), T0, { maxCallsPerDay: 3 });
    for (let i = 0; i < 3; i++) await source.bars("AAPL", FROM, FROM + 600, 60);
    const e = await source.bars("AAPL", FROM, FROM + 600, 60).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TwelveDataError);
    expect(e).toMatchObject({ code: "QUOTA" });
    expect((e as Error).message).toMatch(/daily request budget of 3/);
    expect((e as Error).message).not.toContain(KEY);
    expect(fetchMock).toHaveBeenCalledTimes(3); // nothing was sent for the refused call
    await expect(source.bars("AAPL", FROM, FROM + 600, 60)).rejects.toMatchObject({ code: "QUOTA" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("QUOTA is not RATE_LIMIT: a provider 429 stays RATE_LIMIT", async () => {
    const { source } = clockSource(async () => new Response("slow", { status: 429 }), T0, { maxRetries: 0 });
    await expect(source.bars("AAPL", FROM, FROM + 600, 60)).rejects.toMatchObject({ code: "RATE_LIMIT" });
  });

  it("retries are counted: a 429 loop cannot go past the budget", async () => {
    const { source, fetchMock } = clockSource(async () => new Response("slow", { status: 429, headers: { "retry-after": "1" } }), T0, { maxCallsPerDay: 6 });
    // 4 requests per call (1 + 3 retries): the first call uses 4, the second is cut off by the budget after 2 more
    await expect(source.bars("AAPL", FROM, FROM + 600, 60)).rejects.toMatchObject({ code: "RATE_LIMIT" });
    await expect(source.bars("AAPL", FROM, FROM + 600, 60)).rejects.toMatchObject({ code: "QUOTA" });
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("the budget resets on the next UTC day", async () => {
    const { source, fetchMock, clock } = clockSource(async () => ok([]), Date.UTC(2027, 0, 15, 23, 59, 59), { maxCallsPerDay: 2 });
    await source.bars("AAPL", FROM, FROM + 600, 60);
    await source.bars("AAPL", FROM, FROM + 600, 60);
    await expect(source.bars("AAPL", FROM, FROM + 600, 60)).rejects.toMatchObject({ code: "QUOTA" });
    clock.now += 2000; // 00:00:01 UTC of the next day
    await source.bars("AAPL", FROM, FROM + 600, 60);
    await source.bars("AAPL", FROM, FROM + 600, 60);
    await expect(source.bars("AAPL", FROM, FROM + 600, 60)).rejects.toMatchObject({ code: "QUOTA" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("the default budget is 700 per UTC day", async () => {
    const { source, fetchMock, clock } = clockSource(async () => ok([]), T0, { maxCallsPerMin: 100_000 });
    let quota = 0;
    for (let i = 0; i < 710; i++) {
      clock.now += 1000;
      try {
        await source.bars("AAPL", FROM, FROM + 600, 60);
      } catch (e) {
        if ((e as TwelveDataError).code === "QUOTA") quota++;
      }
    }
    expect(fetchMock).toHaveBeenCalledTimes(700);
    expect(quota).toBe(10);
  });

  it("refuses a bad budget", () => {
    expect(() => createTwelveDataSource({ apiKey: KEY, maxCallsPerDay: 0 })).toThrow(/maxCallsPerDay/);
    expect(() => createTwelveDataSource({ apiKey: KEY, maxCallsPerDay: 1.5 })).toThrow(/maxCallsPerDay/);
  });
});

describe("3 h of 5 s ticks against a failing feed stay inside the daily budget", () => {
  const template: RoundTemplate = { ticker: "AAPL", candleSec: 300, commitSec: 90, revealSec: 30, marketSec: 60, leadSec: 4, settleGraceSec: 3600, entryStake: 10n };
  const TICKS = (3 * 3600) / 5;

  /** The loop's planNext: planRound on every tick, errors are only logged. Returns the error codes seen. */
  async function runPlanning(feed: PriceFeed, clock: { now: number }): Promise<Map<string, number>> {
    const seen = new Map<string, number>();
    for (let i = 0; i < TICKS; i++) {
      clock.now += 5000;
      try {
        await planRound(template, feed, Math.floor(clock.now / 1000));
        seen.set("opened", (seen.get("opened") ?? 0) + 1);
      } catch (e) {
        const code = (e as { code?: string }).code ?? "?";
        seen.set(code, (seen.get(code) ?? 0) + 1);
      }
    }
    return seen;
  }

  const staleFetch = (clock: { now: number }) => async () => {
    const newest = Math.floor(clock.now / 1000 / 60) * 60 - 3000; // newest bar is 50 minutes old: the market is closed
    return ok([row(newest - 60), row(newest)]);
  };

  it("STALE answers: the throttled feed sends at most one request per minute", async () => {
    const clock = { now: T0 };
    // one clock shared by the loop, the adapter and the throttle
    const shared = clockSource(staleFetch(clock), T0, { nowMs: () => clock.now, sleep: async (ms: number) => void (clock.now += ms) });
    const feed = throttleFeed(shared.source, { nowMs: () => clock.now });
    const seen = await runPlanning(feed, clock);
    expect(seen.get("STALE")).toBe(TICKS);
    expect(shared.fetchMock.mock.calls.length).toBeLessThanOrEqual(3 * 60 + 2);
    expect(shared.fetchMock.mock.calls.length).toBeLessThan(700);
  });

  it("NO_DATA answers (market closed, HTTP 400): at most one request per minute", async () => {
    const clock = { now: T0 };
    const shared = clockSource(async () => noData(), T0, { nowMs: () => clock.now, sleep: async (ms: number) => void (clock.now += ms) });
    const feed = throttleFeed(shared.source, { nowMs: () => clock.now });
    const seen = await runPlanning(feed, clock);
    expect(seen.get("NO_DATA")).toBe(TICKS);
    expect(shared.fetchMock.mock.calls.length).toBeLessThanOrEqual(3 * 60 + 2);
  });

  it("a lasting provider failure (500) is throttled too", async () => {
    const clock = { now: T0 };
    const shared = clockSource(async () => new Response("down", { status: 503 }), T0, { nowMs: () => clock.now, sleep: async (ms: number) => void (clock.now += ms) });
    const feed = throttleFeed(shared.source, { nowMs: () => clock.now });
    const seen = await runPlanning(feed, clock);
    expect(seen.size).toBe(1);
    expect(shared.fetchMock.mock.calls.length).toBeLessThanOrEqual(3 * 60 + 2);
  });

  it("for contrast, the unthrottled adapter burns the whole daily budget and then reports QUOTA", async () => {
    const clock = { now: T0 };
    const shared = clockSource(async () => noData(), T0, { nowMs: () => clock.now, sleep: async (ms: number) => void (clock.now += ms), maxCallsPerMin: 100_000 });
    const seen = await runPlanning(shared.source, clock);
    expect(shared.fetchMock.mock.calls.length).toBe(700);
    expect(seen.get("QUOTA")).toBe(TICKS - 700);
  });

  it("after the quota is spent, the throttled feed keeps answering QUOTA without a request, and recovers next UTC day", async () => {
    const clock = { now: Date.UTC(2027, 0, 15, 23, 50, 0) };
    const shared = clockSource(async () => noData(), clock.now, { nowMs: () => clock.now, sleep: async (ms: number) => void (clock.now += ms), maxCallsPerDay: 5 });
    const feed = throttleFeed(shared.source, { nowMs: () => clock.now });
    const codes: string[] = [];
    for (let i = 0; i < 12 * 20; i++) {
      // 20 minutes of 5 s ticks: crosses 00:00 UTC
      clock.now += 5000;
      try {
        await feed.bars("AAPL", Math.floor(clock.now / 1000) - 7200, Math.floor(clock.now / 1000), 60);
        codes.push("ok");
      } catch (e) {
        codes.push((e as { code?: string }).code ?? "?");
      }
    }
    expect(codes).toContain("QUOTA");
    // 5 requests on day 1 (one per minute, so day 1 is spent within the first 5 minutes), 5 more after midnight
    expect(shared.fetchMock.mock.calls.length).toBe(10);
  });

  it("DataError from the planner is untouched by the throttle (the loop logs it as before)", async () => {
    const clock = { now: T0 };
    const feed = throttleFeed({ mode: "live", attributionBase: "x", attributionParams: {}, bars: async () => [] }, { nowMs: () => clock.now });
    await expect(planRound(template, feed, Math.floor(T0 / 1000))).rejects.toBeInstanceOf(DataError);
  });
});

describe("throttleFeed", () => {
  function fake(impl: (from: number, to: number) => Promise<Bar[]>) {
    const clock = { now: T0 };
    const bars = vi.fn(async (_t: string, from: number, to: number) => impl(from, to));
    const feed = throttleFeed({ mode: "live", attributionBase: "https://x/", attributionParams: { a: "b" }, bars }, { nowMs: () => clock.now });
    return { feed, bars, clock };
  }
  const bar = (t: number): Bar => ({ t, open: 100, high: 100.1, low: 99.9, close: 100 });
  const WFROM = 1_799_999_400; // multiple of 60 and 300
  const WTO = WFROM + 900;
  const full = () => Array.from({ length: 15 }, (_, i) => bar(WFROM + 60 * i));

  it("keeps mode and attribution of the inner feed", () => {
    const { feed } = fake(async () => []);
    expect(feed.mode).toBe("live");
    expect(feed.attributionBase).toBe("https://x/");
    expect(feed.attributionParams).toEqual({ a: "b" });
  });

  it("an empty result is reused for 60 s, then asked again", async () => {
    const { feed, bars, clock } = fake(async () => []);
    clock.now = (WTO + 1000) * 1000;
    await feed.bars("AAPL", WFROM, WTO, 60);
    clock.now += 5000;
    await feed.bars("AAPL", WFROM, WTO, 60);
    clock.now += 54_000;
    await feed.bars("AAPL", WFROM, WTO, 60);
    expect(bars).toHaveBeenCalledTimes(1);
    clock.now += 2000;
    await feed.bars("AAPL", WFROM, WTO, 60);
    expect(bars).toHaveBeenCalledTimes(2);
  });

  it("an error is replayed for 60 s without a request, then asked again", async () => {
    const { feed, bars, clock } = fake(async () => {
      throw new TwelveDataError("SERVER", "down", 503);
    });
    await expect(feed.bars("AAPL", WFROM, WTO, 60)).rejects.toMatchObject({ code: "SERVER" });
    clock.now += 10_000;
    await expect(feed.bars("AAPL", WFROM, WTO, 60)).rejects.toMatchObject({ code: "SERVER" });
    expect(bars).toHaveBeenCalledTimes(1);
    clock.now += 51_000;
    await expect(feed.bars("AAPL", WFROM, WTO, 60)).rejects.toMatchObject({ code: "SERVER" });
    expect(bars).toHaveBeenCalledTimes(2);
  });

  it("a complete result for a closed window is cached for good", async () => {
    const { feed, bars, clock } = fake(async () => full());
    clock.now = (WTO + 120) * 1000; // window ended two minutes ago
    const a = await feed.bars("AAPL", WFROM, WTO, 60);
    clock.now += 10 * 3600_000;
    const b = await feed.bars("AAPL", WFROM, WTO, 60);
    expect(bars).toHaveBeenCalledTimes(1);
    expect(b).toEqual(a);
    b[0]!.close = 1; // a caller cannot corrupt the cache
    expect((await feed.bars("AAPL", WFROM, WTO, 60))[0]!.close).toBe(100);
  });

  it("a PARTIAL result for a closed window is not cached for good (the provider may still add bars)", async () => {
    let n = 0;
    const { feed, bars, clock } = fake(async () => (++n === 1 ? full().slice(0, 10) : full()));
    clock.now = (WTO + 120) * 1000;
    expect((await feed.bars("AAPL", WFROM, WTO, 60)).length).toBe(10);
    clock.now += 61_000;
    expect((await feed.bars("AAPL", WFROM, WTO, 60)).length).toBe(15);
    expect(bars).toHaveBeenCalledTimes(2);
    clock.now += 3600_000;
    expect((await feed.bars("AAPL", WFROM, WTO, 60)).length).toBe(15);
    expect(bars).toHaveBeenCalledTimes(2); // now complete, cached
  });

  it("a complete result for a window that has not closed yet is not cached for good", async () => {
    const { feed, bars, clock } = fake(async () => full());
    clock.now = (WTO + 10) * 1000; // less than one bar after the end
    await feed.bars("AAPL", WFROM, WTO, 60);
    clock.now += 61_000;
    await feed.bars("AAPL", WFROM, WTO, 60);
    expect(bars).toHaveBeenCalledTimes(2);
  });

  it("a drifting live window (planRound every tick) is served from memory, filtered to the new window", async () => {
    const { feed, bars, clock } = fake(async (from, to) => {
      const out: Bar[] = [];
      for (let t = Math.ceil(from / 60) * 60; t < to; t += 60) out.push(bar(t));
      return out;
    });
    clock.now = (WTO + 1000) * 1000;
    const first = await feed.bars("AAPL", WTO - 600, WTO, 60);
    clock.now += 5000;
    const second = await feed.bars("AAPL", WTO - 595, WTO + 5, 60);
    expect(bars).toHaveBeenCalledTimes(1);
    expect(second.every((b) => b.t >= WTO - 595 && b.t < WTO + 5)).toBe(true);
    expect(second.length).toBeLessThanOrEqual(first.length);
  });

  it("different windows, tickers and intervals are never conflated", async () => {
    const { feed, bars } = fake(async () => []);
    await feed.bars("AAPL", WFROM, WTO, 60);
    await feed.bars("AAPL", WFROM - 7200, WTO, 60); // starts earlier than the cached window: cannot be served from it
    await feed.bars("MSFT", WFROM, WTO, 60);
    await feed.bars("AAPL", WFROM, WTO, 300);
    await feed.bars("AAPL", WFROM + 86_400, WTO + 86_400, 60); // another day: far from the cached window
    expect(bars).toHaveBeenCalledTimes(5);
  });
});
