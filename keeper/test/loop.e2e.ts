// End-to-end test against a real local anvil with the contracts deployed by contracts/script/Deploy.s.sol.
//
// One full round driven only by the keeper loop and the relay: the loop opens the round, 3 humans (through the
// relay: one queued during the commit window, two directly after it) and 3 agents (direct) commit and reveal,
// the loop calls freezeAll right after revealEnd, a bet is placed on each side, the loop posts the candles, and
// GapMarket resolves (`settled(id) === true`, `GapMarket.status(id) === 2`).
//
// The price source is a mock (no network, no Twelve Data key). Only anvil's public development mnemonic is used.
// If anvil or forge are missing this test FAILS loudly on purpose (it never skips silently).
//
// Vitest only collects `*.test.ts`, so `loop.e2e.test.ts` imports this file; run it with
// `pnpm vitest run keeper/test/loop.e2e.test.ts`.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bytesToHex, createPublicClient, createWalletClient, http, keccak256, stringToBytes, type Address, type Hex, type PublicClient } from "viem";
import { foundry } from "viem/chains";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { hashPath, loadAbi } from "../../agents/src/salt";
import { score, type Path } from "../../shared/score";
import { demoTemplate } from "../src/demo";
import { Mutex } from "../src/lock";
import { startLoop, type LoopHandle } from "../src/loop";
import { createRelay, createRelayChain, type Relay } from "../src/relay";
import { arenaAbi, createKeeperDeps, type KeeperDeps } from "../src/rounds";
import type { PriceFeed } from "../src/source";
import { createLoopOps } from "../src/ops";
import { FileStateStore, deserializeConfig } from "../src/state";

const run = promisify(execFile);
const MNEMONIC = "test test test test test test test test test test test junk"; // anvil's public dev mnemonic
const PORT = 22545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const CONTRACTS_DIR = fileURLToPath(new URL("../../contracts", import.meta.url));

const registryAbi = loadAbi("Registry");
const gateAbi = loadAbi("AllowlistGate");
const marketAbi = loadAbi("GapMarket");

function bin(name: "anvil" | "forge"): string {
  const p = join(homedir(), ".foundry", "bin", process.platform === "win32" ? `${name}.exe` : name);
  if (!existsSync(p)) throw new Error(`${name} not found at ${p}: install Foundry (anvil is required for this test)`);
  return p;
}

function devKey(index: number): Hex {
  const k = mnemonicToAccount(MNEMONIC, { addressIndex: index }).getHdKey().privateKey;
  if (!k) throw new Error("no key");
  return bytesToHex(k);
}
const addr = (i: number): Address => mnemonicToAccount(MNEMONIC, { addressIndex: i }).address;

async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await res.json()) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result as T;
}

async function waitForAnvil(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      await rpc("eth_chainId");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("anvil did not start");
}

// Accounts: 0 deployer/owner, 1 keeper, 2..4 humans, 5..7 agents, 9 a stranger without a commit.
const HUMANS = [2, 3, 4];
const AGENTS = [5, 6, 7];
const HUMAN_PATH: Path = [
  { close: 10, high: 12, low: 0 },
  { close: 25, high: 27, low: 8 },
  { close: 15, high: 27, low: 13 },
];
const AGENT_PATH: Path = [
  { close: 0, high: 0, low: 0 },
  { close: 0, high: 0, low: 0 },
  { close: 0, high: 0, low: 0 },
];
const salt = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;

// ---- the mock price feed: flat at 100.00 until the candle window, then three levels of +10, +25, +15 bp
const BASE = 100;
const LEVELS = [100.1, 100.25, 100.15];
const feedState = { windowStart: undefined as number | undefined, calls: 0 };
const feed: PriceFeed = {
  mode: "live",
  attributionBase: "https://twelvedata.com/",
  attributionParams: { interval: "1min" },
  async bars(_ticker, from, to) {
    feedState.calls++;
    const out = [];
    for (let t = Math.ceil(from / 60) * 60; t < to; t += 60) {
      const idx = feedState.windowStart !== undefined && t >= feedState.windowStart ? Math.floor((t - feedState.windowStart) / 300) : -1;
      const p = idx >= 0 ? (LEVELS[idx] as number) : BASE;
      out.push({ t, open: p, high: p, low: p, close: p });
    }
    return out;
  },
};

let anvil: ChildProcess | undefined;
let deps: KeeperDeps;
let arena: Address;
let registry: Address;
let gate: Address;
let market: Address;
let stateDir: string;
let relay: Relay | undefined;
let relayUrl: string;
const publicClient = createPublicClient({ chain: foundry, transport: http(RPC) }) as PublicClient;
const wallet = (i: number) => createWalletClient({ account: privateKeyToAccount(devKey(i)), chain: foundry, transport: http(RPC) });

async function send(i: number, address: Address, abi: unknown, functionName: string, args: unknown[]): Promise<void> {
  const hash = await wallet(i).writeContract({ address, abi, functionName, args } as never);
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
}
const read = (address: Address, abi: unknown, functionName: string, args: unknown[] = []) =>
  publicClient.readContract({ address, abi, functionName, args } as never) as Promise<unknown>;

async function chainNow(): Promise<number> {
  return Number((await publicClient.getBlock()).timestamp);
}
async function jumpTo(ts: number): Promise<void> {
  const now = await chainNow();
  if (ts > now) await rpc("evm_increaseTime", [ts - now]);
  await rpc("evm_mine");
}
const nonceOf = (a: Address) => publicClient.getTransactionCount({ address: a, blockTag: "pending" });

async function postReveal(id: bigint, i: number, path: Path, s: Hex): Promise<{ status: number; body: { code: string; ok: boolean } }> {
  const r = await fetch(`${relayUrl}/reveal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: id.toString(), who: addr(i), path, salt: s }),
  });
  return { status: r.status, body: (await r.json()) as { code: string; ok: boolean } };
}

let loop: LoopHandle | undefined;
const logs: string[] = [];
const alerts: string[] = [];

beforeAll(async () => {
  anvil = spawn(bin("anvil"), ["--port", String(PORT), "--silent"], { stdio: "ignore" });
  anvil.on("error", (e) => {
    throw e;
  });
  await waitForAnvil();
  // Private cache, artifacts and broadcast directories: other test files also run `forge script` for chain 31337
  // in parallel, and sharing contracts/cache and contracts/broadcast makes forge fail on its recovery-state lock.
  stateDir = mkdtempSync(join(tmpdir(), "keeper-e2e-"));
  const forgeDir = join(stateDir, "forge");
  const { stdout } = await run(bin("forge"), ["script", "script/Deploy.s.sol", "--rpc-url", RPC, "--broadcast"], {
    cwd: CONTRACTS_DIR,
    env: {
      ...process.env,
      PRIVATE_KEY: devKey(0),
      KEEPER_ADDRESS: addr(1),
      FOUNDRY_CACHE_PATH: join(forgeDir, "cache"),
      FOUNDRY_OUT: join(forgeDir, "out"),
      FOUNDRY_BROADCAST: join(forgeDir, "broadcast"),
    },
    maxBuffer: 20 * 1024 * 1024,
  });
  const find = (name: string): Address => {
    const m = new RegExp(`\\b${name}\\s+(0x[0-9a-fA-F]{40})`).exec(stdout);
    if (!m) throw new Error(`could not find ${name} in forge output:\n${stdout}`);
    return m[1] as Address;
  };
  arena = find("Arena");
  registry = find("Registry");
  gate = find("AllowlistGate");
  market = find("GapMarket");
  deps = await createKeeperDeps({ rpcUrl: RPC, chainId: 31337, arenaAddress: arena, privateKey: devKey(1) });
  deps.log = (m) => logs.push(m);

  for (const i of HUMANS) {
    await send(0, gate, gateAbi, "setAllowed", [addr(i), true]);
    await send(i, registry, registryAbi, "registerHuman", []);
  }
  for (const i of AGENTS) await send(i, registry, registryAbi, "registerAgent", ['{"role":"test"}']);
}, 300_000);

afterAll(async () => {
  await loop?.stop();
  await relay?.close();
  anvil?.kill();
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
});

describe("keeper loop end to end on anvil", () => {
  let id = 1n;
  let marketEnd = 0;
  let revealEnd = 0;
  let commitEnd = 0;

  it("opens a round from the feed, with the demo windows", async () => {
    const lock = new Mutex();
    relay = createRelay({ chain: createRelayChain(deps, lock), flushMs: 0, log: (m) => logs.push(m) });
    relayUrl = `http://127.0.0.1:${(await relay.listen(0, "127.0.0.1")).port}`;
    loop = await startLoop({
      deps,
      lock,
      feed,
      store: new FileStateStore(join(stateDir, "keeper-state.json")),
      template: demoTemplate(),
      maxRounds: 1,
      tickMs: 0,
      mineOnTick: true,
      dataDelaySec: 0,
      log: (m) => logs.push(m),
      alert: (m) => alerts.push(m),
    });
    await loop.tick();
    expect(await read(arena, arenaAbi, "roundCount")).toBe(1n);
    const r = (await read(arena, arenaAbi, "getRound", [id])) as Record<string, bigint | number>;
    commitEnd = Number(r.commitEnd);
    revealEnd = Number(r.revealEnd);
    marketEnd = Number(r.marketEnd);
    expect(revealEnd - commitEnd).toBe(30);
    expect(marketEnd - revealEnd).toBe(60);
    expect(Number(r.candleSec)).toBe(300);
    expect(r.p0).toBe(100_000_000n); // 100.00 on the 1e6 scale
    expect(r.T).toBe(1); // a flat history
    expect(loop.state().rounds[0]).toMatchObject({ stage: "open", id: "1" });
    // a second tick does not open a second round
    await loop.tick();
    expect(await read(arena, arenaAbi, "roundCount")).toBe(1n);
  });

  it("3 humans and 3 agents commit; the relay queues a human's reveal during the commit window", async () => {
    for (const [n, i] of HUMANS.entries()) {
      await send(i, arena, arenaAbi, "commit", [id, hashPath(HUMAN_PATH, salt(100 + n), addr(i))]);
    }
    for (const [n, i] of AGENTS.entries()) {
      await send(i, arena, arenaAbi, "commit", [id, hashPath(AGENT_PATH, salt(200 + n), addr(i))]);
    }
    expect(await chainNow()).toBeLessThan(commitEnd);
    const nonce0 = await nonceOf(addr(1));
    const queued = await postReveal(id, HUMANS[0] as number, HUMAN_PATH, salt(100));
    expect(queued).toMatchObject({ status: 202, body: { code: "QUEUED" } });
    expect(relay?.queueSize()).toBe(1);
    expect(await nonceOf(addr(1))).toBe(nonce0); // nothing was sent yet
  });

  it("reveals: the queued human via flush, two humans through the relay, three agents directly; a stranger is refused", async () => {
    await jumpTo(commitEnd);
    expect(await chainNow()).toBeLessThan(revealEnd);
    await relay?.flush();
    expect(await relay?.queueSize()).toBe(0);
    for (const n of [1, 2]) {
      const r = await postReveal(id, HUMANS[n] as number, HUMAN_PATH, salt(100 + n));
      expect(r).toMatchObject({ status: 200, body: { ok: true, code: "REVEALED" } });
    }
    // the relay is not an open gas sink: no commit -> no transaction
    const nonce0 = await nonceOf(addr(1));
    expect((await postReveal(id, 9, HUMAN_PATH, salt(1))).body.code).toBe("NO_COMMIT");
    expect((await postReveal(id, HUMANS[1] as number, HUMAN_PATH, salt(999))).body.code).toBe("ALREADY_REVEALED"); // wrong salt is not even looked at once revealed
    expect(await nonceOf(addr(1))).toBe(nonce0);
    for (const [n, i] of AGENTS.entries()) await send(i, arena, arenaAbi, "reveal", [id, addr(i), AGENT_PATH, salt(200 + n)]);
    expect(await read(arena, arenaAbi, "revealCount", [id, 1])).toBe(3n);
    expect(await read(arena, arenaAbi, "revealCount", [id, 2])).toBe(3n);
  });

  it("the loop freezes right after revealEnd; then a bet is placed on each side", async () => {
    await jumpTo(revealEnd);
    expect(((await read(arena, arenaAbi, "consensus", [id, 1])) as [unknown, boolean])[1]).toBe(false);
    await loop?.tick();
    expect(logs.join("\n")).toMatch(/freezeAll: round 1 frozen/);
    expect(((await read(arena, arenaAbi, "consensus", [id, 1])) as [unknown, boolean])[1]).toBe(true);
    expect(((await read(arena, arenaAbi, "consensus", [id, 2])) as [unknown, boolean])[1]).toBe(true);
    expect(loop?.state().rounds[0]?.stage).toBe("frozen");
    expect(await chainNow()).toBeLessThan(marketEnd);
    await send(HUMANS[0] as number, market, marketAbi, "bet", [id, 0, 50n]); // Side.Human
    await send(AGENTS[0] as number, market, marketAbi, "bet", [id, 1, 50n]); // Side.Agent
    expect(await read(market, marketAbi, "status", [id])).toBe(0);
  });

  it("the loop posts the real candles after marketEnd + 3*candleSec; the round settles and GapMarket resolves", async () => {
    feedState.windowStart = marketEnd;
    await jumpTo(marketEnd + 900 - 30);
    await loop?.tick();
    expect(await read(arena, arenaAbi, "settled", [id])).toBe(false); // too early: nothing posted
    await jumpTo(marketEnd + 900);
    const nonce0 = await nonceOf(addr(1));
    await loop?.tick();
    expect(await nonceOf(addr(1))).toBe(nonce0 + 1);

    expect(await read(arena, arenaAbi, "settled", [id])).toBe(true);
    expect(await read(market, marketAbi, "status", [id])).toBe(2);

    const [stored, hash] = (await read(arena, arenaAbi, "realCandles", [id])) as [readonly { close: number; high: number; low: number }[], Hex];
    expect(stored.map((c) => ({ close: c.close, high: c.high, low: c.low }))).toEqual([
      { close: 10, high: 10, low: 0 },
      { close: 25, high: 25, low: 10 },
      { close: 15, high: 25, low: 15 },
    ]);
    // licence-safe source: generic attribution with the window only, and its hash is on chain
    const url = `https://twelvedata.com/?interval=1min&mode=live&from=${marketEnd}&to=${marketEnd + 900}`;
    expect(hash).toBe(keccak256(stringToBytes(url)));

    // humans (who drew the real path) beat the flat agents, by the shared scoring code
    const [humanScore, agentScore] = (await read(arena, arenaAbi, "consensusScores", [id])) as [number, number, boolean, boolean];
    expect(humanScore).toBeGreaterThan(agentScore);
    const real: Path = [
      { close: 10, high: 10, low: 0 },
      { close: 25, high: 25, low: 10 },
      { close: 15, high: 25, low: 15 },
    ];
    expect(humanScore).toBe(score(HUMAN_PATH, real, 1));
    expect(agentScore).toBe(score(AGENT_PATH, real, 1));

    expect(loop?.state().rounds[0]).toMatchObject({ stage: "done", outcome: "settled" });
    await expect(loop?.finished).resolves.toBeUndefined();
    expect(alerts).toEqual([]);
  });

  it("a restarted keeper on the same state does nothing more for the settled round and opens no new one", async () => {
    await loop?.stop();
    const nonce0 = await nonceOf(addr(1));
    const calls0 = feedState.calls;
    loop = await startLoop({
      deps,
      feed,
      store: new FileStateStore(join(stateDir, "keeper-state.json")),
      template: demoTemplate(),
      maxRounds: 1,
      tickMs: 0,
      mineOnTick: true,
      log: (m) => logs.push(m),
      alert: (m) => alerts.push(m),
    });
    await loop.tick();
    await loop.tick();
    expect(await nonceOf(addr(1))).toBe(nonce0);
    expect(feedState.calls).toBe(calls0);
    expect(await read(arena, arenaAbi, "roundCount")).toBe(1n);
    expect(loop.state().rounds.length).toBe(1);
  });

  it("a lost round id is recovered from the RoundOpened logs, and freezeAll on a frozen round sends nothing", async () => {
    const ops = createLoopOps(deps, new Mutex());
    const rc = deserializeConfig((loop as LoopHandle).state().rounds[0]!.cfg);
    expect(await ops.recoverRoundId(rc, 0n)).toBe(id);
    expect(await ops.recoverRoundId({ ...rc, p0: rc.p0 + 1n }, 0n)).toBeUndefined(); // another tuple: not ours
    expect(await ops.recoverRoundId(rc, (await publicClient.getBlockNumber({ cacheTime: 0 })) + 1n)).toBeUndefined(); // scan starts after the log
    expect(await ops.isFrozen(id)).toBe(true);
    const nonce0 = await nonceOf(addr(1));
    await ops.freezeAll(id);
    expect(await nonceOf(addr(1))).toBe(nonce0);
  });

  it("no log line contains a price or a key", async () => {
    const all = [...logs, ...alerts].join("\n");
    expect(all.length).toBeGreaterThan(100);
    for (const needle of ["100.1", "100.25", "100.15", "100000000", devKey(1).slice(2), devKey(0).slice(2)]) expect(all).not.toContain(needle);
  });
});
