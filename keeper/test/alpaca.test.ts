// Alpaca adapter with a mocked fetch: request shape, error handling, untrusted responses, no key leak.
import { describe, expect, it, vi } from "vitest";
import { AlpacaError, createAlpacaSource, loadAlpacaCredentials } from "../src/alpaca";
import { sourceUrlFor } from "../src/source";

const KEY_ID = "PKTESTKEYID123456";
const SECRET = "s3cr3t-Value-ABCdef/987654321";
const FROM = 1_800_000_000;
const TO = FROM + 600;

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

const bar = (t: number, c = 100) => ({ t: new Date(t * 1000).toISOString(), o: c, h: c + 0.1, l: c - 0.1, c, v: 10, n: 2, vw: c });

function mkSource(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, extra: Record<string, unknown> = {}) {
  const logs: string[] = [];
  const fetchMock = vi.fn(fetchImpl);
  const source = createAlpacaSource({ keyId: KEY_ID, secretKey: SECRET, fetch: fetchMock as unknown as typeof fetch, log: (m) => logs.push(m), ...extra });
  return { source, fetchMock, logs };
}

/** Everything a caller could see after a failure: the message, the name and the logs. */
function leaks(e: unknown, logs: string[]): boolean {
  const seen = [e instanceof Error ? `${e.name} ${e.message} ${e.stack ?? ""}` : String(e), ...logs].join("\n");
  return seen.includes(KEY_ID) || seen.includes(SECRET);
}

describe("alpaca request", () => {
  it("calls the bars endpoint with feed=iex, 1Min bars, an explicit window, and sends both key headers", async () => {
    const { source, fetchMock } = mkSource(async () => json({ bars: { AAPL: [bar(FROM)] }, next_page_token: null }));
    await source.bars("AAPL", FROM, TO, 60);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://data.alpaca.markets/v2/stocks/bars");
    expect(u.searchParams.get("symbols")).toBe("AAPL");
    expect(u.searchParams.get("timeframe")).toBe("1Min");
    expect(u.searchParams.get("feed")).toBe("iex");
    expect(u.searchParams.get("adjustment")).toBe("raw");
    expect(u.searchParams.get("sort")).toBe("asc");
    expect(u.searchParams.get("start")).toBe("2027-01-15T08:00:00Z");
    expect(u.searchParams.get("end")).toBe("2027-01-15T08:10:00Z");
    const h = init.headers as Record<string, string>;
    expect(h["APCA-API-KEY-ID"]).toBe(KEY_ID);
    expect(h["APCA-API-SECRET-KEY"]).toBe(SECRET);
    expect(init.method).toBe("GET");
    // the credentials travel in headers only, never in the URL
    expect(url).not.toContain(KEY_ID);
    expect(url).not.toContain(SECRET);
  });

  it("returns bars in seconds, sorted, deduplicated and limited to [from, to)", async () => {
    const { source } = mkSource(async () =>
      json({ bars: { AAPL: [bar(FROM + 120, 101), bar(FROM, 100), bar(FROM + 120, 101), bar(TO, 102), bar(FROM - 60, 99)] } }),
    );
    const bars = await source.bars("AAPL", FROM, TO, 60);
    expect(bars.map((b) => b.t)).toEqual([FROM, FROM + 120]);
    expect(bars[0]).toEqual({ t: FROM, open: 100, high: 100.1, low: 99.9, close: 100 });
  });

  it("follows next_page_token and stops when it is null", async () => {
    let n = 0;
    const { source, fetchMock } = mkSource(async (url) => {
      n++;
      if (n === 1) return json({ bars: { AAPL: [bar(FROM)] }, next_page_token: "TOK1" });
      expect(new URL(url).searchParams.get("page_token")).toBe("TOK1");
      return json({ bars: { AAPL: [bar(FROM + 60)] }, next_page_token: null });
    });
    expect((await source.bars("AAPL", FROM, TO, 60)).length).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refuses a page loop that never ends", async () => {
    const { source } = mkSource(async () => json({ bars: { AAPL: [bar(FROM)] }, next_page_token: "AGAIN" }));
    await expect(source.bars("AAPL", FROM, TO, 60)).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });

  it("rejects bad requests before any network call", async () => {
    const { source, fetchMock } = mkSource(async () => json({}));
    await expect(source.bars("AAPL", FROM, TO, 300)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(source.bars("aapl&feed=sip", FROM, TO, 60)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(source.bars("AAPL", TO, FROM, 60)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(source.bars("AAPL", FROM * 1000, TO * 1000, 60)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("alpaca no data and errors", () => {
  it.each([
    ["empty list", { bars: { AAPL: [] }, next_page_token: null }],
    ["null bars", { bars: null, next_page_token: null }],
    ["symbol missing", { bars: {}, next_page_token: null }],
    ["no bars key", { next_page_token: null }],
  ])("returns [] for %s (the caller must not post)", async (_n, body) => {
    const { source } = mkSource(async () => json(body));
    await expect(source.bars("AAPL", FROM, TO, 60)).resolves.toEqual([]);
  });

  it("403 is an AUTH error that names no key", async () => {
    const { source, logs } = mkSource(async () => json({ message: `forbidden ${KEY_ID}` }, { status: 403 }));
    const e = await source.bars("AAPL", FROM, TO, 60).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AlpacaError);
    expect(e).toMatchObject({ code: "AUTH", status: 403 });
    expect(leaks(e, logs)).toBe(false);
  });

  it("429 is RATE_LIMIT and blocks further calls (no fetch) until Retry-After has passed", async () => {
    let now = 1_000_000;
    const { source, fetchMock } = mkSource(
      async () => new Response("slow down", { status: 429, headers: { "retry-after": "20" } }),
      { nowMs: () => now },
    );
    await expect(source.bars("AAPL", FROM, TO, 60)).rejects.toMatchObject({ code: "RATE_LIMIT", status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now += 10_000;
    await expect(source.bars("AAPL", FROM, TO, 60)).rejects.toMatchObject({ code: "RATE_LIMIT" });
    expect(fetchMock).toHaveBeenCalledTimes(1); // still cooling down: no request was made
    now += 11_000;
    await expect(source.bars("AAPL", FROM, TO, 60)).rejects.toMatchObject({ code: "RATE_LIMIT" });
    expect(fetchMock).toHaveBeenCalledTimes(2); // cooled down: asked again (and got 429 again)
  });

  it.each([500, 502, 503])("%i is a SERVER error", async (status) => {
    const { source } = mkSource(async () => new Response("oops", { status }));
    await expect(source.bars("AAPL", FROM, TO, 60)).rejects.toMatchObject({ code: "SERVER", status });
  });

  it("a network failure does not echo the cause (it could contain the request)", async () => {
    const { source, logs } = mkSource(async () => {
      throw new Error(`connect failed for headers ${KEY_ID} ${SECRET}`);
    });
    const e = await source.bars("AAPL", FROM, TO, 60).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: "NETWORK" });
    expect(leaks(e, logs)).toBe(false);
  });

  it.each([
    ["not JSON", "<html>oops</html>"],
    ["truncated JSON", '{"bars": {"AAPL": [{"t":'],
    ["a JSON string", '"hello"'],
    ["bars is an array", JSON.stringify({ bars: [] })],
    ["symbol list is not a list", JSON.stringify({ bars: { AAPL: "x" } })],
  ])("malformed response (%s) is BAD_RESPONSE", async (_n, text) => {
    const { source } = mkSource(async () => json(text));
    await expect(source.bars("AAPL", FROM, TO, 60)).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });

  it.each([
    ["bad time", { t: "yesterday", o: 1, h: 1, l: 1, c: 1 }],
    ["numeric time", { t: 1800000000, o: 1, h: 1, l: 1, c: 1 }],
    ["string price", { t: "2027-01-15T08:00:00Z", o: "1", h: 1, l: 1, c: 1 }],
    ["missing close", { t: "2027-01-15T08:00:00Z", o: 1, h: 1, l: 1 }],
    ["null item", null],
  ])("a bar with %s is BAD_RESPONSE", async (_n, item) => {
    const { source } = mkSource(async () => json({ bars: { AAPL: [item] } }));
    await expect(source.bars("AAPL", FROM, TO, 60)).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });

  it("an oversized response is refused", async () => {
    const big = new Response("x", { status: 200, headers: { "content-length": String(50 * 1024 * 1024) } });
    const { source } = mkSource(async () => big);
    await expect(source.bars("AAPL", FROM, TO, 60)).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });

  it("no error path leaks the key or the secret", async () => {
    const cases: (() => Promise<Response>)[] = [
      async () => json({ message: KEY_ID + SECRET }, { status: 401 }),
      async () => new Response(SECRET, { status: 500 }),
      async () => json(`${KEY_ID}`),
      async () => {
        throw new Error(SECRET);
      },
    ];
    for (const c of cases) {
      const { source, logs } = mkSource(c);
      const e = await source.bars("AAPL", FROM, TO, 60).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(Error);
      expect(leaks(e, logs)).toBe(false);
    }
  });
});

describe("alpaca rate limit and configuration", () => {
  it("spends at most maxCallsPerMin per minute and waits (sleep) instead of exceeding it", async () => {
    let now = 5_000_000;
    const sleeps: number[] = [];
    const { source, fetchMock } = mkSource(async () => json({ bars: { AAPL: [] } }), {
      maxCallsPerMin: 2,
      nowMs: () => now,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    await source.bars("AAPL", FROM, TO, 60);
    await source.bars("AAPL", FROM, TO, 60);
    expect(sleeps).toEqual([]);
    await source.bars("AAPL", FROM, TO, 60); // third call inside the same minute
    expect(sleeps.length).toBe(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("loadAlpacaCredentials needs both variables and never prints a value", () => {
    expect(loadAlpacaCredentials({ APCA_API_KEY_ID: "a", APCA_API_SECRET_KEY: "b" })).toEqual({ keyId: "a", secretKey: "b" });
    for (const env of [{}, { APCA_API_KEY_ID: SECRET }, { APCA_API_SECRET_KEY: SECRET }]) {
      try {
        loadAlpacaCredentials(env);
        throw new Error("should have thrown");
      } catch (e) {
        expect((e as AlpacaError).code).toBe("CONFIG");
        expect((e as Error).message).not.toContain(SECRET);
      }
    }
  });

  it("createAlpacaSource refuses empty credentials", () => {
    expect(() => createAlpacaSource({ keyId: "", secretKey: "x" })).toThrow(/credentials/);
  });
});

describe("source attribution (licensing)", () => {
  it("the sourceUrl is a generic attribution with the window only: no symbol, no price", () => {
    const { source } = mkSource(async () => json({}));
    const url = sourceUrlFor(source, FROM, TO);
    expect(url).toBe(`https://alpaca.markets/data?feed=iex&mode=live&from=${FROM}&to=${TO}`);
    expect(url).not.toMatch(/AAPL|symbol|price|[0-9]+\.[0-9]+/);
  });
});
