// Pure logic for the result screen and the share card (screen 5). Scores are integers 0..100 that come
// from the contract (consensus scores) or from the shared `score` (the user's own path against the real
// candles); nothing here implements scoring, and no float ever enters a score. The card route is public,
// so its query parameters are validated strictly (digits only, bounded, no free text).

import { score, type Path } from "../../../shared/score";
import { parsePath } from "./chainData";
import { NO_ENDORSEMENT, US_NOTICE } from "./disclaimer";

const isScore = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 100;

function assertScore(v: unknown, name: string): asserts v is number {
  if (!isScore(v)) throw new RangeError(`${name} must be an integer score 0..100`);
}

/**
 * The near-miss (or win) line for the user's score against the Agent consensus score, for example
 * "87, 3 short of beating the Agent". Equal integer scores are "level". Callers must pass integers
 * 0..100; anything else throws instead of printing a made-up line.
 */
export function nearMissLine(myScore: number, opponentScore: number): string {
  assertScore(myScore, "myScore");
  assertScore(opponentScore, "opponentScore");
  if (myScore < opponentScore) return `${myScore}, ${opponentScore - myScore} short of beating the Agent`;
  if (myScore === opponentScore) return `${myScore}, level with the Agent`;
  return `${myScore}, beat the Agent by ${myScore - opponentScore}`;
}

/** How the score compares with the flat "price stays at P0" path (rewards are paid only strictly above it). */
export function baselineLine(myScore: number, baseline: number): string {
  assertScore(myScore, "myScore");
  assertScore(baseline, "baseline");
  if (myScore > baseline) return `${myScore - baseline} above the flat-path baseline (${baseline})`;
  if (myScore === baseline) return `Level with the flat-path baseline (${baseline}): no reward`;
  return `${baseline - myScore} below the flat-path baseline (${baseline}): no reward`;
}

// ---- The user's own entry (untrusted contract read) ----

export type EntryRead = { kind: 0 | 1 | 2; revealed: boolean; path: Path };

/** `entryOf` result: [kind, revealed, hash, path]. Null when malformed. Kind: 0 none, 1 Human, 2 Agent. */
export function parseEntryRead(raw: unknown): EntryRead | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const [kind, revealed, hash, path] = raw as unknown[];
  if (kind !== 0 && kind !== 1 && kind !== 2) return null;
  if (typeof revealed !== "boolean") return null;
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return null;
  const p = parsePath(path);
  if (p === null) return null;
  return { kind, revealed, path: p };
}

export type MyResult =
  | { state: "ready"; score: number }
  | { state: "no-wallet" | "loading" | "error" | "no-entry" | "unrevealed" | "agent-entry" };

/**
 * The user's score for a settled round. `entry` is undefined while loading and null when the read failed
 * or was malformed. Only a revealed Human entry has a score here: an unrevealed entry lost its stake and
 * scores nothing. An Agent entry is also scored on-chain against the real candles, but this screen
 * compares a human with the Agent consensus, so it shows no personal score for an Agent entry.
 */
export function deriveMyResult(input: {
  connected: boolean;
  entry: EntryRead | null | undefined;
  real: Path;
  T: number;
}): MyResult {
  if (!input.connected) return { state: "no-wallet" };
  if (input.entry === undefined) return { state: "loading" };
  if (input.entry === null) return { state: "error" };
  if (input.entry.kind === 0) return { state: "no-entry" };
  if (input.entry.kind === 2) return { state: "agent-entry" };
  if (!input.entry.revealed) return { state: "unrevealed" };
  try {
    return { state: "ready", score: score(input.entry.path, input.real, input.T) };
  } catch {
    return { state: "error" };
  }
}

// ---- Share card parameters ----

export type CardParams = {
  /** The user's score, 0..100. */
  me: number;
  /** The Agent consensus score, 0..100. */
  agent: number;
  /** Flat-path baseline score, 0..100. */
  base?: number;
  /** Round id, decimal digits only. */
  round?: string;
  /** Ticker, 1..5 capital letters. */
  ticker?: string;
};

export type CardParse = { ok: true; value: CardParams } | { ok: false };

const SCORE_RE = /^(0|[1-9]\d{0,2})$/;
const ROUND_RE = /^(0|[1-9]\d{0,8})$/;
const TICKER_RE = /^[A-Z]{1,5}$/;

/** One value of `name`: `undefined` if absent, `null` if repeated or malformed. */
function single(q: URLSearchParams, name: string, re: RegExp): string | undefined | null {
  const all = q.getAll(name);
  if (all.length === 0) return undefined;
  if (all.length > 1) return null;
  const v = all[0] as string;
  return re.test(v) ? v : null;
}

function toScore(s: string | undefined | null): number | undefined | null {
  if (s === undefined || s === null) return s;
  const n = Number(s);
  return n <= 100 ? n : null;
}

const CARD_KEYS: ReadonlySet<string> = new Set(["me", "agent", "base", "round", "t"]);

/**
 * Strict parse of the card query: required `me` and `agent`; optional `base`, `round`, `t`. An unknown
 * parameter is rejected, not ignored: otherwise a caller could vary the URL to bypass the shared cache
 * and force a render each time.
 */
export function parseCardParams(q: URLSearchParams): CardParse {
  for (const key of q.keys()) if (!CARD_KEYS.has(key)) return { ok: false };
  const me = toScore(single(q, "me", SCORE_RE));
  const agent = toScore(single(q, "agent", SCORE_RE));
  const base = toScore(single(q, "base", SCORE_RE));
  const round = single(q, "round", ROUND_RE);
  const ticker = single(q, "t", TICKER_RE);
  if (me === undefined || me === null || agent === undefined || agent === null) return { ok: false };
  if (base === null || round === null || ticker === null) return { ok: false };
  return {
    ok: true,
    value: {
      me,
      agent,
      ...(base !== undefined ? { base } : {}),
      ...(round !== undefined ? { round } : {}),
      ...(ticker !== undefined ? { ticker } : {}),
    },
  };
}

/** Relative URL of the share image for these parameters. */
export function cardUrl(p: CardParams): string {
  const q = new URLSearchParams();
  q.set("me", String(p.me));
  q.set("agent", String(p.agent));
  if (p.base !== undefined) q.set("base", String(p.base));
  if (p.round !== undefined) q.set("round", p.round);
  if (p.ticker !== undefined) q.set("t", p.ticker);
  return `/api/card?${q.toString()}`;
}

/**
 * Card parameters from values that may come from the chain or the UI: the two scores are required (they
 * must be integers 0..100, else this throws), an optional field that would not pass `parseCardParams`
 * is dropped instead of being sent.
 */
export function cardParamsFor(input: { me: number; agent: number; base?: number; round?: string; ticker?: string }): CardParams {
  assertScore(input.me, "me");
  assertScore(input.agent, "agent");
  return {
    me: input.me,
    agent: input.agent,
    ...(input.base !== undefined && isScore(input.base) ? { base: input.base } : {}),
    ...(input.round !== undefined && ROUND_RE.test(input.round) ? { round: input.round } : {}),
    ...(input.ticker !== undefined && TICKER_RE.test(input.ticker) ? { ticker: input.ticker } : {}),
  };
}

/**
 * Footer of the share image. The card is posted away from the site and shows a stock ticker, so it carries
 * the full notice and the no-endorsement text, taken from the same constants as every screen.
 */
export const CARD_FOOTER = `${US_NOTICE} ${NO_ENDORSEMENT}`;

/** The card is built from the link alone and is not checked against the chain: say so on the image. */
export function cardVerifyLine(round?: string): string {
  const where = round !== undefined && ROUND_RE.test(round) ? `round #${round}` : "the round";
  return `Self-reported from the link. Verify ${where} on Base Sepolia.`;
}
