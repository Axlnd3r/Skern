// Durable keeper state: which rounds the loop planned, which id each got, and how far each one is.
//
// The round config is saved (stage "planned") BEFORE `openRound` is sent, because the dedup in `openRound`
// only matches an identical parameter tuple: after a crash the loop must re-use the exact same config, not
// build a fresh one from newer prices. The file never contains a key, only round parameters and ids.
// (It holds each round's p0, the same reference price the contract stores on-chain; no other prices.)
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { Candle } from "../../shared/score";
import type { RoundConfig } from "./rounds";

export type Stage = "planned" | "open" | "frozen" | "done";
export type Outcome =
  | "settled"
  | "missed_deadline"
  | "posted_different"
  | "open_failed"
  | "id_mismatch";

/** `RoundConfig` with its bigints as decimal strings (JSON has no bigint). */
export interface StoredConfig {
  ticker: string;
  p0: string;
  T: number;
  commitEnd: number;
  revealEnd: number;
  marketEnd: number;
  candleSec: number;
  settleDeadline: number;
  entryStake: string;
}

export interface StoredRound {
  /** 1, 2, 3, ... in the order the loop planned them. */
  seq: number;
  cfg: StoredConfig;
  /** Block number when the round was planned: lower bound of the `RoundOpened` log scan. */
  fromBlock: string;
  /** Round id on chain, once known. */
  id?: string;
  stage: Stage;
  outcome?: Outcome;
  /** The missed-settleDeadline alert was already raised. */
  missedAlerted?: boolean;
  /**
   * Pre-round candles from the bars the keeper planned this round with: int32 bp relative to this round's P0,
   * oldest first, `{close, high, low}`. Served by `GET /context/:id`, so no provider call is needed later.
   * Absent in state files written before this field existed (served as an empty history).
   */
  historyBp?: Candle[];
}

export interface KeeperState {
  version: 1;
  chainId: number;
  arena: string;
  rounds: StoredRound[];
}

export class StateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateError";
  }
}

export function serializeConfig(c: RoundConfig): StoredConfig {
  return { ...c, p0: c.p0.toString(), entryStake: c.entryStake.toString() };
}

export function deserializeConfig(s: StoredConfig): RoundConfig {
  return { ...s, p0: BigInt(s.p0), entryStake: BigInt(s.entryStake) };
}

export interface StateStore {
  /** Returns the persisted state, or an empty state for `chainId`/`arena` if none exists. Throws on a corrupt file or a different chain/arena. */
  load(chainId: number, arena: string): KeeperState;
  save(state: KeeperState): void;
}

export function emptyState(chainId: number, arena: string): KeeperState {
  return { version: 1, chainId, arena: arena.toLowerCase(), rounds: [] };
}

const STAGES: readonly string[] = ["planned", "open", "frozen", "done"];

function parseState(text: string, file: string): KeeperState {
  const bad = (why: string): never => {
    throw new StateError(`keeper state ${file} is corrupt (${why}); it was NOT modified, inspect it by hand`);
  };
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return bad("not JSON");
  }
  if (j === null || typeof j !== "object") return bad("not an object");
  const s = j as Partial<KeeperState>;
  if (s.version !== 1 || !Number.isSafeInteger(s.chainId) || typeof s.arena !== "string" || !Array.isArray(s.rounds)) return bad("shape");
  for (const r of s.rounds) {
    if (r === null || typeof r !== "object") return bad("round");
    if (!Number.isSafeInteger(r.seq) || !STAGES.includes(r.stage) || typeof r.fromBlock !== "string" || !/^\d+$/.test(r.fromBlock)) return bad("round fields");
    if (r.id !== undefined && !/^[1-9]\d*$/.test(r.id)) return bad("round id");
    if (r.historyBp !== undefined) {
      if (!Array.isArray(r.historyBp) || r.historyBp.length > 1000) return bad("round history");
      for (const c of r.historyBp as unknown[]) {
        const o = c as Record<string, unknown> | null;
        if (o === null || typeof o !== "object") return bad("round history candle");
        for (const k of ["close", "high", "low"]) {
          const v = o[k];
          if (typeof v !== "number" || !Number.isInteger(v) || v < -2147483648 || v > 2147483647) return bad("round history candle");
        }
      }
    }
    const c = r.cfg as StoredConfig | undefined;
    if (!c || typeof c.ticker !== "string" || !/^\d+$/.test(String(c.p0)) || !/^\d+$/.test(String(c.entryStake))) return bad("round cfg");
    for (const k of ["T", "commitEnd", "revealEnd", "marketEnd", "candleSec", "settleDeadline"] as const) {
      if (!Number.isSafeInteger(c[k])) return bad(`round cfg ${k}`);
    }
  }
  return s as KeeperState;
}

/** Writes `data` to `file` atomically (temp file in the same directory, fsync, rename), mode 0600, directory 0700. */
export function writeFileAtomic(file: string, data: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw new StateError(`cannot write ${file}: ${(e as Error).message}`);
  }
}

/** Atomic JSON state file. */
export class FileStateStore implements StateStore {
  constructor(readonly file: string) {}

  load(chainId: number, arena: string): KeeperState {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyState(chainId, arena);
      throw new StateError(`cannot read keeper state ${this.file}: ${(e as Error).message}`);
    }
    const s = parseState(text, this.file);
    if (s.chainId !== chainId || s.arena.toLowerCase() !== arena.toLowerCase()) {
      throw new StateError(`keeper state ${this.file} belongs to chain ${s.chainId} / arena ${s.arena}, not chain ${chainId} / arena ${arena}`);
    }
    return s;
  }

  save(state: KeeperState): void {
    writeFileAtomic(this.file, JSON.stringify(state, null, 2) + "\n");
  }
}

/** In-memory store for tests; survives "restarts" when the same instance is passed to a new loop. */
export class MemoryStateStore implements StateStore {
  saves = 0;
  private data: string | undefined;

  load(chainId: number, arena: string): KeeperState {
    if (this.data === undefined) return emptyState(chainId, arena);
    return JSON.parse(this.data) as KeeperState;
  }

  save(state: KeeperState): void {
    this.saves++;
    this.data = JSON.stringify(state);
  }
}
