// Keeper chain calls: open a round and post the real candles.
//
// Safety model
//  - All timestamps are unix SECONDS. "now" is the latest block timestamp (what the contract compares
//    against), never the local clock, so anvil time travel and a skewed local clock cannot mislead us.
//  - Contract ABI comes only from shared/abi/Arena.json. Addresses and the key are injected (KeeperDeps) or
//    read from the environment at runtime. The key is never logged and never put in an error message.
//  - Every send is preceded by an `eth_call` dry run. A transaction is signed and sent at most once per
//    call; on any error after the send we re-read chain state instead of re-sending.
//  - `openRound` is idempotent across restarts: an identical existing round is returned instead of opening
//    a duplicate. `postCandles` is idempotent: `AlreadyPosted` / `settled(id)` is a final state and nothing
//    is ever re-posted with different data.
import { readFileSync } from "node:fs";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  keccak256,
  parseEventLogs,
  stringToBytes,
  stringToHex,
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
import { isValid, type Candle, type Path } from "../../shared/score";

// ---------------------------------------------------------------------------------------------- constants

export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const LOCAL_CHAIN_ID = 31337;
const CHAINS: Record<number, Chain> = { [BASE_SEPOLIA_CHAIN_ID]: baseSepolia, [LOCAL_CHAIN_ID]: foundry };

/** `commitEnd - now` above this is almost certainly a millisecond timestamp (see plan, Task 9 forward notes). */
export const MAX_COMMIT_AHEAD_SEC = 3 * 24 * 3600;
const MAX_MARKET_AHEAD_SEC = 30 * 24 * 3600;
const MAX_SETTLE_AHEAD_SEC = 60 * 24 * 3600;
/** Worst case of `postCandles` is about 2.7M gas; never send with less than this. */
export const MIN_POST_GAS = 3_500_000n;
const DEFAULT_RECEIPT_TIMEOUT_MS = 120_000;
/** How many of the latest rounds `openRound` inspects for an identical earlier open. */
const DEDUP_SCAN = 20n;

const UINT32_MAX = 4294967295n;
const UINT64_MAX = 18446744073709551615n;
const UINT256_MAX = (1n << 256n) - 1n;

// ---------------------------------------------------------------------------------------------- ABI

function loadArenaAbi(): Abi {
  const raw = JSON.parse(readFileSync(new URL("../../shared/abi/Arena.json", import.meta.url), "utf8")) as unknown;
  const abi = Array.isArray(raw) ? raw : (raw as { abi?: unknown }).abi;
  if (!Array.isArray(abi)) throw new Error("shared/abi/Arena.json: no ABI array");
  return abi as Abi;
}

export const arenaAbi: Abi = loadArenaAbi();

interface AbiParam {
  name: string;
  type: string;
  components?: AbiParam[];
}

/** The `RoundParams` struct components, read from the ABI of `openRound` (never hard-coded). */
function roundParamComponents(): AbiParam[] {
  const fn = arenaAbi.find((x) => x.type === "function" && x.name === "openRound") as
    | { inputs: AbiParam[] }
    | undefined;
  const comps = fn?.inputs[0]?.components;
  if (!fn || fn.inputs.length !== 1 || !comps || comps.length === 0) {
    throw new Error("Arena ABI: openRound must take a single struct argument");
  }
  return comps;
}

type ParamValue = bigint | number | Hex;
export type RoundParamsObj = Record<string, ParamValue>;

// ---------------------------------------------------------------------------------------------- types

export interface RoundConfig {
  /** Stock identifier, at most 32 UTF-8 bytes, right-padded into `bytes32` (same as Solidity `bytes32("AAPL")`). */
  ticker: string;
  /** Reference price in on-chain units (informational for the contract; the scale is the keeper's choice). */
  p0: bigint;
  /** Tolerance in bp, `1..uint32.max` (see `computeT`). */
  T: number;
  /** Unix SECONDS. */
  commitEnd: number;
  revealEnd: number;
  marketEnd: number;
  candleSec: number;
  settleDeadline: number;
  entryStake: bigint;
}

export interface KeeperDeps {
  publicClient: PublicClient;
  walletClient: WalletClient;
  /** Keeper account that signs (local account, key held only inside it). */
  account: Account;
  chain: Chain;
  arenaAddress: Address;
  /** Chain id the deps were configured for; checked against `eth_chainId` before any call. */
  chainId: number;
  log?: (msg: string) => void;
  receiptTimeoutMs?: number;
}

export interface KeeperConfig {
  rpcUrl: string;
  chainId: number;
  arenaAddress: string;
  /** 0x + 64 hex. Never logged. Distinct from the deployer key. */
  privateKey: string;
}

export class KeeperError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "KeeperError";
  }
}

// ---------------------------------------------------------------------------------------------- config / deps

/** Reads RPC_URL, CHAIN_ID, ARENA_ADDRESS and KEEPER_PRIVATE_KEY. Error messages never contain the key. */
export function loadKeeperConfig(env: Record<string, string | undefined> = process.env): KeeperConfig {
  const need = (k: string): string => {
    const v = env[k];
    if (!v) throw new KeeperError("CONFIG", `missing environment variable ${k}`);
    return v;
  };
  const chainId = Number(need("CHAIN_ID"));
  return {
    rpcUrl: need("RPC_URL"),
    chainId,
    arenaAddress: need("ARENA_ADDRESS"),
    privateKey: need("KEEPER_PRIVATE_KEY"),
  };
}

export function assertAllowedChainId(chainId: number): void {
  if (chainId !== BASE_SEPOLIA_CHAIN_ID && chainId !== LOCAL_CHAIN_ID) {
    throw new KeeperError("WRONG_CHAIN", `refusing to run on chain ${chainId}: only 84532 (Base Sepolia) and 31337 (anvil)`);
  }
}

/**
 * Builds the viem clients from config and verifies, before returning, that the RPC reports the configured
 * allowed chain id, that the Arena address has code, and that the key is the Arena's `keeper`.
 */
export async function createKeeperDeps(cfg: KeeperConfig): Promise<KeeperDeps> {
  assertAllowedChainId(cfg.chainId);
  if (!/^0x[0-9a-fA-F]{64}$/.test(cfg.privateKey)) {
    throw new KeeperError("CONFIG", "KEEPER_PRIVATE_KEY must be 0x followed by 64 hex characters"); // never echo the value
  }
  let arenaAddress: Address;
  try {
    arenaAddress = getAddress(cfg.arenaAddress);
  } catch {
    throw new KeeperError("CONFIG", "ARENA_ADDRESS is not a valid address");
  }
  const chain = CHAINS[cfg.chainId] as Chain;
  const account = privateKeyToAccount(cfg.privateKey as Hex);
  const publicClient = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: http(cfg.rpcUrl) });
  const deps: KeeperDeps = {
    publicClient: publicClient as PublicClient,
    walletClient: walletClient as WalletClient,
    account,
    chain,
    arenaAddress,
    chainId: cfg.chainId,
  };
  await assertDeps(deps);
  const keeper = (await read(deps, "keeper", [])) as Address;
  if (keeper.toLowerCase() !== account.address.toLowerCase()) {
    throw new KeeperError("NOT_KEEPER", `the configured key (${account.address}) is not the Arena keeper (${keeper})`);
  }
  return deps;
}

const checkedDeps = new WeakSet<KeeperDeps>();

/** Allowed chain id, and the RPC agrees with the configured chain id. Checked once per deps object. */
async function assertDeps(deps: KeeperDeps): Promise<void> {
  assertAllowedChainId(deps.chainId);
  if (checkedDeps.has(deps)) return;
  let actual: number;
  try {
    actual = await deps.publicClient.getChainId();
  } catch (e) {
    throw new KeeperError("RPC", `cannot read chain id from the RPC: ${shortMessage(e)}`);
  }
  if (actual !== deps.chainId) {
    throw new KeeperError("WRONG_CHAIN", `RPC reports chain ${actual}, configured chain is ${deps.chainId}`);
  }
  assertAllowedChainId(actual);
  checkedDeps.add(deps);
}

let defaultDeps: Promise<KeeperDeps> | undefined;

/** Explicit deps win; otherwise build (once) from the environment. A failed build is not cached. */
function resolveDeps(deps?: KeeperDeps): Promise<KeeperDeps> {
  if (deps) return Promise.resolve(deps);
  if (!defaultDeps) {
    defaultDeps = createKeeperDeps(loadKeeperConfig());
    defaultDeps.catch(() => {
      defaultDeps = undefined;
    });
  }
  return defaultDeps;
}

// ---------------------------------------------------------------------------------------------- helpers

function logger(deps: KeeperDeps): (m: string) => void {
  return deps.log ?? ((m) => console.log(`[keeper] ${m}`));
}

export function shortMessage(e: unknown): string {
  if (e instanceof BaseError) return e.shortMessage;
  return e instanceof Error ? e.message : String(e);
}

/** Name of a custom error the contract reverted with, if the error is a decoded revert. */
export function revertName(e: unknown): string | undefined {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName;
  }
  return undefined;
}

function read(deps: KeeperDeps, functionName: string, args: readonly unknown[]): Promise<unknown> {
  return deps.publicClient.readContract({
    address: deps.arenaAddress,
    abi: arenaAbi,
    functionName,
    args,
  } as never) as Promise<unknown>;
}

/** Latest block timestamp in unix seconds. */
async function chainNow(deps: KeeperDeps): Promise<number> {
  const block = await deps.publicClient.getBlock({ blockTag: "latest" });
  return Number(block.timestamp);
}

/**
 * Refuses to send while the keeper account has a transaction pending (pending nonce > latest nonce), so a
 * retry after a restart cannot double-send while an earlier, not yet mined transaction is still in flight.
 * Limit: it only sees what the connected RPC node knows; a transaction sitting only in another node's
 * mempool is invisible to a public RPC.
 */
export async function assertNoPendingTx(deps: KeeperDeps): Promise<void> {
  const address = deps.account.address;
  const [latest, pending] = await Promise.all([
    deps.publicClient.getTransactionCount({ address, blockTag: "latest" }),
    deps.publicClient.getTransactionCount({ address, blockTag: "pending" }),
  ]);
  if (pending > latest) {
    throw new KeeperError(
      "PENDING_TX",
      `keeper account has ${pending - latest} pending transaction(s); not sending another. Wait for it to be mined, then call again.`,
    );
  }
}

// ---------------------------------------------------------------------------------------------- openRound

function isUintInRange(x: unknown, max: bigint): x is bigint {
  return typeof x === "bigint" && x >= 0n && x <= max;
}

function checkSeconds(name: string, v: number): void {
  if (!Number.isSafeInteger(v) || v <= 0 || BigInt(v) > UINT64_MAX) {
    throw new KeeperError("BAD_ROUND", `${name} must be a positive integer number of seconds`);
  }
}

const badRound = (m: string): never => {
  throw new KeeperError("BAD_ROUND", m);
};

/**
 * Static (time-independent) checks: field ranges, ordering of the four timestamps among themselves and the
 * `settleDeadline` rule. Safe to run on a config whose round may already exist on chain.
 */
export function validateRoundConfigStatic(cfg: RoundConfig): void {
  const bad = badRound;
  if (typeof cfg.ticker !== "string" || cfg.ticker.length === 0) bad("ticker must be a non-empty string");
  if (stringToBytes(cfg.ticker).length > 32) bad("ticker must be at most 32 bytes");
  if (!isUintInRange(cfg.p0, UINT256_MAX) || cfg.p0 === 0n) bad("p0 must be a bigint in 1..uint256.max");
  if (!Number.isInteger(cfg.T) || cfg.T < 1 || BigInt(cfg.T) > UINT32_MAX) bad("T must be an integer in 1..uint32.max");
  if (!Number.isInteger(cfg.candleSec) || cfg.candleSec < 1 || BigInt(cfg.candleSec) > UINT32_MAX) {
    bad("candleSec must be an integer in 1..uint32.max");
  }
  if (!isUintInRange(cfg.entryStake, UINT256_MAX) || cfg.entryStake === 0n) bad("entryStake must be a bigint > 0");
  checkSeconds("commitEnd", cfg.commitEnd);
  checkSeconds("revealEnd", cfg.revealEnd);
  checkSeconds("marketEnd", cfg.marketEnd);
  checkSeconds("settleDeadline", cfg.settleDeadline);
  if (!(cfg.commitEnd < cfg.revealEnd)) bad("revealEnd must be after commitEnd");
  if (!(cfg.revealEnd < cfg.marketEnd)) bad("marketEnd must be after revealEnd");
  if (!(cfg.settleDeadline > cfg.marketEnd + 3 * cfg.candleSec)) bad("settleDeadline must be > marketEnd + 3*candleSec");
}

/**
 * Time-dependent checks for opening a NEW round (`now` = chain time, seconds): commitEnd in the future and the
 * keeper-side millisecond guards the contract lacks (a millisecond timestamp would pin
 * `anyCommitWindowOpen()` to true and block `reclassify`).
 */
export function validateRoundConfigTiming(cfg: RoundConfig, now: number): void {
  const bad = badRound;
  if (!(now < cfg.commitEnd)) bad("commitEnd must be in the future");
  if (cfg.commitEnd - now > MAX_COMMIT_AHEAD_SEC) {
    bad("commitEnd is more than 3 days ahead: timestamps must be SECONDS, not milliseconds");
  }
  if (cfg.marketEnd - now > MAX_MARKET_AHEAD_SEC) bad("marketEnd is more than 30 days ahead (milliseconds?)");
  if (cfg.settleDeadline - now > MAX_SETTLE_AHEAD_SEC) bad("settleDeadline is more than 60 days ahead (milliseconds?)");
}

/** Static plus timing checks of a config against `now` (seconds). Throws `KeeperError` with code BAD_ROUND. */
export function validateRoundConfig(cfg: RoundConfig, now: number): void {
  validateRoundConfigStatic(cfg);
  validateRoundConfigTiming(cfg, now);
}

/** Builds the `RoundParams` struct using the field names and types the ABI declares. */
export function buildRoundParams(cfg: RoundConfig): RoundParamsObj {
  const values: Record<string, bigint | Hex> = {
    ticker: stringToHex(cfg.ticker, { size: 32 }),
    p0: cfg.p0,
    T: BigInt(cfg.T),
    commitEnd: BigInt(cfg.commitEnd),
    revealEnd: BigInt(cfg.revealEnd),
    marketEnd: BigInt(cfg.marketEnd),
    candleSec: BigInt(cfg.candleSec),
    settleDeadline: BigInt(cfg.settleDeadline),
    entryStake: cfg.entryStake,
  };
  const comps = roundParamComponents();
  const names = comps.map((c) => c.name);
  const unknown = names.filter((n) => !(n in values));
  const unused = Object.keys(values).filter((n) => !names.includes(n));
  if (unknown.length > 0 || unused.length > 0) {
    throw new KeeperError(
      "ABI_MISMATCH",
      `RoundParams in shared/abi/Arena.json differs from RoundConfig (abi-only: ${unknown.join(",")}; config-only: ${unused.join(",")})`,
    );
  }
  const out: RoundParamsObj = {};
  for (const c of comps) {
    const v = values[c.name] as bigint | Hex;
    // viem decodes uint8..uint32 as number and uint40..uint256 as bigint; follow the ABI type.
    const m = /^uint(\d+)$/.exec(c.type);
    out[c.name] = m && Number(m[1]) <= 32 ? Number(v) : v;
  }
  return out;
}

export function sameParams(a: Record<string, unknown>, b: RoundParamsObj): boolean {
  for (const c of roundParamComponents()) {
    const x = a[c.name];
    const y = b[c.name];
    if (typeof y === "string") {
      if (typeof x !== "string" || x.toLowerCase() !== y.toLowerCase()) return false;
    } else if (BigInt(x as bigint | number) !== BigInt(y as bigint | number)) {
      return false;
    }
  }
  return true;
}

/** Looks through the latest rounds for one whose params equal `params`; returns its id. */
async function findExistingRound(deps: KeeperDeps, params: RoundParamsObj): Promise<bigint | undefined> {
  const count = (await read(deps, "roundCount", [])) as bigint;
  const lowest = count > DEDUP_SCAN ? count - DEDUP_SCAN + 1n : 1n;
  for (let id = count; id >= lowest; id--) {
    const r = (await read(deps, "getRound", [id])) as Record<string, unknown>;
    if (sameParams(r, params)) return id;
  }
  return undefined;
}

/**
 * Opens a round and returns its id. Idempotent: if an identical round already exists among the latest
 * rounds (for example after a restart), its id is returned and nothing is sent.
 */
export async function openRound(cfg: RoundConfig, depsIn?: KeeperDeps): Promise<bigint> {
  const deps = await resolveDeps(depsIn);
  const log = logger(deps);
  await assertDeps(deps);
  // Static checks only before the dedup lookup: after a crash the round may already be mined and commitEnd
  // may have passed, and the keeper must still recover its id instead of failing "commitEnd in the future".
  validateRoundConfigStatic(cfg);
  const params = buildRoundParams(cfg);

  const existing = await findExistingRound(deps, params);
  if (existing !== undefined) {
    log(`openRound: identical round ${existing} already exists, not opening another`);
    return existing;
  }
  validateRoundConfigTiming(cfg, await chainNow(deps));

  const call = { address: deps.arenaAddress, abi: arenaAbi, functionName: "openRound", args: [params], account: deps.account };
  let request: Record<string, unknown>;
  let gas: bigint;
  try {
    const sim = await deps.publicClient.simulateContract(call as never);
    request = sim.request as unknown as Record<string, unknown>;
    gas = (await deps.publicClient.estimateContractGas(call as never)) * 12n / 10n;
  } catch (e) {
    throw new KeeperError("SIMULATION", `openRound dry run failed: ${revertName(e) ?? shortMessage(e)}`);
  }

  await assertNoPendingTx(deps);

  // Past this point the transaction may reach the chain. Never sign a second one: re-read state instead.
  const recover = async (why: string, hash?: Hex): Promise<bigint> => {
    let found: bigint | undefined;
    try {
      found = await findExistingRound(deps, params);
    } catch {
      /* fall through to the error below */
    }
    if (found !== undefined) {
      log(`openRound: ${why}, but the round exists as ${found}`);
      return found;
    }
    throw new KeeperError(
      "SEND_UNCERTAIN",
      `openRound: ${why}${hash ? ` (tx ${hash} may still be pending)` : ""}; NOT re-sending. Call openRound again later: it finds the round if it was mined.`,
    );
  };

  let hash: Hex;
  try {
    hash = await deps.walletClient.writeContract({ ...request, gas } as never);
  } catch (e) {
    return recover(`send failed (${shortMessage(e)})`);
  }
  let receipt;
  try {
    receipt = await deps.publicClient.waitForTransactionReceipt({
      hash,
      timeout: deps.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS,
    });
  } catch (e) {
    return recover(`no receipt (${shortMessage(e)})`, hash);
  }
  if (receipt.status !== "success") throw new KeeperError("TX_REVERTED", `openRound transaction ${hash} reverted`);

  const events = parseEventLogs({ abi: arenaAbi, eventName: "RoundOpened", logs: receipt.logs }).filter(
    (l) => l.address.toLowerCase() === deps.arenaAddress.toLowerCase(),
  );
  if (events.length !== 1) throw new KeeperError("NO_EVENT", `expected exactly one RoundOpened in ${hash}, got ${events.length}`);
  const args = (events[0] as unknown as { args: { id: bigint; params: Record<string, unknown> } }).args;
  if (!sameParams(args.params, params)) throw new KeeperError("MISMATCH", `RoundOpened params differ from what was sent (${hash})`);
  const count = (await read(deps, "roundCount", [])) as bigint;
  if (args.id < 1n || args.id > count) throw new KeeperError("MISMATCH", `RoundOpened id ${args.id} exceeds roundCount ${count}`);
  log(`openRound: round ${args.id} opened in ${hash}`);
  return args.id;
}

// ---------------------------------------------------------------------------------------------- postCandles

/**
 * `sourceHash = keccak256(UTF-8 bytes of sourceUrl)`. The contract stores it verbatim and never interprets it;
 * the URL names the data the candles were built from so anyone can recompute the hash and audit the source.
 */
export function sourceHashOf(sourceUrl: string): Hex {
  return keccak256(stringToBytes(sourceUrl));
}

function sameCandles(a: readonly Candle[], b: readonly Candle[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((c, i) => {
    const d = b[i];
    return d !== undefined && Number(c.close) === d.close && Number(c.high) === d.high && Number(c.low) === d.low;
  });
}

/**
 * Posts the real candles of round `id` once. Final states are never retried: if the round is already
 * settled (`settled(id)` or an `AlreadyPosted` revert) nothing is sent, ever.
 *  - Stored candles AND sourceHash equal ours: resolves (idempotent success).
 *  - Anything differs: throws the terminal `KeeperError("POSTED_DIFFERENT")`. Callers MUST NOT retry: the
 *    on-chain data is permanent and nothing the keeper can send will change it.
 * Also throws if the candles are invalid, the round is unknown or void,
 * the post window is not open, the dry run reverts, or the transaction reverts without the round settling.
 */
export async function postCandles(id: bigint, real: Path, sourceUrl: string, depsIn?: KeeperDeps): Promise<void> {
  // Local checks first: no RPC for input that can never succeed.
  if (typeof id !== "bigint" || id < 1n) throw new KeeperError("BAD_ID", "round id must be a bigint >= 1");
  if (!isValid(real)) {
    throw new KeeperError("INVALID_CANDLES", "real candles are not valid (need low <= min(open, close), high >= max(open, close), int32)");
  }
  if (typeof sourceUrl !== "string" || sourceUrl.length === 0) throw new KeeperError("BAD_SOURCE", "sourceUrl must be non-empty");
  const sourceHash = sourceHashOf(sourceUrl);

  const deps = await resolveDeps(depsIn);
  const log = logger(deps);
  await assertDeps(deps);

  const count = (await read(deps, "roundCount", [])) as bigint;
  if (id > count) throw new KeeperError("UNKNOWN_ROUND", `round ${id} does not exist (roundCount ${count})`);

  // Final state: already posted. Never overwrite; resolve only if the stored data equals ours.
  const reportPosted = async (): Promise<void> => {
    const [stored, storedHash] = (await read(deps, "realCandles", [id])) as [readonly Candle[], Hex];
    if (storedHash.toLowerCase() === sourceHash.toLowerCase() && sameCandles(stored, real)) {
      log(`postCandles: round ${id} is already settled with these exact candles`);
      return;
    }
    throw new KeeperError(
      "POSTED_DIFFERENT",
      `round ${id} is already settled with different candles or sourceHash than the ones built now; terminal, do not retry`,
    );
  };
  if ((await read(deps, "settled", [id])) === true) {
    await reportPosted();
    return;
  }
  if ((await read(deps, "isVoid", [id])) === true) throw new KeeperError("ROUND_VOID", `round ${id} is void`);

  const rp = (await read(deps, "getRound", [id])) as { marketEnd: bigint; candleSec: number | bigint; settleDeadline: bigint };
  const earliest = Number(rp.marketEnd) + 3 * Number(rp.candleSec);
  const now = await chainNow(deps);
  if (now < earliest) throw new KeeperError("TOO_EARLY", `round ${id}: candles can be posted from ${earliest}, chain time is ${now}`);
  if (now > Number(rp.settleDeadline)) throw new KeeperError("WINDOW_CLOSED", `round ${id}: settleDeadline ${rp.settleDeadline} has passed`);

  const args = [id, real.map((c) => ({ close: c.close, high: c.high, low: c.low })), sourceHash];
  const call = { address: deps.arenaAddress, abi: arenaAbi, functionName: "postCandles", args, account: deps.account };
  let request: Record<string, unknown>;
  let gas: bigint;
  try {
    const sim = await deps.publicClient.simulateContract({ ...call, gas: MIN_POST_GAS } as never);
    request = sim.request as unknown as Record<string, unknown>;
    const est = ((await deps.publicClient.estimateContractGas(call as never)) * 12n) / 10n;
    gas = est > MIN_POST_GAS ? est : MIN_POST_GAS;
  } catch (e) {
    const name = revertName(e);
    if (name === "AlreadyPosted") {
      await reportPosted();
      return;
    }
    throw new KeeperError(name ?? "SIMULATION", `postCandles dry run failed: ${name ?? shortMessage(e)}`);
  }

  await assertNoPendingTx(deps);

  // After this point never sign a second transaction: re-read state instead.
  const settledAfter = async (why: string, hash?: Hex): Promise<void> => {
    let settled = false;
    try {
      settled = (await read(deps, "settled", [id])) === true;
    } catch {
      /* treated as not settled below */
    }
    if (settled) {
      log(`postCandles: ${why}, but round ${id} is settled`);
      await reportPosted();
      return;
    }
    throw new KeeperError(
      "SEND_UNCERTAIN",
      `postCandles: ${why}${hash ? ` (tx ${hash} may still be pending)` : ""}; round ${id} is not settled yet; NOT re-sending, call again later.`,
    );
  };

  let hash: Hex;
  try {
    hash = await deps.walletClient.writeContract({ ...request, gas } as never);
  } catch (e) {
    return settledAfter(`send failed (${shortMessage(e)})`);
  }
  let receipt;
  try {
    receipt = await deps.publicClient.waitForTransactionReceipt({
      hash,
      timeout: deps.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS,
    });
  } catch (e) {
    return settledAfter(`no receipt (${shortMessage(e)})`, hash);
  }
  if (receipt.status !== "success") return settledAfter(`transaction ${hash} reverted`, hash);

  const posted = parseEventLogs({ abi: arenaAbi, eventName: "CandlesPosted", logs: receipt.logs }).filter(
    (l) => l.address.toLowerCase() === deps.arenaAddress.toLowerCase(),
  );
  const ours = posted.find((l) => {
    const a = (l as unknown as { args: { id: bigint; sourceHash: Hex } }).args;
    return a.id === id && a.sourceHash.toLowerCase() === sourceHash.toLowerCase();
  });
  if (!ours) throw new KeeperError("NO_EVENT", `no CandlesPosted for round ${id} in ${hash}`);
  if ((await read(deps, "settled", [id])) !== true) throw new KeeperError("MISMATCH", `round ${id} not settled after ${hash}`);
  log(`postCandles: round ${id} settled in ${hash}`);
}
