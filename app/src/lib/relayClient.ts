// Client of the keeper reveal relay (decision D1; request and answer shapes are in keeper/src/relay.ts):
//   POST {keeper}/reveal  {"id":"12","who":"0x..","path":[{close,high,low} x3],"salt":"0x.."}
//   -> {"ok":bool,"code":"REVEALED"|"ALREADY_REVEALED"|"QUEUED"|"PENDING"|<error code>,"message":"..","tx":"0x.."}
// The relay's answer is untrusted input: only its status code, `ok`, `code` and a 32-byte `tx` are used, and
// every text shown to the user is our own. An answer the app does not understand is "unavailable", never
// success. The relay only ever reveals for a commit that is already on chain and matches the hash.

import type { Address, Hex } from "viem";
import type { Path } from "../../../shared/score";

export const DEFAULT_KEEPER_URL = "http://127.0.0.1:8787";

/**
 * Normalized base URL of the keeper relay. Unset or empty gives the local default, except in a production
 * build, where it means "not configured" (a deployed app must never post secrets to the visitor's localhost).
 * A value that is set but is not an http(s) URL without credentials gives undefined, never a silent fallback.
 */
export function parseKeeperUrl(raw: string | undefined, production = false): string | undefined {
  const v = (raw ?? "").trim();
  if (v === "") return production ? undefined : DEFAULT_KEEPER_URL;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  if (u.username !== "" || u.password !== "") return undefined;
  return `${u.origin}${u.pathname}`.replace(/\/+$/, "");
}

/** `NEXT_PUBLIC_KEEPER_URL` and `NODE_ENV` to the base URL; the localhost default is for development and tests only. */
export function keeperUrlFromEnv(raw: string | undefined, nodeEnv: string | undefined): string | undefined {
  return parseKeeperUrl(raw, nodeEnv === "production");
}

export type RelayOutcome =
  /** The relay says the reveal is on chain. The screen still waits for the chain to show it. */
  | { state: "revealed"; code: string; tx?: Hex }
  /** Accepted; it will be revealed when the reveal window opens. */
  | { state: "queued" }
  /** A reveal was sent and is not confirmed yet. In progress, not a failure. */
  | { state: "pending"; tx?: Hex }
  /** The chain says this can never work (window over, hash mismatch, ...). */
  | { state: "rejected"; code: string; message: string }
  /** Busy, rate limited or a transient chain error: asking again may work. */
  | { state: "retry"; message: string }
  /** Not configured, not reachable (also CORS), timed out, or an answer the app does not understand. */
  | { state: "unavailable"; message: string };

export type RelayRequest = { id: bigint; who: Address; path: Path; salt: Hex };

export type RelayDeps = {
  fetch: typeof fetch;
  /** From `parseKeeperUrl`; undefined means not configured. */
  baseUrl: string | undefined;
  timeoutMs: number;
};

const REJECT_TEXT: Record<string, string> = {
  WRONG_WINDOW: "The reveal window is not open (or is already over), so the relay cannot reveal.",
  NO_COMMIT: "The chain has no commit from this wallet in this round.",
  HASH_MISMATCH: "The saved path and salt do not match your commit on chain, so they cannot be revealed.",
  INVALID_PATH: "The saved path is not a valid path.",
  AGENT_NOT_RELAYED: "The relay reveals for human entries only.",
  UNKNOWN_ROUND: "The relay does not know this round.",
  BAD_REQUEST: "The relay refused the request as malformed.",
  BAD_JSON: "The relay refused the request as malformed.",
  TOO_LARGE: "The relay refused the request as malformed.",
  UNSUPPORTED_MEDIA_TYPE: "The relay refused the request as malformed.",
};
const REJECT_GENERIC = "The relay refused to reveal this entry.";
const RETRY_TEXT: Record<string, string> = {
  RATE_LIMITED: "The relay is rate limiting requests. Try again in a minute.",
  BUSY: "The relay is busy. Try again shortly.",
  RPC_ERROR: "The relay could not reach the chain. Try again shortly.",
  QUEUE_FULL: "The relay queue is full. Try again shortly, or reveal yourself.",
  REVEAL_FAILED: "The relay could not send the reveal. Try again, or reveal yourself.",
  IN_FLIGHT: "The relay is already processing a reveal for you. Check again shortly.",
};
const RETRY_GENERIC = "The relay could not process the request. Try again, or reveal yourself.";
export const NO_RELAY = "The reveal relay is not available. Reveal yourself during the reveal window with the manual reveal button.";
const BAD_ANSWER = "The relay answered in a way this app does not understand. Reveal yourself during the reveal window.";

const isTx = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);

/** Plain text for an outcome. Never contains text from the relay itself. */
export function relayText(o: RelayOutcome): string {
  switch (o.state) {
    case "revealed":
      return "The relay reports that your path was revealed. The chain status above is what counts.";
    case "queued":
      return "The relay holds your path and will reveal it for you when the reveal window opens.";
    case "pending":
      return "The relay sent your reveal and is waiting for the chain to confirm it.";
    case "rejected":
      return REJECT_TEXT[o.code] ?? REJECT_GENERIC;
    case "retry":
    case "unavailable":
      return o.message;
  }
}

/** Sends the path and salt to the relay. Never throws. */
export async function postReveal(deps: RelayDeps, req: RelayRequest): Promise<RelayOutcome> {
  if (deps.baseUrl === undefined) return { state: "unavailable", message: NO_RELAY };
  const body = JSON.stringify({
    id: req.id.toString(),
    who: req.who,
    path: req.path.map((c) => ({ close: c.close, high: c.high, low: c.low })),
    salt: req.salt,
  });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), deps.timeoutMs);
  let res: Response;
  let text: string;
  try {
    res = await deps.fetch(`${deps.baseUrl}/reveal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      credentials: "omit",
      cache: "no-store",
      signal: ctl.signal,
    });
    text = await res.text();
  } catch {
    return { state: "unavailable", message: NO_RELAY };
  } finally {
    clearTimeout(timer);
  }

  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return { state: "unavailable", message: BAD_ANSWER };
  }
  if (j === null || typeof j !== "object" || Array.isArray(j)) return { state: "unavailable", message: BAD_ANSWER };
  const { ok, code, tx } = j as { ok?: unknown; code?: unknown; tx?: unknown };
  if (typeof ok !== "boolean" || typeof code !== "string") return { state: "unavailable", message: BAD_ANSWER };
  const txHex = isTx(tx) ? { tx } : {};

  if (res.status === 200 && ok && (code === "REVEALED" || code === "ALREADY_REVEALED")) {
    return { state: "revealed", code, ...txHex };
  }
  if (res.status === 202 && ok && code === "QUEUED") return { state: "queued" };
  if (res.status === 202 && ok && code === "PENDING") return { state: "pending", ...txHex };
  if (ok || res.status < 400) return { state: "unavailable", message: BAD_ANSWER };

  if (Object.hasOwn(REJECT_TEXT, code)) return { state: "rejected", code, message: REJECT_TEXT[code] as string };
  return { state: "retry", message: Object.hasOwn(RETRY_TEXT, code) ? (RETRY_TEXT[code] as string) : RETRY_GENERIC };
}
