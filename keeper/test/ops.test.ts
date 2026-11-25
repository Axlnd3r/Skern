// Send paths of the loop operations and the relay chain with mocked clients: gas floors and caps, idempotence,
// and "never sign a second transaction after a send".
import { describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { Mutex } from "../src/lock";
import { MIN_FREEZE_GAS, createLoopOps } from "../src/ops";
import { MAX_REVEAL_GAS, RelayChainError, createRelayChain } from "../src/relay";
import type { KeeperDeps } from "../src/rounds";
import type { Path } from "../../shared/score";

const ARENA = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const;
const TX = ("0x" + "cd".repeat(32)) as Hex;
const PATH: Path = [
  { close: 10, high: 12, low: 0 },
  { close: 20, high: 22, low: 8 },
  { close: 30, high: 32, low: 18 },
];

function mock(read: (fn: string, args: readonly unknown[]) => unknown) {
  const account = privateKeyToAccount(generatePrivateKey());
  const readContract = vi.fn(async (a: { functionName: string; args?: readonly unknown[] }) => read(a.functionName, a.args ?? []));
  const simulateContract = vi.fn(async () => ({ request: { marker: 1 } }) as unknown);
  const estimateContractGas = vi.fn(async () => 2_000_000n);
  const getTransactionCount = vi.fn(async () => 0);
  const writeContract = vi.fn(async () => TX);
  const waitForTransactionReceipt = vi.fn(async () => ({ status: "success", logs: [] }) as unknown);
  const deps = {
    publicClient: { readContract, simulateContract, estimateContractGas, getTransactionCount, waitForTransactionReceipt, getChainId: async () => 31337 },
    walletClient: { writeContract },
    account,
    chain: foundry,
    arenaAddress: ARENA,
    chainId: 31337,
    log: () => {},
  } as unknown as KeeperDeps;
  return { deps, readContract, simulateContract, estimateContractGas, writeContract, waitForTransactionReceipt, getTransactionCount };
}

describe("loop ops: freezeAll", () => {
  /** `frozen` is a function so a test can flip it after the send. */
  const reader = (frozen: () => boolean) => (fn: string): unknown => {
    if (fn === "revealCount") return 3n;
    if (fn === "frozenMask") return frozen() ? 0x1ff : 0x0ff;
    throw new Error(`unexpected ${fn}`);
  };

  it("sends nothing when everything is already frozen", async () => {
    const m = mock(reader(() => true));
    await createLoopOps(m.deps, new Mutex()).freezeAll(1n);
    expect(m.simulateContract).not.toHaveBeenCalled();
    expect(m.writeContract).not.toHaveBeenCalled();
  });

  it("an absent side (0 reveals) needs no freezing: no transaction", async () => {
    const m = mock((fn) => (fn === "revealCount" ? 0n : (() => { throw new Error("no mask read expected"); })()));
    await createLoopOps(m.deps, new Mutex()).freezeAll(1n);
    expect(m.writeContract).not.toHaveBeenCalled();
  });

  it("sends once with at least 3_500_000 gas (the dry run uses the floor too)", async () => {
    let frozen = false;
    const m = mock(reader(() => frozen));
    m.writeContract.mockImplementation(async () => {
      frozen = true;
      return TX;
    });
    await createLoopOps(m.deps, new Mutex()).freezeAll(1n);
    expect(m.writeContract).toHaveBeenCalledTimes(1);
    expect(m.writeContract).toHaveBeenCalledWith(expect.objectContaining({ gas: MIN_FREEZE_GAS }));
    expect(m.simulateContract).toHaveBeenCalledWith(expect.objectContaining({ gas: MIN_FREEZE_GAS }));
  });

  it("a receipt timeout is SEND_UNCERTAIN and never a second send; frozen by then is success", async () => {
    let frozen = false;
    const m = mock(reader(() => frozen));
    m.waitForTransactionReceipt.mockRejectedValue(new Error("timed out"));
    const ops = createLoopOps(m.deps, new Mutex());
    await expect(ops.freezeAll(1n)).rejects.toMatchObject({ code: "SEND_UNCERTAIN" });
    expect(m.writeContract).toHaveBeenCalledTimes(1);
    frozen = true; // it was mined after all
    await expect(ops.freezeAll(1n)).resolves.toBeUndefined();
    expect(m.writeContract).toHaveBeenCalledTimes(1);
  });

  it("a failed dry run (for example FreezeTooEarly) sends nothing", async () => {
    const m = mock(reader(() => false));
    m.simulateContract.mockRejectedValue(new Error("revert"));
    await expect(createLoopOps(m.deps, new Mutex()).freezeAll(1n)).rejects.toMatchObject({ code: "SIMULATION" });
    expect(m.writeContract).not.toHaveBeenCalled();
  });

  it("refuses to send while the keeper account has a transaction pending", async () => {
    const m = mock(reader(() => false));
    m.getTransactionCount.mockImplementation((async (a: { blockTag: string }) => (a.blockTag === "pending" ? 5 : 4)) as never);
    await expect(createLoopOps(m.deps, new Mutex()).freezeAll(1n)).rejects.toMatchObject({ code: "PENDING_TX" });
    expect(m.writeContract).not.toHaveBeenCalled();
  });

  it("mine() is refused outside the local chain", async () => {
    const m = mock(reader(() => true));
    (m.deps as { chainId: number }).chainId = 84532;
    await expect(createLoopOps(m.deps, new Mutex()).mine?.()).rejects.toMatchObject({ code: "WRONG_CHAIN" });
  });

  it("verifyKeeper rejects a key that is not Arena.keeper()", async () => {
    const m = mock((fn) => (fn === "keeper" ? "0x000000000000000000000000000000000000dEaD" : undefined));
    await expect(createLoopOps(m.deps, new Mutex()).verifyKeeper()).rejects.toMatchObject({ code: "NOT_KEEPER" });
  });
});

describe("relay chain: reveal gas", () => {
  const WHO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
  const SALT = ("0x" + "11".repeat(32)) as Hex;

  it("pads the estimate by 30 percent and caps the gas limit", async () => {
    const m = mock(() => undefined);
    m.estimateContractGas.mockResolvedValue(349_000n);
    const chain = createRelayChain(m.deps, new Mutex());
    expect(await chain.sendReveal(1n, WHO, PATH, SALT)).toBe(TX);
    expect(m.writeContract).toHaveBeenCalledWith(expect.objectContaining({ gas: (349_000n * 13n) / 10n }));
    m.estimateContractGas.mockResolvedValue(MAX_REVEAL_GAS);
    await chain.sendReveal(1n, WHO, PATH, SALT);
    expect(m.writeContract).toHaveBeenLastCalledWith(expect.objectContaining({ gas: 700_000n }));
  });

  it("an estimate above the bound is refused before any send (no gas sink)", async () => {
    const m = mock(() => undefined);
    m.estimateContractGas.mockResolvedValue(MAX_REVEAL_GAS + 1n);
    await expect(createRelayChain(m.deps, new Mutex()).sendReveal(1n, WHO, PATH, SALT)).rejects.toMatchObject({ code: "GAS_TOO_HIGH" });
    expect(m.writeContract).not.toHaveBeenCalled();
  });

  it("a failing dry run sends nothing", async () => {
    const m = mock(() => undefined);
    m.simulateContract.mockRejectedValue(new Error("boom"));
    await expect(createRelayChain(m.deps, new Mutex()).sendReveal(1n, WHO, PATH, SALT)).rejects.toBeInstanceOf(RelayChainError);
    expect(m.writeContract).not.toHaveBeenCalled();
  });

  it("sends are serialized through the shared lock (one nonce sequence with the round loop)", async () => {
    const m = mock(() => undefined);
    m.estimateContractGas.mockResolvedValue(349_000n);
    const order: string[] = [];
    m.writeContract.mockImplementation(async () => {
      order.push("start");
      await new Promise((r) => setTimeout(r, 10));
      order.push("end");
      return TX;
    });
    const chain = createRelayChain(m.deps, new Mutex());
    await Promise.all([chain.sendReveal(1n, WHO, PATH, SALT), chain.sendReveal(2n, WHO, PATH, SALT)]);
    expect(order).toEqual(["start", "end", "start", "end"]);
  });

  it("waitReveal maps receipt outcomes and never throws", async () => {
    const m = mock(() => undefined);
    const chain = createRelayChain(m.deps, new Mutex());
    expect(await chain.waitReveal(TX)).toBe("success");
    m.waitForTransactionReceipt.mockResolvedValue({ status: "reverted", logs: [] } as never);
    expect(await chain.waitReveal(TX)).toBe("reverted");
    m.waitForTransactionReceipt.mockRejectedValue(new Error("timeout"));
    expect(await chain.waitReveal(TX)).toBe("timeout");
  });
});

describe("mutex", () => {
  it("a rejection does not poison later runs", async () => {
    const lock = new Mutex();
    await expect(lock.run(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    await expect(lock.run(async () => 7)).resolves.toBe(7);
  });
});
