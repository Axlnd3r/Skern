// House agent "Mean Reversion": reverts toward the recent mean close, rule-based, deterministic, integer math.
//
// m = rounded mean of the last (up to 10) history closes, in bp relative to P0 (0 without history). Each predicted
// close moves half of the way from the previous close (P0 = 0 for candle 1) to m, so it approaches m and never
// overshoots it. A symmetric wick of `typicalWick` is added; the result goes through `repairPath` and is valid and
// bounded by 10*T for any input.
import type { Agent } from "../sdk";
import { HOUSE_METADATA_URI, assertContext, cleanHistory, divRound, meanInt, pathFromCloses, typicalWick, type Path, type RoundContext } from "./types";

export const name = "meanReversion";

export async function predict(ctx: RoundContext): Promise<Path> {
  assertContext(ctx);
  const T = Number.isInteger(ctx.T) && ctx.T >= 1 ? ctx.T : 1;
  const history = cleanHistory(ctx);
  const m = meanInt(history.slice(-10).map((c) => c.close));
  const c1 = divRound(m, 2);
  const c2 = c1 + divRound(m - c1, 2);
  const c3 = c2 + divRound(m - c2, 2);
  return pathFromCloses([c1, c2, c3], typicalWick(history, T), T);
}

/** Registers this house wallet in the Registry through the same SDK call an outside agent uses. */
export const register = (agent: Agent) => agent.registerAgent(HOUSE_METADATA_URI);
