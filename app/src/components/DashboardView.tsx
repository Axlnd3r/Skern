import {
  QUORUM_MIN_REVEALS,
  buildLeaderboard,
  gapOf,
  hasQuorum,
  outcomeOf,
  tally,
  winRate,
  type LeaderRow,
  type Outcome,
  type RoundSummary,
} from "@/lib/history";
import { HOUSE_LABEL } from "@/lib/disclaimer";
import { ReplayPanel, SimulatedTag } from "./ReplayPanel";
import { TrendChart } from "./TrendChart";

const OUTCOME_TEXT: Record<Outcome, string> = {
  human: "Human higher",
  agent: "Agent higher",
  tie: "Tie (refund)",
  none: "-",
};

const STATE_TEXT: Record<RoundSummary["state"], string> = {
  settled: "Settled",
  void: "Void (refundable)",
  open: "Not settled yet",
  unreadable: "Settled, data unreadable",
};

function shortWho(who: string): string {
  return /^0x[0-9a-fA-F]{40}$/.test(who) ? `${who.slice(0, 6)}...${who.slice(-4)}` : who;
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

/** 750 -> "75.0" (integer math only). */
function avgText(avg10: number): string {
  return `${Math.floor(avg10 / 10)}.${avg10 % 10}`;
}

/** The result cell: a settled round below the reveal quorum is labeled, never given an outcome. */
function resultText(r: RoundSummary): string {
  if (r.state !== "settled") return STATE_TEXT[r.state];
  if (r.reveals !== null && !hasQuorum(r)) {
    return `Below quorum (${r.reveals.human} human, ${r.reveals.agent} agent reveals; ${QUORUM_MIN_REVEALS} needed per side), not counted`;
  }
  return OUTCOME_TEXT[outcomeOf(r)];
}

function KindTag({ row }: { row: LeaderRow }) {
  if (row.kind === 1) return <span className="tag-side human">human</span>;
  return (
    <>
      <span className="tag-side agent">agent</span>
      {row.house ? <span className="tag">{HOUSE_LABEL}</span> : null}
    </>
  );
}

/**
 * The dashboard body for a set of rounds that is either all read from the chain or all simulated.
 * A mix is refused: simulated rows are never shown next to real ones.
 */
export function DashboardView(props: {
  rounds: readonly RoundSummary[];
  houseAgents: ReadonlySet<string>;
  /** Error from the house agent list; shown, and no agent is labeled house then. */
  houseError?: string | null;
}) {
  const { rounds } = props;
  const simCount = rounds.filter((r) => r.simulated).length;
  if (simCount > 0 && simCount < rounds.length) {
    return (
      <p className="error" role="alert">
        Simulated and chain rows were mixed, so nothing is shown. This is a bug.
      </p>
    );
  }
  const simulated = simCount > 0;
  if (rounds.length === 0) {
    return (
      <p className="muted">
        No round has been opened in the scanned range yet. Nothing is shown until real rounds exist; the dashboard
        never fills the gap with made-up history.
      </p>
    );
  }

  const t = tally(rounds);
  const rate = winRate(rounds);
  const decided = t.human + t.agent;
  const board = buildLeaderboard(rounds, props.houseAgents);
  const shown = [...rounds].reverse();

  return (
    <>
      {simulated ? (
        <p className="sim-label" role="note">
          <strong>{`SIMULATED SAMPLE DATA.`}</strong> Not read from the chain: made-up paths scored with the real scoring
          code, for demonstration only. It says nothing about real forecasting skill.
        </p>
      ) : null}

      <section className="card" aria-label="Win rate">
        <h2>
          Human vs Agent {simulated ? <SimulatedTag /> : null}
        </h2>
        {decided === 0 ? (
          <p className="muted">No decided round yet. Void, tied and unsettled rounds do not count as wins.</p>
        ) : (
          <>
            <p className="winrate">
              <span className="tag-side human">Human {rate.human}%</span> <span className="tag-side agent">Agent {rate.agent}%</span>
            </p>
            <p className="muted">
              Of {decided} decided {decided === 1 ? "round" : "rounds"}: Human won {t.human}, Agent won {t.agent}. Ties ({t.tie}),
              void ({t.void}), not settled ({t.open}), below the {QUORUM_MIN_REVEALS}-reveal quorum ({t.belowQuorum}) and rounds without both
              consensus scores ({t.noResult}) are not counted.
            </p>
          </>
        )}
      </section>

      <section className="card" aria-label="Gap trend">
        <h2>Gap trend {simulated ? <SimulatedTag /> : null}</h2>
        <TrendChart rounds={rounds} />
      </section>

      <section className="card" aria-label="Rounds">
        <h2>Rounds</h2>
        <table className="values dash-table">
          <thead>
            <tr>
              <th>Round</th>
              <th>Human</th>
              <th>Agent</th>
              <th>Gap</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const gap = gapOf(r);
              return (
                <tr key={`${r.simulated ? "s" : "c"}-${r.id}`}>
                  <td>
                    #{String(r.id)} {r.ticker}
                    {r.simulated ? <SimulatedTag /> : null}
                  </td>
                  <td>{r.state === "settled" && r.humanScore !== null ? r.humanScore : "-"}</td>
                  <td>{r.state === "settled" && r.agentScore !== null ? r.agentScore : "-"}</td>
                  <td>{gap === null ? "-" : signed(gap)}</td>
                  <td>{resultText(r)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="card" aria-label="Leaderboard">
        <h2>Leaderboard {simulated ? <SimulatedTag /> : null}</h2>
        {board.length === 0 ? (
          <p className="muted">No revealed entries in a settled round yet.</p>
        ) : (
          <table className="values dash-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Entry</th>
                <th>Kind</th>
                <th>Rounds</th>
                <th>Avg</th>
                <th>Best</th>
              </tr>
            </thead>
            <tbody>
              {board.map((row, i) => (
                <tr key={row.who.toLowerCase()}>
                  <td>{i + 1}</td>
                  <td className="addr">{shortWho(row.who)}</td>
                  <td>
                    <KindTag row={row} />
                  </td>
                  <td>{row.rounds}</td>
                  <td>{avgText(row.avg10)}</td>
                  <td>{row.best}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted">
          Average of each entry&apos;s own score over settled rounds, scored with the shared scoring code. Humans and agents
          are separate kinds.{" "}
          {props.houseError
            ? props.houseError
            : props.houseAgents.size === 0
              ? "The project's house agent address list is not published yet, so no agent is marked house here: do not read an agent row as an independent user."
              : "Agents tagged house are operated by the project."}
        </p>
      </section>

      <section className="card" aria-label="Replay">
        <h2>Replay a settled round {simulated ? <SimulatedTag /> : null}</h2>
        <ReplayPanel rounds={rounds} />
      </section>
    </>
  );
}
