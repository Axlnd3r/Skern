import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useReadContracts } from "wagmi";
import { getAccount, getBlock, readContracts, simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { zeroAddress, type Address, type Hash, type Hex } from "viem";
import { afterCommit, runArenaClaim, runCommit, runJoin, runManualReveal, runRelay, type ActionDeps, type FreshPlayer, type RelayState } from "./actionTx";
import { newSalt } from "./commitHash";
import {
  addresses,
  arenaAbi,
  arenaCallAbi,
  BASE_SEPOLIA_CHAIN_ID,
  gateAddress,
  keeperUrl,
  registryCallAbi,
  wagmiConfig,
} from "./chain";
import { browserInflight, browserStorage, type InflightSlot } from "./inflight";
import { awaitReceipt, receiptOutcome, type TxState } from "./marketTx";
import { parsePlayerReads, playerContracts, type PlayerAddresses, type PlayerReads } from "./player";
import { postReveal } from "./relayClient";
import { deriveRound } from "./round";
import { createSaltStore, type SaltLookup } from "./saltStore";
import type { Path } from "../../../shared/score";

const chainId = BASE_SEPOLIA_CHAIN_ID;

/** The contracts a player needs, or null when one address is not configured. */
export const playerAddresses: PlayerAddresses | null =
  addresses.arena && addresses.registry && addresses.points && gateAddress
    ? { arena: addresses.arena, registry: addresses.registry, points: addresses.points, gate: gateAddress }
    : null;

/** Used only while the hook is disabled (nothing is ever read from these). */
const PLACEHOLDER: PlayerAddresses = { arena: zeroAddress, registry: zeroAddress, points: zeroAddress, gate: zeroAddress };

async function readFresh(id: bigint | undefined, who: Address): Promise<FreshPlayer> {
  if (playerAddresses === null) throw new Error("contracts are not configured");
  const arena = playerAddresses.arena;
  const block = await getBlock(wagmiConfig, { chainId });
  let round: FreshPlayer["round"];
  if (id !== undefined) {
    const roundReads = await readContracts(wagmiConfig, {
      allowFailure: false,
      contracts: [
        { address: arena, abi: arenaAbi, functionName: "getRound", args: [id], chainId },
        { address: arena, abi: arenaAbi, functionName: "settled", args: [id], chainId },
        { address: arena, abi: arenaAbi, functionName: "isVoid", args: [id], chainId },
      ],
    });
    round = deriveRound(roundReads as unknown as readonly [unknown, unknown, unknown], block.timestamp);
  }
  const results = await readContracts(wagmiConfig, { allowFailure: true, contracts: playerContracts(playerAddresses, id, who) });
  return { round, reads: parsePlayerReads(results as unknown[], id !== undefined) };
}

let cached: ActionDeps | null = null;

/** The real dependencies of the click paths (wagmi actions, localStorage, the keeper relay). Client only. */
export function getActionDeps(): ActionDeps | null {
  if (playerAddresses === null) return null;
  if (cached !== null) return cached;
  const a = playerAddresses;
  cached = {
    chainId,
    account: () => {
      const acct = getAccount(wagmiConfig);
      return { address: acct.address, isConnected: acct.isConnected, chainId: acct.chainId };
    },
    readFresh,
    simulate: async ({ contract, functionName, args, who }) => {
      const target = contract === "arena" ? { address: a.arena, abi: arenaCallAbi } : { address: a.registry, abi: registryCallAbi };
      const sim = await simulateContract(wagmiConfig, { ...target, functionName, args, account: who, chainId } as never);
      return sim.request;
    },
    // The request carries chainId; wagmi refuses to send it if the wallet is connected to another chain.
    write: (request) => writeContract(wagmiConfig, { ...(request as object), chainId } as never),
    waitReceipt: async (hash) => {
      // viem returns the REPLACEMENT's receipt after a speed up or cancel: only the hash that was sent counts.
      const r = await waitForTransactionReceipt(wagmiConfig, { hash, chainId });
      return receiptOutcome(hash, r);
    },
    inflight: browserInflight(chainId),
    salts: createSaltStore(browserStorage(), chainId, a.arena),
    newSalt: () => newSalt(),
    relay: (req) => postReveal({ fetch: (input, init) => globalThis.fetch(input, init), baseUrl: keeperUrl, timeoutMs: 15_000 }, req),
  };
  return cached;
}

// ---------------------------------------------------------------------------------------------- reads

export type PlayerView = {
  /** undefined while loading or disabled, null when the read failed or was malformed. */
  reads: PlayerReads | null | undefined;
  refetch: () => void;
  configured: boolean;
  address: Address | undefined;
  connected: boolean;
  correctChain: boolean;
};

/** The connected wallet's registration, balance and entry (when `id` is given), refreshed every few seconds. */
export function usePlayer(id: bigint | undefined): PlayerView {
  const { address, chainId: walletChain, isConnected } = useAccount();
  const enabled = playerAddresses !== null && isConnected && address !== undefined;
  const q = useReadContracts({
    allowFailure: true,
    contracts: playerContracts(playerAddresses ?? PLACEHOLDER, id, address ?? zeroAddress),
    query: { enabled, refetchInterval: 6_000 },
  });
  const { refetch } = q;
  const reads = useMemo(() => {
    if (!enabled) return undefined;
    if (q.data === undefined) return q.isError ? null : undefined;
    return parsePlayerReads(q.data as unknown[], id !== undefined);
  }, [enabled, q.data, q.isError, id]);
  return {
    reads,
    refetch: useCallback(() => void refetch(), [refetch]),
    configured: playerAddresses !== null,
    address,
    connected: isConnected && address !== undefined,
    correctChain: walletChain === BASE_SEPOLIA_CHAIN_ID,
  };
}

/**
 * The saved path and salt of (id, who) from localStorage: the record whose hash is the on-chain entry hash
 * (`entryHash`) when there is one. `tick` forces a re-read (after a transaction).
 */
export function useSaltLookup(id: bigint | undefined, who: Address | undefined, entryHash: Hex | undefined, tick: unknown): SaltLookup | undefined {
  const [lookup, setLookup] = useState<SaltLookup | undefined>(undefined);
  const [storageTick, setStorageTick] = useState(0);
  useEffect(() => {
    const onStorage = () => setStorageTick((n) => n + 1); // another tab saved or changed a record
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  useEffect(() => {
    const deps = getActionDeps();
    if (!deps || id === undefined || !who) {
      setLookup(undefined);
      return;
    }
    setLookup(deps.salts.load(id, who, entryHash));
  }, [id, who, entryHash, tick, storageTick]);
  return lookup;
}

// ---------------------------------------------------------------------------------------------- actions

/**
 * Transaction state of one action family. A transaction remembered in localStorage for this (round, wallet)
 * that belongs to the family (`owns`) is picked up again after a reload: its receipt is awaited and
 * `afterReceipt` runs, so the screen shows the real result instead of an idle button.
 */
function useTxFamily(
  id: bigint | undefined,
  who: Address | undefined,
  slot: InflightSlot,
  owns: (action: string) => boolean,
  onFinal: () => void,
  afterReceipt?: (deps: ActionDeps, action: string, result: Awaited<ReturnType<typeof awaitReceipt>>, hash: Hash) => Promise<void>,
) {
  const [tx, setTx] = useState<TxState>({ step: "idle" });
  const resumed = useRef<string | null>(null);
  const latest = useRef({ owns, onFinal, afterReceipt });
  latest.current = { owns, onFinal, afterReceipt };

  const finish = useCallback(
    async (deps: ActionDeps, label: string, hash: `0x${string}`, action: string) => {
      const result = await awaitReceipt(deps, label, hash, setTx, () => deps.inflight.clear(id, who as Address, slot));
      try {
        await latest.current.afterReceipt?.(deps, action, result, hash);
      } finally {
        latest.current.onFinal();
      }
    },
    [id, who, slot],
  );

  useEffect(() => {
    const deps = getActionDeps();
    if (!deps || !who) return;
    const held = deps.inflight.get(id, who, slot);
    if (!held || !latest.current.owns(held.action)) return;
    const key = `${id}:${who}:${held.hash}`;
    if (resumed.current === key) return;
    resumed.current = key;
    void finish(deps, held.label, held.hash, held.action);
  }, [id, who, slot, finish]);

  const recheck = useCallback(async () => {
    const deps = getActionDeps();
    if (!deps || !who || tx.step !== "unconfirmed") return;
    const held = deps.inflight.get(id, who, slot);
    await finish(deps, tx.label, tx.hash, held?.action ?? "");
  }, [id, who, slot, tx, finish]);

  return { tx, setTx, recheck };
}

/** Join as human: `Registry.registerHuman()`. */
export function useJoinAction(who: Address | undefined, onChange: () => void) {
  const fam = useTxFamily(undefined, who, "join", (a) => a === "registry:registerHuman", onChange);
  const join = useCallback(async () => {
    const deps = getActionDeps();
    if (!deps) return;
    try {
      await runJoin(deps, fam.setTx);
    } finally {
      onChange();
    }
  }, [fam.setTx, onChange]);
  return { tx: fam.tx, join, recheck: fam.recheck };
}

/** Commit, relay and manual reveal for round `id`. */
export function useEntryActions(id: bigint | undefined, who: Address | undefined, onChange: () => void) {
  const [relay, setRelay] = useState<RelayState>({ step: "idle" });
  const fam = useTxFamily(
    id,
    who,
    "entry",
    (a) => a === "arena:commit" || a === "arena:reveal",
    onChange,
    async (deps, action, result, hash) => {
      if (action === "arena:commit" && id !== undefined && who) await afterCommit(deps, id, who, result, setRelay, hash);
    },
  );
  const { setTx } = fam;

  const commit = useCallback(
    async (path: Path) => {
      const deps = getActionDeps();
      if (!deps || id === undefined) return;
      try {
        await runCommit(deps, { id, path }, setTx, setRelay);
      } finally {
        onChange();
      }
    },
    [id, setTx, onChange],
  );
  const resendRelay = useCallback(async () => {
    const deps = getActionDeps();
    if (!deps || id === undefined) return;
    try {
      await runRelay(deps, { id }, setRelay);
    } finally {
      onChange();
    }
  }, [id, onChange]);
  const reveal = useCallback(async () => {
    const deps = getActionDeps();
    if (!deps || id === undefined) return;
    try {
      await runManualReveal(deps, { id }, setTx);
    } finally {
      onChange();
    }
  }, [id, setTx, onChange]);

  return { tx: fam.tx, relay, commit, resendRelay, reveal, recheck: fam.recheck };
}

/** `Arena.claim(id)` for the connected wallet. */
export function useArenaClaimAction(id: bigint | undefined, who: Address | undefined, onChange: () => void) {
  const fam = useTxFamily(id, who, "arena-claim", (a) => a === "arena:claim", onChange);
  const claim = useCallback(async () => {
    const deps = getActionDeps();
    if (!deps || id === undefined) return;
    try {
      await runArenaClaim(deps, { id }, fam.setTx);
    } finally {
      onChange();
    }
  }, [id, fam.setTx, onChange]);
  return { tx: fam.tx, claim, recheck: fam.recheck };
}
