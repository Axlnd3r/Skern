import { useQuery } from "@tanstack/react-query";
import { HistoryError, loadHistory, type RoundSummary } from "./history";

export type HistoryData = {
  rounds: RoundSummary[];
  /** True when older rounds exist that this load did not include (only the most recent are loaded). */
  truncated: boolean;
};

/**
 * The round history from Base Sepolia (contract views plus reveal logs inside each settled round's
 * reveal window), covering rounds since the deploy block, most recent 200 at most. Not polled: it
 * reloads on demand (`refetch`) and when the cache is older than a minute.
 */
export function useHistory(enabled: boolean) {
  return useQuery<HistoryData, Error>({
    queryKey: ["history"],
    enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
    queryFn: async () => {
      const { deployBlock } = await import("./historySource");
      const rounds = await loadHistory(deployBlock());
      const first = rounds[0];
      return { rounds, truncated: first !== undefined && first.id > 1n };
    },
  });
}

/** Message safe to show: only our own errors carry text; anything else (it may hold an RPC URL) is generic. */
export function historyErrorText(e: unknown): string {
  return e instanceof HistoryError ? e.message : "Could not load the round history from Base Sepolia.";
}
