import { useMemo } from "react";
import { useReadContracts } from "wagmi";
import { zeroAddress } from "viem";
import { addresses, arenaAbi, BASE_SEPOLIA_CHAIN_ID } from "./chain";
import { KIND_AGENT, KIND_HUMAN } from "./market";
import { parseRevealReads, type RevealReads } from "./reveal";

/**
 * Reads of a settled round for the reveal screen: the real candles, both consensus paths, the stored
 * consensus scores and the baseline. `enabled` must be true only once the round is settled: these
 * views revert before candles are posted. Returns undefined while loading and null when the reads
 * failed or were malformed (the data is untrusted and validated by `parseRevealReads`).
 */
export function useRevealReads(id: bigint | undefined, enabled: boolean): RevealReads | null | undefined {
  const arena = addresses.arena ?? zeroAddress;
  const rid = id ?? 0n;
  const chainId = BASE_SEPOLIA_CHAIN_ID;
  const q = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: arena, abi: arenaAbi, functionName: "realCandles", args: [rid], chainId },
      { address: arena, abi: arenaAbi, functionName: "consensus", args: [rid, KIND_HUMAN], chainId },
      { address: arena, abi: arenaAbi, functionName: "consensus", args: [rid, KIND_AGENT], chainId },
      { address: arena, abi: arenaAbi, functionName: "consensusScores", args: [rid], chainId },
      { address: arena, abi: arenaAbi, functionName: "baselineScore", args: [rid], chainId },
    ],
    query: { enabled: enabled && id !== undefined && addresses.arena !== undefined },
  });
  return useMemo(() => {
    if (q.data === undefined) return q.isError ? null : undefined;
    return parseRevealReads(q.data as unknown[]);
  }, [q.data, q.isError]);
}
