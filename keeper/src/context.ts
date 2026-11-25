// The round context served to house agents by `GET /context/:id` (see relay.ts). It is built from the keeper
// state only: no provider call, no chain read. The shape is `RoundContext` of agents/src/house/types.ts.
//
// Only integers in bp relative to the round's P0 leave here (never p0 or any price), so serving it does not
// republish provider data.
import type { RoundContext } from "../../agents/src/house/types";
import type { KeeperState } from "./state";

/**
 * The context of the round the keeper opened as `id`, or undefined when the keeper has no such round: unknown id,
 * a round that is only planned (no id yet), or one whose on-chain parameters did not match the keeper's
 * (`id_mismatch`, so its stored data cannot be trusted for that id). A round without stored history (a state file
 * from before the history was stored) gets an empty `recentCandlesBp`, which agents handle.
 * The result is a fresh copy: callers cannot change the state through it.
 */
export function roundContextFromState(state: KeeperState, id: bigint): RoundContext | undefined {
  const rec = state.rounds.find((r) => r.id !== undefined && r.id === id.toString() && r.outcome !== "id_mismatch");
  if (!rec) return undefined;
  return {
    ticker: rec.cfg.ticker,
    T: rec.cfg.T,
    candleCount: 3,
    recentCandlesBp: (rec.historyBp ?? []).map((c) => ({ close: c.close, high: c.high, low: c.low })),
  };
}
