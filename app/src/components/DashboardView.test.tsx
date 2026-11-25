import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { simulatedRounds, type RoundSummary } from "@/lib/history";
import { DashboardView } from "./DashboardView";
import { ReplayPanel } from "./ReplayPanel";
import { TrendChart } from "./TrendChart";

const HOUSE = "0x00000000000000000000000000000000000000c3";
const OTHER = "0x00000000000000000000000000000000000000d4";

function chainRound(over: Partial<RoundSummary> & { id: bigint }): RoundSummary {
  return {
    ticker: "AAPL",
    T: 100,
    commitEnd: 1000n,
    revealEnd: 1100n,
    state: "settled",
    humanScore: 70,
    agentScore: 60,
    baseline: 20,
    reads: null,
    entries: [],
    reveals: { human: 3, agent: 3 },
    simulated: false,
    ...over,
  };
}

const view = (rounds: RoundSummary[], house = new Set<string>(), extra: { houseError?: string | null } = {}) =>
  renderToStaticMarkup(<DashboardView rounds={rounds} houseAgents={house} {...extra} />);

describe("DashboardView", () => {
  it("shows an honest empty state for no rounds, with no chart, no sample and no label", () => {
    const html = view([]);
    expect(html).toMatch(/no round has been opened/i);
    expect(html).not.toMatch(/data-simulated-tag/);
    expect(html).not.toMatch(/<svg/);
  });

  it("refuses to render simulated and chain rows together", () => {
    const html = view([chainRound({ id: 1n }), ...simulatedRounds()]);
    expect(html).toMatch(/mixed/i);
    expect(html).not.toMatch(/<table/);
  });

  it("labels house agents only by address, never as organic, and shows agents as agents", () => {
    const html = view(
      [
        chainRound({
          id: 1n,
          entries: [
            { who: HOUSE, kind: 2, score: 90 },
            { who: OTHER, kind: 2, score: 80 },
            { who: "0x00000000000000000000000000000000000000e5", kind: 1, score: 70 },
          ],
        }),
      ],
      new Set([HOUSE]),
    );
    const rows = html.split("<tr").filter((r) => r.includes("0x0000"));
    const houseRow = rows.find((r) => r.includes("0x0000...00c3")) ?? "";
    const otherRow = rows.find((r) => r.includes("0x0000...00d4")) ?? "";
    expect(houseRow).toContain(">house<");
    expect(houseRow).toContain("agent");
    expect(otherRow).toContain("agent");
    expect(otherRow).not.toContain(">house<");
  });

  it("says when no house list is published and shows a house list error", () => {
    const r = [chainRound({ id: 1n, entries: [{ who: OTHER, kind: 2, score: 80 }] })];
    expect(view(r)).toMatch(/not published yet/i);
    expect(view(r, new Set(), { houseError: "The house agent address list is invalid" })).toMatch(/house agent address list is invalid/);
  });

  it("shows the disclaimer-relevant honesty lines and never a raw price", () => {
    const html = view([chainRound({ id: 1n }), chainRound({ id: 2n, humanScore: 40, agentScore: 40 })]);
    expect(html).toMatch(/Tie \(refund\)/);
    expect(html).toMatch(/not counted/i);
    expect(html).not.toMatch(/\$\d/);
  });

  it("labels a below-quorum round, shows its scores, and leaves it out of the win rate", () => {
    const html = view([
      chainRound({ id: 1n, humanScore: 90, agentScore: 10, reveals: { human: 1, agent: 5 } }),
      chainRound({ id: 2n, humanScore: 60, agentScore: 40 }),
    ]);
    expect(html).toMatch(/Below quorum \(1 human, 5 agent reveals; 3 needed per side\), not counted/);
    expect(html.match(/Human higher/g)).toHaveLength(1); // only round 2 has an outcome
    expect(html).toMatch(/Human 100%/); // 1 decided round: round 2
    expect(html).toMatch(/Of 1 decided round/);
    expect(html).toMatch(/below the 3-reveal quorum/);
    expect(html).toContain(">90<"); // round 1 keeps its scores in the row
  });

  it("keeps void and unsettled rows out of the win rate and marks them", () => {
    const html = view([
      chainRound({ id: 1n, state: "void", humanScore: null, agentScore: null }),
      chainRound({ id: 2n, state: "open", humanScore: null, agentScore: null }),
    ]);
    expect(html).toMatch(/no decided round yet/i);
    expect(html).toMatch(/Void \(refundable\)/);
    expect(html).toMatch(/Not settled yet/);
  });
});

describe("TrendChart", () => {
  it("draws one labeled point per decided round with labeled axes", () => {
    const html = renderToStaticMarkup(
      <TrendChart
        rounds={[
          chainRound({ id: 1n, humanScore: 80, agentScore: 60 }),
          chainRound({ id: 2n, humanScore: 50, agentScore: 70 }),
          chainRound({ id: 3n, humanScore: 55, agentScore: 55 }),
          chainRound({ id: 4n, state: "void", humanScore: null, agentScore: null }),
        ]}
      />,
    );
    expect(html.match(/data-round="/g)).toHaveLength(3);
    expect(html).toContain('data-gap="20"');
    expect(html).toContain('data-gap="-20"');
    expect(html).toContain('data-gap="0"');
    expect(html).toMatch(/Round \(oldest to newest\)/);
    expect(html).toMatch(/Human score minus Agent score/);
    expect(html).toMatch(/role="img"/);
  });

  it("has no point for a below-quorum round", () => {
    const html = renderToStaticMarkup(
      <TrendChart
        rounds={[
          chainRound({ id: 1n, humanScore: 90, agentScore: 10, reveals: { human: 2, agent: 5 } }),
          chainRound({ id: 2n, humanScore: 60, agentScore: 40 }),
        ]}
      />,
    );
    expect(html.match(/data-round="/g)).toHaveLength(1);
    expect(html).toContain('data-round="2"');
    expect(html).not.toContain('data-round="1"');
  });

  it("says so when there is nothing to draw", () => {
    expect(renderToStaticMarkup(<TrendChart rounds={[]} />)).toMatch(/no decided round/i);
  });
});

describe("ReplayPanel", () => {
  it("offers nothing for rounds that are not replayable", () => {
    const html = renderToStaticMarkup(<ReplayPanel rounds={[chainRound({ id: 1n, state: "void", humanScore: null, agentScore: null })]} />);
    expect(html).toMatch(/no settled round to replay/i);
  });
});
