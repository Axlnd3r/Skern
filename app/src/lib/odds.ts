// Display-only market arithmetic. Floats are allowed here (implied odds are shown, never used to
// decide a payout or a score); the payout preview is integer math that mirrors GapMarket.claim.

export type Odds = { human: number; agent: number };

const SCALE = 1_000_000n;

/**
 * Implied probability of each side from the parimutuel pools: a side's pool share of the total.
 * Both pools empty gives 0.5 / 0.5 (no division by zero). A negative pool (malformed chain data)
 * counts as empty. The two numbers always sum to exactly 1.
 */
export function impliedOdds(humanPool: bigint, agentPool: bigint): Odds {
  const h = humanPool > 0n ? humanPool : 0n;
  const a = agentPool > 0n ? agentPool : 0n;
  const total = h + a;
  if (total === 0n) return { human: 0.5, agent: 0.5 };
  const humanScaled = (h * SCALE) / total; // bigint, so pools beyond 2^53 lose no precision
  return { human: Number(humanScaled) / 1e6, agent: Number(SCALE - humanScaled) / 1e6 };
}

/**
 * What `amt` points would pay if its side wins, given the pools before the bet:
 * `amt * (total + amt) / (sidePool + amt)`, floored like the contract (stake * totalPool / winnerPool).
 * It ignores what the address already holds on that side. A preview only, not a promise: later bets
 * change the pools.
 */
export function projectedPayout(amt: bigint, sidePool: bigint, totalPool: bigint): bigint {
  if (amt <= 0n) return 0n;
  const side = (sidePool > 0n ? sidePool : 0n) + amt;
  const total = (totalPool > 0n ? totalPool : 0n) + amt;
  return (amt * total) / side;
}
