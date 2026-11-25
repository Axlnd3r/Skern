// Agent SDK: commit a 3-candle path, persist the salt first, reveal in the window, read rounds and results.
//
// Safety model
//  - The agent key is read from `process.env.AGENT_PRIVATE_KEY` only (never logged, never put in an error
//    message, never written to disk). Nothing here ever handles a third party's key: the process runs on the
//    owner's machine with the owner's wallet.
//  - `submitPath` validates the path with `shared/score.ts#isValid` BEFORE any RPC or transaction: an invalid
//    committed path can never be revealed and its stake would be lost.
//  - The salt record is written to disk (see salt.ts) BEFORE the commit transaction is sent and is kept if the
//    transaction fails, so a commit that did land can always be revealed.
//  - Every send is preceded by an `eth_call` dry run. After a send we never sign a second transaction for the
//    same action: on any error we re-read chain state instead (idempotent, like keeper/src/rounds.ts).
//  - All timestamps are unix SECONDS; "now" is the latest block timestamp (what the contract compares against).
//    The chain must keep producing blocks (a local anvil needs --block-time or periodic evm_mine), otherwise
//    the scheduled reveal sees stale time and waits until its wall-clock fallback expires.
//  - Default logging goes to stderr: stdout belongs to the MCP stdio protocol.
import { homedir } from "node:os";
import { join } from "node:path";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  getAddress,
  hexToString,
  http,
  type Abi,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, foundry } from "viem/chains";
import { isValid, score as scorePath, type Candle, type Path } from "../../shared/score";
import { SaltStore, hashPath, loadAbi, type SaltKey, type SaltRecord } from "./salt";

export { hashPath } from "./salt";
export type { Candle, Path } from "../../shared/score";

// ---------------------------------------------------------------------------------------------- constants

export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const LOCAL_CHAIN_ID = 31337;
const CHAINS: Record<number, Chain> = { [BASE_SEPOLIA_CHAIN_ID]: baseSepolia, [LOCAL_CHAIN_ID]: foundry };

export const arenaAbi: Abi = loadAbi("Arena");

/** `Kind` enum of Registry/Arena. */
export const KIND_HUMAN = 1;
export const KIND_AGENT = 2;
const KIND_NAMES: Record<number, string> = { 0: "none", 1: "human", 2: "agent" };

const DEFAULT_RECEIPT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_MS = 5_000;
const DEFAULT_MAX_SLEEP_MS = 30_000;
/** Extra wall-clock seconds the scheduler waits past the expected reveal end before giving up on a stalled chain. */
const WALL_SLACK_SEC = 120;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 50;

export type RoundPhase = "commit" | "reveal" | "market" | "play" | "settled" | "void";

// ---------------------------------------------------------------------------------------------- types

export class AgentError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

export interface Clock {
  /** Unix seconds of the local wall clock. */
  nowSec(): number;
  /** Resolves after `ms`, or early when `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  nowSec: () => Math.floor(Date.now() / 1000),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      const t = setTimeout(done, ms);
      function done(): void {
        clearTimeout(t);
        signal?.removeEventListener("abort", done);
        resolve();
      }
      signal?.addEventListener("abort", done, { once: true });
    }),
};

export interface AgentDeps {
  publicClient: PublicClient;
  walletClient: WalletClient;
  /** The agent's own account (a local account; the key stays inside it). */
  account: Account;
  chain: Chain;
  arenaAddress: Address;
  /** Chain id the deps were configured for; checked against `eth_chainId` before any call. */
  chainId: number;
  /** Directory of salt files. Created if missing. */
  saltDir: string;
  clock?: Clock;
  log?: (msg: string) => void;
  receiptTimeoutMs?: number;
  /** Scheduler poll interval while waiting for the reveal window or retrying (default 5 s). */
  pollMs?: number;
  /** Longest single sleep of the scheduler (default 30 s). */
  maxSleepMs?: number;
  /** Optional source of recent candle context (bp relative to P0) for `getRound`; the chain has none. */
  candleContext?: (ticker: string) => Promise<readonly Candle[]>;
}

export interface AgentConfig {
  rpcUrl: string;
  chainId: number;
  arenaAddress: string;
  /** 0x + 64 hex. Never logged. */
  privateKey: string;
  saltDir: string;
}

/** Reads RPC_URL, CHAIN_ID, ARENA_ADDRESS, AGENT_PRIVATE_KEY and the optional AGENT_SALT_DIR. */
export function loadAgentConfig(env: Record<string, string | undefined> = process.env): AgentConfig {
  const need = (k: string): string => {
    const v = env[k];
    if (!v) throw new AgentError("CONFIG", `missing environment variable ${k}`);
    return v;
  };
  return {
    rpcUrl: need("RPC_URL"),
    chainId: Number(need("CHAIN_ID")),
    arenaAddress: need("ARENA_ADDRESS"),
    privateKey: need("AGENT_PRIVATE_KEY"),
    saltDir: env.AGENT_SALT_DIR || join(homedir(), ".consensus-path", "salts"),
  };
}

export function assertAllowedChainId(chainId: number): void {
  if (chainId !== BASE_SEPOLIA_CHAIN_ID && chainId !== LOCAL_CHAIN_ID) {
    throw new AgentError("WRONG_CHAIN", `refusing to run on chain ${chainId}: only 84532 (Base Sepolia) and 31337 (anvil)`);
  }
}

/** Builds clients from config and checks that the RPC reports the configured chain and the Arena has code. */
export async function createAgentDeps(cfg: AgentConfig): Promise<AgentDeps> {
  assertAllowedChainId(cfg.chainId);
  if (!/^0x[0-9a-fA-F]{64}$/.test(cfg.privateKey)) {
    throw new AgentError("CONFIG", "AGENT_PRIVATE_KEY must be 0x followed by 64 hex characters"); // never echo the value
  }
  let arenaAddress: Address;
  try {
    arenaAddress = getAddress(cfg.arenaAddress);
  } catch {
    throw new AgentError("CONFIG", "ARENA_ADDRESS is not a valid address");
  }
  const chain = CHAINS[cfg.chainId] as Chain;
  const account = privateKeyToAccount(cfg.privateKey as Hex);
  const deps: AgentDeps = {
    publicClient: createPublicClient({ chain, transport: http(cfg.rpcUrl) }) as PublicClient,
    walletClient: createWalletClient({ account, chain, transport: http(cfg.rpcUrl) }) as WalletClient,
    account,
    chain,
    arenaAddress,
    chainId: cfg.chainId,
    saltDir: cfg.saltDir,
  };
  await assertDeps(deps);
  const code = await deps.publicClient.getCode({ address: arenaAddress });
  if (!code || code === "0x") throw new AgentError("CONFIG", `no contract at ARENA_ADDRESS ${arenaAddress} on chain ${cfg.chainId}`);
  return deps;
}

const checkedDeps = new WeakSet<AgentDeps>();

async function assertDeps(deps: AgentDeps): Promise<void> {
  assertAllowedChainId(deps.chainId);
  if (checkedDeps.has(deps)) return;
  let actual: number;
  try {
    actual = await deps.publicClient.getChainId();
  } catch (e) {
    throw new AgentError("RPC", `cannot read chain id from the RPC: ${shortMessage(e)}`);
  }
  if (actual !== deps.chainId) throw new AgentError("WRONG_CHAIN", `RPC reports chain ${actual}, configured chain is ${deps.chainId}`);
  checkedDeps.add(deps);
}

// ---------------------------------------------------------------------------------------------- helpers

/** Error text that is safe to log or show to a model: viem's short message, with any URL masked (RPC URLs can carry API keys). */
export function shortMessage(e: unknown): string {
  const m = e instanceof BaseError ? e.shortMessage : e instanceof Error ? e.message : String(e);
  return m.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>");
}

/** Name of the custom error the contract reverted with, if the error is a decoded revert. */
export function revertName(e: unknown): string | undefined {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName;
  }
  return undefined;
}

/** The 9-number wire format (`candle*3 + {0: close, 1: high, 2: low}`) to a path. Shape is checked by `isValid`. */
export function pathFromNumbers(nums: readonly number[]): Path {
  if (!Array.isArray(nums) || nums.length !== 9) throw new AgentError("INVALID_PATH", "a path is exactly 9 numbers: close, high, low for each of 3 candles");
  const c = (i: number): Candle => ({ close: nums[i * 3] as number, high: nums[i * 3 + 1] as number, low: nums[i * 3 + 2] as number });
  return [c(0), c(1), c(2)];
}

/** A plain, frozen-shape copy of the candles (one read of every field, -0 normalised) so later checks and the send see the same numbers. */
function snapshotPath(p: unknown): Path {
  const src = p as readonly Candle[] | null | undefined;
  if (!Array.isArray(src) || src.length !== 3) throw new AgentError("INVALID_PATH", "path must be exactly 3 candles");
  const out: Candle[] = [];
  for (let i = 0; i < 3; i++) {
    const c = src[i] as Candle | undefined;
    if (c === null || c === undefined || typeof c !== "object") throw new AgentError("INVALID_PATH", `candle ${i + 1} is missing`);
    const { close, high, low } = c;
    out.push({
      close: typeof close === "number" && close === 0 ? 0 : close,
      high: typeof high === "number" && high === 0 ? 0 : high,
      low: typeof low === "number" && low === 0 ? 0 : low,
    });
  }
  return out as unknown as Path;
}

function samePath(a: Path, b: Path): boolean {
  return a.every((c, i) => c.close === b[i]?.close && c.high === b[i]?.high && c.low === b[i]?.low);
}

function wirePath(p: Path): { close: number; high: number; low: number }[] {
  return p.map((c) => ({ close: c.close, high: c.high, low: c.low }));
}

function parseRoundId(id: unknown): bigint {
  if (typeof id !== "bigint" || id < 1n) throw new AgentError("BAD_ID", "round id must be a bigint >= 1");
  return id;
}

function decodeTicker(t: Hex): string {
  return hexToString(t).replace(/\0+$/, "");
}

export interface RoundParamsView {
  ticker: string;
  p0: bigint;
  T: number;
  commitEnd: number;
  revealEnd: number;
  marketEnd: number;
  candleSec: number;
  settleDeadline: number;
  entryStake: bigint;
}

function toRoundParams(raw: Record<string, unknown>): RoundParamsView {
  return {
    ticker: decodeTicker(raw.ticker as Hex),
    p0: BigInt(raw.p0 as bigint),
    T: Number(raw.T),
    commitEnd: Number(raw.commitEnd),
    revealEnd: Number(raw.revealEnd),
    marketEnd: Number(raw.marketEnd),
    candleSec: Number(raw.candleSec),
    settleDeadline: Number(raw.settleDeadline),
    entryStake: BigInt(raw.entryStake as bigint),
  };
}

export function phaseAt(rp: RoundParamsView, now: number, settled: boolean, isVoid: boolean): RoundPhase {
  if (isVoid) return "void";
  if (settled) return "settled";
  if (now < rp.commitEnd) return "commit";
  if (now < rp.revealEnd) return "reveal";
  if (now < rp.marketEnd) return "market";
  return "play";
}

const candleView = (c: Candle): { close: number; high: number; low: number } => ({ close: Number(c.close), high: Number(c.high), low: Number(c.low) });

// ---------------------------------------------------------------------------------------------- agent

export interface RevealOutcome {
  state: "scheduled" | "revealed" | "missed" | "failed";
  detail?: string;
}

export interface Agent {
  readonly address: Address;
  /** Validates, persists the salt, commits, and schedules the reveal for the window. */
  submitPath(id: bigint, path: Path): Promise<void>;
  /** Manual reveal with the persisted salt. `AlreadyRevealed` counts as success. */
  reveal(id: bigint): Promise<void>;
  /** Schedules reveals for every committed, not yet revealed record of this agent (call after a restart). */
  resumePending(): Promise<bigint[]>;
  listRounds(limit?: number): Promise<Record<string, unknown>[]>;
  getRound(id: bigint): Promise<Record<string, unknown>>;
  getConsensus(id: bigint): Promise<Record<string, unknown>>;
  getMyResults(limit?: number): Promise<Record<string, unknown>[]>;
  /** The persisted entry without the salt (safe to show to a model). */
  mySubmission(id: bigint): { hash: Hex; status: string; commitTx?: Hex; revealTx?: Hex } | undefined;
  revealOutcome(id: bigint): RevealOutcome | undefined;
  /** Resolves when no scheduled reveal is running. */
  idle(): Promise<void>;
  /** Stops all scheduled reveals (their salt files stay on disk). */
  close(): void;
}

export function createAgent(deps: AgentDeps): Agent {
  const clock = deps.clock ?? systemClock;
  const log = deps.log ?? ((m: string) => console.error(`[agent] ${m}`));
  const store = new SaltStore(deps.saltDir, { nowSec: () => clock.nowSec() });
  const who = deps.account.address;
  const abort = new AbortController();
  const tasks = new Map<string, Promise<void>>();
  const outcomes = new Map<string, RevealOutcome>();

  const keyOf = (id: bigint): SaltKey => ({ chainId: deps.chainId, arena: deps.arenaAddress, id, who });

  const read = (functionName: string, args: readonly unknown[] = []): Promise<unknown> =>
    deps.publicClient.readContract({ address: deps.arenaAddress, abi: arenaAbi, functionName, args } as never) as Promise<unknown>;

  const chainNow = async (): Promise<number> => Number((await deps.publicClient.getBlock({ blockTag: "latest" })).timestamp);

  async function roundOf(id: bigint): Promise<RoundParamsView> {
    const count = (await read("roundCount")) as bigint;
    if (id > count) throw new AgentError("UNKNOWN_ROUND", `round ${id} does not exist (roundCount ${count})`);
    return toRoundParams((await read("getRound", [id])) as Record<string, unknown>);
  }

  interface Entry {
    kind: number;
    revealed: boolean;
    hash: Hex;
    path: Path;
  }
  async function entryOf(id: bigint): Promise<Entry> {
    const [kind, revealed, hash, path] = (await read("entryOf", [id, who])) as [number, boolean, Hex, readonly Candle[]];
    return { kind: Number(kind), revealed, hash, path: path.map(candleView) as unknown as Path };
  }

  /** Never sign while this account has an unmined transaction (sees only the connected node's mempool). */
  async function assertNoPendingTx(): Promise<void> {
    const [latest, pending] = await Promise.all([
      deps.publicClient.getTransactionCount({ address: who, blockTag: "latest" }),
      deps.publicClient.getTransactionCount({ address: who, blockTag: "pending" }),
    ]);
    if (pending > latest) {
      throw new AgentError("PENDING_TX", `account has ${pending - latest} pending transaction(s); not sending another. Wait for it to be mined, then call again.`);
    }
  }

  /**
   * One in-process lock for every send (commit and reveal): a scheduled reveal for one round and a commit for
   * another must not sign with the same nonce. The pending-transaction check and the receipt wait both happen
   * inside it, so the next sender sees the previous transaction mined.
   */
  let lockTail: Promise<unknown> = Promise.resolve();
  function withSendLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = lockTail.then(() => fn());
    lockTail = run.catch(() => undefined);
    return run;
  }

  /** The status in the salt file is informational (chain state is the authority): a failed update must never hide a landed transaction. */
  function markStatus(key: SaltKey, patch: { status: "pending" | "committed" | "revealed"; commitTx?: Hex; revealTx?: Hex }): void {
    try {
      store.update(key, patch);
    } catch (e) {
      log(`salt file update failed (${shortMessage(e)}); the record keeps its previous status`);
    }
  }

  /** Dry run; returns the request to send and a gas limit with 20 percent headroom. */
  async function dryRun(functionName: string, args: readonly unknown[]): Promise<{ request: Record<string, unknown>; gas: bigint }> {
    const call = { address: deps.arenaAddress, abi: arenaAbi, functionName, args, account: deps.account };
    const sim = await deps.publicClient.simulateContract(call as never);
    const gas = ((await deps.publicClient.estimateContractGas(call as never)) * 12n) / 10n;
    return { request: sim.request as unknown as Record<string, unknown>, gas };
  }

  // ------------------------------------------------------------------------------------------ commit

  async function submitPath(idIn: bigint, pathIn: Path): Promise<void> {
    // Local checks first: no RPC and no file for input that can never succeed.
    const id = parseRoundId(idIn);
    const path = snapshotPath(pathIn);
    if (!isValid(path)) {
      throw new AgentError("INVALID_PATH", "path is not valid (need low <= min(open, close), high >= max(open, close), all int32); an invalid committed path can never be revealed");
    }
    await assertDeps(deps);
    const key = keyOf(id);

    const rp = await roundOf(id);
    const existing = store.get(key);
    const entry = await entryOf(id);
    if (existing && !samePath(existing.path, path)) {
      throw new AgentError(
        "PENDING_DIFFERENT",
        `round ${id} already has a salt record for a different path (status ${existing.status}); it may still be committed on chain. Submit the same path, or remove the file by hand only if you are sure no commit landed.`,
      );
    }
    if (entry.kind !== 0) {
      // Already committed (a retry after a crash, or a commit that mined late, possibly after commitEnd): only
      // valid if we hold its salt. This runs BEFORE the commit-window check so the reveal is still scheduled.
      if (!existing) throw new AgentError("ALREADY_COMMITTED", `round ${id}: this address already committed and no local salt record exists, so it cannot be revealed by this agent`);
      if (entry.hash.toLowerCase() !== existing.hash.toLowerCase()) throw new AgentError("HASH_MISMATCH", `round ${id}: the on-chain commit does not match the local salt record`);
      if (existing.status === "pending") markStatus(key, { status: "committed" });
      log(`submitPath: round ${id} is already committed, scheduling the reveal`);
      scheduleReveal(id);
      return;
    }
    const now = await chainNow();
    if (now >= rp.commitEnd) throw new AgentError("COMMIT_CLOSED", `round ${id}: the commit window ended at ${rp.commitEnd}, chain time is ${now}`);

    const simFail = (e: unknown): never => {
      const name = revertName(e);
      throw new AgentError(name ?? "SIMULATION", `commit dry run failed: ${name ?? shortMessage(e)}`);
    };
    let rec: SaltRecord | undefined = existing;
    if (!rec) {
      // Dry run with a placeholder hash (the hash value cannot change which checks pass) BEFORE any file exists,
      // so a rejected submit leaves nothing behind that could block a later, different path.
      try {
        await dryRun("commit", [id, `0x${"00".repeat(31)}01` as Hex]);
      } catch (e) {
        simFail(e);
      }
      // The salt hits the disk BEFORE the transaction is sent, and stays there if the send fails.
      rec = store.create(key, path);
    }
    const hashHex = rec.hash;
    let request: Record<string, unknown>;
    let gas: bigint;
    try {
      ({ request, gas } = await dryRun("commit", [id, hashHex]));
    } catch (e) {
      return simFail(e);
    }

    await withSendLock(async () => {
      await assertNoPendingTx();

      // Past this point the transaction may reach the chain. Never sign a second one: re-read state instead.
      // `mayLand`: the transaction might still be mined (send error or lost receipt), so the reveal is scheduled
      // BEFORE throwing; the scheduler ends in `failed` (NOT_COMMITTED) if nothing landed by the reveal window.
      const settleCommit = async (why: string, mayLand: boolean, txHash?: Hex): Promise<void> => {
        let landed = false;
        try {
          const e = await entryOf(id);
          landed = e.kind !== 0 && e.hash.toLowerCase() === hashHex.toLowerCase();
        } catch {
          /* treated as not landed below */
        }
        if (landed) {
          log(`submitPath: ${why}, but the commit for round ${id} is on chain`);
          markStatus(key, { status: "committed", ...(txHash ? { commitTx: txHash } : {}) });
          scheduleReveal(id);
          return;
        }
        if (mayLand) scheduleReveal(id);
        throw new AgentError(
          "SEND_UNCERTAIN",
          `submitPath: ${why}${txHash ? ` (tx ${txHash} may still be pending)` : ""}; the salt record for round ${id} was kept and nothing was re-sent. Call submitPath again with the same path to retry.`,
        );
      };

      let hash: Hex;
      try {
        hash = await deps.walletClient.writeContract({ ...request, gas } as never);
      } catch (e) {
        return settleCommit(`send failed (${shortMessage(e)})`, true);
      }
      let status: "success" | "reverted";
      try {
        const receipt = await deps.publicClient.waitForTransactionReceipt({ hash, timeout: deps.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS });
        status = receipt.status;
      } catch (e) {
        return settleCommit(`no receipt (${shortMessage(e)})`, true, hash);
      }
      if (status !== "success") return settleCommit(`transaction ${hash} reverted`, false, hash);
      const after = await entryOf(id);
      if (after.kind === 0 || after.hash.toLowerCase() !== hashHex.toLowerCase()) {
        throw new AgentError("MISMATCH", `round ${id}: commit ${hash} mined but the on-chain entry does not match the salt record`);
      }
      markStatus(key, { status: "committed", commitTx: hash });
      log(`submitPath: committed round ${id} in ${hash}`);
      scheduleReveal(id);
    });
  }

  // ------------------------------------------------------------------------------------------ reveal

  /** One reveal attempt with the persisted salt. Resolves on success or `AlreadyRevealed`. Window waits are the scheduler's job. */
  async function revealOnce(idIn: bigint): Promise<void> {
    const id = parseRoundId(idIn);
    await assertDeps(deps);
    const key = keyOf(id);
    const rec = store.get(key);
    if (!rec) throw new AgentError("NO_SALT", `no salt record for round ${id} and this address in ${deps.saltDir}`);
    if (!isValid(rec.path)) throw new AgentError("INVALID_PATH", `the stored path for round ${id} is not valid`);

    const entry = await entryOf(id);
    if (entry.revealed) {
      if (rec.status !== "revealed") markStatus(key, { status: "revealed" });
      log(`reveal: round ${id} is already revealed`);
      return;
    }
    if (entry.kind === 0) throw new AgentError("NOT_COMMITTED", `round ${id}: no commit on chain for this address (status ${rec.status})`);
    if (entry.hash.toLowerCase() !== rec.hash.toLowerCase()) throw new AgentError("HASH_MISMATCH", `round ${id}: the on-chain commit does not match the salt record`);

    const rp = await roundOf(id);
    const now = await chainNow();
    if (now < rp.commitEnd) throw new AgentError("TOO_EARLY", `round ${id}: reveal opens at ${rp.commitEnd}, chain time is ${now}`);
    if (now >= rp.revealEnd) throw new AgentError("WINDOW_CLOSED", `round ${id}: the reveal window ended at ${rp.revealEnd}; the stake is forfeited`);

    const args = [id, who, wirePath(rec.path), rec.salt];
    let request: Record<string, unknown>;
    let gas: bigint;
    try {
      ({ request, gas } = await dryRun("reveal", args));
    } catch (e) {
      const name = revertName(e);
      if (name === "AlreadyRevealed") {
        markStatus(key, { status: "revealed" });
        log(`reveal: round ${id} was revealed by someone else`);
        return;
      }
      throw new AgentError(name ?? "SIMULATION", `reveal dry run failed: ${name ?? shortMessage(e)}`);
    }
    await withSendLock(async () => {
      await assertNoPendingTx();

      const settleReveal = async (why: string, txHash?: Hex): Promise<void> => {
        let done = false;
        try {
          done = (await entryOf(id)).revealed;
        } catch {
          /* treated as not revealed below */
        }
        if (done) {
          markStatus(key, { status: "revealed", ...(txHash ? { revealTx: txHash } : {}) });
          log(`reveal: ${why}, but round ${id} is revealed`);
          return;
        }
        throw new AgentError("SEND_UNCERTAIN", `reveal: ${why}${txHash ? ` (tx ${txHash} may still be pending)` : ""}; round ${id} is not revealed yet; NOT re-sending`);
      };

      let hash: Hex;
      try {
        hash = await deps.walletClient.writeContract({ ...request, gas } as never);
      } catch (e) {
        return settleReveal(`send failed (${shortMessage(e)})`);
      }
      let status: "success" | "reverted";
      try {
        status = (await deps.publicClient.waitForTransactionReceipt({ hash, timeout: deps.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS })).status;
      } catch (e) {
        return settleReveal(`no receipt (${shortMessage(e)})`, hash);
      }
      if (status !== "success") return settleReveal(`transaction ${hash} reverted`, hash);
      if (!(await entryOf(id)).revealed) throw new AgentError("MISMATCH", `round ${id}: reveal ${hash} mined but the entry is not revealed`);
      markStatus(key, { status: "revealed", revealTx: hash });
      log(`reveal: round ${id} revealed in ${hash}`);
    });
  }

  const TRANSIENT = new Set(["RPC", "SEND_UNCERTAIN", "PENDING_TX", "SIMULATION"]);

  /** Waits for the reveal window of round `id`, reveals, retries transient failures until the window ends. Never rejects. */
  async function autoReveal(id: bigint): Promise<void> {
    const k = id.toString();
    try {
      const rp = await roundOf(id);
      const first = await chainNow();
      const wallStart = clock.nowSec();
      const wallLimit = wallStart + Math.max(0, rp.revealEnd - first) + WALL_SLACK_SEC;
      const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
      const maxSleep = deps.maxSleepMs ?? DEFAULT_MAX_SLEEP_MS;
      for (;;) {
        if (abort.signal.aborted) return;
        const now = await chainNow();
        if (now >= rp.revealEnd) {
          const e = await entryOf(id);
          if (e.revealed) {
            outcomes.set(k, { state: "revealed" });
            return;
          }
          outcomes.set(k, { state: "missed", detail: `reveal window ended at ${rp.revealEnd}` });
          log(`autoReveal: round ${id}: the reveal window passed without a reveal; the stake is forfeited`);
          return;
        }
        if (clock.nowSec() > wallLimit) {
          outcomes.set(k, { state: "missed", detail: "chain time did not advance (no new blocks); gave up" });
          log(`autoReveal: round ${id}: gave up, chain time is stalled`);
          return;
        }
        if (now < rp.commitEnd) {
          await clock.sleep(Math.min(maxSleep, (rp.commitEnd - now + 1) * 1000), abort.signal);
          continue;
        }
        try {
          await revealOnce(id);
          outcomes.set(k, { state: "revealed" });
          return;
        } catch (e) {
          const code = e instanceof AgentError ? e.code : "RPC";
          if (!TRANSIENT.has(code) && code !== "TOO_EARLY") {
            outcomes.set(k, { state: "failed", detail: `${code}: ${shortMessage(e)}` });
            log(`autoReveal: round ${id} failed: ${code}`);
            return;
          }
          log(`autoReveal: round ${id}: ${code}, retrying`);
          await clock.sleep(pollMs, abort.signal);
        }
      }
    } catch (e) {
      outcomes.set(k, { state: "failed", detail: shortMessage(e) });
      log(`autoReveal: round ${id} failed: ${shortMessage(e)}`);
    }
  }

  function scheduleReveal(id: bigint): void {
    const k = id.toString();
    if (tasks.has(k)) return;
    outcomes.set(k, { state: "scheduled" });
    const p = autoReveal(id).finally(() => tasks.delete(k));
    tasks.set(k, p);
  }

  async function resumePending(): Promise<bigint[]> {
    await assertDeps(deps);
    const out: bigint[] = [];
    const onCorrupt = (file: string, why: string): void => log(`skipping unreadable salt file ${file}: ${why}`);
    for (const rec of store.list({ chainId: deps.chainId, arena: deps.arenaAddress, who }, onCorrupt)) {
      if (rec.status === "revealed") continue;
      // `pending` records may or may not have landed on chain: scheduleReveal checks the entry itself.
      if (rec.status === "pending") {
        let e: Entry;
        try {
          e = await entryOf(rec.id);
        } catch {
          continue;
        }
        if (e.kind === 0 || e.hash.toLowerCase() !== rec.hash.toLowerCase()) continue;
        markStatus(keyOf(rec.id), { status: "committed" });
      }
      scheduleReveal(rec.id);
      out.push(rec.id);
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------ queries

  const rounds = async (): Promise<bigint> => (await read("roundCount")) as bigint;

  async function stateOf(id: bigint): Promise<{ settled: boolean; isVoid: boolean }> {
    const [settled, isVoid] = await Promise.all([read("settled", [id]), read("isVoid", [id])]);
    return { settled: settled === true, isVoid: isVoid === true };
  }

  async function roundView(id: bigint, now: number): Promise<Record<string, unknown>> {
    const [rp, st, width, humans, agents] = await Promise.all([
      read("getRound", [id]),
      stateOf(id),
      read("bucketWidth", [id]),
      read("revealCount", [id, KIND_HUMAN]),
      read("revealCount", [id, KIND_AGENT]),
    ]);
    const p = toRoundParams(rp as Record<string, unknown>);
    return {
      id: id.toString(),
      ticker: p.ticker,
      p0: p.p0.toString(),
      T: p.T,
      commitEnd: p.commitEnd,
      revealEnd: p.revealEnd,
      marketEnd: p.marketEnd,
      candleSec: p.candleSec,
      settleDeadline: p.settleDeadline,
      entryStake: p.entryStake.toString(),
      bucketWidth: Number(width),
      phase: phaseAt(p, now, st.settled, st.isVoid),
      chainTime: now,
      revealCounts: { human: Number(humans), agent: Number(agents) },
    };
  }

  const clampLimit = (n: number | undefined): number => {
    if (n === undefined) return DEFAULT_LIST_LIMIT;
    if (!Number.isInteger(n) || n < 1) throw new AgentError("BAD_LIMIT", "limit must be a positive integer");
    return Math.min(n, MAX_LIST_LIMIT);
  };

  async function listRounds(limit?: number): Promise<Record<string, unknown>[]> {
    const n = clampLimit(limit);
    await assertDeps(deps);
    const count = await rounds();
    const now = await chainNow();
    const ids: bigint[] = [];
    for (let id = count; id >= 1n && ids.length < n; id--) ids.push(id);
    return Promise.all(ids.map((id) => roundView(id, now)));
  }

  async function getRound(idIn: bigint): Promise<Record<string, unknown>> {
    const id = parseRoundId(idIn);
    await assertDeps(deps);
    const rp = await roundOf(id);
    const view = await roundView(id, await chainNow());
    if (deps.candleContext) {
      try {
        view.recentCandles = (await deps.candleContext(rp.ticker)).slice(-20).map(candleView);
      } catch (e) {
        view.recentCandlesError = shortMessage(e);
      }
    }
    return view;
  }

  async function consensusOf(id: bigint, kind: number): Promise<Record<string, unknown>> {
    const [present, count] = await Promise.all([read("isPresent", [id, kind]), read("revealCount", [id, kind])]);
    const base = { present: present === true, reveals: Number(count) };
    try {
      const [path, ready] = (await read("consensus", [id, kind])) as [readonly Candle[], boolean];
      return { ...base, ready: ready === true, path: ready === true ? path.map(candleView) : null };
    } catch (e) {
      if (revertName(e) === undefined) throw e;
      return { ...base, ready: false, path: null };
    }
  }

  async function getConsensus(idIn: bigint): Promise<Record<string, unknown>> {
    const id = parseRoundId(idIn);
    await assertDeps(deps);
    const rp = await roundOf(id);
    const [now, st, human, agent] = await Promise.all([chainNow(), stateOf(id), consensusOf(id, KIND_HUMAN), consensusOf(id, KIND_AGENT)]);
    const out: Record<string, unknown> = { id: id.toString(), phase: phaseAt(rp, now, st.settled, st.isVoid), human, agent };
    if (st.settled && !st.isVoid) {
      const [scores, real, baseline] = await Promise.all([read("consensusScores", [id]), read("realCandles", [id]), read("baselineScore", [id])]);
      const [hs, as, hp, ap] = scores as [number, number, boolean, boolean];
      const [candles] = real as [readonly Candle[], Hex];
      out.final = {
        humanScore: hp ? Number(hs) : null,
        agentScore: ap ? Number(as) : null,
        baselineScore: Number(baseline),
        realCandles: candles.map(candleView),
      };
    }
    return out;
  }

  async function getMyResults(limit?: number): Promise<Record<string, unknown>[]> {
    const n = clampLimit(limit);
    await assertDeps(deps);
    const count = await rounds();
    const now = await chainNow();
    const reward = (await read("REWARD_PER_POINT")) as bigint;
    const out: Record<string, unknown>[] = [];
    let scanned = 0;
    for (let id = count; id >= 1n && out.length < n && scanned < 200; id--, scanned++) {
      const entry = await entryOf(id);
      if (entry.kind === 0) continue;
      const rp = toRoundParams((await read("getRound", [id])) as Record<string, unknown>);
      const st = await stateOf(id);
      const row: Record<string, unknown> = {
        id: id.toString(),
        ticker: rp.ticker,
        phase: phaseAt(rp, now, st.settled, st.isVoid),
        kind: KIND_NAMES[entry.kind],
        revealed: entry.revealed,
        committedHash: entry.hash,
      };
      const mine = store.get(keyOf(id));
      if (mine) row.localStatus = mine.status;
      const oc = outcomes.get(id.toString());
      if (oc) row.autoReveal = oc;
      if (st.settled && !st.isVoid) {
        const baseline = Number(await read("baselineScore", [id]));
        row.baselineScore = baseline;
        row.claimed = (await read("isClaimed", [id, who])) === true;
        if (entry.revealed) {
          const [real] = (await read("realCandles", [id])) as [readonly Candle[], Hex];
          const sc = scorePath(entry.path, real.map(candleView) as unknown as Path, rp.T);
          row.score = sc;
          row.rewardPoints = (sc > baseline ? BigInt(sc - baseline) * reward : 0n).toString();
        } else {
          row.score = null;
          row.note = "not revealed: the stake was burned";
        }
      } else if (st.isVoid) {
        row.note = "round void: claim returns the stake";
      }
      out.push(row);
    }
    return out;
  }

  return {
    address: who,
    submitPath,
    reveal: revealOnce,
    resumePending,
    listRounds,
    getRound,
    getConsensus,
    getMyResults,
    mySubmission(idIn) {
      const rec = store.get(keyOf(parseRoundId(idIn)));
      if (!rec) return undefined;
      return { hash: rec.hash, status: rec.status, ...(rec.commitTx ? { commitTx: rec.commitTx } : {}), ...(rec.revealTx ? { revealTx: rec.revealTx } : {}) };
    },
    revealOutcome: (id) => outcomes.get(id.toString()),
    async idle() {
      while (tasks.size > 0) await Promise.allSettled([...tasks.values()]);
    },
    close() {
      abort.abort();
    },
  };
}

// ---------------------------------------------------------------------------------------------- default agent

let defaultAgent: Promise<Agent> | undefined;

/** The process-wide agent, built once from the environment (RPC_URL, CHAIN_ID, ARENA_ADDRESS, AGENT_PRIVATE_KEY). A failed build is not cached. */
export function defaultAgentFromEnv(): Promise<Agent> {
  if (!defaultAgent) {
    defaultAgent = createAgentDeps(loadAgentConfig()).then(createAgent);
    defaultAgent.catch(() => {
      defaultAgent = undefined;
    });
  }
  return defaultAgent;
}

/** Persists the salt BEFORE the commit transaction, commits, and schedules the reveal (agent from the environment). */
export async function submitPath(id: bigint, path: Path): Promise<void> {
  // Cheap local rejection before any client is built from the environment.
  parseRoundId(id);
  const p = snapshotPath(path);
  if (!isValid(p)) throw new AgentError("INVALID_PATH", "path is not valid (need low <= min(open, close), high >= max(open, close), all int32)");
  return (await defaultAgentFromEnv()).submitPath(id, p);
}

/** Manual reveal using the persisted salt (agent from the environment). */
export async function reveal(id: bigint): Promise<void> {
  return (await defaultAgentFromEnv()).reveal(id);
}
