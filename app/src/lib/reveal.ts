// Pure logic for the reveal screen: which real candles are visible at a step, the live score at that
// step, and validation of the contract reads (untrusted). No scoring is implemented here: every score
// comes from `score` in shared/score.ts (bigint math, no float).

import { isValid, score, type Candle, type Path } from "../../../shared/score";
import { parseBaseline, parsePath, parseScores, successOf, type ConsensusScores } from "./chainData";
import type { Phase } from "./round";

export { parseScores, type ConsensusScores };

export const STEP_COUNT = 3;
/** Animation speed of the replay: one candle per step. */
export const STEP_MS = 1500;

/** Whole step within 0..3; anything non-finite is 0. */
export function clampStep(step: number): number {
  if (typeof step !== "number" || !Number.isFinite(step)) return 0;
  return Math.min(STEP_COUNT, Math.max(0, Math.floor(step)));
}

export function nextStep(step: number): number {
  return Math.min(STEP_COUNT, clampStep(step) + 1);
}

export type RevealInput = {
  real: Path;
  /** Frozen human consensus path, or null when that side has none (no reveals / not ready). */
  human: Path | null;
  agent: Path | null;
  /** Round tolerance in bp (uint32). */
  T: number;
};

export type RevealFrame = {
  step: number;
  /** Only the real candles revealed so far: exactly `step` of them. */
  real: Candle[];
  humanScore: number | null;
  agentScore: number | null;
  done: boolean;
};

/**
 * Score of `pred` after `step` real candles are known. `score` needs 3 candles on both sides, so the
 * candles that are not revealed yet are filled with the path's own candles (not with the hidden real
 * ones). This is an estimate under that assumption, not a bound: the first unrevealed candle still opens
 * at the real close of the previous candle, so even a filled-in candle can score below 100 (its open,
 * and so its direction, comes from the real path). The value depends only on real candles 1..step. At
 * step 3 it is exactly `score(pred, real, T)`, the on-chain value.
 */
function scoreSoFar(pred: Path | null, real: Path, T: number, step: number): number | null {
  if (pred === null || step === 0) return null;
  const hybrid = [...real.slice(0, step), ...pred.slice(step)] as unknown as Path;
  try {
    return score(pred, hybrid, T);
  } catch {
    return null;
  }
}

/** The frame shown after `step` steps. Deterministic in its inputs, so a replay is faithful. */
export function revealFrame(input: RevealInput, step: number): RevealFrame {
  const n = clampStep(step);
  return {
    step: n,
    real: input.real.slice(0, n),
    humanScore: scoreSoFar(input.human, input.real, input.T, n),
    agentScore: scoreSoFar(input.agent, input.real, input.T, n),
    done: n === STEP_COUNT,
  };
}

// ---- Untrusted contract reads ----

/** `realCandles` result: [real (3 valid candles), sourceHash (bytes32)]. */
export function parseRealCandles(raw: unknown): { real: Path; sourceHash: string } | null {
  if (!Array.isArray(raw) || raw.length !== 2) return null;
  const [candles, sourceHash] = raw as unknown[];
  if (typeof sourceHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(sourceHash)) return null;
  const real = parsePath(candles);
  if (real === null || !isValid(real)) return null;
  return { real, sourceHash };
}

/**
 * Whether the local replay (the shared `score` at step 3) equals the scores the contract stored.
 * A side the contract flags absent has no score and must have no local score either.
 */
export function scoresAgree(
  local: { humanScore: number | null; agentScore: number | null },
  chain: ConsensusScores,
): boolean {
  const human = chain.humanPresent ? local.humanScore === chain.human : local.humanScore === null;
  const agent = chain.agentPresent ? local.agentScore === chain.agent : local.agentScore === null;
  return human && agent;
}

export type RevealReads = {
  real: Path;
  sourceHash: string;
  human: Path | null;
  agent: Path | null;
  scores?: ConsensusScores;
  baseline?: number;
};

/** A consensus path is used only when the contract says it is `ready` and the data parses. */
function readyPath(r: unknown): Path | null {
  const s = successOf(r);
  if (s === null || !Array.isArray(s.result) || s.result.length !== 2) return null;
  const [path, ready] = s.result as unknown[];
  return ready === true ? parsePath(path) : null;
}

/**
 * Parses the reveal multicall (allowFailure): [realCandles, consensus(human), consensus(agent),
 * consensusScores, baselineScore]. Only `realCandles` is essential; the rest degrade honestly.
 */
export function parseRevealReads(results: readonly unknown[] | undefined): RevealReads | null {
  if (!results || results.length !== 5) return null;
  const [realR, humanR, agentR, scoresR, baseR] = results;
  const realS = successOf(realR);
  if (realS === null) return null;
  const real = parseRealCandles(realS.result);
  if (real === null) return null;
  const scoresS = successOf(scoresR);
  const baseS = successOf(baseR);
  const scores = scoresS !== null ? parseScores(scoresS.result) : null;
  const baseline = baseS !== null ? parseBaseline(baseS.result) : null;
  return {
    real: real.real,
    sourceHash: real.sourceHash,
    human: readyPath(humanR),
    agent: readyPath(agentR),
    ...(scores !== null ? { scores } : {}),
    ...(baseline !== null ? { baseline } : {}),
  };
}

export type RevealState = "waiting" | "pending" | "void" | "loading" | "error" | "ready";

export type RevealView = {
  state: RevealState;
  message: string;
  reads?: RevealReads;
};

/**
 * What the reveal screen can honestly show. `reads` is undefined while loading, null when the reads
 * failed or were malformed. Real candles exist only once the round is `settled`.
 */
export function deriveReveal(input: { phase: Phase; reads: RevealReads | null | undefined }): RevealView {
  switch (input.phase) {
    case "commit":
    case "reveal":
    case "market":
      return { state: "waiting", message: "The real candles do not exist yet. The reveal starts after the market closes and the keeper posts them." };
    case "play":
      return {
        state: "pending",
        message: "Waiting for the keeper to post the real candles. They can be posted only after the last candle has closed.",
      };
    case "void":
      return {
        state: "void",
        message: "This round did not settle (void): no real candles were posted in time. There is nothing to replay and no score; entry and market stakes are refundable.",
      };
    case "settled":
      if (input.reads === undefined) return { state: "loading", message: "Reading the posted candles..." };
      if (input.reads === null) return { state: "error", message: "Could not read valid real candles from the chain." };
      return { state: "ready", message: "", reads: input.reads };
  }
}

// ---- Chart range (display only; integers in, integer out) ----

/** Half-range in bp that contains every field of every candle list given, with a margin, and at least T and 1. */
export function fitBound(paths: readonly (readonly Candle[])[], T: number): number {
  let m = Number.isFinite(T) && T > 0 ? Math.floor(T) : 0;
  for (const p of paths) {
    for (const c of p) m = Math.max(m, Math.abs(c.close), Math.abs(c.high), Math.abs(c.low));
  }
  m = Math.max(1, m);
  return m + Math.ceil(m / 10);
}

/** One line on who won, from the two consensus scores (equal integer scores are a tie). */
export function outcomeLine(humanScore: number | null, agentScore: number | null): string {
  if (humanScore === null || agentScore === null) return "Only one consensus took part, so there is no Human versus Agent result.";
  if (humanScore === agentScore) return `Tie at ${humanScore}: stakes are refunded.`;
  return humanScore > agentScore
    ? `The Human consensus scored higher: ${humanScore} to ${agentScore}.`
    : `The Agent consensus scored higher: ${agentScore} to ${humanScore}.`;
}
