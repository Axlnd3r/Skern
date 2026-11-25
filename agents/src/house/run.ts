// House runner: makes the three house agents (momentum, meanReversion, newsLlm) play every round.
//
// Run (from the repo root, with the three throwaway testnet wallets in agents/.env.house):
//
//   pnpm dlx tsx agents/src/house/run.ts
//
// Configuration (process environment, see agents/.env.example)
//   HOUSE_WALLETS_FILE   env-style file with MOMENTUM_PRIVATE_KEY, MEANREVERSION_PRIVATE_KEY and
//                        NEWSLLM_PRIVATE_KEY (default: agents/.env.house). Only these three variables are read from it.
//   RPC_URL, CHAIN_ID, ARENA_ADDRESS   default to Base Sepolia and the Arena in shared/addresses.json.
//   KEEPER_URL           base URL of the keeper context endpoint: GET {KEEPER_URL}/context/:id returns a RoundContext.
//                        Not ready (404 before the keeper opened the round, timeout, invalid): the round is retried on
//                        every poll; only within 30 s of the end of the commit window do the agents play with an empty
//                        history (warning logged). Unset: empty history at once.
//   AGENT_SALT_DIR       where salt files live (default ~/.consensus-path/salts; one file per round and wallet).
//   HOUSE_POLL_MS        poll interval in ms (default 3000, minimum 1000).
//   ANTHROPIC_API_KEY    optional; without it the News LLM agent uses its momentum rule.
//
// What it does
//  - Builds one SDK `Agent` per wallet with loadAgentConfig / createAgentDeps / createAgent, the same path an
//    outside agent uses. Commits go through `agent.submitPath`, which validates the path, persists the salt BEFORE
//    the commit transaction and schedules the reveal for its window. On start `resumePending` re-arms the reveals
//    of a previous run, so a restart inside a window never double-commits and never misses a reveal.
//  - Every ~3 s (one poll at a time, never overlapping) it reads the newest rounds. For every round still in its
//    commit phase and not yet committed on chain by a wallet, it fetches the context once per round, calls the
//    agent's `predict`, checks the path with `isValid` and submits it. At most one commit per agent and round: the
//    chain (`entryOf`) is the authority. A failed commit is logged and retried on the next poll, only while the
//    commit window is open and for a bounded number of attempts.
//  - SIGINT / SIGTERM stop the loop; scheduled reveals stop with the process and are resumed by the next start.
//
// Safety: keys come from the wallet file only and are never logged. Logs carry the round id, the agent name and a
// short outcome; the only value derived from a path is the on-chain commit hash (which includes the salt).
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getAddress, hexToString, isAddress, type Address, type Hex, type PublicClient } from "viem";
import { isValid } from "../../../shared/score";
import { SaltStore } from "../salt";
import { AgentError, arenaAbi, createAgent, createAgentDeps, loadAgentConfig, shortMessage, systemClock, type Agent, type AgentDeps } from "../sdk";
import { predict as meanReversionPredict, name as meanReversionName } from "./meanReversion";
import { predict as momentumPredict, name as momentumName } from "./momentum";
import { createNewsLlm, name as newsLlmName } from "./newsLlm";
import { INT32_MAX, INT32_MIN, assertContext, cleanHistory, houseAddresses, isHouseAgent, type Candle, type Path, type RoundContext } from "./types";

// ---------------------------------------------------------------------------------------------- constants

export const DEFAULT_POLL_MS = 3_000;
const MIN_ENV_POLL_MS = 1_000;
const DEFAULT_SCAN_ROUNDS = 5;
const DEFAULT_MAX_ATTEMPTS = 20;
const DEFAULT_CONTEXT_TIMEOUT_MS = 5_000;
const DEFAULT_CONTEXT_FALLBACK_SEC = 30;
const MAX_CONTEXT_BYTES = 1_000_000;
const MAX_HISTORY = 200;
const MAX_HEADLINES = 50;
const MAX_HEADLINE_CHARS = 1_000;
const DEFAULT_RPC_URL = "https://sepolia.base.org";

export type HouseName = typeof momentumName | typeof meanReversionName | typeof newsLlmName;

/** Wallet file variable per agent. */
export const WALLET_VARS: Record<HouseName, string> = {
  [momentumName]: "MOMENTUM_PRIVATE_KEY",
  [meanReversionName]: "MEANREVERSION_PRIVATE_KEY",
  [newsLlmName]: "NEWSLLM_PRIVATE_KEY",
} as Record<HouseName, string>;

const HOUSE_ORDER: HouseName[] = [momentumName, meanReversionName, newsLlmName];

// ---------------------------------------------------------------------------------------------- wallet file

/** A tiny env-file parser: `KEY=VALUE` lines, `#` comments, optional `export `, optional matching quotes. */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = (m[2] as string).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) value = value.slice(1, -1);
    out[m[1] as string] = value;
  }
  return out;
}

/** `agents/.env.house`, resolved from this file (not from the current directory). */
export function defaultWalletsFile(): string {
  return fileURLToPath(new URL("../../.env.house", import.meta.url));
}

/**
 * The three private keys from the wallet file. Throws an AgentError that never contains the file content or a key
 * value: only the file path, the variable names and a reason.
 */
export function loadHouseWallets(file: string): Record<HouseName, Hex> {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | undefined)?.code ?? "error";
    throw new AgentError("CONFIG", `cannot read the house wallet file ${file} (${code}); set HOUSE_WALLETS_FILE`);
  }
  const vars = parseEnvText(text);
  const out = {} as Record<HouseName, Hex>;
  const seen = new Map<string, string>();
  for (const name of HOUSE_ORDER) {
    const variable = WALLET_VARS[name];
    const raw = vars[variable];
    const key = raw !== undefined && /^(0x)?[0-9a-fA-F]{64}$/.test(raw) ? (`0x${raw.replace(/^0x/, "")}`.toLowerCase() as Hex) : undefined;
    if (!key) throw new AgentError("CONFIG", `${variable} in ${file} is missing or is not 64 hex characters (optionally prefixed by 0x)`);
    const other = seen.get(key);
    if (other) throw new AgentError("CONFIG", `${variable} and ${other} hold the same wallet; each house agent needs its own wallet`);
    seen.set(key, variable);
    out[name] = key;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- keeper context

/**
 * Validates the JSON the keeper returns for a round and builds the `RoundContext`. The chain is the authority for
 * ticker and T: the keeper's values must match them (a stale or wrong round is rejected). History entries must be
 * int32 integers (bp relative to P0) with high >= low. Throws a plain Error with a short reason; the reason never
 * echoes the payload.
 */
export function parseKeeperContext(json: unknown, chain: { ticker: string; T: number }): RoundContext {
  if (json === null || typeof json !== "object" || Array.isArray(json)) throw new Error("context is not a JSON object");
  const o = json as Record<string, unknown>;
  if (o.ticker !== chain.ticker) throw new Error("context ticker does not match the round");
  if (typeof o.T !== "number" || !Number.isInteger(o.T) || o.T !== chain.T) throw new Error("context T does not match the round");
  if (o.candleCount !== 3) throw new Error("context candleCount must be 3");
  const hist = o.recentCandlesBp;
  if (!Array.isArray(hist) || hist.length > MAX_HISTORY) throw new Error(`recentCandlesBp must be an array of at most ${MAX_HISTORY} candles`);
  const isInt32 = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= INT32_MIN && v <= INT32_MAX;
  const candles: Candle[] = [];
  for (const c of hist as unknown[]) {
    if (c === null || typeof c !== "object") throw new Error("a history candle is not an object");
    const { close, high, low } = c as Record<string, unknown>;
    if (!isInt32(close) || !isInt32(high) || !isInt32(low) || high < low) throw new Error("a history candle has a non-int32 field or high < low");
    candles.push({ close: close + 0, high: high + 0, low: low + 0 });
  }
  let headlines: string[] | undefined;
  if (o.headlines !== undefined) {
    const h = o.headlines;
    if (!Array.isArray(h) || h.length > MAX_HEADLINES || h.some((x) => typeof x !== "string" || x.length > MAX_HEADLINE_CHARS)) {
      throw new Error("headlines must be an array of short strings");
    }
    headlines = h as string[];
  }
  const ctx: RoundContext = { ticker: chain.ticker, T: chain.T, candleCount: 3, recentCandlesBp: candles, ...(headlines ? { headlines } : {}) };
  assertContext(ctx);
  if (cleanHistory(ctx).length !== candles.length) throw new Error("history holds unusable candles");
  return ctx;
}

// ---------------------------------------------------------------------------------------------- runner

export interface Player {
  name: string;
  agent: Agent;
  predict(ctx: RoundContext): Promise<Path>;
  /**
   * The path of this wallet's persisted salt record for a round, if there is one (a commit that was sent but did not
   * land, or a run that died before the status update). The SDK refuses a different path for such a round, so it
   * must be reused instead of predicting again.
   */
  storedPath?(id: bigint): Path | undefined;
}

export interface RunnerOptions {
  players: readonly Player[];
  /** Used for the chain time, the round list and `entryOf`. */
  publicClient: PublicClient;
  arenaAddress: Address;
  /** Base URL of the keeper (no trailing path). Unset: empty history. */
  keeperUrl?: string | undefined;
  pollMs?: number;
  /** How many of the newest rounds are looked at on each poll. */
  scanRounds?: number;
  /** Commit attempts per agent and round before giving up. */
  maxAttempts?: number;
  contextTimeoutMs?: number;
  /**
   * While the keeper has no usable context (404 before it has opened the round, a timeout, a restart) the round is
   * skipped and retried on the next poll. Only when the chain time is within this many seconds of `commitEnd` does the
   * agent play with an empty history instead. Default 30.
   */
  contextFallbackSec?: number;
  /** Largest keeper response body accepted, in bytes (default 1,000,000). */
  maxContextBytes?: number;
  fetch?: typeof fetch;
  log?: (msg: string) => void;
}

export interface HouseRunner {
  /** One poll: single-flight (a call during a running poll joins it). Never rejects. */
  tick(): Promise<void>;
  /** Re-arms the reveals of earlier runs (SDK `resumePending`). */
  resume(): Promise<void>;
  /** `resume`, then polls until `stop`. */
  start(): Promise<void>;
  stop(): void;
  /** Resolves when no agent has a scheduled reveal left. */
  idle(): Promise<void>;
  /** `stop` and close the agents (salt files stay on disk). */
  close(): void;
}

interface RoundInfo {
  id: bigint;
  ticker: string;
  T: number;
  commitEnd: number;
}

interface PlayState {
  attempts: number;
  path?: Path;
  /** The last transient failure and how many times in a row it was identical. */
  lastFailure?: string;
  repeats: number;
}

/** Errors worth another try while the commit window is open. Everything else (invalid path, closed window, reverts) is final. */
const TRANSIENT = new Set(["RPC", "SEND_UNCERTAIN", "PENDING_TX", "SIMULATION"]);
/** An identical transient failure this many times in a row is treated as final (a dry run that keeps failing the same way will not heal). */
const MAX_IDENTICAL_FAILURES = 3;

/** The response body as text, read as a stream and cut off at `limit` bytes (not characters). */
async function readLimited(res: Response, limit: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error("keeper context is too large");
  }
  if (!res.body) throw new Error("keeper answered without a body");
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error("keeper context is too large");
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

export function createRunner(opts: RunnerOptions): HouseRunner {
  const log = opts.log ?? ((m: string) => console.error(`[house] ${m}`));
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const scan = BigInt(Math.max(1, opts.scanRounds ?? DEFAULT_SCAN_ROUNDS));
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const timeoutMs = opts.contextTimeoutMs ?? DEFAULT_CONTEXT_TIMEOUT_MS;
  const fallbackSec = opts.contextFallbackSec ?? DEFAULT_CONTEXT_FALLBACK_SEC;
  const maxBytes = opts.maxContextBytes ?? MAX_CONTEXT_BYTES;
  const doFetch = opts.fetch ?? fetch;
  const keeperBase = opts.keeperUrl ? opts.keeperUrl.replace(/\/+$/, "") : undefined;
  const abort = new AbortController();

  const read = (functionName: string, args: readonly unknown[] = []): Promise<unknown> =>
    opts.publicClient.readContract({ address: opts.arenaAddress, abi: arenaAbi, functionName, args } as never) as Promise<unknown>;

  const closedRounds = new Set<bigint>();
  const roundCache = new Map<bigint, RoundInfo>();
  /** Only SUCCESSFUL fetches (and the deliberate empty fallback near commitEnd) are cached, never a transient failure. */
  const contexts = new Map<bigint, RoundContext>();
  const fetching = new Map<bigint, Promise<RoundContext | undefined>>();
  const announcedWait = new Set<bigint>();
  const finished = new Set<string>();
  const states = new Map<string, PlayState>();
  let stopped = false;
  let inFlight: Promise<void> | undefined;
  let warnedNoKeeper = false;

  /** The newest rounds whose commit window is still open (chain time), oldest first. */
  async function openRounds(): Promise<{ rounds: RoundInfo[]; now: number }> {
    const count = (await read("roundCount")) as bigint;
    const now = Number((await opts.publicClient.getBlock({ blockTag: "latest" })).timestamp);
    const lowest = count >= scan ? count - scan + 1n : 1n;
    const out: RoundInfo[] = [];
    for (let id = count; id >= lowest && id >= 1n; id--) {
      if (closedRounds.has(id)) continue;
      let info = roundCache.get(id);
      if (!info) {
        const raw = (await read("getRound", [id])) as Record<string, unknown>;
        info = { id, ticker: hexToString(raw.ticker as Hex).replace(/\0+$/, ""), T: Number(raw.T), commitEnd: Number(raw.commitEnd) };
        roundCache.set(id, info);
      }
      if (now >= info.commitEnd) {
        closedRounds.add(id);
        roundCache.delete(id);
        contexts.delete(id);
        announcedWait.delete(id);
        continue;
      }
      out.push(info);
    }
    return { rounds: out.reverse(), now };
  }

  /**
   * The context for a round, or undefined when the keeper has none yet and the round should be skipped this poll.
   * Only a success (or the deliberate empty history close to `commitEnd`, or without a keeper) is remembered; a 404
   * before the keeper opened the round, a timeout or a keeper restart is retried on the next poll.
   */
  function contextFor(round: RoundInfo, now: number): Promise<RoundContext | undefined> {
    const cached = contexts.get(round.id);
    if (cached) return Promise.resolve(cached);
    let p = fetching.get(round.id);
    if (!p) {
      p = fetchContext(round, now).finally(() => fetching.delete(round.id));
      fetching.set(round.id, p);
    }
    return p;
  }

  async function fetchContext(round: RoundInfo, now: number): Promise<RoundContext | undefined> {
    const empty: RoundContext = { ticker: round.ticker, T: round.T, candleCount: 3, recentCandlesBp: [] };
    if (!keeperBase) {
      if (!warnedNoKeeper) log("warning: KEEPER_URL is not set; the agents play with an empty history");
      warnedNoKeeper = true;
      contexts.set(round.id, empty);
      return empty;
    }
    try {
      const res = await doFetch(`${keeperBase}/context/${round.id}`, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "application/json" },
        redirect: "error",
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new Error(`keeper answered HTTP ${res.status}`);
      }
      const text = await readLimited(res, maxBytes);
      const ctx = parseKeeperContext(JSON.parse(text) as unknown, { ticker: round.ticker, T: round.T });
      contexts.set(round.id, ctx);
      log(`round ${round.id}: context from the keeper (${ctx.recentCandlesBp.length} candles)`);
      return ctx;
    } catch (e) {
      const why = shortMessage(e);
      if (now >= round.commitEnd - fallbackSec) {
        log(`warning: round ${round.id}: no usable keeper context (${why}) and the commit window ends soon; using an empty history`);
        contexts.set(round.id, empty);
        return empty;
      }
      if (!announcedWait.has(round.id)) {
        announcedWait.add(round.id);
        log(`round ${round.id}: keeper context not ready (${why}); retrying on the next polls until ${fallbackSec} s before the commit window ends`);
      }
      return undefined;
    }
  }

  async function play(player: Player, round: RoundInfo, now: number): Promise<void> {
    const key = `${player.name}:${round.id}`;
    if (finished.has(key)) return;
    try {
      const entry = (await read("entryOf", [round.id, player.agent.address])) as readonly unknown[];
      if (Number(entry[0]) !== 0) {
        finished.add(key);
        log(`round ${round.id} ${player.name}: already committed`);
        return;
      }
    } catch (e) {
      log(`round ${round.id} ${player.name}: cannot read the entry (${shortMessage(e)}); will retry`);
      return;
    }
    const st = states.get(key) ?? { attempts: 0, repeats: 0 };
    states.set(key, st);
    if (st.attempts >= maxAttempts) {
      finished.add(key);
      log(`round ${round.id} ${player.name}: giving up after ${st.attempts} failed attempts`);
      return;
    }
    try {
      let ctx: RoundContext | undefined;
      if (!st.path) {
        let stored: Path | undefined;
        try {
          stored = player.storedPath?.(round.id);
        } catch (e) {
          log(`round ${round.id} ${player.name}: cannot read the stored salt record (${shortMessage(e)})`);
        }
        if (stored !== undefined && isValid(stored)) {
          // A salt record exists although nothing is on chain (a dropped commit, or a crash after the file was written):
          // the SDK only accepts this very path for the round.
          st.path = stored;
          log(`round ${round.id} ${player.name}: reusing the path of its stored salt record`);
        } else {
          ctx = await contextFor(round, now);
          if (!ctx) return; // the keeper has no context yet: skip this poll without counting an attempt
        }
      }
      st.attempts++;
      if (!st.path && ctx) {
        const path = await player.predict(structuredClone(ctx));
        if (!isValid(path)) throw new AgentError("INVALID_PATH", "the prediction is not a valid path");
        st.path = path;
      }
      if (!st.path) throw new Error("no path to submit");
      await player.agent.submitPath(round.id, st.path);
      finished.add(key);
      const sub = player.agent.mySubmission(round.id);
      log(`round ${round.id} ${player.name}: committed${sub ? ` (hash ${sub.hash.slice(0, 12)}...)` : ""}; reveal scheduled`);
    } catch (e) {
      const code = e instanceof AgentError ? e.code : "ERROR";
      const why = e instanceof AgentError ? `${code}: ${e.message}` : shortMessage(e);
      let retry = e instanceof AgentError ? TRANSIENT.has(code) : true;
      if (retry) {
        st.repeats = why === st.lastFailure ? st.repeats + 1 : 1;
        st.lastFailure = why;
        if (st.repeats >= MAX_IDENTICAL_FAILURES) retry = false; // the same failure again and again will not heal
      }
      if (code === "ALREADY_COMMITTED" || code === "COMMIT_CLOSED" || !retry) finished.add(key);
      log(`round ${round.id} ${player.name}: commit failed (${why})${retry ? "; will retry while the commit window is open" : "; not retrying"}`);
    }
  }

  async function doTick(): Promise<void> {
    let open: { rounds: RoundInfo[]; now: number };
    try {
      open = await openRounds();
    } catch (e) {
      log(`warning: cannot read rounds (${shortMessage(e)})`);
      return;
    }
    for (const round of open.rounds) {
      if (stopped) return;
      await Promise.allSettled(opts.players.map((p) => play(p, round, open.now)));
    }
  }

  function tick(): Promise<void> {
    if (!inFlight) inFlight = doTick().finally(() => (inFlight = undefined));
    return inFlight;
  }

  async function resume(): Promise<void> {
    for (const p of opts.players) {
      try {
        const ids = await p.agent.resumePending();
        if (ids.length > 0) log(`${p.name}: resumed reveals for rounds ${ids.join(", ")}`);
      } catch (e) {
        log(`warning: ${p.name}: could not resume pending reveals (${shortMessage(e)})`);
      }
    }
  }

  return {
    tick,
    resume,
    async start() {
      await resume();
      while (!stopped) {
        await tick();
        await systemClock.sleep(pollMs, abort.signal);
      }
    },
    stop() {
      stopped = true;
      abort.abort();
    },
    async idle() {
      await Promise.all(opts.players.map((p) => p.agent.idle()));
    },
    close() {
      stopped = true;
      abort.abort();
      for (const p of opts.players) p.agent.close();
    },
  };
}

// ---------------------------------------------------------------------------------------------- wiring

export interface BuildOptions {
  /** RPC_URL, CHAIN_ID, ARENA_ADDRESS, KEEPER_URL, AGENT_SALT_DIR, HOUSE_POLL_MS, ANTHROPIC_API_KEY, HOUSE_AGENT_ADDRESSES. */
  env: Record<string, string | undefined>;
  walletsFile?: string;
  log?: (msg: string) => void;
  /** Test hooks: extra AgentDeps fields (clock, pollMs, ...) and a fetch replacement. */
  depsOverride?: Partial<AgentDeps>;
  fetch?: typeof fetch;
  /** Overrides HOUSE_POLL_MS (no minimum). */
  pollMs?: number;
  /** See RunnerOptions.contextFallbackSec / maxContextBytes. */
  contextFallbackSec?: number;
  maxContextBytes?: number;
}

export interface BuiltRunner extends HouseRunner {
  players: readonly Player[];
}

function readAddressesJson(): { chainId?: number; contracts?: { Arena?: string }; houseAgents?: string[] } {
  try {
    return JSON.parse(readFileSync(new URL("../../../shared/addresses.json", import.meta.url), "utf8")) as ReturnType<typeof readAddressesJson>;
  } catch {
    return {};
  }
}

/** Loads the wallets, builds one SDK agent per wallet and the runner around them. */
export async function buildHouseRunner(opts: BuildOptions): Promise<BuiltRunner> {
  const log = opts.log ?? ((m: string) => console.error(`[house] ${m}`));
  const env = opts.env;
  const file = opts.walletsFile ?? (env.HOUSE_WALLETS_FILE ? resolve(env.HOUSE_WALLETS_FILE) : defaultWalletsFile());
  const keys = loadHouseWallets(isAbsolute(file) ? file : resolve(file));
  const known = readAddressesJson();

  const base: Record<string, string | undefined> = {
    RPC_URL: env.RPC_URL || DEFAULT_RPC_URL,
    CHAIN_ID: env.CHAIN_ID || (known.chainId !== undefined ? String(known.chainId) : undefined),
    ARENA_ADDRESS: env.ARENA_ADDRESS || known.contracts?.Arena,
    AGENT_SALT_DIR: env.AGENT_SALT_DIR,
  };

  let houseList: Address[] = [];
  try {
    houseList = [...houseAddresses(env), ...(known.houseAgents ?? []).filter((a) => isAddress(a)).map((a) => getAddress(a))];
  } catch (e) {
    log(`warning: ${e instanceof Error ? e.message : "HOUSE_AGENT_ADDRESSES is malformed"}`);
  }

  const llm = createNewsLlm({ env, log: (m) => log(`${newsLlmName}: ${m}`) });
  const predictors: Record<HouseName, (ctx: RoundContext) => Promise<Path>> = {
    [momentumName]: momentumPredict,
    [meanReversionName]: meanReversionPredict,
    [newsLlmName]: (ctx) => llm.predict(ctx),
  } as Record<HouseName, (ctx: RoundContext) => Promise<Path>>;

  const players: Player[] = [];
  let publicClient: PublicClient | undefined;
  let arenaAddress: Address | undefined;
  try {
    for (const name of HOUSE_ORDER) {
      const cfg = loadAgentConfig({ ...base, AGENT_PRIVATE_KEY: keys[name] });
      const deps: AgentDeps = { ...(await createAgentDeps(cfg)), log: (m) => log(`${name}: ${m}`), ...opts.depsOverride };
      const agent = createAgent(deps);
      const store = new SaltStore(deps.saltDir, { nowSec: () => systemClock.nowSec() });
      const saltKey = (id: bigint) => ({ chainId: deps.chainId, arena: deps.arenaAddress, id, who: agent.address });
      players.push({ name, agent, predict: predictors[name], storedPath: (id) => store.get(saltKey(id))?.path });
      publicClient ??= deps.publicClient;
      arenaAddress ??= deps.arenaAddress;
      log(`${name}: wallet ${agent.address}${isHouseAgent(agent.address, houseList) ? "" : " (not in the known house address list: the app will not label it house)"}`);
    }
  } catch (e) {
    for (const p of players) p.agent.close();
    throw e;
  }

  const envPoll = Number(env.HOUSE_POLL_MS);
  const pollMs = opts.pollMs ?? (Number.isInteger(envPoll) && envPoll >= MIN_ENV_POLL_MS ? envPoll : DEFAULT_POLL_MS);
  const runner = createRunner({
    players,
    publicClient: publicClient as PublicClient,
    arenaAddress: arenaAddress as Address,
    keeperUrl: env.KEEPER_URL || undefined,
    pollMs,
    ...(opts.contextFallbackSec !== undefined ? { contextFallbackSec: opts.contextFallbackSec } : {}),
    ...(opts.maxContextBytes !== undefined ? { maxContextBytes: opts.maxContextBytes } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    log,
  });
  return { ...runner, players };
}

export async function main(): Promise<void> {
  const runner = await buildHouseRunner({ env: process.env });
  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.error(`[house] ${signal}: stopping; scheduled reveals stop with the process and resume on the next start`);
    runner.stop();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  console.error("[house] running; Ctrl+C to stop");
  await runner.start();
  runner.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(0),
    (e: unknown) => {
      // AgentError messages are written to carry no secret; anything else goes through shortMessage (URLs masked).
      console.error(`[house] fatal: ${e instanceof AgentError ? `${e.code}: ${e.message}` : shortMessage(e)}`);
      process.exit(1);
    },
  );
}
