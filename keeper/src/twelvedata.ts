// Twelve Data adapter (free Basic plan) behind the `PriceFeed` / `CandleSource` interface.
//
//   GET https://api.twelvedata.com/time_series?symbol=<S>&interval=1min&timezone=UTC&order=asc&outputsize=5000
//       &start_date=YYYY-MM-DDTHH:MM:SS&end_date=YYYY-MM-DDTHH:MM:SS        (Authorization: apikey <key>)
//
// Verified against the live API (2026-11-25): `datetime` is the bar OPEN time ("YYYY-MM-DD HH:MM:SS", in the
// requested `timezone`, here UTC); prices are decimal strings; `end_date` is INCLUSIVE; an empty window is
// answered with HTTP 400 `{"code":400,"message":"No data is available on the specified dates...","status":"error"}`;
// an invalid key is HTTP 401 `status:"error"`; the header `Authorization: apikey <key>` is accepted.
// Not verified (so handled by failing loudly): the exact body of a 429 and of a 403 plan error; whether the free
// plan serves every interval (a refusal arrives as 401/403 -> AUTH).
//
// - The key is read from the environment, sent only in the Authorization header and never appears in a log
//   line, an error message, an error cause or a URL. Provider error messages are never echoed.
// - The response is untrusted data: size-limited, parsed defensively, every bar strictly validated.
// - Rate limit: the free plan allows 8 credits/min and 800/day (one request = one credit). This adapter spends
//   at most `maxCallsPerMin` (default 6) in any sliding minute (retries included) and waits instead of
//   exceeding it. A 429 is retried with backoff, a bounded number of times.
// - Daily budget: at most `maxCallsPerDay` (default 700 of the 800 credits) requests per UTC day, retries
//   included. Once spent, `bars` throws a QUOTA error WITHOUT sending anything, until the next UTC day. The count
//   lives in memory: a restarted keeper starts from zero again (the throttle in `throttleFeed` keeps a failing
//   loop far below the budget, see demo.ts).
// - No data is returned as `[]`; the caller decides (the keeper then does not post and the round voids rather
//   than receive invented candles).
// - Licensing: redistribution terms of Twelve Data are unverified. This module returns bars to the keeper only;
//   the keeper publishes bp moves relative to P0 and a generic attribution URL (see source.ts). Get written
//   confirmation before the public submission.
import type { Bar } from "./candles";
import type { PriceFeed } from "./source";

const DEFAULT_BASE_URL = "https://api.twelvedata.com";
const ATTRIBUTION_BASE = "https://twelvedata.com/";
const MAX_BODY_BYTES = 5 * 1024 * 1024;
/** 2 days of 1-minute bars is 2880 rows, below the provider's outputsize cap of 5000, so a window is never truncated. */
const MAX_SPAN_SEC = 2 * 24 * 3600;
const OUTPUT_SIZE = 5000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CALLS_PER_MIN = 6;
const DEFAULT_MAX_CALLS_PER_DAY = 700;
const DAY_MS = 86_400_000;
const DEFAULT_MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 10_000;
const MAX_WAIT_MS = 60_000;
const SYMBOL_RE = /^[A-Z][A-Z0-9.]{0,9}$/;
const KEY_RE = /^[\x21-\x7e]+$/; // printable ASCII, no whitespace or control characters (no header injection)
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const PRICE_RE = /^\d{1,15}(\.\d{1,15})?$/;
const INTERVALS: Readonly<Record<number, string>> = { 60: "1min", 300: "5min" };

export class TwelveDataError extends Error {
  constructor(
    readonly code: "CONFIG" | "AUTH" | "RATE_LIMIT" | "QUOTA" | "SERVER" | "NETWORK" | "BAD_RESPONSE" | "BAD_REQUEST",
    message: string,
    /** HTTP status (or the provider's error code) when the error came from a response. */
    readonly status?: number,
  ) {
    super(message);
    this.name = "TwelveDataError";
  }
}

export interface TwelveDataOptions {
  apiKey: string;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  baseUrl?: string;
  /** Default 6 (the free plan allows 8 credits/min; the margin covers other tools sharing the key). */
  maxCallsPerMin?: number;
  /** Requests per UTC day, retries included (default 700; the free plan allows 800 credits/day). */
  maxCallsPerDay?: number;
  /** Retries after a 429 (default 3, so at most 4 requests per `bars` call). */
  maxRetries?: number;
  /** Injectable clock (ms) and sleep for tests. */
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

/** Reads TWELVEDATA_API_KEY. The error never contains a value. */
export function loadTwelveDataKey(env: Record<string, string | undefined> = process.env): string {
  const key = (env.TWELVEDATA_API_KEY ?? "").trim();
  if (!key) throw new TwelveDataError("CONFIG", "missing environment variable TWELVEDATA_API_KEY");
  if (!KEY_RE.test(key)) throw new TwelveDataError("CONFIG", "TWELVEDATA_API_KEY contains whitespace or control characters");
  return key;
}

function formatUtc(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 19); // YYYY-MM-DDTHH:MM:SS
}

function badBar(): never {
  throw new TwelveDataError("BAD_RESPONSE", "a bar in the response has an unexpected shape or inconsistent values");
}

/** A provider decimal string -> a finite positive number. Anything else is rejected. */
function price(x: unknown): number {
  if (typeof x !== "string" || !PRICE_RE.test(x)) return badBar();
  const v = Number(x);
  if (!Number.isFinite(v) || v <= 0) return badBar();
  return v;
}

/** "YYYY-MM-DD HH:MM:SS" (UTC) -> unix seconds on the minute grid, or throws. */
function parseDatetime(x: unknown): number {
  if (typeof x !== "string") return badBar();
  const m = DATETIME_RE.exec(x);
  if (!m) return badBar();
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19).replace("T", " ") !== x) return badBar(); // 2027-02-31 etc.
  const t = ms / 1000;
  if (t <= 0 || t % 60 !== 0) return badBar();
  return t;
}

/** One raw API item -> Bar, or throws BAD_RESPONSE. */
function parseBar(item: unknown): Bar {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return badBar();
  const r = item as Record<string, unknown>;
  const t = parseDatetime(r.datetime);
  const open = price(r.open);
  const high = price(r.high);
  const low = price(r.low);
  const close = price(r.close);
  if (high < Math.max(open, close) || low > Math.min(open, close)) return badBar();
  return { t, open, high, low, close };
}

function sameBar(a: Bar, b: Bar): boolean {
  return a.t === b.t && a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close;
}

export function createTwelveDataSource(opts: TwelveDataOptions): PriceFeed {
  if (typeof opts.apiKey !== "string" || !opts.apiKey || !KEY_RE.test(opts.apiKey)) {
    throw new TwelveDataError("CONFIG", "a Twelve Data API key without whitespace is required");
  }
  const doFetch = opts.fetch ?? fetch;
  const base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const maxCalls = opts.maxCallsPerMin ?? DEFAULT_MAX_CALLS_PER_MIN;
  const maxPerDay = opts.maxCallsPerDay ?? DEFAULT_MAX_CALLS_PER_DAY;
  if (!Number.isSafeInteger(maxPerDay) || maxPerDay < 1) throw new TwelveDataError("CONFIG", "maxCallsPerDay must be a positive integer");
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const nowMs = opts.nowMs ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const log = opts.log ?? (() => {});
  const headers = { Authorization: `apikey ${opts.apiKey}`, accept: "application/json" };

  const calls: number[] = []; // start times (ms) of requests in the last minute
  let budgetDay = -1; // UTC day number of `usedToday`
  let usedToday = 0;

  async function waitForSlot(): Promise<void> {
    for (;;) {
      const now = nowMs();
      const day = Math.floor(now / DAY_MS);
      if (day !== budgetDay) {
        budgetDay = day;
        usedToday = 0;
      }
      if (usedToday >= maxPerDay) {
        throw new TwelveDataError("QUOTA", `daily request budget of ${maxPerDay} is spent; no request was sent (it resets at 00:00 UTC)`);
      }
      while (calls.length > 0 && now - (calls[0] as number) >= 60_000) calls.shift();
      if (calls.length < maxCalls) {
        calls.push(now);
        usedToday++;
        return;
      }
      await sleep(60_000 - (now - (calls[0] as number)) + 1);
    }
  }

  async function readBody(res: Response): Promise<string> {
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > MAX_BODY_BYTES) throw new TwelveDataError("BAD_RESPONSE", "response too large");
    const text = await res.text();
    if (text.length > MAX_BODY_BYTES) throw new TwelveDataError("BAD_RESPONSE", "response too large");
    return text;
  }

  type Outcome = { kind: "bars"; bars: Bar[] } | { kind: "rate_limited"; retryAfterMs: number | undefined };

  /** One request. Throws a TwelveDataError for everything that is not a usable answer or a 429. */
  async function requestOnce(url: string, ticker: string, interval: string): Promise<Outcome> {
    await waitForSlot();
    let res: Response;
    try {
      res = await doFetch(url, { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new TwelveDataError("NETWORK", "request to the market-data provider failed"); // no cause: it could echo the request
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, MAX_WAIT_MS) : undefined;
    if (res.status === 429) return { kind: "rate_limited", retryAfterMs };
    if (res.status >= 500) throw new TwelveDataError("SERVER", `provider answered ${res.status}`, res.status);

    let parsed: unknown;
    let text: string;
    try {
      text = await readBody(res);
    } catch (e) {
      if (e instanceof TwelveDataError) throw e;
      throw new TwelveDataError("NETWORK", "reading the response from the market-data provider failed");
    }
    try {
      parsed = JSON.parse(text);
    } catch {
      if (res.status === 401 || res.status === 403) throw new TwelveDataError("AUTH", `provider answered ${res.status}: check the API key and that the plan serves this interval`, res.status);
      if (res.status !== 200) throw new TwelveDataError("BAD_RESPONSE", `provider answered ${res.status}`, res.status);
      throw new TwelveDataError("BAD_RESPONSE", "response is not valid JSON");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      if (res.status !== 200) throw new TwelveDataError("BAD_RESPONSE", `provider answered ${res.status}`, res.status);
      throw new TwelveDataError("BAD_RESPONSE", "response is not an object");
    }
    const body = parsed as Record<string, unknown>;

    // Errors arrive as a JSON body with status:"error" and a `code`, with HTTP 4xx or even 200.
    if (body.status === "error" || res.status !== 200) {
      const code = typeof body.code === "number" && Number.isInteger(body.code) ? body.code : res.status !== 200 ? res.status : undefined;
      if (code === undefined) throw new TwelveDataError("BAD_RESPONSE", "provider reported an error without a code");
      if (code === 429) return { kind: "rate_limited", retryAfterMs };
      if (code >= 500) throw new TwelveDataError("SERVER", `provider answered ${code}`, code);
      if (code === 401 || code === 403) {
        throw new TwelveDataError("AUTH", `provider answered ${code}: check the API key and that the plan serves this interval`, code);
      }
      // The provider answers an empty window with 400 "No data is available on the specified dates". The message
      // is read here but never copied into an error or a log line.
      const msg = typeof body.message === "string" ? body.message : "";
      if ((code === 400 || code === 404) && /no data is available/i.test(msg)) return { kind: "bars", bars: [] };
      if (code === 400) throw new TwelveDataError("BAD_REQUEST", "provider rejected the request (400)", 400);
      throw new TwelveDataError("BAD_RESPONSE", `provider answered ${code}`, code);
    }

    if (body.status !== "ok") throw new TwelveDataError("BAD_RESPONSE", "response status is not ok");
    const meta = body.meta;
    if (meta === null || typeof meta !== "object" || Array.isArray(meta)) throw new TwelveDataError("BAD_RESPONSE", "response has no meta");
    const m = meta as Record<string, unknown>;
    if (typeof m.symbol !== "string" || m.symbol.toUpperCase() !== ticker) throw new TwelveDataError("BAD_RESPONSE", "response is for another symbol");
    if (m.interval !== interval) throw new TwelveDataError("BAD_RESPONSE", "response is for another interval");
    if (!Array.isArray(body.values)) throw new TwelveDataError("BAD_RESPONSE", "response has no values list");
    return { kind: "bars", bars: body.values.map(parseBar) };
  }

  return {
    mode: "live",
    attributionBase: ATTRIBUTION_BASE,
    attributionParams: { interval: "1min" },
    async bars(ticker: string, fromTs: number, toTs: number, intervalSec: number): Promise<Bar[]> {
      const interval = INTERVALS[intervalSec];
      if (interval === undefined) throw new TwelveDataError("BAD_REQUEST", "this adapter serves 1min and 5min bars only (intervalSec 60 or 300)");
      if (typeof ticker !== "string" || !SYMBOL_RE.test(ticker)) throw new TwelveDataError("BAD_REQUEST", "ticker is not a valid symbol");
      if (!Number.isSafeInteger(fromTs) || !Number.isSafeInteger(toTs) || fromTs <= 0 || toTs <= fromTs || toTs - fromTs > MAX_SPAN_SEC) {
        throw new TwelveDataError("BAD_REQUEST", "bad time range (unix seconds, from < to, at most 2 days)");
      }
      const params = new URLSearchParams({
        symbol: ticker,
        interval,
        timezone: "UTC",
        order: "asc",
        outputsize: String(OUTPUT_SIZE),
        start_date: formatUtc(fromTs),
        end_date: formatUtc(toTs - 1), // inclusive on the provider side
      });
      const url = `${base}/time_series?${params.toString()}`;

      let bars: Bar[] | undefined;
      for (let attempt = 0; ; attempt++) {
        const out = await requestOnce(url, ticker, interval);
        if (out.kind === "bars") {
          bars = out.bars;
          break;
        }
        if (attempt >= maxRetries) throw new TwelveDataError("RATE_LIMIT", "provider answered 429 (rate limit) and retries are exhausted", 429);
        const wait = out.retryAfterMs ?? Math.min(BACKOFF_BASE_MS * 2 ** attempt, MAX_WAIT_MS);
        log(`twelvedata: rate limited, retrying in ${Math.ceil(wait / 1000)} s`);
        await sleep(wait);
      }

      // Contract of CandleSource: [fromTs, toTs) by bar start time. Sort and dedupe; two different bars with the
      // same start time are a provider fault, not something to pick from.
      const byTime = new Map<number, Bar>();
      for (const b of bars) {
        if (b.t < fromTs || b.t >= toTs) continue;
        const prev = byTime.get(b.t);
        if (prev !== undefined) {
          if (!sameBar(prev, b)) throw new TwelveDataError("BAD_RESPONSE", "two different bars with the same start time");
          continue;
        }
        byTime.set(b.t, b);
      }
      const result = [...byTime.values()].sort((a, b) => a.t - b.t);
      log(`twelvedata: ${result.length} bars`);
      return result;
    },
  };
}

// ---------------------------------------------------------------------------------------------- throttle

export interface ThrottleOptions {
  /** After a call, the same (ticker, interval, nearly the same window) is answered from memory for this long. Default 60. */
  minIntervalSec?: number;
  /** Injectable wall clock (ms) for tests. */
  nowMs?: () => number;
}

const MAX_DONE = 32;

/**
 * Protects the provider quota from the keeper loop, which polls every few seconds (`planRound` on every tick after
 * a STALE or NO_DATA result, `postCandles` data on every tick until the window is complete).
 *
 * - A request whose (ticker, interval) matches the previous one and whose window has drifted by at most
 *   `2 * minIntervalSec` at the end and starts no earlier than the previous one is answered from memory for
 *   `minIntervalSec`: the previous bars filtered to the new window, or the previous error again. So a failing or
 *   empty or stale loop costs at most one provider call per `minIntervalSec` instead of one per tick. A result
 *   reused this way can lack the newest `minIntervalSec` seconds of bars.
 * - A COMPLETE result for a CLOSED window (aligned to the bar size, every bar present, window ended at least one
 *   bar ago) is cached permanently: asking again never costs a request. A partial result is not cached that way,
 *   because a late provider could still add bars and candles posted on chain are permanent.
 */
export function throttleFeed(inner: PriceFeed, opts: ThrottleOptions = {}): PriceFeed {
  const minSec = opts.minIntervalSec ?? 60;
  if (!Number.isFinite(minSec) || minSec < 0) throw new TwelveDataError("CONFIG", "minIntervalSec must be >= 0");
  const nowMs = opts.nowMs ?? (() => Date.now());
  const drift = 2 * minSec;
  const done = new Map<string, Bar[]>();
  const last = new Map<string, { at: number; from: number; to: number; bars?: Bar[]; error?: unknown }>();
  const copy = (bars: readonly Bar[]): Bar[] => bars.map((b) => ({ ...b }));

  return {
    mode: inner.mode,
    attributionBase: inner.attributionBase,
    attributionParams: inner.attributionParams,
    async bars(ticker: string, fromTs: number, toTs: number, intervalSec: number): Promise<Bar[]> {
      const exact = `${ticker}|${intervalSec}|${fromTs}|${toTs}`;
      const hit = done.get(exact);
      if (hit) return copy(hit);

      const group = `${ticker}|${intervalSec}`;
      const prev = last.get(group);
      if (
        prev !== undefined &&
        nowMs() - prev.at < minSec * 1000 &&
        fromTs >= prev.from &&
        fromTs - prev.from <= drift &&
        Math.abs(toTs - prev.to) <= drift
      ) {
        if (prev.error !== undefined) throw prev.error;
        return copy((prev.bars as Bar[]).filter((b) => b.t >= fromTs && b.t < toTs));
      }

      let bars: Bar[];
      try {
        bars = await inner.bars(ticker, fromTs, toTs, intervalSec);
      } catch (e) {
        last.set(group, { at: nowMs(), from: fromTs, to: toTs, error: e });
        throw e;
      }
      const at = nowMs();
      last.set(group, { at, from: fromTs, to: toTs, bars: copy(bars) });
      const aligned = Number.isSafeInteger(intervalSec) && intervalSec > 0 && fromTs % intervalSec === 0 && toTs % intervalSec === 0;
      const closed = at / 1000 >= toTs + intervalSec;
      if (aligned && closed && bars.length === (toTs - fromTs) / intervalSec) {
        if (done.size >= MAX_DONE) done.delete(done.keys().next().value as string);
        done.set(exact, copy(bars));
      }
      return bars;
    },
  };
}
