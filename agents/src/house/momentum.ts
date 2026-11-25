// House agent "Momentum": extrapolates the recent drift of the closes, rule-based, deterministic, integer math.
//
// drift = (newest close - oldest close) / (k - 1) over the last k <= 5 history candles (rounded half away from
// zero, limited to +-T per candle); 0 with fewer than 2 candles. close_i = close_(i-1) + drift, starting at 0 (P0).
// Every candle gets a symmetric wick of `typicalWick`; the result goes through `repairPath` and is valid and
// bounded by 10*T for any input.
import type { Agent } from "../sdk";
import { HOUSE_METADATA_URI, assertContext, cleanHistory, clampInt, divRound, pathFromCloses, typicalWick, type Path, type RoundContext } from "./types";

export const name = "momentum";

export async function predict(ctx: RoundContext): Promise<Path> {
  assertContext(ctx);
  const T = Number.isInteger(ctx.T) && ctx.T >= 1 ? ctx.T : 1;
  const history = cleanHistory(ctx);
  const closes = history.slice(-5).map((c) => c.close);
  const drift = closes.length >= 2 ? clampInt(divRound((closes[closes.length - 1] as number) - (closes[0] as number), closes.length - 1), T) : 0;
  return pathFromCloses([drift, 2 * drift, 3 * drift], typicalWick(history, T), T);
}

/** Registers this house wallet in the Registry through the same SDK call an outside agent uses. */
export const register = (agent: Agent) => agent.registerAgent(HOUSE_METADATA_URI);
