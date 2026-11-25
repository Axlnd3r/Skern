// Integration tests against a real local anvil with the contracts deployed by contracts/script/Deploy.s.sol.
// Only anvil's public development mnemonic is used (worthless keys). If anvil or forge are missing these tests
// FAIL loudly on purpose (never skip silently).
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { HttpRequestError, bytesToHex, createPublicClient, createWalletClient, http, keccak256, stringToHex, toHex, type Address, type Hex, type PublicClient } from "viem";
import { foundry } from "viem/chains";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { score, type Path } from "../../shared/score";
import { createMcpServer } from "../src/mcp";
import { SaltError, SaltStore, loadAbi, saltFileName } from "../src/salt";
import {
  arenaAbi,
  createAgent,
  createAgentDeps,
  hashPath,
  loadAgentConfig,
  type Agent,
  type AgentDeps,
  type Clock,
} from "../src/sdk";

const run = promisify(execFile);
const MNEMONIC = "test test test test test test test test test test test junk"; // anvil's public dev mnemonic
const PORT = 19545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const CONTRACTS_DIR = fileURLToPath(new URL("../../contracts", import.meta.url));

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

const GOOD: Path = [
  { close: 10, high: 12, low: -2 },
  { close: 20, high: 22, low: 8 },
  { close: 30, high: 32, low: 18 },
];
const REAL: Path = [
  { close: 10, high: 12, low: -2 },
  { close: 20, high: 22, low: 8 },
  { close: 30, high: 32, low: 18 },
];
const T = 20;

let anvil: ChildProcess | undefined;
let arena: Address;
let registry: Address;
const publicClient = createPublicClient({ chain: foundry, transport: http(RPC) }) as PublicClient;
const keeperWallet = () => createWalletClient({ account: privateKeyToAccount(devKey(1)), chain: foundry, transport: http(RPC) });
const tmpDirs: string[] = [];
const agents: Agent[] = [];

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "agent-sdk-test-"));
  tmpDirs.push(d);
  return d;
}

async function chainNow(): Promise<number> {
  return Number((await publicClient.getBlock()).timestamp);
}

async function jumpTo(ts: number): Promise<void> {
  const now = await chainNow();
  if (ts > now) await rpc("evm_increaseTime", [ts - now + 1]);
  await rpc("evm_mine");
}

/** A clock whose sleep advances the chain (instead of waiting), so a scheduled reveal runs in milliseconds. */
const advancingClock: Clock = {
  nowSec: () => Math.floor(Date.now() / 1000),
  sleep: async (ms) => {
    await rpc("evm_increaseTime", [Math.ceil(ms / 1000)]);
    await rpc("evm_mine");
  },
};
/** A clock whose sleep never returns until the agent is closed: the scheduled reveal never fires. */
const frozenClock: Clock = {
  nowSec: () => Math.floor(Date.now() / 1000),
  sleep: (_ms, signal) => new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true })),
};

async function mkDeps(account: number, saltDir: string, extra: Partial<AgentDeps> = {}): Promise<AgentDeps> {
  const deps = await createAgentDeps({ rpcUrl: RPC, chainId: 31337, arenaAddress: arena, privateKey: devKey(account), saltDir });
  deps.log = () => {};
  return { ...deps, maxSleepMs: 10_000_000, ...extra };
}

async function mkAgent(account: number, saltDir: string, extra: Partial<AgentDeps> = {}): Promise<{ agent: Agent; deps: AgentDeps }> {
  const deps = await mkDeps(account, saltDir, extra);
  const agent = createAgent(deps);
  agents.push(agent);
  return { agent, deps };
}

interface RoundTimes {
  id: bigint;
  commitEnd: number;
  revealEnd: number;
  marketEnd: number;
  candleSec: number;
}

async function newRound(opts: { commitIn?: number } = {}): Promise<RoundTimes> {
  const now = await chainNow();
  const commitEnd = now + (opts.commitIn ?? 600);
  const revealEnd = commitEnd + 600;
  const marketEnd = revealEnd + 600;
  const candleSec = 300;
  const w = keeperWallet();
  const hash = await w.writeContract({
    address: arena,
    abi: arenaAbi,
    functionName: "openRound",
    args: [
      {
        ticker: stringToHex("AAPL", { size: 32 }),
        p0: 19000n,
        T,
        commitEnd: BigInt(commitEnd),
        revealEnd: BigInt(revealEnd),
        marketEnd: BigInt(marketEnd),
        candleSec,
        settleDeadline: BigInt(marketEnd + 3 * candleSec + 3600),
        entryStake: 10n,
      },
    ],
  } as never);
  await publicClient.waitForTransactionReceipt({ hash });
  const id = (await publicClient.readContract({ address: arena, abi: arenaAbi, functionName: "roundCount" })) as bigint;
  return { id, commitEnd, revealEnd, marketEnd, candleSec };
}

async function entryOf(id: bigint, who: Address): Promise<{ kind: number; revealed: boolean; hash: Hex; path: { close: number; high: number; low: number }[] }> {
  const [kind, revealed, hash, path] = (await publicClient.readContract({ address: arena, abi: arenaAbi, functionName: "entryOf", args: [id, who] })) as [
    number,
    boolean,
    Hex,
    { close: number; high: number; low: number }[],
  ];
  return { kind: Number(kind), revealed, hash, path: path.map((c) => ({ close: c.close, high: c.high, low: c.low })) };
}

const nonceOf = (a: Address): Promise<number> => publicClient.getTransactionCount({ address: a, blockTag: "pending" });
const addr = (i: number): Address => mnemonicToAccount(MNEMONIC, { addressIndex: i }).address;

/** Wraps a wallet client so every writeContract is observed (and optionally failed) before it reaches the chain. */
function spyWallet(deps: AgentDeps, hook: (call: { functionName: string; args: readonly unknown[] }) => void | Promise<void>): AgentDeps {
  const wallet = new Proxy(deps.walletClient, {
    get(target, prop, recv) {
      if (prop === "writeContract") {
        return async (a: { functionName: string; args: readonly unknown[] }) => {
          await hook(a);
          return (target.writeContract as (x: unknown) => Promise<Hex>)(a);
        };
      }
      return Reflect.get(target, prop, recv);
    },
  });
  return { ...deps, walletClient: wallet };
}

/** Counts every method call made on the public client. */
function countingPublic(deps: AgentDeps): { deps: AgentDeps; calls: () => number } {
  let n = 0;
  const pc = new Proxy(deps.publicClient, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      return typeof v === "function"
        ? (...a: unknown[]) => {
            n++;
            return (v as (...x: unknown[]) => unknown).apply(target, a);
          }
        : v;
    },
  });
  return { deps: { ...deps, publicClient: pc }, calls: () => n };
}

beforeAll(async () => {
  anvil = spawn(bin("anvil"), ["--port", String(PORT), "--silent"], { stdio: "ignore" });
  anvil.on("error", (e) => {
    throw e;
  });
  await waitForAnvil();
  // Private cache, artifacts and broadcast directories: other test files also run `forge script` for chain 31337
  // in parallel, and sharing contracts/cache and contracts/broadcast makes forge fail on its recovery-state lock.
  const forgeDir = freshDir();
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
  const m = /\bArena\s+(0x[0-9a-fA-F]{40})/.exec(stdout);
  if (!m) throw new Error(`could not find the Arena address in forge output:\n${stdout}`);
  arena = m[1] as Address;
  registry = (await publicClient.readContract({ address: arena, abi: arenaAbi, functionName: "registry" })) as Address;
  // Register dev accounts 2..8 as agents (registration is outside this task, done directly).
  const registryAbi = loadAbi("Registry");
  for (let i = 2; i <= 8; i++) {
    const w = createWalletClient({ account: privateKeyToAccount(devKey(i)), chain: foundry, transport: http(RPC) });
    const h = await w.writeContract({ address: registry, abi: registryAbi, functionName: "registerAgent", args: ["{\"role\":\"test\"}"] } as never);
    await publicClient.waitForTransactionReceipt({ hash: h });
  }
}, 300_000);

afterEach(() => {
  while (agents.length > 0) agents.pop()?.close();
});

afterAll(() => {
  anvil?.kill();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------- tests

const OTHER: Path = [{ close: 5, high: 6, low: 0 }, { close: 20, high: 22, low: 5 }, GOOD[2]];
const keyOf = (id: bigint, who: Address) => ({ chainId: 31337, arena, id, who });
const wire = (p: Path) => p.map((c) => ({ close: c.close, high: c.high, low: c.low }));

describe("hashPath", () => {
  it("hashPath matches Arena.hashPath on Anvil for a fixed vector", async () => {
    const salt = `0x${"11".repeat(32)}` as Hex;
    const who = addr(1); // 0x7099...79C8, the address used for the independent cast vector
    const onChain = await publicClient.readContract({ address: arena, abi: arenaAbi, functionName: "hashPath", args: [wire(GOOD), salt, who] });
    expect(hashPath(GOOD, salt, who)).toBe(onChain);
    // independent value: keccak256(cast abi-encode "f((int32,int32,int32)[3],bytes32,address)" ...)
    expect(onChain).toBe("0xc745c33e50e5d98a0954aa664ead31c9b4b100f0ceff07647f91cbff85748710");
  });

  it("matches the contract for int32 extremes, negatives and other addresses", async () => {
    const extreme: Path = [
      { close: -2147483648, high: 2147483647, low: -2147483648 },
      { close: 0, high: 0, low: -1 },
      { close: 2147483647, high: 2147483647, low: -5 },
    ];
    for (const [path, who] of [
      [extreme, addr(3)],
      [GOOD, addr(0)],
    ] as const) {
      const salt = keccak256(toHex(`${who}`));
      const onChain = await publicClient.readContract({ address: arena, abi: arenaAbi, functionName: "hashPath", args: [wire(path), salt, who] });
      expect(hashPath(path, salt, who)).toBe(onChain);
    }
  });
});

describe("submitPath", () => {
  it("salt is written to disk before the commit transaction is sent", async () => {
    const round = await newRound();
    const dir = freshDir();
    const who = addr(2);
    const seen: { rec: ReturnType<SaltStore["get"]>; arg: unknown; kindOnChain: number; fn: string }[] = [];
    const base = await mkDeps(2, dir, { clock: frozenClock });
    const deps = spyWallet(base, async (call) => {
      seen.push({ rec: new SaltStore(dir).get(keyOf(round.id, who)), arg: call.args[1], kindOnChain: (await entryOf(round.id, who)).kind, fn: call.functionName });
    });
    const agent = createAgent(deps);
    agents.push(agent);

    await agent.submitPath(round.id, GOOD);

    expect(seen).toHaveLength(1);
    const s = seen[0];
    expect(s?.fn).toBe("commit");
    expect(s?.kindOnChain).toBe(0); // nothing committed yet when the file already existed
    expect(s?.rec?.status).toBe("pending");
    expect(s?.rec?.hash).toBe(s?.arg); // the file holds exactly the hash that is being sent
    expect(s?.rec?.hash).toBe(hashPath(GOOD, s?.rec?.salt as Hex, who));
    const after = new SaltStore(dir).get(keyOf(round.id, who));
    expect(after?.status).toBe("committed");
    expect(after?.salt).toBe(s?.rec?.salt);
    expect((await entryOf(round.id, who)).hash).toBe(after?.hash);
  });

  it("a failed commit transaction keeps the salt file, blocks a different path, and a retry reuses the salt", async () => {
    const round = await newRound();
    const dir = freshDir();
    const who = addr(3);
    const base = await mkDeps(3, dir, { clock: frozenClock });
    const failing = createAgent(
      spyWallet(base, () => {
        throw new Error("connection reset");
      }),
    );
    agents.push(failing);
    const nonce0 = await nonceOf(who);

    await expect(failing.submitPath(round.id, GOOD)).rejects.toMatchObject({ code: "SEND_UNCERTAIN" });
    const kept = new SaltStore(dir).get(keyOf(round.id, who));
    expect(kept?.status).toBe("pending");
    expect(kept?.hash).toBe(hashPath(GOOD, kept?.salt as Hex, who));
    expect((await entryOf(round.id, who)).kind).toBe(0);
    expect(await nonceOf(who)).toBe(nonce0);

    // a different path must not replace the kept salt: the earlier transaction could still land
    const other: Path = OTHER;
    await expect(failing.submitPath(round.id, other)).rejects.toMatchObject({ code: "PENDING_DIFFERENT" });
    expect(new SaltStore(dir).get(keyOf(round.id, who))?.salt).toBe(kept?.salt);

    // retry with the same path and a healthy connection reuses the very same salt
    const { agent: healthy } = await mkAgent(3, dir, { clock: frozenClock });
    await healthy.submitPath(round.id, GOOD);
    const done = new SaltStore(dir).get(keyOf(round.id, who));
    expect(done?.salt).toBe(kept?.salt);
    expect(done?.status).toBe("committed");
    expect((await entryOf(round.id, who)).hash).toBe(kept?.hash);
  });

  it("detects a commit that landed although the receipt was lost, and does not send twice", async () => {
    const round = await newRound();
    const dir = freshDir();
    const who = addr(3);
    const base = await mkDeps(3, dir, { clock: frozenClock });
    let sends = 0;
    const lossy: AgentDeps = {
      ...spyWallet(base, () => {
        sends++;
      }),
      publicClient: new Proxy(base.publicClient, {
        get(t, p, r) {
          if (p === "waitForTransactionReceipt") return async () => Promise.reject(new Error("timeout"));
          return Reflect.get(t, p, r);
        },
      }),
    };
    const agent = createAgent(lossy);
    agents.push(agent);
    await agent.submitPath(round.id, GOOD);
    const rec = new SaltStore(dir).get(keyOf(round.id, who));
    expect(sends).toBe(1);
    expect(rec?.status).toBe("committed");
    expect((await entryOf(round.id, who)).hash).toBe(rec?.hash);
  });

  const holes = new Array(3) as unknown as Path;
  // eslint-disable-next-line no-sparse-arrays
  const hole = [GOOD[0], , GOOD[2]] as unknown as Path;
  const invalid: [string, unknown][] = [
    ["high below close", [{ close: 10, high: 5, low: 0 }, GOOD[1], GOOD[2]]],
    ["low above the open (0)", [{ close: 10, high: 12, low: 3 }, GOOD[1], GOOD[2]]],
    ["low above the previous close", [GOOD[0], { close: 20, high: 22, low: 11 }, GOOD[2]]],
    ["high below the previous close", [GOOD[0], { close: 5, high: 8, low: 0 }, GOOD[2]]],
    ["NaN close", [{ close: Number.NaN, high: 12, low: -2 }, GOOD[1], GOOD[2]]],
    ["Infinity high", [{ close: 10, high: Infinity, low: -2 }, GOOD[1], GOOD[2]]],
    ["non-integer close", [{ close: 10.5, high: 12, low: -2 }, GOOD[1], GOOD[2]]],
    ["int32 overflow high", [{ close: 10, high: 2 ** 31, low: -2 }, GOOD[1], GOOD[2]]],
    ["int32 underflow low", [{ close: 10, high: 12, low: -(2 ** 31) - 1 }, GOOD[1], GOOD[2]]],
    ["string number", [{ close: "10", high: 12, low: -2 }, GOOD[1], GOOD[2]]],
    ["missing field", [{ close: 10, high: 12 }, GOOD[1], GOOD[2]]],
    ["null candle", [null, GOOD[1], GOOD[2]]],
    ["two candles", [GOOD[0], GOOD[1]]],
    ["four candles", [...GOOD, GOOD[0]]],
    ["empty array of length 3 (holes)", holes],
    ["hole in the middle", hole],
    ["not an array", { 0: GOOD[0], 1: GOOD[1], 2: GOOD[2], length: 3 }],
    ["undefined", undefined],
  ];

  it.each(invalid)("submitPath rejects an invalid path before sending any transaction: %s", async (_name, bad) => {
    const round = await newRound();
    const dir = freshDir();
    const who = addr(4);
    let sends = 0;
    const counted = countingPublic(await mkDeps(4, dir, { clock: frozenClock }));
    const agent = createAgent(
      spyWallet(counted.deps, () => {
        sends++;
      }),
    );
    agents.push(agent);
    const nonce0 = await nonceOf(who);
    const rpcBefore = counted.calls();

    await expect(agent.submitPath(round.id, bad as Path)).rejects.toMatchObject({ code: "INVALID_PATH" });

    expect(sends).toBe(0);
    expect(await nonceOf(who)).toBe(nonce0);
    expect(counted.calls()).toBe(rpcBefore); // not even an RPC read
    expect(readdirSync(dir)).toEqual([]); // and no salt file
  });

  it("the env-based module function rejects an invalid path before it even needs an environment", async () => {
    const { submitPath } = await import("../src/sdk");
    expect(process.env.AGENT_PRIVATE_KEY).toBeUndefined();
    await expect(submitPath(1n, [{ close: 1, high: 0, low: 0 }, GOOD[1], GOOD[2]])).rejects.toMatchObject({ code: "INVALID_PATH" });
  });

  it("rejects after the commit window without sending or writing a file", async () => {
    const round = await newRound({ commitIn: 60 });
    await jumpTo(round.commitEnd + 1);
    const dir = freshDir();
    const { agent } = await mkAgent(4, dir, { clock: frozenClock });
    const nonce0 = await nonceOf(addr(4));
    await expect(agent.submitPath(round.id, GOOD)).rejects.toMatchObject({ code: "COMMIT_CLOSED" });
    expect(await nonceOf(addr(4))).toBe(nonce0);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("an unregistered address is rejected by the dry run and leaves no salt file", async () => {
    const round = await newRound();
    const dir = freshDir();
    const { agent } = await mkAgent(9, dir, { clock: frozenClock });
    await expect(agent.submitPath(round.id, GOOD)).rejects.toMatchObject({ code: "NotRegistered" });
    expect(readdirSync(dir)).toEqual([]);
    expect(await nonceOf(addr(9))).toBe(0);
  });

  it("a second submit for the same round is idempotent and keeps the first salt", async () => {
    const round = await newRound();
    const dir = freshDir();
    const { agent } = await mkAgent(5, dir, { clock: frozenClock });
    await agent.submitPath(round.id, GOOD);
    const first = new SaltStore(dir).get(keyOf(round.id, addr(5)));
    const nonce0 = await nonceOf(addr(5));
    await agent.submitPath(round.id, GOOD);
    expect(await nonceOf(addr(5))).toBe(nonce0);
    expect(new SaltStore(dir).get(keyOf(round.id, addr(5)))?.salt).toBe(first?.salt);
    const other: Path = OTHER;
    await expect(agent.submitPath(round.id, other)).rejects.toMatchObject({ code: "PENDING_DIFFERENT" });
  });

  it("uses a different salt in every round", async () => {
    const dir = freshDir();
    const { agent } = await mkAgent(5, dir, { clock: frozenClock });
    const a = await newRound();
    const b = await newRound();
    await agent.submitPath(a.id, GOOD);
    await agent.submitPath(b.id, GOOD);
    const s = new SaltStore(dir);
    const sa = s.get(keyOf(a.id, addr(5)))?.salt;
    const sb = s.get(keyOf(b.id, addr(5)))?.salt;
    expect(sa).toBeDefined();
    expect(sa).not.toBe(sb);
  });
});

describe("reveal", () => {
  it("reveal after a process restart uses the persisted salt", async () => {
    const round = await newRound();
    const dir = freshDir();
    const who = addr(5);
    const first = await mkAgent(5, dir, { clock: frozenClock });
    await first.agent.submitPath(round.id, GOOD);
    const persisted = new SaltStore(dir).get(keyOf(round.id, who));
    first.agent.close(); // the process "dies"; only the salt directory survives

    // restart: fresh clients, fresh agent, no in-memory state
    const second = await mkAgent(5, dir, { clock: frozenClock });
    await expect(second.agent.reveal(round.id)).rejects.toMatchObject({ code: "TOO_EARLY" });
    await jumpTo(round.commitEnd + 1);
    await second.agent.reveal(round.id);

    const entry = await entryOf(round.id, who);
    expect(entry.revealed).toBe(true);
    expect(entry.path).toEqual(wire(GOOD));
    const rec = new SaltStore(dir).get(keyOf(round.id, who));
    expect(rec?.status).toBe("revealed");
    expect(rec?.salt).toBe(persisted?.salt);

    // an agent without that salt directory cannot reveal at all
    const lost = await mkAgent(5, freshDir(), { clock: frozenClock });
    await expect(lost.agent.reveal(round.id)).rejects.toMatchObject({ code: "NO_SALT" });
  });

  it("resumePending after a restart reveals automatically with the persisted salt", async () => {
    const round = await newRound();
    const dir = freshDir();
    const who = addr(6);
    const first = await mkAgent(6, dir, { clock: frozenClock });
    await first.agent.submitPath(round.id, GOOD);
    first.agent.close();

    const second = await mkAgent(6, dir, { clock: advancingClock });
    expect(await second.agent.resumePending()).toEqual([round.id]);
    await second.agent.idle();

    expect((await entryOf(round.id, who)).revealed).toBe(true);
    expect(second.agent.revealOutcome(round.id)?.state).toBe("revealed");
    expect(await second.agent.resumePending()).toEqual([]); // nothing left to do
  });

  it("submitPath schedules the reveal and sends it in the window", async () => {
    const round = await newRound();
    const dir = freshDir();
    const { agent } = await mkAgent(7, dir, { clock: advancingClock });
    await agent.submitPath(round.id, GOOD);
    expect((await entryOf(round.id, addr(7))).revealed).toBe(false);
    await agent.idle();
    const entry = await entryOf(round.id, addr(7));
    expect(entry.revealed).toBe(true);
    expect(entry.path).toEqual(wire(GOOD));
    expect(agent.revealOutcome(round.id)?.state).toBe("revealed");
    expect(agent.mySubmission(round.id)?.status).toBe("revealed");
  });

  it("reports a missed window without sending, and a manual reveal after the window fails clearly", async () => {
    const round = await newRound();
    const dir = freshDir();
    const first = await mkAgent(8, dir, { clock: frozenClock });
    await first.agent.submitPath(round.id, GOOD);
    first.agent.close();
    await jumpTo(round.revealEnd + 1);

    const second = await mkAgent(8, dir, { clock: advancingClock });
    const nonce0 = await nonceOf(addr(8));
    await second.agent.resumePending();
    await second.agent.idle();
    expect(second.agent.revealOutcome(round.id)?.state).toBe("missed");
    await expect(second.agent.reveal(round.id)).rejects.toMatchObject({ code: "WINDOW_CLOSED" });
    expect(await nonceOf(addr(8))).toBe(nonce0);
    expect((await entryOf(round.id, addr(8))).revealed).toBe(false);
  });

  it("treats AlreadyRevealed as success, both when it is visible up front and when it only shows in the dry run", async () => {
    const round = await newRound();
    const dir = freshDir();
    const who = addr(2);
    const { agent, deps } = await mkAgent(2, dir, { clock: frozenClock });
    await agent.submitPath(round.id, GOOD);
    const rec = new SaltStore(dir).get(keyOf(round.id, who));
    await jumpTo(round.commitEnd + 1);

    // someone else (here: the keeper account) reveals for `who`: allowed by design (D1)
    const h = await keeperWallet().writeContract({
      address: arena,
      abi: arenaAbi,
      functionName: "reveal",
      args: [round.id, who, wire(GOOD), rec?.salt],
    } as never);
    await publicClient.waitForTransactionReceipt({ hash: h });
    expect((await entryOf(round.id, who)).revealed).toBe(true);

    const nonce0 = await nonceOf(who);
    await agent.reveal(round.id); // visible up front
    expect(new SaltStore(dir).get(keyOf(round.id, who))?.status).toBe("revealed");

    // race: the pre-check still sees "not revealed", so the dry run is what reports AlreadyRevealed
    const racing: AgentDeps = {
      ...deps,
      publicClient: new Proxy(deps.publicClient, {
        get(t, p, r) {
          if (p === "readContract") {
            return async (a: { functionName: string }) => {
              const v = await (t.readContract as (x: unknown) => Promise<unknown>)(a);
              if (a.functionName !== "entryOf") return v;
              const [kind, , hash, path] = v as [number, boolean, Hex, unknown];
              return [kind, false, hash, path];
            };
          }
          return Reflect.get(t, p, r);
        },
      }),
    };
    const racer = createAgent(racing);
    agents.push(racer);
    await racer.reveal(round.id);
    expect(await nonceOf(who)).toBe(nonce0); // no transaction was sent
  });

  it("a salt file whose hash differs from the on-chain commit is refused (the chain is the authority)", async () => {
    const round = await newRound();
    const dirA = freshDir();
    const dirB = freshDir();
    // two different records for the same round and address: only A matches what is on chain
    const a = await mkAgent(3, dirA, { clock: frozenClock });
    await a.agent.submitPath(round.id, GOOD);
    const keyA = keyOf(round.id, addr(3));
    const recB = new SaltStore(dirB).create(keyA, OTHER);
    expect(recB.hash).not.toBe(new SaltStore(dirA).get(keyA)?.hash);
    await jumpTo(round.commitEnd + 1);
    const b = await mkAgent(3, dirB, { clock: frozenClock });
    const nonce0 = await nonceOf(addr(3));
    await expect(b.agent.reveal(round.id)).rejects.toMatchObject({ code: "HASH_MISMATCH" });
    expect(await nonceOf(addr(3))).toBe(nonce0);
    await a.agent.reveal(round.id);
    expect((await entryOf(round.id, addr(3))).revealed).toBe(true);
  });
});

describe("configuration", () => {
  it("reads the key from AGENT_PRIVATE_KEY and never echoes it", async () => {
    expect(() => loadAgentConfig({ RPC_URL: RPC, CHAIN_ID: "31337", ARENA_ADDRESS: arena })).toThrow(/AGENT_PRIVATE_KEY/);
    const secret = "0xnot-a-valid-key-SECRET";
    const cfg = loadAgentConfig({ RPC_URL: RPC, CHAIN_ID: "31337", ARENA_ADDRESS: arena, AGENT_PRIVATE_KEY: secret, AGENT_SALT_DIR: "/x" });
    let msg = "";
    await createAgentDeps(cfg).catch((e: Error) => (msg = e.message));
    expect(msg).toMatch(/AGENT_PRIVATE_KEY/);
    expect(msg).not.toContain("SECRET");
  });

  it("refuses a chain the RPC does not report and chains other than 84532 and 31337", async () => {
    const base = { rpcUrl: RPC, arenaAddress: arena, privateKey: devKey(2), saltDir: freshDir() };
    await expect(createAgentDeps({ ...base, chainId: 84532 })).rejects.toMatchObject({ code: "WRONG_CHAIN" });
    await expect(createAgentDeps({ ...base, chainId: 1 })).rejects.toMatchObject({ code: "WRONG_CHAIN" });
    await expect(createAgentDeps({ ...base, chainId: 31337, arenaAddress: addr(0) })).rejects.toMatchObject({ code: "CONFIG" });
  });
});

describe("MCP server and results", () => {
  it("exposes the five tools and runs a full round: submit, reveal, settle, consensus and results", async () => {
    const round = await newRound();
    const dir = freshDir();
    const who = addr(5);
    const { agent } = await mkAgent(5, dir, { clock: advancingClock });
    const server = createMcpServer(() => Promise.resolve(agent));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
      return { isError: r.isError === true, text: r.content[0]?.text ?? "" };
    };

    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["get_consensus", "get_my_results", "get_round", "list_rounds", "submit_path"]);

    const nonce0 = await nonceOf(who);
    const bad = await call("submit_path", { id: round.id.toString(), path: [10, 5, 0, 20, 22, 8, 30, 32, 18] }); // high1 < close1
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("INVALID_PATH");
    expect(await nonceOf(who)).toBe(nonce0);
    expect((await call("submit_path", { id: round.id.toString(), path: [1, 2, 3] })).isError).toBe(true); // wrong length

    const sub = await call("submit_path", { id: round.id.toString(), path: [10, 12, -2, 20, 22, 8, 30, 32, 18] });
    expect(sub.isError).toBe(false);
    const salt = new SaltStore(dir).get(keyOf(round.id, who))?.salt as Hex;
    expect(sub.text).not.toContain(salt.slice(2)); // the salt never goes to the model
    expect(JSON.parse(sub.text).entry.hash).toBe(hashPath(GOOD, salt, who));

    await agent.idle(); // the scheduled reveal runs in the window
    expect((await entryOf(round.id, who)).revealed).toBe(true);

    const info = JSON.parse((await call("get_round", { id: Number(round.id) })).text);
    expect(info).toMatchObject({ id: round.id.toString(), ticker: "AAPL", T, p0: "19000", bucketWidth: 2, revealCounts: { human: 0, agent: 1 } });

    // settle: the keeper posts the real candles at marketEnd + 3 * candleSec
    await jumpTo(round.marketEnd + 3 * round.candleSec + 1);
    expect(JSON.parse((await call("get_round", { id: round.id.toString() })).text).phase).toBe("play");
    const post = await keeperWallet().writeContract({
      address: arena,
      abi: arenaAbi,
      functionName: "postCandles",
      args: [round.id, wire(REAL), keccak256(toHex("test"))],
      gas: 3_500_000n,
    } as never);
    await publicClient.waitForTransactionReceipt({ hash: post });

    const consensus = JSON.parse((await call("get_consensus", { id: round.id.toString() })).text);
    expect(consensus.phase).toBe("settled");
    expect(consensus.agent).toMatchObject({ present: true, reveals: 1, ready: true, path: wire(GOOD) });
    expect(consensus.human).toMatchObject({ present: false, reveals: 0, ready: false });
    const expected = score(GOOD, REAL, T);
    expect(expected).toBe(100);
    expect(consensus.final).toMatchObject({ humanScore: null, agentScore: expected, baselineScore: 29 });

    const mine = JSON.parse((await call("get_my_results", { limit: 5 })).text) as Record<string, unknown>[];
    const row = mine.find((r) => r.id === round.id.toString());
    expect(row).toMatchObject({ kind: "agent", revealed: true, score: expected, baselineScore: 29, claimed: false, rewardPoints: "71", localStatus: "revealed" });

    const list = JSON.parse((await call("list_rounds", { limit: 3 })).text) as Record<string, unknown>[];
    expect(list[0]?.id).toBe(round.id.toString());
    expect(list.length).toBeLessThanOrEqual(3);
    expect((await call("get_round", { id: "999999" })).isError).toBe(true);

    // the wallet key is never written next to the salts
    for (const f of readdirSync(dir)) expect(readFileSync(join(dir, f), "utf8").toLowerCase()).not.toContain(devKey(5).slice(2).toLowerCase());
    await client.close();
  });
});

// ---------------------------------------------------------------------------------------------- review round 1

/** A clock whose sleep blocks until `open()` is called, and then advances the chain like `advancingClock`. */
function gatedClock(): { clock: Clock; open: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  return {
    open,
    clock: {
      nowSec: () => Math.floor(Date.now() / 1000),
      sleep: async (ms, signal) => {
        await Promise.race([gate, new Promise<void>((r) => signal?.addEventListener("abort", () => r(), { once: true }))]);
        if (signal?.aborted) return;
        await advancingClock.sleep(ms);
      },
    },
  };
}

/** Public client whose receipt wait always fails: the commit may or may not land. */
function lostReceipts(deps: AgentDeps): AgentDeps {
  return {
    ...deps,
    publicClient: new Proxy(deps.publicClient, {
      get(t, p, r) {
        if (p === "waitForTransactionReceipt") return async () => Promise.reject(new Error("timeout"));
        return Reflect.get(t, p, r);
      },
    }),
  };
}

/** Runs `fn` with automine off so a sent transaction stays pending until `evm_mine`. */
async function withoutAutomine<T>(fn: () => Promise<T>): Promise<T> {
  await rpc("evm_setAutomine", [false]);
  try {
    return await fn();
  } finally {
    await rpc("evm_setAutomine", [true]);
  }
}

describe("uncertain commits still get their reveal", () => {
  it("an uncertain commit schedules the reveal before throwing, and it lands after the commit mines late", async () => {
    const round = await newRound();
    const dir = freshDir();
    const who = addr(3);
    const gate = gatedClock();
    const agent = createAgent(lostReceipts(await mkDeps(3, dir, { clock: gate.clock })));
    agents.push(agent);

    await withoutAutomine(async () => {
      await expect(agent.submitPath(round.id, GOOD)).rejects.toMatchObject({ code: "SEND_UNCERTAIN" });
      expect((await entryOf(round.id, who)).kind).toBe(0); // the transaction is only pending
      expect(agent.revealOutcome(round.id)?.state).toBe("scheduled");
    });
    await rpc("evm_mine"); // the commit mines now, before commitEnd
    expect((await entryOf(round.id, who)).kind).not.toBe(0);

    gate.open(); // now let the scheduler move chain time past commitEnd
    await agent.idle();
    expect((await entryOf(round.id, who)).revealed).toBe(true);
    expect(agent.revealOutcome(round.id)?.state).toBe("revealed");
  });

  it("a retry after commitEnd with a landed pending record schedules the reveal instead of COMMIT_CLOSED", async () => {
    const round = await newRound();
    const dir = freshDir();
    const who = addr(4);
    const first = createAgent(lostReceipts(await mkDeps(4, dir, { clock: frozenClock })));
    await withoutAutomine(async () => {
      await expect(first.submitPath(round.id, GOOD)).rejects.toMatchObject({ code: "SEND_UNCERTAIN" });
    });
    await rpc("evm_mine"); // mined late, but before commitEnd
    first.close(); // the process dies before the scheduler can act
    expect(new SaltStore(dir).get(keyOf(round.id, who))?.status).toBe("pending");
    await jumpTo(round.commitEnd + 1);
    expect((await entryOf(round.id, who)).kind).not.toBe(0);

    const { agent } = await mkAgent(4, dir, { clock: advancingClock });
    await agent.submitPath(round.id, GOOD); // used to throw COMMIT_CLOSED
    await agent.idle();
    expect((await entryOf(round.id, who)).revealed).toBe(true);
    expect(new SaltStore(dir).get(keyOf(round.id, who))?.status).toBe("revealed");
  });

  it("a salt file update that fails after a successful commit still schedules the reveal", async () => {
    const round = await newRound();
    const dir = freshDir();
    const who = addr(5);
    const spy = vi.spyOn(SaltStore.prototype, "update").mockImplementationOnce(() => {
      throw new SaltError("SALT_IO", "disk full");
    });
    try {
      const { agent } = await mkAgent(5, dir, { clock: advancingClock });
      await agent.submitPath(round.id, GOOD); // the commit landed: this must not throw
      expect(spy).toHaveBeenCalled();
      expect((await entryOf(round.id, who)).kind).not.toBe(0);
      expect(agent.revealOutcome(round.id)?.state).toBeDefined();
      await agent.idle();
      expect((await entryOf(round.id, who)).revealed).toBe(true);
      expect(agent.revealOutcome(round.id)?.state).toBe("revealed");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("error text never carries an RPC URL", () => {
  const secretUrl = "https://rpc.example.test/v2/SUPERSECRETAPIKEY";

  async function toolText(deps: AgentDeps, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
    const agent = createAgent(deps);
    agents.push(agent);
    const server = createMcpServer(() => Promise.resolve(agent));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    await client.close();
    return { isError: r.isError === true, text: r.content[0]?.text ?? "" };
  }

  /** Deps whose public client fails `method` with `err` (a fresh deps object, so `getChainId` is hit by the first check). */
  const failing = async (method: "readContract" | "getChainId", err: Error): Promise<AgentDeps> => {
    const base = await mkDeps(2, freshDir());
    return { ...base, publicClient: new Proxy(base.publicClient, { get: (t, p, r) => (p === method ? () => Promise.reject(err) : Reflect.get(t, p, r)) }) };
  };

  it.each([
    ["a viem HttpRequestError from a read", "readContract" as const, new HttpRequestError({ url: secretUrl, body: {}, details: "boom" })],
    ["a plain Error that quotes the URL", "readContract" as const, new Error(`fetch failed for ${secretUrl}?x=1`)],
    ["a viem HttpRequestError while checking the chain id", "getChainId" as const, new HttpRequestError({ url: secretUrl, body: {}, details: "boom" })],
  ])("%s", async (_name, method, err) => {
    expect(err.message).toContain("SUPERSECRETAPIKEY"); // the raw message really does leak
    const out = await toolText(await failing(method, err), "list_rounds", {});
    expect(out.isError).toBe(true);
    expect(out.text).not.toContain("SUPERSECRETAPIKEY");
    expect(out.text).not.toContain("rpc.example.test");
  });
});

describe("salt directory robustness", () => {
  it("one unreadable salt file does not block resumePending or a new commit", async () => {
    const round = await newRound();
    const dir = freshDir();
    const who = addr(6);
    const first = await mkAgent(6, dir, { clock: frozenClock });
    await first.agent.submitPath(round.id, GOOD);
    first.agent.close();
    writeFileSync(join(dir, "garbage.salt.json"), "not json at all");
    writeFileSync(join(dir, "31337-0xabc-1-0xdef.salt.json"), JSON.stringify({ version: 1 }));

    const logs: string[] = [];
    const second = await mkAgent(6, dir, { clock: advancingClock, log: (m) => logs.push(m) });
    expect(await second.agent.resumePending()).toEqual([round.id]);
    await second.agent.idle();
    expect((await entryOf(round.id, who)).revealed).toBe(true);
    expect(logs.join("\n")).toMatch(/skipping unreadable salt file garbage\.salt\.json/);

    // creating a salt for a new round still works with the bad files around (create scans the directory)
    const next = await newRound();
    await second.agent.submitPath(next.id, GOOD);
    expect(new SaltStore(dir, { warn: () => {} }).get(keyOf(next.id, who))?.status).toBe("committed");
    // and the strict read of a round's own key still reports corruption instead of ignoring it
    writeFileSync(join(dir, saltFileName(keyOf(999n, who))), "{}");
    expect(() => new SaltStore(dir).get(keyOf(999n, who))).toThrowError(expect.objectContaining({ code: "SALT_CORRUPT" }));
  });
});

describe("sending is serialized", () => {
  it("two concurrent submits never overlap their sends and both commits land", async () => {
    const a = await newRound();
    const b = await newRound();
    const dir = freshDir();
    const who = addr(7);
    const base = await mkDeps(7, dir, { clock: frozenClock });
    let inFlight = 0;
    let maxInFlight = 0;
    const slow = new Proxy(base.walletClient, {
      get(t, p, r) {
        if (p === "writeContract") {
          return async (x: unknown) => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            try {
              await new Promise((res) => setTimeout(res, 150));
              return await (t.writeContract as (y: unknown) => Promise<Hex>)(x);
            } finally {
              inFlight--;
            }
          };
        }
        return Reflect.get(t, p, r);
      },
    });
    const agent = createAgent({ ...base, walletClient: slow });
    agents.push(agent);

    await Promise.all([agent.submitPath(a.id, GOOD), agent.submitPath(b.id, GOOD)]);

    expect(maxInFlight).toBe(1);
    expect((await entryOf(a.id, who)).kind).not.toBe(0);
    expect((await entryOf(b.id, who)).kind).not.toBe(0);
  });
});

describe("stalled chain", () => {
  it("the scheduler gives up on wall-clock time when chain time does not advance", async () => {
    const round = await newRound();
    const dir = freshDir();
    let wall = Math.floor(Date.now() / 1000);
    // The chain is not mined at all while the wall clock runs on (sleep advances only the wall clock).
    const stalled: Clock = {
      nowSec: () => wall,
      sleep: async (ms) => {
        wall += Math.ceil(ms / 1000);
      },
    };
    const { agent } = await mkAgent(8, dir, { clock: stalled, maxSleepMs: 60_000 });
    await agent.submitPath(round.id, GOOD);
    await agent.idle(); // would never return without the fallback
    const out = agent.revealOutcome(round.id);
    expect(out?.state).toBe("missed");
    expect(out?.detail).toMatch(/chain time did not advance/);
    expect((await entryOf(round.id, addr(8))).revealed).toBe(false);
  }, 20_000);
});
