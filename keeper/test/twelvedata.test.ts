// Twelve Data adapter with a mocked fetch: request shape, [from, to) selection, strict bar validation, error
// mapping, 429 retry, client-side rate limit, and no key leak (errors, logs and console).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TwelveDataError, createTwelveDataSource, loadTwelveDataKey } from "../src/twelvedata";
import { barsToCandles, DataError, planRound, sourceUrlFor } from "../src/source";

const KEY = "td-TESTKEY-0123456789abcdef";
const FROM = 1_800_000_000; // 2027-01-15T08:00:00Z, on the minute grid
const TO = FROM + 600;

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function dt(t: number): string {
  return new Date(t * 1000).toISOString().slice(0, 19).replace("T", " ");
}

const row = (t: number, c = 100) => ({
  datetime: dt(t),
  open: c.toFixed(5),
  high: (c + 0.1).toFixed(5),
  low: (c - 0.1).toFixed(5),
  close: c.toFixed(5),
  volume: "1000",
});

const ok = (values: unknown[], meta: Record<string, unknown> = {}) =>
  json({ meta: { symbol: "AAPL", interval: "1min", currency: "USD", exchange_timezone: "America/New_York", ...meta }, values, status: "ok" });

function mkSource(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, extra: Record<string, unknown> = {}) {
  const logs: string[] = [];
  const clock = { now: 10_000_000, sleeps: [] as number[] };
  const fetchMock = vi.fn(fetchImpl);
  const source = createTwelveDataSource({
    apiKey: KEY,
    fetch: fetchMock as unknown as typeof fetch,
    log: (m) => logs.push(m),
    nowMs: () => clock.now,
    sleep: async (ms: number) => {
      clock.sleeps.push(ms);
      clock.now += ms;
    },
    ...extra,
  });
  return { source, fetchMock, logs, clock };
}

/** Everything a caller could see after a failure: the message, the name, the stack, the cause and the logs. */
function leaks(e: unknown, logs: string[]): boolean {
  const parts = [e instanceof Error ? `${e.name} ${e.message} ${e.stack ?? ""} ${String((e as { cause?: unknown }).cause ?? "")}` : String(e), ...logs];
  return parts.join("\n").includes(KEY);
}

const consoleSpies = () => (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
let spies: ReturnType<typeof consoleSpies> = [];
beforeEach(() => {
  spies = consoleSpies();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("twelvedata request", () => {
  it("calls time_series with 1min, UTC, asc, an explicit [from, to-1s] window; the key is in the Authorization header only", async () => {
    const { source, fetchMock } = mkSource(async () => ok([row(FROM)]));
    await source.bars("AAPL", FROM, TO, 60);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://api.twelvedata.com/time_series");
    expect(u.searchParams.get("symbol")).toBe("AAPL");
    expect(u.searchParams.get("interval")).toBe("1min");
    expect(u.searchParams.get("timezone")).toBe("UTC");
    expect(u.searchParams.get("order")).toBe("asc");
    expect(u.searchParams.get("outputsize")).toBe("5000");
    expect(u.searchParams.get("start_date")).toBe("2027-01-15T08:00:00");
    expect(u.searchParams.get("end_date")).toBe("2027-01-15T08:09:59"); // end_date is inclusive on the provider side
    expect(u.searchParams.has("apikey")).toBe(false);
    expect(url).not.toContain(KEY);
    const h = init.headers as Record<string, string>;
    expect(h.Authorization).toBe(`apikey ${KEY}`);
    expect(init.method).toBe("GET");
  });

  it("serves 5min bars too", async () => {
    const { source, fetchMock } = mkSource(async () => ok([row(FROM)], { interval: "5min" }));
    await source.bars("AAPL", FROM, TO, 300);
    expect(new URL((fetchMock.mock.calls[0] as unknown as [string])[0]).searchParams.get("interval")).toBe("5min");
  });

  it("returns bars in seconds with numbers parsed from the strings", async () => {
    const { source } = mkSource(async () => ok([row(FROM, 100)]));
    const bars = await source.bars("AAPL", FROM, TO, 60);
    expect(bars).toEqual([{ t: FROM, open: 100, high: 100.1, low: 99.9, close: 100 }]);
  });

  it("selects by bar start time in the half-open window [from, to)", async () => {
    const { source } = mkSource(async () => ok([row(FROM - 60, 99), row(FROM, 100), row(TO - 60, 101), row(TO, 102), row(TO + 60, 103)]));
    const bars = await source.bars("AAPL", FROM, TO, 60);
    expect(bars.map((b) => b.t)).toEqual([FROM, TO - 60]);
  });

  it("sorts unsorted input and removes identical duplicates", async () => {
    const { source } = mkSource(async () => ok([row(FROM + 120, 101), row(FROM, 100), row(FROM + 120, 101), row(FROM + 60, 100.5)]));
    const bars = await source.bars("AAPL", FROM, TO, 60);
    expect(bars.map((b) => b.t)).toEqual([FROM, FROM + 60, FROM + 120]);
  });

  it("refuses two different bars with the same start time", async () => {
    const { source } = mkSource(async () => ok([row(FROM, 100), row(FROM, 105)]));
    await expect(source.bars("AAPL", FROM, TO, 60)).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });

  it("rejects bad requests before any network call", async () => {
    const { source, fetchMock } = mkSource(async () => json({}));
    await expect(source.bars("AAPL", FROM, TO, 120)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(source.bars("aapl&apikey=x", FROM, TO, 60)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(source.bars("AAPL", TO, FROM, 60)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(source.bars("AAPL", FROM * 1000, TO * 1000, 60)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(source.bars("AAPL", FROM, FROM + 3 * 24 * 3600, 60)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("twelvedata no data", () => {
  it("an empty values list is [] (the caller must not post)", async () => {
    const { source, logs } = mkSource(async () => ok([]));
    await expect(source.bars("AAPL", FROM, TO, 60)).resolves.toEqual([]);
    expect(logs).toEqual(["twelvedata: 0 bars"]);
  });

  it("the provider's 'No data is available on the specified dates' (HTTP 400) is []", async () => {
    const body = { code: 400, message: "No data is available on the specified dates. Try setting different start/end dates.", status: "error" };
    const { source } = mkSource(async () => json(body, { status: 400 }));
    await expect(source.bars("AAPL", FROM, TO, 60)).resolves.toEqual([]);
  });

  it("every other 400 is BAD_REQUEST, not silently empty", async () => {
    const { source } = mkSource(async () => json({ code: 400, message: "symbol is missing or invalid", status: "error" }, { status: 400 }));
    await expect(source.bars("AAPL", FROM, TO, 60)).rejects.toMatchObject({ code: "BAD_REQUEST", status: 400 });
  });

  it("too few bars: bars() returns what exists and the keeper's consumers raise NO_DATA", async () => {
    const { source } = mkSource(async () => ok([row(FROM), row(FROM + 60), row(FROM + 120)]));
    const bars = await source.bars("AAPL", FROM, TO, 60);
    expect(bars.length).toBe(3);
    expect(() => barsToCandles(bars, 150_000_000n, FROM, 300)).toThrowError(DataError);
    expect(() => barsToCandles(bars, 150_000_000n, FROM, 300)).toThrowError(/interval 1 has 3 samples/);
    // an empty answer makes planRound refuse to open a round
    const empty = mkSource(async () => ok([]));
    await expect(
      planRound({ ticker: "AAPL", candleSec: 300, commitSec: 90, revealSec: 30, marketSec: 60, leadSec: 4, settleGraceSec: 3600, entryStake: 10n }, empty.source, FROM + 7200),
    ).rejects.toMatchObject({ code: "NO_DATA" });
  });
});

describe("twelvedata strict validation of every bar", () => {
  const good = (): Record<string, unknown> => row(FROM);
  const withField = (k: string, v: unknown) => ({ ...good(), [k]: v });

  it.each([
    ["empty string", withField("close", "")],
    ["leading space", withField("open", " 100")],
    ["letters", withField("high", "abc")],
    ["negative", withField("low", "-1")],
    ["zero", withField("open", "0.00000")],
    ["exponent", withField("close", "1e3")],
    ["NaN", withField("close", "NaN")],
    ["Infinity", withField("high", "Infinity")],
    ["hex", withField("close", "0x10")],
    ["too long to be exact", withField("close", "9".repeat(400))],
    ["a JSON number instead of a string", withField("close", 100)],
    ["null", withField("open", null)],
    ["missing close", { ...good(), close: undefined }],
  ])("a bar with a malformed price (%s) is BAD_RESPONSE", async (_n, item) => {
    const { source } = mkSource(async () => ok([item]));
    await expect(source.bars("AAPL", FROM, TO, 60)).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });

  it.each([
    ["high below close", { ...good(), open: "100.00000", close: "100.50000", high: "100.20000", low: "99.90000" }],
    ["high below open", { ...good(), open: "100.50000", close: "100.00000", high: "100.20000", low: "99.90000" }],
    ["low above close", { ...good(), open: "100.00000", close: "99.50000", high: "100.10000", low: "99.80000" }],
    ["low above open", { ...good(), open: "100.00000", close: "99.90000", low: "100.01000", high: "100.10000" }],
    ["low above high", { ...good(), open: "100.00000", close: "100.00000", high: "99.00000", low: "101.00000" }],
  ])("a bar with inconsistent high/low (%s) is BAD_RESPONSE", async (_n, item) => {
    const { source } = mkSource(async () => ok([item]));
    await expect(source.bars("AAPL", FROM, TO, 60)).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });

  it("accepts equal high/low/open/close (a flat bar)", async () => {
    const flat = { ...good(), open: "100", high: "100", low: "100", close: "100" };
    const { source } = mkSource(async () => ok([flat]));
    await expect(source.bars("AAPL", FROM, TO, 60)).resolves.toHaveLength(1);
  });

  it.each([
    ["date only", "2027-01-15"],
    ["ISO with T", "2027-01-15T08:00:00"],
    ["impossible month", "2027-13-15 08:00:00"],
    ["impossible day", "2027-02-31 08:00:00"],
    ["garbage", "yesterday"],
    ["off the minute grid", "2027-01-15 08:00:30"],
    ["epoch zero", "1970-01-01 00:00:00"],
  ])("a bar with a bad datetime (%s) is BAD_RESPONSE", async (_n, datetime) => {
    const { source } = mkSource(async () => ok([{ ...good(), datetime }]));
    await expect(source.bars("AAPL", FROM, TO, 60)).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });

  it.each([
    ["null item", null],
    ["a string item", "x"],
    ["a numeric datetime", { ...good(), datetime: FROM }],
  ])("%s is BAD_RESPONSE", async (_n, item) => {
    const { source } = mkSource(async () => ok([item]));
    await expect(source.bars("AAPL", FROM, TO, 60)).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });

  it("a bar outside the window is not validated away silently: a malformed bar anywhere fails loudly", async () => {
    const { source } = mkSource(async () => ok([row(FROM), { ...row(TO + 600), close: "abc" }]));
    await expect(source.bars("AAPL", FROM, TO, 60)).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });

  it.each([
    ["not JSON", "<html>oops</html>"],
    ["truncated JSON", '{"meta": {"symbol": "AAPL"'],
    ["a JSON string", '"hello"'],
    ["a JSON array", "[]"],
    ["ok without values", JSON.stringify({ meta: { symbol: "AAPL", interval: "1min" }, status: "ok" })],
    ["values is not a list", JSON.stringify({ meta: { symbol: "AAPL", interval: "1min" }, values: {}, status: "ok" })],
    ["no status", JSON.stringify({ meta: { symbol: "AAPL", interval: "1min" }, values: [] })],
    ["unknown status", JSON.stringify({ meta: { symbol: "AAPL", interval: "1min" }, values: [], status: "weird" })],
    ["no meta", JSON.stringify({ values: [], status: "ok" })],
    ["another symbol", JSON.stringify({ meta: { symbol: "MSFT", interval: "1min" }, values: [], status: "ok" })],
    ["another interval", JSON.stringify({ meta: { symbol: "AAPL", interval: "5min" }, values: [], status: "ok" })],
  ])("malformed response (%s) is BAD_RESPONSE", async (_n, text) => {
    const { source } = mkSource(async () => json(text));
    await expect(source.bars("AAPL", FROM, TO, 60)).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });

  it("an oversized response is refused", async () => {
    const big = new Response("x", { status: 200, headers: { "content-length": String(50 * 1024 * 1024) } });
    const { source } = mkSource(async () => big);
    await expect(source.bars("AAPL", FROM, TO, 60)).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });
});

describe("twelvedata errors and 429 retry", () => {
  it("a status:error body with HTTP 200 is mapped by its code (401 -> AUTH) and does not echo the message", async () => {
    const { source, logs } = mkSource(async () => json({ code: 401, message: `**apikey** ${KEY} is incorrect`, status: "error" }));
    const e = await source.bars("AAPL", FROM, TO, 60).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TwelveDataError);
    expect(e).toMatchObject({ code: "AUTH", status: 401 });
    expect((e as Error).message).not.toContain("incorrect");
    expect(leaks(e, logs)).toBe(false);
  });

  it.each([401, 403])("HTTP %i is an AUTH error (invalid key or plan lacks the resource)", async (status) => {
    const { source, logs } = mkSource(async () => json({ code: status, message: `nope ${KEY}`, status: "error" }, { status }));
    const e = await source.bars("AAPL", FROM, TO, 60).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: "AUTH", status });
    expect(leaks(e, logs)).toBe(false);
  });

  it.each([500, 502, 503])("HTTP %i is a SERVER error", async (status) => {
    const { source } = mkSource(async () => new Response("oops", { status }));
    await expect(source.bars("AAPL", FROM, TO, 60)).rejects.toMatchObject({ code: "SERVER", status });
  });

  it("a non-JSON 401 is still an AUTH error", async () => {
    const { source } = mkSource(async () => new Response("Unauthorized", { status: 401 }));
    await expect(source.bars("AAPL", FROM, TO, 60)).rejects.toMatchObject({ code: "AUTH", status: 401 });
  });

  it("another 4xx is BAD_RESPONSE", async () => {
    const { source } = mkSource(async () => new Response("teapot", { status: 418 }));
    await expect(source.bars("AAPL", FROM, TO, 60)).rejects.toMatchObject({ code: "BAD_RESPONSE", status: 418 });
  });

  it("a status:error body without a usable code is BAD_RESPONSE", async () => {
    const { source } = mkSource(async () => json({ status: "error", message: "?" }));
    await expect(source.bars("AAPL", FROM, TO, 60)).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });

  it("429 is retried with backoff and then succeeds", async () => {
    let n = 0;
    const { source, fetchMock, clock } = mkSource(async () => {
      n++;
      if (n <= 2) return json({ code: 429, message: "run out of API credits for the current minute", status: "error" }, { status: 429 });
      return ok([row(FROM)]);
    });
    const bars = await source.bars("AAPL", FROM, TO, 60);
    expect(bars.length).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(clock.sleeps.length).toBe(2);
    expect(clock.sleeps[1]).toBeGreaterThan(clock.sleeps[0] as number); // backoff grows
  });

  it("a 429 inside an HTTP 200 body is retried too", async () => {
    let n = 0;
    const { source, fetchMock } = mkSource(async () => (++n === 1 ? json({ code: 429, message: "limit", status: "error" }) : ok([row(FROM)])));
    await expect(source.bars("AAPL", FROM, TO, 60)).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("honours a numeric Retry-After (capped at 60 s)", async () => {
    let n = 0;
    const { source, clock } = mkSource(async () => (++n === 1 ? new Response("slow", { status: 429, headers: { "retry-after": "7" } }) : ok([row(FROM)])));
    await source.bars("AAPL", FROM, TO, 60);
    expect(clock.sleeps).toEqual([7000]);
    let m = 0;
    const big = mkSource(async () => (++m === 1 ? new Response("slow", { status: 429, headers: { "retry-after": "3600" } }) : ok([row(FROM)])));
    await big.source.bars("AAPL", FROM, TO, 60);
    expect(big.clock.sleeps).toEqual([60_000]);
  });

  it("gives up with RATE_LIMIT after a bounded number of attempts", async () => {
    const { source, fetchMock } = mkSource(async () => new Response("slow", { status: 429 }));
    await expect(source.bars("AAPL", FROM, TO, 60)).rejects.toMatchObject({ code: "RATE_LIMIT", status: 429 });
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it("a network failure does not echo the cause and has no cause attached", async () => {
    const { source, logs } = mkSource(async () => {
      throw new Error(`connect failed, headers Authorization: apikey ${KEY}`);
    });
    const e = await source.bars("AAPL", FROM, TO, 60).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: "NETWORK" });
    expect((e as Error).cause).toBeUndefined();
    expect(leaks(e, logs)).toBe(false);
  });

  it("no error path leaks the key into an error, a log line or the console", async () => {
    const cases: (() => Promise<Response>)[] = [
      async () => json({ code: 401, message: KEY, status: "error" }, { status: 401 }),
      async () => json({ code: 400, message: KEY, status: "error" }, { status: 400 }),
      async () => json({ code: 429, message: KEY, status: "error" }, { status: 429 }),
      async () => new Response(KEY, { status: 500 }),
      async () => new Response(KEY, { status: 200 }),
      async () => json(`${KEY}`),
      async () => ok([{ ...row(FROM), close: KEY }]),
      async () => {
        throw new Error(KEY);
      },
    ];
    for (const c of cases) {
      const { source, logs } = mkSource(c);
      const e = await source.bars("AAPL", FROM, TO, 60).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(Error);
      expect(leaks(e, logs)).toBe(false);
    }
    // a successful call logs only a bar count
    const good = mkSource(async () => ok([row(FROM)]));
    await good.source.bars("AAPL", FROM, TO, 60);
    expect(good.logs).toEqual(["twelvedata: 1 bars"]);
    for (const s of spies) {
      const printed = s.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
      expect(printed).not.toContain(KEY);
    }
  });

  it("the default log is silent (nothing reaches the console without an injected logger)", async () => {
    const source = createTwelveDataSource({
      apiKey: KEY,
      fetch: (async () => ok([row(FROM)])) as unknown as typeof fetch,
    });
    await source.bars("AAPL", FROM, TO, 60);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it("logs never carry a raw price", async () => {
    const { source, logs } = mkSource(async () => ok([row(FROM, 123.45678)]));
    await source.bars("AAPL", FROM, TO, 60);
    expect(logs.join("\n")).not.toMatch(/123|\d\.\d/);
  });
});

describe("twelvedata rate limit and configuration", () => {
  it("defaults to at most 6 requests per minute and waits (sleep) instead of exceeding it", async () => {
    const { source, fetchMock, clock } = mkSource(async () => ok([]));
    for (let i = 0; i < 6; i++) await source.bars("AAPL", FROM, TO, 60);
    expect(clock.sleeps).toEqual([]);
    await source.bars("AAPL", FROM, TO, 60); // seventh call inside the same minute
    expect(clock.sleeps.length).toBe(1);
    expect(clock.sleeps[0]).toBeGreaterThanOrEqual(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it("retries are counted against the limit too", async () => {
    let n = 0;
    const { source, clock } = mkSource(async () => (++n <= 5 ? new Response("slow", { status: 429, headers: { "retry-after": "1" } }) : ok([])), {
      maxRetries: 10,
    });
    await source.bars("AAPL", FROM, TO, 60); // 5 x 429 + 1 ok = 6 requests, all inside one minute
    expect(clock.sleeps.filter((s) => s >= 60_000)).toEqual([]);
    await source.bars("AAPL", FROM, TO, 60); // 7th request: must wait for the window
    expect(clock.sleeps.some((s) => s >= 50_000)).toBe(true);
  });

  it("loadTwelveDataKey reads TWELVEDATA_API_KEY, trims it, and never prints a value", () => {
    expect(loadTwelveDataKey({ TWELVEDATA_API_KEY: ` ${KEY}\r\n` })).toBe(KEY);
    for (const env of [{}, { TWELVEDATA_API_KEY: "" }, { TWELVEDATA_API_KEY: "   " }, { TWELVEDATA_API_KEY: "has space inside" }, { TWELVEDATA_API_KEY: "bad\nkey" }]) {
      try {
        loadTwelveDataKey(env);
        throw new Error("should have thrown");
      } catch (e) {
        expect((e as TwelveDataError).code).toBe("CONFIG");
        expect((e as Error).message).not.toContain("inside");
      }
    }
  });

  it("createTwelveDataSource refuses an empty or malformed key", () => {
    expect(() => createTwelveDataSource({ apiKey: "" })).toThrow(/API key/);
    expect(() => createTwelveDataSource({ apiKey: "a b" })).toThrow(/API key/);
  });
});

describe("source attribution (licensing)", () => {
  it("the sourceUrl is a generic attribution with the window only: no symbol, no price, no key", () => {
    const { source } = mkSource(async () => json({}));
    const url = sourceUrlFor(source, FROM, TO);
    expect(url).toBe(`https://twelvedata.com/?interval=1min&mode=live&from=${FROM}&to=${TO}`);
    expect(url).not.toMatch(/AAPL|symbol|price|apikey|[0-9]+\.[0-9]+/);
  });
});
