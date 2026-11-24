// Integration test against a real local anvil: deploys the contracts with contracts/script/Deploy.s.sol, then
// drives openRound / postCandles through the keeper code. Only anvil's well-known development mnemonic is
// used (public, worthless); the keys are derived at runtime and passed to forge through its environment.
// If anvil or forge are missing this test FAILS loudly on purpose (it never skips silently).
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bytesToHex, type Address, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { buildCandles } from "../src/candles";
import { arenaAbi, createKeeperDeps, openRound, postCandles, sourceHashOf, type KeeperDeps, type RoundConfig } from "../src/rounds";
import type { Path } from "../../shared/score";

const run = promisify(execFile);
const MNEMONIC = "test test test test test test test test test test test junk"; // anvil's public dev mnemonic
const PORT = 18545 + Math.floor(Math.random() * 1000);
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
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
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

let anvil: ChildProcess | undefined;
let deps: KeeperDeps;
let arena: Address;
let deployerAddr: Address;

async function keeperNonce(): Promise<number> {
  return deps.publicClient.getTransactionCount({ address: deps.account.address, blockTag: "pending" });
}

async function chainNow(): Promise<number> {
  const b = await deps.publicClient.getBlock();
  return Number(b.timestamp);
}

const trendSamples = (start: number, iv: number) => {
  const mk = (i: number, v: number) => Array.from({ length: 6 }, (_, k) => ({ t: start + i * iv + k * 40, p: v }));
  // Strong trend: the sampled range of each interval does not include the previous close.
  return [...mk(0, 50), ...mk(1, 100), ...mk(2, 30)];
};

describe("keeper against local anvil", () => {
  beforeAll(async () => {
    anvil = spawn(bin("anvil"), ["--port", String(PORT), "--silent"], { stdio: "ignore" });
    anvil.on("error", (e) => {
      throw e;
    });
    await waitForAnvil();

    const deployerKey = devKey(0);
    const keeperKey = devKey(1);
    deployerAddr = mnemonicToAccount(MNEMONIC, { addressIndex: 0 }).address;
    const keeperAddr = mnemonicToAccount(MNEMONIC, { addressIndex: 1 }).address;
    const { stdout } = await run(
      bin("forge"),
      ["script", "script/Deploy.s.sol", "--rpc-url", RPC, "--broadcast"],
      { cwd: CONTRACTS_DIR, env: { ...process.env, PRIVATE_KEY: deployerKey, KEEPER_ADDRESS: keeperAddr }, maxBuffer: 20 * 1024 * 1024 },
    );
    const m = /\bArena\s+(0x[0-9a-fA-F]{40})/.exec(stdout);
    if (!m) throw new Error(`could not find the Arena address in forge output:\n${stdout}`);
    arena = m[1] as Address;
    deps = await createKeeperDeps({ rpcUrl: RPC, chainId: 31337, arenaAddress: arena, privateKey: keeperKey });
    deps.log = () => {};
  }, 300_000);

  afterAll(() => {
    anvil?.kill();
  });

  it("refuses a key that is not the Arena keeper", async () => {
    await expect(
      createKeeperDeps({ rpcUrl: RPC, chainId: 31337, arenaAddress: arena, privateKey: devKey(0) }),
    ).rejects.toThrow(/not the Arena keeper/);
    expect(deployerAddr).not.toBe(deps.account.address);
  });

  it("refuses to run when the configured chain id differs from the RPC", async () => {
    await expect(
      createKeeperDeps({ rpcUrl: RPC, chainId: 84532, arenaAddress: arena, privateKey: devKey(1) }),
    ).rejects.toThrow(/RPC reports chain 31337/);
  });

  let id: bigint;
  let cfg: RoundConfig;

  it("openRound sends once and is idempotent; a millisecond commitEnd is rejected locally", async () => {
    const now = await chainNow();
    cfg = {
      ticker: "AAPL",
      p0: 19_000n,
      T: 15,
      commitEnd: now + 90,
      revealEnd: now + 120,
      marketEnd: now + 180,
      candleSec: 300,
      settleDeadline: now + 180 + 900 + 3600,
      entryStake: 10n,
    };
    const nonce0 = await keeperNonce();
    await expect(
      openRound({ ...cfg, commitEnd: cfg.commitEnd * 1000, revealEnd: cfg.revealEnd * 1000, marketEnd: cfg.marketEnd * 1000, settleDeadline: cfg.settleDeadline * 1000 }, deps),
    ).rejects.toThrow(/SECONDS/);
    expect(await keeperNonce()).toBe(nonce0);

    id = await openRound(cfg, deps);
    expect(id).toBe(1n);
    expect(await keeperNonce()).toBe(nonce0 + 1);

    // A restart (or a retry) with the same config must not open a second round.
    expect(await openRound(cfg, deps)).toBe(1n);
    expect(await keeperNonce()).toBe(nonce0 + 1);
    const count = (await deps.publicClient.readContract({
      address: arena,
      abi: arenaAbi,
      functionName: "roundCount",
    })) as bigint;
    expect(count).toBe(1n);
  });

  it("rejects unwidened candles locally and a too-early post without sending", async () => {
    const start = cfg.marketEnd;
    const unwidened: Path = [
      { close: 50, high: 50, low: 50 },
      { close: 100, high: 100, low: 100 },
      { close: 30, high: 30, low: 30 },
    ];
    const nonce0 = await keeperNonce();
    await expect(postCandles(id, unwidened, "https://example.test/AAPL", deps)).rejects.toThrow(/not valid/);
    const widened = buildCandles(trendSamples(start, 300), start, 300);
    await expect(postCandles(id, widened, "https://example.test/AAPL", deps)).rejects.toThrow(/from/); // too early
    await expect(postCandles(99n, widened, "https://example.test/AAPL", deps)).rejects.toThrow(/does not exist/);
    expect(await keeperNonce()).toBe(nonce0);
  });

  it("posts widened trending candles after time travel and the round settles", async () => {
    const start = cfg.marketEnd;
    const url = "https://example.test/AAPL?from=1&to=2";
    const widened = buildCandles(trendSamples(start, 300), start, 300);
    expect(widened).toEqual([
      { close: 50, high: 50, low: 0 },
      { close: 100, high: 100, low: 50 },
      { close: 30, high: 100, low: 30 },
    ]);

    await rpc("evm_increaseTime", [180 + 900 + 5]); // past marketEnd + 3*candleSec
    await rpc("evm_mine");

    const nonce0 = await keeperNonce();
    await postCandles(id, widened, url, deps);
    expect(await keeperNonce()).toBe(nonce0 + 1);

    expect(await deps.publicClient.readContract({ address: arena, abi: arenaAbi, functionName: "settled", args: [id] })).toBe(true);
    const [stored, hash] = (await deps.publicClient.readContract({ address: arena, abi: arenaAbi, functionName: "realCandles", args: [id] })) as [
      readonly { close: number; high: number; low: number }[],
      Hex,
    ];
    expect(stored.map((c) => ({ close: c.close, high: c.high, low: c.low }))).toEqual([...widened]);
    expect(hash).toBe(sourceHashOf(url));
  });

  it("a second post with the same data is a no-op; different data is POSTED_DIFFERENT and never re-posted", async () => {
    const start = cfg.marketEnd;
    const other = buildCandles(trendSamples(start, 300).map((s) => ({ t: s.t, p: s.p + 7 })), start, 300);
    const nonce0 = await keeperNonce();
    const widened = buildCandles(trendSamples(start, 300), start, 300);
    await expect(postCandles(id, widened, "https://example.test/AAPL?from=1&to=2", deps)).resolves.toBeUndefined();
    await expect(postCandles(id, other, "https://example.test/AAPL?from=1&to=2", deps)).rejects.toMatchObject({ code: "POSTED_DIFFERENT" });
    await expect(postCandles(id, widened, "https://example.test/other", deps)).rejects.toMatchObject({ code: "POSTED_DIFFERENT" });
    expect(await keeperNonce()).toBe(nonce0);
  });

  it("openRound after commitEnd still recovers the existing round id and sends nothing", async () => {
    expect(await chainNow()).toBeGreaterThan(cfg.commitEnd);
    const nonce0 = await keeperNonce();
    expect(await openRound(cfg, deps)).toBe(id);
    expect(await keeperNonce()).toBe(nonce0);
    // a NEW round whose commitEnd is already in the past is still refused
    await expect(openRound({ ...cfg, p0: cfg.p0 + 1n }, deps)).rejects.toMatchObject({ code: "BAD_ROUND" });
    expect(await keeperNonce()).toBe(nonce0);
  });

  it("handles an AlreadyPosted revert from the dry run (race with another post) without sending", async () => {
    const start = cfg.marketEnd;
    const widened = buildCandles(trendSamples(start, 300), start, 300);
    // Hide the fact that the round is settled from the pre-check so the dry run is what reports AlreadyPosted.
    const real = deps.publicClient;
    const racing = new Proxy(real, {
      get(target, prop, recv) {
        if (prop === "readContract") {
          return async (a: { functionName: string }) =>
            a.functionName === "settled" ? false : (target.readContract as (x: unknown) => Promise<unknown>)(a);
        }
        return Reflect.get(target, prop, recv);
      },
    });
    const logs: string[] = [];
    const racingDeps: KeeperDeps = { ...deps, publicClient: racing, log: (m) => logs.push(m) };
    const nonce0 = await keeperNonce();
    await expect(postCandles(id, widened, "https://example.test/AAPL?from=1&to=2", racingDeps)).resolves.toBeUndefined();
    expect(await keeperNonce()).toBe(nonce0);
    expect(logs.join("\n")).toMatch(/already settled/);
  });
});
