// Alpaca Market Data adapter (free Basic plan, IEX feed) behind the `PriceFeed` / `CandleSource` interface.
//
//   GET https://data.alpaca.markets/v2/stocks/bars?symbols=<S>&timeframe=1Min&start=..&end=..&feed=iex
//
// - `feed=iex` is always sent explicitly: the default `sip` returns 403 for recent data on the free plan.
// - Credentials (APCA-API-KEY-ID, APCA-API-SECRET-KEY) come from the environment, are sent only as request
//   headers and never appear in a log line, an error message or a URL.
// - The response is untrusted data: it is size-limited, parsed defensively and every bar is validated.
// - Rate limit: the free plan allows 200 calls/min; this adapter spends at most `maxCallsPerMin` (default
//   150) and waits instead of exceeding it. After a 429 it refuses calls until the cool-down ends.
// - No data (empty bars) is returned as `[]`; the caller decides (the keeper then does not post, and the
//   round voids rather than receive invented candles).
// - Licensing: Alpaca forbids redistributing its data. This module returns bars to the keeper only; the keeper
//   publishes bp moves relative to P0 and a generic attribution URL (see source.ts).
import type { Bar } from "./candles";
import type { PriceFeed } from "./source";

const DEFAULT_BASE_URL = "https://data.alpaca.markets";
const ATTRIBUTION_BASE = "https://alpaca.markets/data";
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_PAGES = 5;
const MAX_SPAN_SEC = 2 * 24 * 3600;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_COOLDOWN_MS = 30_000;
const SYMBOL_RE = /^[A-Z][A-Z0-9.]{0,9}$/;

export class AlpacaError extends Error {
  constructor(
    readonly code: "CONFIG" | "AUTH" | "RATE_LIMIT" | "SERVER" | "NETWORK" | "BAD_RESPONSE" | "BAD_REQUEST",
    message: string,
    /** HTTP status when the error came from a response. */
    readonly status?: number,
  ) {
    super(message);
    this.name = "AlpacaError";
  }
}

export interface AlpacaOptions {
  keyId: string;
  secretKey: string;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  baseUrl?: string;
  /** Default 150 (the plan allows 200/min; the margin covers retries and other tools sharing the key). */
  maxCallsPerMin?: number;
  /** Injectable clock (ms) and sleep for tests. */
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

/** Reads APCA_API_KEY_ID and APCA_API_SECRET_KEY. The error never contains a value. */
export function loadAlpacaCredentials(env: Record<string, string | undefined> = process.env): { keyId: string; secretKey: string } {
  const keyId = env.APCA_API_KEY_ID;
  const secretKey = env.APCA_API_SECRET_KEY;
  if (!keyId || !secretKey) throw new AlpacaError("CONFIG", "missing environment variable APCA_API_KEY_ID or APCA_API_SECRET_KEY");
  return { keyId, secretKey };
}

function isoSeconds(ts: number): string {
  return new Date(ts * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function num(x: unknown): number | undefined {
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
}

/** One raw API item -> Bar, or throws BAD_RESPONSE. `t` is an RFC 3339 string (bar start). */
function parseBar(item: unknown): Bar {
  const bad = (): never => {
    throw new AlpacaError("BAD_RESPONSE", "a bar in the response has an unexpected shape");
  };
  if (item === null || typeof item !== "object") return bad();
  const r = item as Record<string, unknown>;
  if (typeof r.t !== "string") return bad();
  const ms = Date.parse(r.t);
  const open = num(r.o);
  const high = num(r.h);
  const low = num(r.l);
  const close = num(r.c);
  if (!Number.isFinite(ms) || open === undefined || high === undefined || low === undefined || close === undefined) return bad();
  const t = Math.floor(ms / 1000);
  if (t <= 0) return bad();
  return { t, open, high, low, close };
}

export function createAlpacaSource(opts: AlpacaOptions): PriceFeed {
  if (!opts.keyId || !opts.secretKey) throw new AlpacaError("CONFIG", "Alpaca credentials are required");
  const doFetch = opts.fetch ?? fetch;
  const base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const maxCalls = opts.maxCallsPerMin ?? 150;
  const nowMs = opts.nowMs ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const log = opts.log ?? (() => {});
  const headers = { "APCA-API-KEY-ID": opts.keyId, "APCA-API-SECRET-KEY": opts.secretKey, accept: "application/json" };

  const calls: number[] = []; // start times (ms) of calls in the last minute
  let blockedUntil = 0;

  async function waitForSlot(): Promise<void> {
    for (;;) {
      const now = nowMs();
      if (now < blockedUntil) throw new AlpacaError("RATE_LIMIT", `rate limited by the provider; retry in ${Math.ceil((blockedUntil - now) / 1000)} s`, 429);
      while (calls.length > 0 && now - (calls[0] as number) >= 60_000) calls.shift();
      if (calls.length < maxCalls) {
        calls.push(now);
        return;
      }
      await sleep(60_000 - (now - (calls[0] as number)) + 1);
    }
  }

  async function readBody(res: Response): Promise<string> {
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > MAX_BODY_BYTES) throw new AlpacaError("BAD_RESPONSE", "response too large");
    const text = await res.text();
    if (text.length > MAX_BODY_BYTES) throw new AlpacaError("BAD_RESPONSE", "response too large");
    return text;
  }

  async function getPage(params: URLSearchParams): Promise<{ bars: Bar[]; next: string | undefined }> {
    await waitForSlot();
    const url = `${base}/v2/stocks/bars?${params.toString()}`;
    let res: Response;
    try {
      res = await doFetch(url, { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new AlpacaError("NETWORK", "request to the market-data provider failed"); // no cause: it could echo the request
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      blockedUntil = nowMs() + (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : DEFAULT_COOLDOWN_MS);
      throw new AlpacaError("RATE_LIMIT", "provider answered 429 (rate limit)", 429);
    }
    if (res.status === 401 || res.status === 403) {
      throw new AlpacaError("AUTH", `provider answered ${res.status}: check the credentials, the plan and feed=iex`, res.status);
    }
    if (res.status >= 500) throw new AlpacaError("SERVER", `provider answered ${res.status}`, res.status);
    if (res.status !== 200) throw new AlpacaError("BAD_RESPONSE", `provider answered ${res.status}`, res.status);

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(res));
    } catch (e) {
      if (e instanceof AlpacaError) throw e;
      throw new AlpacaError("BAD_RESPONSE", "response is not valid JSON");
    }
    if (parsed === null || typeof parsed !== "object") throw new AlpacaError("BAD_RESPONSE", "response is not an object");
    const body = parsed as Record<string, unknown>;
    const symbol = params.get("symbols") as string;
    const perSymbol = body.bars;
    let items: unknown[] = [];
    if (perSymbol !== null && perSymbol !== undefined) {
      if (typeof perSymbol !== "object" || Array.isArray(perSymbol)) throw new AlpacaError("BAD_RESPONSE", "bars has an unexpected shape");
      const list = (perSymbol as Record<string, unknown>)[symbol];
      if (list !== null && list !== undefined) {
        if (!Array.isArray(list)) throw new AlpacaError("BAD_RESPONSE", "bars of the symbol is not a list");
        items = list;
      }
    }
    const next = typeof body.next_page_token === "string" && body.next_page_token.length > 0 ? body.next_page_token : undefined;
    return { bars: items.map(parseBar), next };
  }

  return {
    mode: "live",
    attributionBase: ATTRIBUTION_BASE,
    attributionParams: { feed: "iex" },
    async bars(ticker: string, fromTs: number, toTs: number, intervalSec: number): Promise<Bar[]> {
      if (intervalSec !== 60) throw new AlpacaError("BAD_REQUEST", "this adapter serves 1Min bars only (intervalSec must be 60)");
      if (typeof ticker !== "string" || !SYMBOL_RE.test(ticker)) throw new AlpacaError("BAD_REQUEST", "ticker is not a valid symbol");
      if (!Number.isSafeInteger(fromTs) || !Number.isSafeInteger(toTs) || fromTs <= 0 || toTs <= fromTs || toTs - fromTs > MAX_SPAN_SEC) {
        throw new AlpacaError("BAD_REQUEST", "bad time range (unix seconds, from < to, at most 2 days)");
      }
      const out: Bar[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const params = new URLSearchParams({
          symbols: ticker,
          timeframe: "1Min",
          start: isoSeconds(fromTs),
          end: isoSeconds(toTs),
          limit: "10000",
          adjustment: "raw",
          feed: "iex",
          sort: "asc",
        });
        if (pageToken) params.set("page_token", pageToken);
        const { bars, next } = await getPage(params);
        out.push(...bars);
        if (!next) {
          pageToken = undefined;
          break;
        }
        pageToken = next;
      }
      if (pageToken) throw new AlpacaError("BAD_RESPONSE", "too many pages");
      // `end` is inclusive on the provider side; the contract of CandleSource is [fromTs, toTs). Sort and dedupe.
      const seen = new Set<number>();
      const result = out
        .filter((b) => b.t >= fromTs && b.t < toTs)
        .sort((a, b) => a.t - b.t)
        .filter((b) => (seen.has(b.t) ? false : (seen.add(b.t), true)));
      log(`alpaca: ${result.length} bars`);
      return result;
    },
  };
}
