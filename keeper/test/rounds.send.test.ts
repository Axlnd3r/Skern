// Mocked-send tests: pin the code after the dry run (gas, receipt handling, event filtering, final-state
// handling). Logs are encoded with the real ABI so viem's parseEventLogs decodes them for real.
import { describe, expect, it, vi } from "vitest";
import {
  ContractFunctionRevertedError,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  stringToHex,
  type Abi,
  type AbiParameter,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import type { Path } from "../../shared/score";
import { arenaAbi, openRound, postCandles, sourceHashOf, type KeeperDeps, type RoundConfig } from "../src/rounds";

const NOW = 1_800_000_000;
const ARENA = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const;
const HASH_TX = ("0x" + "ab".repeat(32)) as Hex;
const URL_OK = "https://example.test/AAPL?round=1";

const validPath: Path = [
  { close: 10, high: 12, low: 0 },
  { close: 22, high: 25, low: 10 },
  { close: 15, high: 22, low: 13 },
];
type C = { close: number; high: number; low: number };
const z: C = { close: 0, high: 0, low: 0 };

type Reader = (fn: string, args: readonly unknown[]) => unknown;

function mockDeps(read: Reader, blockTs = NOW) {
  const account = privateKeyToAccount(generatePrivateKey());
  const readContract = vi.fn(async (a: { functionName: string; args?: readonly unknown[] }) => read(a.functionName, a.args ?? []));
  const getBlock = vi.fn(async () => ({ timestamp: BigInt(blockTs) }));
  const simulateContract = vi.fn(async () => ({ request: { marker: 1 } }) as unknown);
  const estimateContractGas = vi.fn(async () => 100_000n);
  const getTransactionCount = vi.fn(async () => 0);
  const waitForTransactionReceipt = vi.fn(async () => ({ status: "success", logs: [] }) as unknown);
  const writeContract = vi.fn(async () => HASH_TX);
  const deps = {
    publicClient: {
      readContract,
      getChainId: async () => 31337,
      getBlock,
      simulateContract,
      estimateContractGas,
      waitForTransactionReceipt,
      getTransactionCount,
    },
    walletClient: { writeContract },
    account,
    chain: foundry,
    arenaAddress: ARENA,
    chainId: 31337,
    log: () => {},
  } as unknown as KeeperDeps;
  return { deps, readContract, getBlock, simulateContract, estimateContractGas, waitForTransactionReceipt, writeContract };
}

/** ABI-encode a log of `eventName` the way a node returns it. */
function encodeLog(eventName: string, indexed: Record<string, unknown>, nonIndexed: unknown[], address: Hex = ARENA) {
  const ev = (arenaAbi as Abi).find((x) => x.type === "event" && x.name === eventName) as unknown as {
    inputs: (AbiParameter & { indexed?: boolean })[];
  };
  const topics = encodeEventTopics({ abi: arenaAbi, eventName, args: indexed } as never);
  const data = encodeAbiParameters(ev.inputs.filter((p) => !p.indexed) as AbiParameter[], nonIndexed as never);
  return { address, topics, data, blockHash: null, blockNumber: 1n, logIndex: 0, transactionHash: HASH_TX, transactionIndex: 0, removed: false };
}

const postedLog = (id: bigint, h: Hex, address: Hex = ARENA) => encodeLog("CandlesPosted", { id }, [h, 0, 0, false, false, 0], address);
const okReceipt = (id = 1n) => ({ status: "success" as const, logs: [postedLog(id, sourceHashOf(URL_OK))] });

type Stored = [readonly C[], Hex];
interface PostSetup {
  estimate: bigint;
  receipt: { status: "success" | "reverted"; logs: unknown[] };
  /** settled(id) on the 2nd and later reads (the first, the pre-check, is always false) */
  settledAfter: boolean;
  stored?: Stored;
}

function postMock(s: PostSetup) {
  let settledReads = 0;
  const m = mockDeps((fn) => {
    if (fn === "roundCount") return 1n;
    if (fn === "settled") return settledReads++ === 0 ? false : s.settledAfter;
    if (fn === "isVoid") return false;
    if (fn === "getRound") return { marketEnd: BigInt(NOW - 5000), candleSec: 300, settleDeadline: BigInt(NOW + 5000) };
    if (fn === "realCandles") return s.stored ?? ([validPath, sourceHashOf(URL_OK)] as Stored);
    throw new Error(`unexpected ${fn}`);
  });
  m.estimateContractGas.mockResolvedValue(s.estimate);
  m.waitForTransactionReceipt.mockResolvedValue(s.receipt as unknown);
  return m;
}

describe("postCandles send path (mocked)", () => {
  it("happy path: sends exactly once and resolves", async () => {
    const m = postMock({ estimate: 1_000_000n, receipt: okReceipt(), settledAfter: true });
    await expect(postCandles(1n, validPath, URL_OK, m.deps)).resolves.toBeUndefined();
    expect(m.writeContract).toHaveBeenCalledTimes(1);
  });

  it("gas is at least 3_500_000, otherwise 1.2x the estimate", async () => {
    const low = postMock({ estimate: 2_000_000n, receipt: okReceipt(), settledAfter: true });
    await postCandles(1n, validPath, URL_OK, low.deps);
    expect(low.writeContract).toHaveBeenCalledWith(expect.objectContaining({ gas: 3_500_000n }));
    const high = postMock({ estimate: 4_000_000n, receipt: okReceipt(), settledAfter: true });
    await postCandles(1n, validPath, URL_OK, high.deps);
    expect(high.writeContract).toHaveBeenCalledWith(expect.objectContaining({ gas: 4_800_000n }));
  });

  it("the dry run itself uses the 3_500_000 gas floor", async () => {
    const m = postMock({ estimate: 1n, receipt: okReceipt(), settledAfter: true });
    await postCandles(1n, validPath, URL_OK, m.deps);
    expect(m.simulateContract).toHaveBeenCalledWith(expect.objectContaining({ gas: 3_500_000n }));
  });

  it("a CandlesPosted event for another round id is NO_EVENT", async () => {
    const m = postMock({ estimate: 1n, receipt: okReceipt(2n), settledAfter: true });
    await expect(postCandles(1n, validPath, URL_OK, m.deps)).rejects.toMatchObject({ code: "NO_EVENT" });
  });

  it("a CandlesPosted event with another sourceHash, or from another contract, is NO_EVENT", async () => {
    const wrongHash = postMock({ estimate: 1n, receipt: { status: "success", logs: [postedLog(1n, sourceHashOf("other"))] }, settledAfter: true });
    await expect(postCandles(1n, validPath, URL_OK, wrongHash.deps)).rejects.toMatchObject({ code: "NO_EVENT" });
    const wrongAddr = postMock({
      estimate: 1n,
      receipt: { status: "success", logs: [postedLog(1n, sourceHashOf(URL_OK), "0x000000000000000000000000000000000000dEaD")] },
      settledAfter: true,
    });
    await expect(postCandles(1n, validPath, URL_OK, wrongAddr.deps)).rejects.toMatchObject({ code: "NO_EVENT" });
  });

  it("a reverted receipt re-reads settled: still false is SEND_UNCERTAIN, never re-sent", async () => {
    const m = postMock({ estimate: 1n, receipt: { status: "reverted", logs: [] }, settledAfter: false });
    await expect(postCandles(1n, validPath, URL_OK, m.deps)).rejects.toMatchObject({ code: "SEND_UNCERTAIN" });
    expect(m.writeContract).toHaveBeenCalledTimes(1);
    const settledReads = m.readContract.mock.calls.filter(([a]) => (a as { functionName: string }).functionName === "settled");
    expect(settledReads).toHaveLength(2); // pre-check + re-read
  });

  it("a reverted receipt but settled with our data (lost race) resolves; with other data it is POSTED_DIFFERENT", async () => {
    const same = postMock({ estimate: 1n, receipt: { status: "reverted", logs: [] }, settledAfter: true });
    await expect(postCandles(1n, validPath, URL_OK, same.deps)).resolves.toBeUndefined();
    const diff = postMock({
      estimate: 1n,
      receipt: { status: "reverted", logs: [] },
      settledAfter: true,
      stored: [[z, z, z], sourceHashOf(URL_OK)],
    });
    await expect(postCandles(1n, validPath, URL_OK, diff.deps)).rejects.toMatchObject({ code: "POSTED_DIFFERENT" });
  });

  it("a successful receipt while settled(id) is still false is MISMATCH", async () => {
    const m = postMock({ estimate: 1n, receipt: okReceipt(), settledAfter: false });
    await expect(postCandles(1n, validPath, URL_OK, m.deps)).rejects.toMatchObject({ code: "MISMATCH" });
  });

  it("a send error never re-sends: settled false is SEND_UNCERTAIN", async () => {
    const m = postMock({ estimate: 1n, receipt: okReceipt(), settledAfter: false });
    m.writeContract.mockRejectedValue(new Error("boom"));
    await expect(postCandles(1n, validPath, URL_OK, m.deps)).rejects.toMatchObject({ code: "SEND_UNCERTAIN" });
    expect(m.writeContract).toHaveBeenCalledTimes(1);
  });

  it("a lost receipt (wait throws) never re-sends: settled false is SEND_UNCERTAIN", async () => {
    const m = postMock({ estimate: 1n, receipt: okReceipt(), settledAfter: false });
    m.waitForTransactionReceipt.mockRejectedValue(new Error("timeout"));
    await expect(postCandles(1n, validPath, URL_OK, m.deps)).rejects.toMatchObject({ code: "SEND_UNCERTAIN" });
    expect(m.writeContract).toHaveBeenCalledTimes(1);
  });
});

describe("postCandles on an already-posted round", () => {
  const stored = (over: Partial<C>, idx: number, hash: Hex = sourceHashOf(URL_OK)): Stored => {
    const c = validPath.map((x) => ({ ...x })) as C[];
    c[idx] = { ...(c[idx] as C), ...over };
    return [c, hash];
  };
  const settledMock = (st: Stored) =>
    mockDeps((fn) => {
      if (fn === "roundCount") return 1n;
      if (fn === "settled") return true;
      if (fn === "realCandles") return st;
      throw new Error(`unexpected ${fn}`);
    });
  const alreadyPosted = () =>
    new ContractFunctionRevertedError({
      abi: arenaAbi,
      data: encodeErrorResult({ abi: arenaAbi, errorName: "AlreadyPosted" }),
      functionName: "postCandles",
    });

  it("identical stored data resolves without sending", async () => {
    const m = settledMock([validPath.map((x) => ({ ...x })) as C[], sourceHashOf(URL_OK)]);
    await expect(postCandles(1n, validPath, URL_OK, m.deps)).resolves.toBeUndefined();
    expect(m.writeContract).not.toHaveBeenCalled();
  });

  it("AlreadyPosted from the dry run with identical data resolves, nothing sent", async () => {
    const m = postMock({ estimate: 1n, receipt: okReceipt(), settledAfter: false });
    m.simulateContract.mockRejectedValue(alreadyPosted());
    await expect(postCandles(1n, validPath, URL_OK, m.deps)).resolves.toBeUndefined();
    expect(m.writeContract).not.toHaveBeenCalled();
  });

  // One field at a time, so every comparison in the equality check is pinned.
  const variants: [string, Stored][] = [
    ["close only (candle 1)", stored({ close: 11 }, 0)],
    ["high only (candle 1)", stored({ high: 13 }, 0)],
    ["low only (candle 1)", stored({ low: -1 }, 0)],
    ["close only (candle 2)", stored({ close: 23 }, 1)],
    ["high only (candle 2)", stored({ high: 26 }, 1)],
    ["low only (candle 2)", stored({ low: 9 }, 1)],
    ["close only (candle 3)", stored({ close: 16 }, 2)],
    ["high only (candle 3)", stored({ high: 23 }, 2)],
    ["low only (candle 3)", stored({ low: 12 }, 2)],
    ["sourceHash only", stored({}, 0, sourceHashOf("other"))],
  ];
  for (const [name, st] of variants) {
    it(`differs in ${name}: POSTED_DIFFERENT from the settled pre-check, nothing sent`, async () => {
      const m = settledMock(st);
      await expect(postCandles(1n, validPath, URL_OK, m.deps)).rejects.toMatchObject({ code: "POSTED_DIFFERENT" });
      expect(m.writeContract).not.toHaveBeenCalled();
      expect(m.simulateContract).not.toHaveBeenCalled();
    });

    it(`differs in ${name}: POSTED_DIFFERENT from an AlreadyPosted dry run, nothing sent`, async () => {
      const m = postMock({ estimate: 1n, receipt: okReceipt(), settledAfter: false, stored: st });
      m.simulateContract.mockRejectedValue(alreadyPosted());
      await expect(postCandles(1n, validPath, URL_OK, m.deps)).rejects.toMatchObject({ code: "POSTED_DIFFERENT" });
      expect(m.writeContract).not.toHaveBeenCalled();
    });
  }
});

describe("openRound send path (mocked)", () => {
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
  const params = (c: RoundConfig, over: Record<string, unknown> = {}) => ({
    ticker: stringToHex(c.ticker, { size: 32 }),
    p0: c.p0,
    T: c.T,
    commitEnd: BigInt(c.commitEnd),
    revealEnd: BigInt(c.revealEnd),
    marketEnd: BigInt(c.marketEnd),
    candleSec: c.candleSec,
    settleDeadline: BigInt(c.settleDeadline),
    entryStake: c.entryStake,
    ...over,
  });
  const openedLog = (id: bigint, p: unknown) => encodeLog("RoundOpened", { id }, [p, 2]);

  function openMock(receipt: { status: "success" | "reverted"; logs: unknown[] }, countAfter: bigint, existing?: unknown, blockTs = NOW) {
    let counts = 0;
    const m = mockDeps((fn) => {
      if (fn === "roundCount") return counts++ === 0 ? (existing ? 1n : 0n) : countAfter;
      if (fn === "getRound") return existing;
      throw new Error(`unexpected ${fn}`);
    }, blockTs);
    m.waitForTransactionReceipt.mockResolvedValue(receipt as unknown);
    return m;
  }

  it("happy path returns the id from the RoundOpened event, sending once", async () => {
    const c = cfg();
    const m = openMock({ status: "success", logs: [openedLog(1n, params(c))] }, 1n);
    await expect(openRound(c, m.deps)).resolves.toBe(1n);
    expect(m.writeContract).toHaveBeenCalledTimes(1);
  });

  it("RoundOpened params that differ from what was sent are MISMATCH", async () => {
    const c = cfg();
    const m = openMock({ status: "success", logs: [openedLog(1n, params(c, { T: c.T + 1 }))] }, 1n);
    await expect(openRound(c, m.deps)).rejects.toMatchObject({ code: "MISMATCH" });
  });

  it("an event id above roundCount is MISMATCH; a missing event is NO_EVENT; a revert is TX_REVERTED", async () => {
    const c = cfg();
    const big = openMock({ status: "success", logs: [openedLog(5n, params(c))] }, 1n);
    await expect(openRound(c, big.deps)).rejects.toMatchObject({ code: "MISMATCH" });
    const none = openMock({ status: "success", logs: [] }, 1n);
    await expect(openRound(c, none.deps)).rejects.toMatchObject({ code: "NO_EVENT" });
    const rev = openMock({ status: "reverted", logs: [] }, 1n);
    await expect(openRound(c, rev.deps)).rejects.toMatchObject({ code: "TX_REVERTED" });
  });

  it("after commitEnd an identical existing round is still found and nothing is sent", async () => {
    const c = cfg();
    const m = openMock({ status: "success", logs: [] }, 1n, params(c), c.commitEnd + 1000);
    await expect(openRound(c, m.deps)).resolves.toBe(1n);
    expect(m.simulateContract).not.toHaveBeenCalled();
    expect(m.writeContract).not.toHaveBeenCalled();
  });

  it("a NEW round whose commitEnd is already past is BAD_ROUND, nothing sent", async () => {
    const c = cfg();
    const m = openMock({ status: "success", logs: [] }, 1n, undefined, c.commitEnd + 1000);
    await expect(openRound(c, m.deps)).rejects.toMatchObject({ code: "BAD_ROUND" });
    expect(m.writeContract).not.toHaveBeenCalled();
  });
});
