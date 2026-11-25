// House runner tests: wallet file, keeper context validation, and rounds played end to end against a local anvil
// with a stub keeper context server. Only anvil's public development mnemonic is used (worthless keys). Like the
// other anvil tests these FAIL loudly if anvil or forge are missing (never skip silently).
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bytesToHex, createPublicClient, createWalletClient, getAddress, http, stringToHex, type Address, type Hex, type PublicClient } from "viem";
import { foundry } from "viem/chains";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import type { Candle, Path } from "../../shared/score";
import { predict as meanReversion } from "../src/house/meanReversion";
import { predict as momentum } from "../src/house/momentum";
import { WALLET_VARS, buildHouseRunner, createRunner, loadHouseWallets, parseEnvText, parseKeeperContext, type BuiltRunner, type Player } from "../src/house/run";
import { HOUSE_METADATA_URI, type RoundContext } from "../src/house/types";
import { SaltStore } from "../src/salt";
import { AgentError, arenaAbi, createAgent, createAgentDeps, type Clock } from "../src/sdk";

const run = promisify(execFile);
const MNEMONIC = "test test test test test test test test test test test junk";
const PORT = 25545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const CONTRACTS_DIR = fileURLToPath(new URL("../../contracts", import.meta.url));

const tmpDirs: string[] = [];
const freshDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "house-run-"));
  tmpDirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const wire = (p: Path) => p.map((c) => ({ close: c.close, high: c.high, low: c.low }));

/** A calm rising history in bp: closes -50, -40, ... 0. */
const HISTORY: Candle[] = Array.from({ length: 6 }, (_v, i) => ({ close: -50 + 10 * i, high: -50 + 10 * i + 4, low: -50 + 10 * i - 4 }));
const ctxOf = (history: readonly Candle[]): RoundContext => ({ ticker: "AAPL", T: 20, candleCount: 3, recentCandlesBp: history });

// ---------------------------------------------------------------------------------------------- wallet file (no chain)

describe("wallet file", () => {
  const K1 = `0x${"11".repeat(32)}`;
  const K2 = `0x${"22".repeat(32)}`;
  const K3 = `0x${"33".repeat(32)}`;
  const write = (text: string): string => {
    const f = join(freshDir(), ".env.house");
    writeFileSync(f, text);
    return f;
  };

  it("the tiny parser handles comments, export, quotes, CRLF and blanks", () => {
    const parsed = parseEnvText(`# comment\r\nA=1\r\n\r\nexport B = "two"\r\nC='three'\r\nD=\r\nnot a pair\r\n  E=x=y  \r\n`);
    expect(parsed).toEqual({ A: "1", B: "two", C: "three", D: "", E: "x=y" });
  });

  it("loads the three wallets, with or without the 0x prefix", () => {
    const f = write(`MOMENTUM_PRIVATE_KEY=${K1}\nMEANREVERSION_PRIVATE_KEY="${K2.slice(2)}"\nNEWSLLM_PRIVATE_KEY=${K3}\nOTHER=ignored\n`);
    expect(loadHouseWallets(f)).toEqual({ momentum: K1, meanReversion: K2, newsLlm: K3 });
  });

  it("fails loudly, without echoing keys or file contents, for every kind of bad file", () => {
    const secret = "SUPERSECRETNOTAKEY";
    const cases: [string, string | undefined][] = [
      ["missing file", undefined],
      ["missing variable", `MOMENTUM_PRIVATE_KEY=${K1}\nMEANREVERSION_PRIVATE_KEY=${K2}\nNOTE=${secret}\n`],
      ["too short", `MOMENTUM_PRIVATE_KEY=0x${"ab".repeat(31)}\nMEANREVERSION_PRIVATE_KEY=${K2}\nNEWSLLM_PRIVATE_KEY=${K3}\n`],
      ["not hex", `MOMENTUM_PRIVATE_KEY=0x${secret}${"z".repeat(46)}\nMEANREVERSION_PRIVATE_KEY=${K2}\nNEWSLLM_PRIVATE_KEY=${K3}\n`],
      ["same wallet twice", `MOMENTUM_PRIVATE_KEY=${K1}\nMEANREVERSION_PRIVATE_KEY=${K1.toUpperCase().replace("0X", "0x")}\nNEWSLLM_PRIVATE_KEY=${K3}\n`],
      ["empty file", ""],
    ];
    for (const [label, text] of cases) {
      const f = text === undefined ? join(freshDir(), "nope.env") : write(text);
      let err: unknown;
      try {
        loadHouseWallets(f);
      } catch (e) {
        err = e;
      }
      expect(err, label).toBeInstanceOf(AgentError);
      const msg = (err as Error).message;
      expect(msg, label).toMatch(/PRIVATE_KEY|wallet file/);
      for (const leak of [K1, K2, K3, K1.slice(2), K2.slice(2), K3.slice(2), secret, "abababab"]) expect(msg, label).not.toContain(leak);
    }
  });

  it("buildHouseRunner rejects a bad wallet file before any RPC call", async () => {
    const f = write(`MOMENTUM_PRIVATE_KEY=${K1}\n`);
    const logs: string[] = [];
    await expect(buildHouseRunner({ env: { RPC_URL: "http://127.0.0.1:1" }, walletsFile: f, log: (m) => logs.push(m) })).rejects.toMatchObject({ code: "CONFIG" });
    expect(logs.join("\n")).not.toContain(K1);
    expect(Object.values(WALLET_VARS)).toEqual(["MOMENTUM_PRIVATE_KEY", "MEANREVERSION_PRIVATE_KEY", "NEWSLLM_PRIVATE_KEY"]);
  });
});

// ---------------------------------------------------------------------------------------------- keeper context validation

describe("parseKeeperContext", () => {
  const chain = { ticker: "AAPL", T: 20 };
  const good = { ticker: "AAPL", T: 20, candleCount: 3, recentCandlesBp: HISTORY, headlines: ["a headline"] };

  it("accepts a valid context and keeps the chain's ticker and T", () => {
    const ctx = parseKeeperContext(JSON.parse(JSON.stringify(good)), chain);
    expect(ctx).toEqual({ ...good });
    expect(parseKeeperContext({ ...good, headlines: undefined }, chain).headlines).toBeUndefined();
    expect(parseKeeperContext({ ...good, recentCandlesBp: [] }, chain).recentCandlesBp).toEqual([]);
  });

  const bad: [string, unknown][] = [
    ["null", null],
    ["an array", []],
    ["a string", "x"],
    ["another ticker", { ...good, ticker: "MSFT" }],
    ["another T", { ...good, T: 21 }],
    ["a string T", { ...good, T: "20" }],
    ["candleCount 4", { ...good, candleCount: 4 }],
    ["no history array", { ...good, recentCandlesBp: "none" }],
    ["too much history", { ...good, recentCandlesBp: Array.from({ length: 201 }, () => ({ close: 0, high: 1, low: -1 })) }],
    ["a float field", { ...good, recentCandlesBp: [{ close: 0.5, high: 1, low: -1 }] }],
    ["a string field", { ...good, recentCandlesBp: [{ close: "0", high: 1, low: -1 }] }],
    ["a missing field", { ...good, recentCandlesBp: [{ close: 0, high: 1 }] }],
    ["beyond int32", { ...good, recentCandlesBp: [{ close: 2 ** 31, high: 2 ** 31, low: 0 }] }],
    ["high below low", { ...good, recentCandlesBp: [{ close: 0, high: -5, low: 5 }] }],
    ["a null candle", { ...good, recentCandlesBp: [null] }],
    ["headlines not strings", { ...good, headlines: [1] }],
    ["too many headlines", { ...good, headlines: Array.from({ length: 51 }, () => "h") }],
    ["a huge headline", { ...good, headlines: ["x".repeat(1001)] }],
  ];
  it.each(bad)("rejects %s", (_n, payload) => {
    expect(() => parseKeeperContext(payload, chain)).toThrow();
  });
});

// ---------------------------------------------------------------------------------------------- anvil

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

let anvil: ChildProcess | undefined;
let arena: Address;
const publicClient = createPublicClient({ chain: foundry, transport: http(RPC) }) as PublicClient;
const chainNow = async (): Promise<number> => Number((await publicClient.getBlock()).timestamp);
const nonceOf = (a: Address): Promise<number> => publicClient.getTransactionCount({ address: a, blockTag: "pending" });
const HOUSE_ACCOUNTS = { momentum: 2, meanReversion: 3, newsLlm: 4 } as const;
const houseAddr = (n: keyof typeof HOUSE_ACCOUNTS): Address => addr(HOUSE_ACCOUNTS[n]);
let walletsFile: string;

async function entryOf(id: bigint, who: Address): Promise<{ kind: number; revealed: boolean; hash: Hex; path: Path }> {
  const [kind, revealed, hash, path] = (await publicClient.readContract({ address: arena, abi: arenaAbi, functionName: "entryOf", args: [id, who] })) as [number, boolean, Hex, Candle[]];
  return { kind: Number(kind), revealed, hash, path: path.map((c) => ({ close: Number(c.close), high: Number(c.high), low: Number(c.low) })) as unknown as Path };
}

async function newRound(entryStake = 10n): Promise<bigint> {
  // Close every earlier round (their commit windows are 600 s) so a test only ever sees its own open round.
  await rpc("evm_increaseTime", [700]);
  await rpc("evm_mine");
  const now = await chainNow();
  const commitEnd = now + 600;
  const revealEnd = commitEnd + 600;
  const marketEnd = revealEnd + 600;
  const w = createWalletClient({ account: privateKeyToAccount(devKey(1)), chain: foundry, transport: http(RPC) });
  const hash = await w.writeContract({
    address: arena,
    abi: arenaAbi,
    functionName: "openRound",
    args: [
      {
        ticker: stringToHex("AAPL", { size: 32 }),
        p0: 19000n,
        T: 20,
        commitEnd: BigInt(commitEnd),
        revealEnd: BigInt(revealEnd),
        marketEnd: BigInt(marketEnd),
        candleSec: 300,
        settleDeadline: BigInt(marketEnd + 900 + 3600),
        entryStake,
      },
    ],
  } as never);
  await publicClient.waitForTransactionReceipt({ hash });
  return (await publicClient.readContract({ address: arena, abi: arenaAbi, functionName: "roundCount" })) as bigint;
}

/**
 * A clock for the SDK's reveal scheduler. Sleeps block until `release()` (so a test can look at the chain between
 * the commit and the reveal), then move the chain to the wanted time. Concurrent sleeps of the three agents are
 * coalesced (a sleep that is already satisfied is a no-op), so the chain never jumps past the reveal window.
 */
function makeClock(): { clock: Clock; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let queue: Promise<unknown> = Promise.resolve();
  const advance = async (ms: number): Promise<void> => {
    const target = (await chainNow()) + Math.ceil(ms / 1000);
    queue = queue.then(async () => {
      const now = await chainNow();
      if (now < target) {
        await rpc("evm_increaseTime", [target - now]);
        await rpc("evm_mine");
      }
    });
    await queue;
  };
  const clock: Clock = {
    nowSec: () => Math.floor(Date.now() / 1000),
    sleep: async (ms, signal) => {
      await new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        signal?.addEventListener("abort", () => resolve(), { once: true });
        void gate.then(resolve);
      });
      if (signal?.aborted) return;
      await advance(ms);
    },
  };
  return { clock, release };
}

// stub keeper context server
type KeeperMode = "ok" | "wrongTicker" | "http500" | "redirect" | "huge";
let keeper: Server;
let keeperUrl: string;
let keeperMode: KeeperMode = "ok";
let keeperHits: string[] = [];
/** The next N context requests are answered with 404 (the keeper has not opened the round yet). */
let keeper404 = 0;
let hugeBytesSent = 0;

const runners: BuiltRunner[] = [];
afterEach(() => {
  while (runners.length > 0) runners.pop()?.close();
  keeperMode = "ok";
  keeperHits = [];
  keeper404 = 0;
  hugeBytesSent = 0;
});

beforeAll(async () => {
  anvil = spawn(bin("anvil"), ["--port", String(PORT), "--silent"], { stdio: "ignore" });
  anvil.on("error", (e) => {
    throw e;
  });
  await waitForAnvil();
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

  // The three house wallets register through the SDK, exactly like outside agents.
  for (const n of Object.keys(HOUSE_ACCOUNTS) as (keyof typeof HOUSE_ACCOUNTS)[]) {
    const deps = await createAgentDeps({ rpcUrl: RPC, chainId: 31337, arenaAddress: arena, privateKey: devKey(HOUSE_ACCOUNTS[n]), saltDir: freshDir() });
    const agent = createAgent({ ...deps, log: () => {} });
    await agent.registerAgent(HOUSE_METADATA_URI);
    agent.close();
  }
  walletsFile = join(freshDir(), ".env.house");
  writeFileSync(
    walletsFile,
    [`MOMENTUM_PRIVATE_KEY=${devKey(2)}`, `MEANREVERSION_PRIVATE_KEY=${devKey(3)}`, `NEWSLLM_PRIVATE_KEY=${devKey(4)}`, ""].join("\n"),
  );

  keeper = createServer((req, res) => {
    const url = req.url ?? "";
    keeperHits.push(url);
    const m2 = /^\/context\/(\d+)$/.exec(url);
    if (m2 && keeper404 > 0) {
      keeper404--;
      res.writeHead(404).end("not yet");
      return;
    }
    if (!m2 || keeperMode === "http500") {
      res.writeHead(m2 ? 500 : 404).end("no");
      return;
    }
    if (keeperMode === "redirect") {
      res.writeHead(302, { location: "/context/999999" }).end();
      return;
    }
    if (keeperMode === "huge") {
      // An endless chunked body: the client must stop reading at its byte limit.
      res.writeHead(200, { "content-type": "application/json" });
      const chunk = Buffer.alloc(65536, 32);
      const pump = (): void => {
        while (!res.destroyed && hugeBytesSent < 200_000_000) {
          hugeBytesSent += chunk.length;
          if (!res.write(chunk)) return void res.once("drain", pump);
        }
        res.end();
      };
      pump();
      return;
    }
    const body = { ticker: keeperMode === "wrongTicker" ? "MSFT" : "AAPL", T: 20, candleCount: 3, recentCandlesBp: HISTORY };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((r) => keeper.listen(0, "127.0.0.1", r));
  keeperUrl = `http://127.0.0.1:${(keeper.address() as { port: number }).port}`;
}, 300_000);

afterAll(() => {
  keeper?.close();
  anvil?.kill();
});

async function build(saltDir: string, clock: Clock, extra: { keeperUrl?: string; logs?: string[]; contextFallbackSec?: number } = {}): Promise<BuiltRunner> {
  const logs = extra.logs ?? [];
  const runner = await buildHouseRunner({
    env: { RPC_URL: RPC, CHAIN_ID: "31337", ARENA_ADDRESS: arena, KEEPER_URL: extra.keeperUrl ?? keeperUrl, AGENT_SALT_DIR: saltDir },
    walletsFile,
    log: (m) => logs.push(m),
    depsOverride: { clock, pollMs: 50, maxSleepMs: 10_000_000 },
    pollMs: 50,
    ...(extra.contextFallbackSec !== undefined ? { contextFallbackSec: extra.contextFallbackSec } : {}),
  });
  runners.push(runner);
  return runner;
}

const NAMES = ["momentum", "meanReversion", "newsLlm"] as const;
const nonces = async (): Promise<number[]> => Promise.all(NAMES.map((n) => nonceOf(houseAddr(n))));

describe("house runner against anvil", () => {
  it("plays a round end to end: each agent commits once in the window and reveals once in its window", async () => {
    const id = await newRound();
    const { clock, release } = makeClock();
    const logs: string[] = [];
    const dir = freshDir();
    const runner = await build(dir, clock, { logs });
    const before = await nonces();

    await runner.tick();
    const after = await nonces();
    expect(after).toEqual(before.map((n) => n + 1)); // exactly one commit per wallet
    const entries = await Promise.all(NAMES.map((n) => entryOf(id, houseAddr(n))));
    for (const e of entries) {
      expect(e.kind).toBe(2); // Kind.Agent
      expect(e.revealed).toBe(false);
    }
    // a second and third poll in the same window send nothing
    await runner.tick();
    await runner.tick();
    expect(await nonces()).toEqual(after);
    // the context was fetched once for the round, not once per agent
    expect(keeperHits.filter((u) => u === `/context/${id}`)).toHaveLength(1);

    release();
    await runner.idle();
    const revealed = await Promise.all(NAMES.map((n) => entryOf(id, houseAddr(n))));
    for (const e of revealed) expect(e.revealed).toBe(true);
    expect(await nonces()).toEqual(after.map((n) => n + 1)); // one reveal each, nothing else

    const ctx = ctxOf(HISTORY);
    expect(wire(revealed[0]?.path as Path)).toEqual(wire(await momentum(ctx)));
    expect(wire(revealed[1]?.path as Path)).toEqual(wire(await meanReversion(ctx)));
    // no ANTHROPIC_API_KEY in the injected env: the News LLM agent plays its momentum rule
    expect(wire(revealed[2]?.path as Path)).toEqual(wire(await momentum(ctx)));
    expect(wire(revealed[0]?.path as Path)).not.toEqual(wire(revealed[1]?.path as Path));

    const text = logs.join("\n");
    expect(text).toContain(`round ${id} momentum: committed`);
    expect(text).toContain(`round ${id} meanReversion: committed`);
    expect(text).toContain(`round ${id} newsLlm: committed`);
    expect(text).toMatch(/ANTHROPIC_API_KEY/);
    for (const i of [2, 3, 4]) expect(text).not.toContain(devKey(i).slice(2));
    // the salt of every record stays out of the logs
    for (const n of NAMES) {
      const rec = new SaltStore(dir).get({ chainId: 31337, arena, id, who: houseAddr(n) });
      expect(rec?.status).toBe("revealed");
      expect(text).not.toContain((rec?.salt as string).slice(2));
    }
  }, 120_000);

  it("a restart in the middle of the window does not double-commit and still reveals", async () => {
    const id = await newRound();
    const dir = freshDir();
    const first = makeClock();
    const r1 = await build(dir, first.clock);
    await r1.tick();
    const afterCommit = await nonces();
    const hashes = (await Promise.all(NAMES.map((n) => entryOf(id, houseAddr(n))))).map((e) => e.hash);
    r1.close(); // the process dies; the salt files stay

    const second = makeClock();
    const logs: string[] = [];
    const r2 = await build(dir, second.clock, { logs });
    await r2.resume();
    await r2.tick();
    await r2.tick();
    expect(await nonces()).toEqual(afterCommit); // no second commit
    expect((await Promise.all(NAMES.map((n) => entryOf(id, houseAddr(n))))).map((e) => e.hash)).toEqual(hashes);
    expect(logs.filter((m) => m.includes("resumed reveals for rounds") && m.includes(String(id)))).toHaveLength(3);
    expect(logs.join("\n")).toContain("already committed");
    expect(keeperHits.filter((u) => u === `/context/${id}`)).toHaveLength(1); // the second run never needed the context

    second.release();
    await r2.idle();
    for (const n of NAMES) expect((await entryOf(id, houseAddr(n))).revealed).toBe(true);
    expect(await nonces()).toEqual(afterCommit.map((n) => n + 1)); // exactly one reveal each
  }, 120_000);

  it("start() polls on its own, commits a new round, and stops on request", async () => {
    const dir = freshDir();
    const { clock } = makeClock(); // reveals stay parked
    const runner = await build(dir, clock);
    const done = runner.start();
    const id = await newRound();
    const deadline = Date.now() + 20_000;
    let committed = 0;
    while (Date.now() < deadline && committed < 3) {
      committed = (await Promise.all(NAMES.map((n) => entryOf(id, houseAddr(n))))).filter((e) => e.kind === 2).length;
      if (committed < 3) await new Promise((r) => setTimeout(r, 100));
    }
    expect(committed).toBe(3);
    runner.stop();
    await done; // resolves after stop
    const n = await nonces();
    await new Promise((r) => setTimeout(r, 300));
    expect(await nonces()).toEqual(n);
  }, 60_000);

  const fallbacks: [string, () => { url?: string; mode: KeeperMode }][] = [
    ["an unreachable context server", () => ({ url: "http://127.0.0.1:1", mode: "ok" })],
    ["a keeper that answers HTTP 500", () => ({ mode: "http500" })],
    ["a context for the wrong ticker", () => ({ mode: "wrongTicker" })],
    ["no KEEPER_URL at all", () => ({ url: "", mode: "ok" })],
  ];
  it.each(fallbacks)("%s: falls back to an empty history, warns once, and still commits", async (_n, setup) => {
    const { url, mode } = setup();
    keeperMode = mode;
    const id = await newRound();
    const dir = freshDir();
    const logs: string[] = [];
    const runner = await build(dir, makeClock().clock, { keeperUrl: url, logs, contextFallbackSec: 1_000_000 });
    await runner.tick();
    await runner.tick();
    const warnings = logs.filter((m) => m.startsWith("warning:") && /context|KEEPER_URL/.test(m));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain("127.0.0.1"); // URLs are masked
    for (const n of NAMES) {
      expect((await entryOf(id, houseAddr(n))).kind).toBe(2);
      const rec = new SaltStore(dir).get({ chainId: 31337, arena, id, who: houseAddr(n) });
      expect(wire(rec?.path as Path)).toEqual(wire(await momentum(ctxOf([])))); // flat path: nothing to extrapolate
    }
  }, 60_000);

  it("retries a failed commit while the window is open, and never after it closed", async () => {
    const id = await newRound();
    const dir = freshDir();
    const logs: string[] = [];
    const built = await build(dir, makeClock().clock, { logs });
    let calls = 0;
    const flaky: Player[] = built.players.map((p) =>
      p.name !== "momentum"
        ? p
        : {
            ...p,
            agent: {
              ...p.agent,
              submitPath: async (rid: bigint, path: Path) => {
                calls++;
                if (calls === 1) throw new AgentError("SEND_UNCERTAIN", "simulated failure");
                return p.agent.submitPath(rid, path);
              },
            },
          },
    );
    const runner = createRunner({ players: flaky, publicClient, arenaAddress: arena, keeperUrl, pollMs: 50, log: (m) => logs.push(m) });
    await runner.tick();
    expect((await entryOf(id, houseAddr("momentum"))).kind).toBe(0);
    expect((await entryOf(id, houseAddr("meanReversion"))).kind).toBe(2);
    expect(logs.join("\n")).toMatch(/round \d+ momentum: commit failed \(SEND_UNCERTAIN.*will retry/);
    await runner.tick();
    expect((await entryOf(id, houseAddr("momentum"))).kind).toBe(2);
    expect(calls).toBe(2);
    await runner.tick();
    expect(calls).toBe(2); // committed: not asked again

    // a round whose commit window has closed is never attempted
    const late = await newRound();
    await rpc("evm_increaseTime", [601]);
    await rpc("evm_mine");
    const before = await nonces();
    await runner.tick();
    expect(await nonces()).toEqual(before);
    expect(calls).toBe(2);
    expect((await entryOf(late, houseAddr("momentum"))).kind).toBe(0);
  }, 60_000);

  it("a permanent failure (invalid prediction) is logged once and not retried", async () => {
    const id = await newRound();
    const logs: string[] = [];
    const built = await build(freshDir(), makeClock().clock, { logs });
    let predictions = 0;
    const players: Player[] = built.players
      .filter((p) => p.name === "momentum")
      .map((p) => ({
        ...p,
        predict: async () => {
          predictions++;
          return [{ close: 5, high: 1, low: 0 }, { close: 0, high: 0, low: 0 }, { close: 0, high: 0, low: 0 }] as unknown as Path; // high < close
        },
      }));
    const runner = createRunner({ players, publicClient, arenaAddress: arena, keeperUrl, pollMs: 50, log: (m) => logs.push(m) });
    await runner.tick();
    await runner.tick();
    expect(predictions).toBe(1);
    expect((await entryOf(id, houseAddr("momentum"))).kind).toBe(0);
    expect(logs.filter((m) => m.includes("INVALID_PATH") && m.includes("not retrying"))).toHaveLength(1);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------- review follow-ups

describe("house runner: keeper context availability", () => {
  it("a 404 before the keeper opened the round is not cached: the agents wait and then play the real history", async () => {
    const id = await newRound();
    keeper404 = 1;
    const { clock, release } = makeClock();
    const logs: string[] = [];
    const runner = await build(freshDir(), clock, { logs }); // default fallback: 30 s before commitEnd
    const before = await nonces();
    await runner.tick(); // 404
    expect(await nonces()).toEqual(before); // nobody committed on an empty history
    expect(keeperHits.filter((u) => u === `/context/${id}`)).toHaveLength(1); // one shared fetch, not three
    await runner.tick(); // 200
    await runner.tick();
    expect(await nonces()).toEqual(before.map((n) => n + 1));
    expect(keeperHits.filter((u) => u === `/context/${id}`)).toHaveLength(2);
    expect(logs.filter((m) => m.includes("keeper context not ready"))).toHaveLength(1);

    release();
    await runner.idle();
    const ctx = ctxOf(HISTORY);
    expect(wire((await entryOf(id, houseAddr("momentum"))).path)).toEqual(wire(await momentum(ctx)));
    expect(wire((await entryOf(id, houseAddr("meanReversion"))).path)).toEqual(wire(await meanReversion(ctx)));
    expect(wire((await entryOf(id, houseAddr("momentum"))).path)).not.toEqual(wire(await momentum(ctxOf([]))));
  }, 60_000);

  it("falls back to an empty history only close to the end of the commit window, and still commits", async () => {
    const id = await newRound();
    keeperMode = "http500";
    const logs: string[] = [];
    const dir = freshDir();
    const runner = await build(dir, makeClock().clock, { logs });
    const before = await nonces();
    await runner.tick();
    await runner.tick();
    expect(await nonces()).toEqual(before); // still waiting for the keeper
    expect(logs.some((m) => m.startsWith("warning:") && m.includes("context"))).toBe(false);

    await rpc("evm_increaseTime", [575]); // commitEnd is 600 s after the round opened: 25 s left, inside the 30 s margin
    await rpc("evm_mine");
    await runner.tick();
    expect(await nonces()).toEqual(before.map((n) => n + 1));
    expect(logs.filter((m) => m.startsWith("warning:") && m.includes("empty history"))).toHaveLength(1);
    for (const n of NAMES) {
      const rec = new SaltStore(dir).get({ chainId: 31337, arena: getAddress(arena), id, who: houseAddr(n) });
      expect(wire(rec?.path as Path)).toEqual(wire(await momentum(ctxOf([]))));
    }
  }, 60_000);

  it("stops reading an oversized streamed body at the byte limit", async () => {
    const id = await newRound();
    keeperMode = "huge";
    const logs: string[] = [];
    const runner = await build(freshDir(), makeClock().clock, { logs, contextFallbackSec: 1_000_000 });
    await runner.tick();
    await new Promise((r) => setTimeout(r, 300));
    const warnings = logs.filter((m) => m.startsWith("warning:") && m.includes("too large"));
    expect(warnings).toHaveLength(1);
    expect(hugeBytesSent).toBeLessThan(40_000_000); // the server was cut off long before its 200 MB
    for (const n of NAMES) expect((await entryOf(id, houseAddr(n))).kind).toBe(2); // fell back and committed
  }, 60_000);

  it("does not follow a redirect from the keeper", async () => {
    await newRound();
    keeperMode = "redirect";
    const logs: string[] = [];
    const runner = await build(freshDir(), makeClock().clock, { logs, contextFallbackSec: 1_000_000 });
    await runner.tick();
    expect(keeperHits.every((u) => !u.endsWith("/context/999999"))).toBe(true);
    expect(logs.filter((m) => m.startsWith("warning:") && m.includes("empty history"))).toHaveLength(1);
  }, 60_000);
});

describe("house runner: failure handling", () => {
  it("a wallet with too few points is refused once and then left alone", async () => {
    const id = await newRound(100_000n); // far more than the 900 points of a registered agent
    const logs: string[] = [];
    const built = await build(freshDir(), makeClock().clock, { logs });
    let calls = 0;
    const players: Player[] = built.players
      .filter((p) => p.name === "momentum")
      .map((p) => ({
        ...p,
        agent: {
          ...p.agent,
          submitPath: async (rid: bigint, path: Path) => {
            calls++;
            return p.agent.submitPath(rid, path);
          },
        },
      }));
    const runner = createRunner({ players, publicClient, arenaAddress: arena, keeperUrl, pollMs: 50, log: (m) => logs.push(m) });
    for (let i = 0; i < 5; i++) await runner.tick();
    expect(calls).toBe(1);
    expect(logs.filter((m) => m.includes("not retrying"))).toHaveLength(1);
    expect(logs.join("\n")).toContain("InsufficientBalance");
    expect((await entryOf(id, houseAddr("momentum"))).kind).toBe(0);
  }, 60_000);

  it("the same transient failure three times in a row is final", async () => {
    await newRound();
    const logs: string[] = [];
    const built = await build(freshDir(), makeClock().clock, { logs });
    let calls = 0;
    const players: Player[] = built.players
      .filter((p) => p.name === "momentum")
      .map((p) => ({
        ...p,
        agent: {
          ...p.agent,
          submitPath: async () => {
            calls++;
            throw new AgentError("SIMULATION", "commit dry run failed: something odd");
          },
        },
      }));
    const runner = createRunner({ players, publicClient, arenaAddress: arena, keeperUrl, pollMs: 50, log: (m) => logs.push(m) });
    for (let i = 0; i < 6; i++) await runner.tick();
    expect(calls).toBe(3);
    expect(logs.filter((m) => m.includes("will retry"))).toHaveLength(2);
    expect(logs.filter((m) => m.includes("not retrying"))).toHaveLength(1);
  }, 60_000);

  it("after a restart with a pending salt record whose commit never landed, the stored path is committed (not a new prediction)", async () => {
    const id = await newRound();
    const dir = freshDir();
    const stored = [
      { close: 7, high: 9, low: 0 },
      { close: 14, high: 15, low: 7 },
      { close: 21, high: 22, low: 14 },
    ] as unknown as Path;
    // the state a dropped commit leaves behind: a pending record, nothing on chain
    new SaltStore(dir).create({ chainId: 31337, arena: getAddress(arena), id, who: houseAddr("momentum") }, stored);
    expect((await entryOf(id, houseAddr("momentum"))).kind).toBe(0);

    const { clock, release } = makeClock();
    const logs: string[] = [];
    const built = await build(dir, clock, { logs });
    let predictions = 0;
    const players: Player[] = built.players
      .filter((p) => p.name === "momentum")
      .map((p) => ({
        ...p,
        predict: async () => {
          predictions++;
          return momentum(ctxOf([])); // a different path than the stored one
        },
      }));
    const runner = createRunner({ players, publicClient, arenaAddress: arena, keeperUrl, pollMs: 50, log: (m) => logs.push(m) });
    const before = await nonceOf(houseAddr("momentum"));
    await runner.tick();
    await runner.tick();
    expect(await nonceOf(houseAddr("momentum"))).toBe(before + 1); // exactly one commit
    expect(predictions).toBe(0);
    expect(logs.join("\n")).toContain("reusing the path of its stored salt record");
    expect(keeperHits.filter((u) => u === `/context/${id}`)).toHaveLength(0);

    release();
    await runner.idle();
    const e = await entryOf(id, houseAddr("momentum"));
    expect(e.revealed).toBe(true);
    expect(wire(e.path)).toEqual(wire(stored));
  }, 60_000);
});
