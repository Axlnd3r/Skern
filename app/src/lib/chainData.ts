// Validators for data read from the chain. Everything a contract returns is untrusted: it is checked
// for type and range before it reaches the UI or a score. Failures return null, never a partial value.

import { isValid, type Candle, type Path } from "../../../shared/score";

export const isBig = (v: unknown): v is bigint => typeof v === "bigint";

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

const isInt32 = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= INT32_MIN && v <= INT32_MAX;

/** A successful multicall entry (`allowFailure: true` shape). */
export function successOf(r: unknown): { result: unknown } | null {
  if (typeof r !== "object" || r === null) return null;
  const e = r as { status?: unknown; result?: unknown };
  return e.status === "success" ? { result: e.result } : null;
}

/** 3 candles, every field an int32 and the whole path valid (low/high contain open and close). */
export function parsePath(raw: unknown): Path | null {
  if (!Array.isArray(raw) || raw.length !== 3) return null;
  const out: Candle[] = [];
  for (let i = 0; i < 3; i++) {
    const c = raw[i] as { close?: unknown; high?: unknown; low?: unknown } | null | undefined;
    if (typeof c !== "object" || c === null) return null;
    if (!isInt32(c.close) || !isInt32(c.high) || !isInt32(c.low)) return null;
    out.push({ close: c.close, high: c.high, low: c.low });
  }
  const path = out as unknown as Path;
  return isValid(path) ? path : null;
}

export type ConsensusScores = { human: number; agent: number; humanPresent: boolean; agentPresent: boolean };

const isScore = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 100;

/** `consensusScores` result: [human, agent, humanPresent, agentPresent], scores integers 0..100. */
export function parseScores(raw: unknown): ConsensusScores | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const [human, agent, humanPresent, agentPresent] = raw as unknown[];
  if (!isScore(human) || !isScore(agent)) return null;
  if (typeof humanPresent !== "boolean" || typeof agentPresent !== "boolean") return null;
  return { human, agent, humanPresent, agentPresent };
}

/** `baselineScore` result: an integer 0..100. */
export function parseBaseline(raw: unknown): number | null {
  return isScore(raw) ? raw : null;
}
