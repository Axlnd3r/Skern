import { describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia, foundry } from "viem/chains";
import { keccak256, stringToBytes, stringToHex } from "viem";
import type { Path } from "../../shared/score";
import {
  createKeeperDeps,
  loadKeeperConfig,
  openRound,
  postCandles,
  sourceHashOf,
  validateRoundConfig,
  type KeeperDeps,
  type RoundConfig,
} from "../src/rounds";

const NOW = 1_800_000_000;
const ARENA = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const;

function cfg(over: Partial<RoundConfig> = {}): RoundConfig {
  return {
    ticker: "AAPL",
    p0: 19_000n,
    T: 15,
    commitEnd: NOW + 90,
    revealEnd: NOW + 120,
    marketEnd: NOW + 180,
    candleSec: 300,
    settleDeadline: NOW + 180 + 900 + 600,
    entryStake: 10n,
    ...over,
  };
}

type Reader = (fn: string, args: readonly unknown[]) => unknown;

/** Mocked clients: every RPC is a spy, so a test can assert that nothing was sent or even called. */
function mockDeps(opts: { chainId?: number; read?: Reader; blockTs?: number } = {}) {
  const account = privateKeyToAccount(generatePrivateKey());
  const readContract = vi.fn(async (a: { functionName: string; args?: readonly unknown[] }) => {
    if (!opts.read) throw new Error(`unexpected read ${a.functionName}`);
    return opts.read(a.functionName, a.args ?? []);
  });
  const getChainId = vi.fn(async () => opts.chainId ?? 31337);
  const getBlock = vi.fn(async () => ({ timestamp: BigInt(opts.blockTs ?? NOW) }));
  const simulateContract = vi.fn(async () => {
    throw new Error("unexpected simulateContract");
  });
  const estimateContractGas = vi.fn(async () => {
    throw new Error("unexpected estimateContractGas");
  });
  const getTransactionCount = vi.fn(async () => 0);
  const writeContract = vi.fn(async () => {
    throw new Error("writeContract must not be called");
  });
  const waitForTransactionReceipt = vi.fn(async () => {
    throw new Error("unexpected wait");
  });
  const deps = {
    publicClient: { readContract, getChainId, getBlock, simulateContract, estimateContractGas, waitForTransactionReceipt, getTransactionCount },
    walletClient: { writeContract },
    account,
    chain: foundry,
    arenaAddress: ARENA,
    chainId: opts.chainId ?? 31337,
    log: () => {},
  } as unknown as KeeperDeps;
  return { deps, readContract, getChainId, getBlock, simulateContract, estimateContractGas, getTransactionCount, writeContract };
}

const z = { close: 0, high: 0, low: 0 };
const validPath: Path = [
  { close: 10, high: 12, low: 0 },
  { close: 22, high: 25, low: 10 },
  { close: 15, high: 22, low: 13 },
];
const invalidPath: Path = [
  { close: 50, high: 50, low: 50 }, // low > open (0): unwidened
  { close: 100, high: 100, low: 100 },
  { close: 30, high: 30, low: 30 },
];

describe("validateRoundConfig", () => {
  it("accepts a sane demo round", () => {
    expect(() => validateRoundConfig(cfg(), NOW)).not.toThrow();
  });

  it("rejects millisecond timestamps (would pin anyCommitWindowOpen() to true)", () => {
    const ms = cfg({
      commitEnd: (NOW + 90) * 1000,
      revealEnd: (NOW + 120) * 1000,
      marketEnd: (NOW + 180) * 1000,
      settleDeadline: (NOW + 1680) * 1000,
    });
    expect(() => validateRoundConfig(ms, NOW)).toThrow(/SECONDS/);
  });

  it("rejects commitEnd more than 3 days ahead", () => {
    const far = 4 * 24 * 3600;
    const c = cfg({ commitEnd: NOW + far, revealEnd: NOW + far + 30, marketEnd: NOW + far + 90, settleDeadline: NOW + far + 5000 });
    expect(() => validateRoundConfig(c, NOW)).toThrow(/3 days/);
  });

  it("rejects wrong ordering and a too-early settleDeadline", () => {
    expect(() => validateRoundConfig(cfg({ commitEnd: NOW }), NOW)).toThrow(/future/);
    expect(() => validateRoundConfig(cfg({ revealEnd: NOW + 90 }), NOW)).toThrow(/revealEnd/);
    expect(() => validateRoundConfig(cfg({ marketEnd: NOW + 120 }), NOW)).toThrow(/marketEnd/);
    expect(() => validateRoundConfig(cfg({ settleDeadline: NOW + 180 + 900 }), NOW)).toThrow(/settleDeadline/);
  });

  it("rejects zero / out-of-range numbers and a long ticker", () => {
    expect(() => validateRoundConfig(cfg({ T: 0 }), NOW)).toThrow(/T /);
    expect(() => validateRoundConfig(cfg({ T: 4294967296 }), NOW)).toThrow(/T /);
    expect(() => validateRoundConfig(cfg({ T: 1.5 }), NOW)).toThrow(/T /);
    expect(() => validateRoundConfig(cfg({ candleSec: 0 }), NOW)).toThrow(/candleSec/);
    expect(() => validateRoundConfig(cfg({ entryStake: 0n }), NOW)).toThrow(/entryStake/);
    expect(() => validateRoundConfig(cfg({ p0: 0n }), NOW)).toThrow(/p0/);
    expect(() => validateRoundConfig(cfg({ ticker: "X".repeat(33) }), NOW)).toThrow(/ticker/);
    expect(() => validateRoundConfig(cfg({ ticker: "" }), NOW)).toThrow(/ticker/);
  });
});

describe("config and chain guard", () => {
  it("refuses a chain that is neither Base Sepolia nor anvil, before any network call", async () => {
    await expect(
      createKeeperDeps({ rpcUrl: "http://127.0.0.1:1", chainId: 1, arenaAddress: ARENA, privateKey: generatePrivateKey() }),
    ).rejects.toThrow(/refusing to run/);
    await expect(
      createKeeperDeps({ rpcUrl: "http://127.0.0.1:1", chainId: 8453, arenaAddress: ARENA, privateKey: generatePrivateKey() }),
    ).rejects.toThrow(/refusing to run/);
  });

  it("never puts the key in an error message", async () => {
    const bad = "0xnot-a-key-" + "ab".repeat(8);
    const err = await createKeeperDeps({ rpcUrl: "http://127.0.0.1:1", chainId: 31337, arenaAddress: ARENA, privateKey: bad }).catch(
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(bad);
    const key = generatePrivateKey();
    const missing = (() => {
      try {
        loadKeeperConfig({ RPC_URL: "x", CHAIN_ID: "31337", ARENA_ADDRESS: ARENA });
      } catch (e) {
        return e as Error;
      }
    })();
    expect(missing?.message).toMatch(/KEEPER_PRIVATE_KEY/);
    expect(missing?.message).not.toContain(key);
  });

  it("loads config from the environment", () => {
    const key = generatePrivateKey();
    const c = loadKeeperConfig({ RPC_URL: "http://x", CHAIN_ID: "84532", ARENA_ADDRESS: ARENA, KEEPER_PRIVATE_KEY: key });
    expect(c).toEqual({ rpcUrl: "http://x", chainId: 84532, arenaAddress: ARENA, privateKey: key });
  });

  it("injected deps on a disallowed chain id are refused before any RPC", async () => {
    const m = mockDeps({ chainId: 1 });
    await expect(openRound(cfg(), m.deps)).rejects.toThrow(/refusing to run/);
    await expect(postCandles(1n, validPath, "https://example.test/x", m.deps)).rejects.toThrow(/refusing to run/);
    expect(m.getChainId).not.toHaveBeenCalled();
    expect(m.writeContract).not.toHaveBeenCalled();
  });

  it("RPC chain id different from the configured one is refused", async () => {
    const m = mockDeps();
    (m.getChainId as unknown as { mockResolvedValue: (v: number) => void }).mockResolvedValue(baseSepolia.id);
    await expect(openRound(cfg(), m.deps)).rejects.toThrow(/RPC reports chain/);
    expect(m.writeContract).not.toHaveBeenCalled();
  });
});

describe("sourceHashOf", () => {
  it("is keccak256 of the UTF-8 bytes of the URL", () => {
    const url = "https://data.example.test/AAPL?from=1&to=2";
    expect(sourceHashOf(url)).toBe(keccak256(stringToBytes(url)));
  });
});

describe("postCandles local checks", () => {
  it("rejects unwidened (invalid) candles before any RPC", async () => {
    const m = mockDeps();
    await expect(postCandles(1n, invalidPath, "https://example.test/x", m.deps)).rejects.toThrow(/not valid/);
    expect(m.getChainId).not.toHaveBeenCalled();
    expect(m.readContract).not.toHaveBeenCalled();
    expect(m.writeContract).not.toHaveBeenCalled();
  });

  it("rejects a holey path, an empty source URL and a bad id before any RPC", async () => {
    const m = mockDeps();
    await expect(postCandles(1n, new Array(3) as unknown as Path, "u", m.deps)).rejects.toThrow(/not valid/);
    await expect(postCandles(1n, [z, , z] as unknown as Path, "u", m.deps)).rejects.toThrow(/not valid/);
    await expect(postCandles(1n, validPath, "", m.deps)).rejects.toThrow(/sourceUrl/);
    await expect(postCandles(0n, validPath, "u", m.deps)).rejects.toThrow(/round id/);
    expect(m.getChainId).not.toHaveBeenCalled();
    expect(m.writeContract).not.toHaveBeenCalled();
  });

  it("rejects an unknown round id", async () => {
    const m = mockDeps({ read: (fn) => (fn === "roundCount" ? 2n : undefined) });
    await expect(postCandles(3n, validPath, "u", m.deps)).rejects.toThrow(/does not exist/);
    expect(m.writeContract).not.toHaveBeenCalled();
  });

  it("returns without sending when the round is already settled (final state)", async () => {
    const url = "u";
    const m = mockDeps({
      read: (fn) => {
        if (fn === "roundCount") return 1n;
        if (fn === "settled") return true;
        if (fn === "realCandles") return [validPath, sourceHashOf(url)];
        throw new Error(`unexpected ${fn}`);
      },
    });
    await expect(postCandles(1n, validPath, url, m.deps)).resolves.toBeUndefined();
    expect(m.simulateContract).not.toHaveBeenCalled();
    expect(m.writeContract).not.toHaveBeenCalled();
  });

  it("throws, without sending, for a void round, too early, and past the settle deadline", async () => {
    const round = { marketEnd: BigInt(NOW), candleSec: 300, settleDeadline: BigInt(NOW + 5000) };
    const base = (voidRound: boolean): Reader => (fn) => {
      if (fn === "roundCount") return 1n;
      if (fn === "settled") return false;
      if (fn === "isVoid") return voidRound;
      if (fn === "getRound") return round;
      throw new Error(`unexpected ${fn}`);
    };
    const v = mockDeps({ read: base(true) });
    await expect(postCandles(1n, validPath, "u", v.deps)).rejects.toThrow(/void/);
    const early = mockDeps({ read: base(false), blockTs: NOW + 899 });
    await expect(postCandles(1n, validPath, "u", early.deps)).rejects.toThrow(/from/);
    const late = mockDeps({ read: base(false), blockTs: NOW + 5001 });
    await expect(postCandles(1n, validPath, "u", late.deps)).rejects.toThrow(/settleDeadline/);
    for (const m of [v, early, late]) expect(m.writeContract).not.toHaveBeenCalled();
  });
});

describe("openRound", () => {
  it("rejects a millisecond commitEnd using the chain time, before any dry run or send", async () => {
    const m = mockDeps({ read: () => 0n });
    const c = cfg({ commitEnd: (NOW + 90) * 1000, revealEnd: (NOW + 120) * 1000, marketEnd: (NOW + 180) * 1000, settleDeadline: (NOW + 1680) * 1000 });
    await expect(openRound(c, m.deps)).rejects.toThrow(/SECONDS/);
    expect(m.simulateContract).not.toHaveBeenCalled();
    expect(m.writeContract).not.toHaveBeenCalled();
  });

  it("returns the existing id of an identical round instead of opening a duplicate", async () => {
    const c = cfg();
    const onChain = {
      ticker: stringToHex("AAPL", { size: 32 }),
      p0: c.p0,
      T: c.T,
      commitEnd: BigInt(c.commitEnd),
      revealEnd: BigInt(c.revealEnd),
      marketEnd: BigInt(c.marketEnd),
      candleSec: c.candleSec,
      settleDeadline: BigInt(c.settleDeadline),
      entryStake: c.entryStake,
    };
    const m = mockDeps({
      read: (fn, args) => {
        if (fn === "roundCount") return 7n;
        if (fn === "getRound") return args[0] === 7n ? { ...onChain, T: 99 } : args[0] === 6n ? onChain : { ...onChain, p0: 1n };
        throw new Error(`unexpected ${fn}`);
      },
    });
    await expect(openRound(c, m.deps)).resolves.toBe(6n);
    expect(m.simulateContract).not.toHaveBeenCalled();
    expect(m.writeContract).not.toHaveBeenCalled();
  });

  it("does not send while an earlier transaction of the keeper is still pending (pending nonce > latest)", async () => {
    const m = mockDeps({ read: (fn) => (fn === "roundCount" ? 0n : undefined) });
    m.simulateContract.mockResolvedValue({ request: {} } as never);
    m.estimateContractGas.mockResolvedValue(100_000n as never);
    m.getTransactionCount.mockImplementation((async (a: { blockTag: string }) => (a.blockTag === "pending" ? 5 : 4)) as never);
    await expect(openRound(cfg(), m.deps)).rejects.toThrow(/pending transaction/);
    expect(m.writeContract).not.toHaveBeenCalled();

    const p = mockDeps({
      read: (fn) => {
        if (fn === "roundCount") return 1n;
        if (fn === "settled" || fn === "isVoid") return false;
        if (fn === "getRound") return { marketEnd: BigInt(NOW - 5000), candleSec: 300, settleDeadline: BigInt(NOW + 5000) };
        throw new Error(`unexpected ${fn}`);
      },
    });
    p.simulateContract.mockResolvedValue({ request: {} } as never);
    p.estimateContractGas.mockResolvedValue(100_000n as never);
    p.getTransactionCount.mockImplementation((async (a: { blockTag: string }) => (a.blockTag === "pending" ? 5 : 4)) as never);
    await expect(postCandles(1n, validPath, "u", p.deps)).rejects.toThrow(/pending transaction/);
    expect(p.writeContract).not.toHaveBeenCalled();
  });

  it("a failed dry run sends nothing", async () => {
    const m = mockDeps({ read: (fn) => (fn === "roundCount" ? 0n : undefined) });
    await expect(openRound(cfg(), m.deps)).rejects.toThrow(/dry run failed/);
    expect(m.writeContract).not.toHaveBeenCalled();
  });
});

