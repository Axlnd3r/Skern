// The chain operations the round loop needs, behind an interface so the scheduler can be tested with fakes.
// The default implementation sits on `rounds.ts` (openRound, postCandles) plus `freezeAll` and reads.
// Every send goes through the shared `Mutex` (the relay sends reveals from the same account).
import { parseEventLogs, type Hex } from "viem";
import type { Path } from "../../shared/score";
import type { Mutex } from "./lock";
import {
  KeeperError,
  arenaAbi,
  assertNoPendingTx,
  buildRoundParams,
  openRound,
  postCandles,
  revertName,
  sameParams,
  shortMessage,
  type KeeperDeps,
  type RoundConfig,
} from "./rounds";
import { tickerFromBytes32 } from "./source";

/** `getRound(id)` as the loop uses it: one read, one object, so ticker, start and p0 always belong together. */
export interface RoundOnChain {
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

export interface LoopOps {
  /** Throws unless the signing key is `arena.keeper()`. */
  verifyKeeper(): Promise<void>;
  /** Latest block timestamp, unix seconds. */
  chainNow(): Promise<number>;
  blockNumber(): Promise<bigint>;
  /** Anvil only: mine one block so chain time advances. */
  mine?(): Promise<void>;
  openRound(cfg: RoundConfig): Promise<bigint>;
  /** Scans `RoundOpened` logs from `fromBlock` for a round whose params equal `cfg`. */
  recoverRoundId(cfg: RoundConfig, fromBlock: bigint): Promise<bigint | undefined>;
  getRound(id: bigint): Promise<RoundOnChain>;
  settled(id: bigint): Promise<boolean>;
  isVoid(id: bigint): Promise<boolean>;
  /** True when every present kind has all 9 fields frozen (also true when no kind has reveals). */
  isFrozen(id: bigint): Promise<boolean>;
  freezeAll(id: bigint): Promise<void>;
  postCandles(id: bigint, real: Path, sourceUrl: string): Promise<void>;
}

/** `freezeAll` costs about 2.53M gas; never send with less than this. */
export const MIN_FREEZE_GAS = 3_500_000n;
const ALL_FROZEN = 0x1ff;
const LOG_CHUNK = 2000n;

export function createLoopOps(deps: KeeperDeps, lock: Mutex): LoopOps {
  const log = deps.log ?? ((m: string) => console.log(`[keeper] ${m}`));
  const read = (functionName: string, args: readonly unknown[] = []): Promise<unknown> =>
    deps.publicClient.readContract({ address: deps.arenaAddress, abi: arenaAbi, functionName, args } as never) as Promise<unknown>;

  const ops: LoopOps = {
    async verifyKeeper() {
      const keeper = (await read("keeper")) as string;
      if (keeper.toLowerCase() !== deps.account.address.toLowerCase()) {
        throw new KeeperError("NOT_KEEPER", `the configured key (${deps.account.address}) is not the Arena keeper (${keeper})`);
      }
    },

    async chainNow() {
      const block = await deps.publicClient.getBlock({ blockTag: "latest" });
      return Number(block.timestamp);
    },

    // cacheTime 0: viem caches the block number for a polling interval; a stale value would make the log scan miss new blocks.
    blockNumber: () => deps.publicClient.getBlockNumber({ cacheTime: 0 }),

    async mine() {
      if (deps.chainId !== 31337) throw new KeeperError("WRONG_CHAIN", "evm_mine is only allowed on the local anvil chain");
      await (deps.publicClient as unknown as { request(a: { method: string; params: unknown[] }): Promise<unknown> }).request({
        method: "evm_mine",
        params: [],
      });
    },

    openRound: (cfg) => lock.run(() => openRound(cfg, deps)),

    async recoverRoundId(cfg, fromBlock) {
      const wanted = buildRoundParams(cfg);
      const latest = await deps.publicClient.getBlockNumber({ cacheTime: 0 });
      for (let from = fromBlock; from <= latest; from += LOG_CHUNK) {
        const to = from + LOG_CHUNK - 1n < latest ? from + LOG_CHUNK - 1n : latest;
        const events = (await deps.publicClient.getContractEvents({
          address: deps.arenaAddress,
          abi: arenaAbi,
          eventName: "RoundOpened",
          fromBlock: from,
          toBlock: to,
        } as never)) as unknown as { args: { id: bigint; params: Record<string, unknown> } }[];
        for (const ev of events) {
          if (sameParams(ev.args.params, wanted)) return ev.args.id;
        }
      }
      return undefined;
    },

    async getRound(id) {
      const r = (await read("getRound", [id])) as Record<string, unknown>;
      return {
        ticker: tickerFromBytes32(r.ticker as string),
        p0: BigInt(r.p0 as bigint),
        T: Number(r.T),
        commitEnd: Number(r.commitEnd),
        revealEnd: Number(r.revealEnd),
        marketEnd: Number(r.marketEnd),
        candleSec: Number(r.candleSec),
        settleDeadline: Number(r.settleDeadline),
        entryStake: BigInt(r.entryStake as bigint),
      };
    },

    async settled(id) {
      return (await read("settled", [id])) === true;
    },

    async isVoid(id) {
      return (await read("isVoid", [id])) === true;
    },

    async isFrozen(id) {
      for (const kind of [1, 2]) {
        const count = (await read("revealCount", [id, kind])) as bigint;
        if (count === 0n) continue; // absent side: nothing to freeze
        const mask = Number(await read("frozenMask", [id, kind]));
        if (mask !== ALL_FROZEN) return false;
      }
      return true;
    },

    async freezeAll(id) {
      // Idempotent: nothing is sent when everything is already frozen (also after a restart or by a third party).
      if (await ops.isFrozen(id)) {
        log(`freezeAll: round ${id} is already frozen`);
        return;
      }
      const call = { address: deps.arenaAddress, abi: arenaAbi, functionName: "freezeAll", args: [id], account: deps.account };
      let request: Record<string, unknown>;
      let gas: bigint;
      try {
        const sim = await deps.publicClient.simulateContract({ ...call, gas: MIN_FREEZE_GAS } as never);
        request = sim.request as unknown as Record<string, unknown>;
        const est = ((await deps.publicClient.estimateContractGas(call as never)) * 12n) / 10n;
        gas = est > MIN_FREEZE_GAS ? est : MIN_FREEZE_GAS;
      } catch (e) {
        throw new KeeperError(revertName(e) ?? "SIMULATION", `freezeAll dry run failed: ${revertName(e) ?? shortMessage(e)}`);
      }
      await lock.run(async () => {
        if (await ops.isFrozen(id)) return; // frozen by someone else while we waited for the lock
        await assertNoPendingTx(deps);
        // After this point never sign a second transaction: re-read state instead.
        const done = async (why: string, hash?: Hex): Promise<void> => {
          let frozen = false;
          try {
            frozen = await ops.isFrozen(id);
          } catch {
            /* treated as not frozen below */
          }
          if (frozen) {
            log(`freezeAll: ${why}, but round ${id} is frozen`);
            return;
          }
          throw new KeeperError("SEND_UNCERTAIN", `freezeAll: ${why}${hash ? ` (tx ${hash} may still be pending)` : ""}; NOT re-sending, the next tick re-checks`);
        };
        let hash: Hex;
        try {
          hash = await deps.walletClient.writeContract({ ...request, gas } as never);
        } catch (e) {
          return done(`send failed (${shortMessage(e)})`);
        }
        let receipt;
        try {
          receipt = await deps.publicClient.waitForTransactionReceipt({ hash, timeout: deps.receiptTimeoutMs ?? 120_000 });
        } catch (e) {
          return done(`no receipt (${shortMessage(e)})`, hash);
        }
        if (receipt.status !== "success") return done(`transaction ${hash} reverted`, hash);
        const ready = parseEventLogs({ abi: arenaAbi, eventName: "ConsensusReady", logs: receipt.logs }).length;
        log(`freezeAll: round ${id} frozen in ${hash} (${ready} side(s) became ready)`);
        if (!(await ops.isFrozen(id))) throw new KeeperError("MISMATCH", `round ${id} is not frozen after ${hash}`);
      });
    },

    postCandles: (id, real, sourceUrl) => lock.run(() => postCandles(id, real, sourceUrl, deps)),
  };
  return ops;
}
