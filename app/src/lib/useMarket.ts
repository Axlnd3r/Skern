import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useReadContracts } from "wagmi";
import { getAccount, getBlock, readContracts, simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { zeroAddress, type Address } from "viem";
import { addresses, arenaAbi, BASE_SEPOLIA_CHAIN_ID, gapMarketCallAbi, wagmiConfig } from "./chain";
import { marketAddresses, marketContracts, parseMarketReads, type MarketData, type Side } from "./market";
import { awaitReceipt, receiptOutcome, runBet, runClaim, type FreshState, type TxDeps, type TxState } from "./marketTx";
import { browserInflight } from "./inflight";
import { deriveRound } from "./round";

const chainId = BASE_SEPOLIA_CHAIN_ID;

const market = marketAddresses(addresses);

/** Placeholder addresses are used only while the hook is disabled (nothing is ever read from them). */
const PLACEHOLDER = { arena: zeroAddress, gapMarket: zeroAddress, points: zeroAddress } as const;

function marketContractsFor(id: bigint, who: Address) {
  return marketContracts(market ?? PLACEHOLDER, id, who);
}

export type MarketReadView = {
  status: "unconfigured" | "loading" | "error" | "ready";
  data: MarketData | undefined;
  /** True when the last refresh failed but earlier data is still shown. */
  stale: boolean;
  refetch: () => void;
};

/**
 * Market reads for round `id` and the connected address (`zeroAddress` when not connected, which
 * reads empty stakes and a 0 balance). One multicall, refreshed every few seconds, validated by
 * `parseMarketReads`. Cached data wins over a transient error; `stale` says so.
 */
export function useMarketReads(id: bigint | undefined, who: Address | undefined): MarketReadView {
  const configured = market !== null;
  const enabled = configured && id !== undefined;
  const q = useReadContracts({
    allowFailure: true,
    contracts: marketContractsFor(id ?? 0n, who ?? zeroAddress),
    query: { enabled, refetchInterval: 6_000 },
  });
  const { refetch } = q;
  const data = useMemo(() => parseMarketReads(q.data as unknown[] | undefined) ?? undefined, [q.data]);
  const refetchVoid = useCallback(() => void refetch(), [refetch]);

  if (!configured) return { status: "unconfigured", data: undefined, stale: false, refetch: refetchVoid };
  if (data !== undefined) return { status: "ready", data, stale: q.isError, refetch: refetchVoid };
  if (q.isError || q.data !== undefined) return { status: "error", data: undefined, stale: false, refetch: refetchVoid };
  return { status: "loading", data: undefined, stale: false, refetch: refetchVoid };
}

export type { TxState };

/** Everything a click handler needs, read fresh from the chain (not from the last render). */
async function readFresh(id: bigint, who: Address): Promise<FreshState> {
  if (market === null) throw new Error("contracts are not configured");
  const arenaAddr = market.arena;
  const block = await getBlock(wagmiConfig, { chainId });
  const roundReads = await readContracts(wagmiConfig, {
    allowFailure: false,
    contracts: [
      { address: arenaAddr, abi: arenaAbi, functionName: "getRound", args: [id], chainId },
      { address: arenaAddr, abi: arenaAbi, functionName: "settled", args: [id], chainId },
      { address: arenaAddr, abi: arenaAbi, functionName: "isVoid", args: [id], chainId },
    ],
  });
  const round = deriveRound(roundReads as unknown as readonly [unknown, unknown, unknown], block.timestamp);
  const reads = await readContracts(wagmiConfig, {
    allowFailure: true,
    contracts: marketContractsFor(id, who),
  });
  return { round, data: parseMarketReads(reads as unknown[]) };
}

/** The real dependencies of the click path (wagmi actions). */
const realDeps: TxDeps = {
  chainId,
  account: () => {
    const a = getAccount(wagmiConfig);
    return { address: a.address, isConnected: a.isConnected, chainId: a.chainId };
  },
  readFresh,
  simulate: async ({ functionName, args, who }) => {
    const gap = market?.gapMarket;
    if (gap === undefined) throw new Error("contracts are not configured");
    // gapMarketCallAbi adds the Points and Arena errors so every revert of the call can be decoded.
    const sim = await simulateContract(wagmiConfig, { address: gap, abi: gapMarketCallAbi, functionName, args, account: who, chainId });
    return sim.request;
  },
  write: (request) => writeContract(wagmiConfig, request as never),
  waitReceipt: async (hash) => {
    // viem returns the REPLACEMENT's receipt after a speed up or cancel: only the hash that was sent counts.
    const r = await waitForTransactionReceipt(wagmiConfig, { hash, chainId });
    return receiptOutcome(hash, r);
  },
  // A sent bet or claim is remembered per (round, wallet): a reload or second tab cannot send it twice.
  inflight: browserInflight(chainId),
};

/**
 * Bet and claim transactions for round `id`. The click path lives in `marketTx.ts` (tested): it
 * re-reads the chain clock, the wallet and the market at click time, applies the same guard as the
 * button, dry-runs the call, sends, and waits. A receipt-lookup error after the send is
 * "unconfirmed" (hash kept, buttons stay disabled, `recheck` looks again). `Points.spend` needs no
 * approval: GapMarket is a spender, and `Points.approve` always reverts (non-transferable).
 */
export function useMarketActions(id: bigint | undefined, onSettled: () => void) {
  const { address, chainId: walletChain, isConnected } = useAccount();
  const [tx, setTx] = useState<TxState>({ step: "idle" });
  const correctChain = walletChain === BASE_SEPOLIA_CHAIN_ID;
  const resumed = useRef<string | null>(null);

  // After a reload: pick up a bet or claim that was sent and not confirmed, so the screen shows its real
  // result and the buttons stay disabled until then.
  useEffect(() => {
    if (id === undefined || address === undefined) return;
    const held = realDeps.inflight?.get(id, address, "market");
    if (!held || !held.action.startsWith("market:")) return;
    const key = `${id}:${address}:${held.hash}`;
    if (resumed.current === key) return;
    resumed.current = key;
    void awaitReceipt(realDeps, held.label, held.hash, setTx, () => realDeps.inflight?.clear(id, address, "market")).finally(onSettled);
  }, [id, address, onSettled]);

  const bet = useCallback(
    async (side: Side, amountText: string) => {
      if (id === undefined) return;
      try {
        await runBet(realDeps, { id, side, amountText }, setTx);
      } finally {
        onSettled();
      }
    },
    [id, onSettled],
  );

  const claim = useCallback(async () => {
    if (id === undefined) return;
    try {
      await runClaim(realDeps, { id }, setTx);
    } finally {
      onSettled();
    }
  }, [id, onSettled]);

  /** Looks the receipt up again for an unconfirmed transaction. */
  const recheck = useCallback(async () => {
    if (tx.step !== "unconfirmed") return;
    try {
      await awaitReceipt(realDeps, tx.label, tx.hash, setTx, () => {
        if (id !== undefined && address !== undefined) realDeps.inflight?.clear(id, address, "market");
      });
    } finally {
      onSettled();
    }
  }, [tx, onSettled, id, address]);

  return { tx, bet, claim, recheck, resetTx: () => setTx({ step: "idle" }), connected: isConnected, correctChain, address };
}
