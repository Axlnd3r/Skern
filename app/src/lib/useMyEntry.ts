import { useMemo } from "react";
import { useReadContracts } from "wagmi";
import type { Address } from "viem";
import { addresses, arenaAbi, BASE_SEPOLIA_CHAIN_ID } from "./chain";
import { successOf } from "./chainData";
import { parseEntryRead, type EntryRead } from "./near";

/**
 * The connected wallet's own entry for round `id` (`entryOf`). Undefined while loading or when disabled,
 * null when the read failed or was malformed (untrusted, validated by `parseEntryRead`).
 */
export function useMyEntry(id: bigint | undefined, who: Address | undefined, enabled: boolean): EntryRead | null | undefined {
  const arena = addresses.arena;
  const q = useReadContracts({
    allowFailure: true,
    contracts:
      arena !== undefined && id !== undefined && who !== undefined
        ? [{ address: arena, abi: arenaAbi, functionName: "entryOf", args: [id, who], chainId: BASE_SEPOLIA_CHAIN_ID }]
        : [],
    query: { enabled: enabled && arena !== undefined && id !== undefined && who !== undefined },
  });
  return useMemo(() => {
    if (q.data === undefined) return q.isError ? null : undefined;
    const s = successOf(q.data[0]);
    return s === null ? null : parseEntryRead(s.result);
  }, [q.data, q.isError]);
}
