"use client";

import Link from "next/link";
import { HouseAgents, UsNotice } from "@/components/Notices";
import { Countdown } from "@/components/Countdown";
import { Cloud, ScribbleCircle } from "@/components/doodle";
import { PhaseSticker } from "@/components/doodle/PhaseSticker";
import { PageHeader } from "@/components/PageHeader";
import { PhaseTracker } from "@/components/PhaseTracker";
import { actionFor, formatCountdown, tickerLabel, useLatestRoundId, useRound } from "@/lib/round";

/** Screen 1: Today's Round. */
export default function TodaysRound() {
  const latest = useLatestRoundId();
  const round = useRound(latest.id);

  return (
    <main className="page">
      <PageHeader />

      <UsNotice />

      <section className="card" aria-live="polite">
        <h2>Today&apos;s Round</h2>
        {latest.unconfigured || latest.loading || latest.id === undefined ? (
          <div className="sticker-wrap sticker-wrap-idle" aria-hidden="true">
            <Cloud size={64} rotate={-4} />
          </div>
        ) : null}
        {latest.unconfigured ? (
          <p className="muted">
            The Arena contract address is not configured. Set NEXT_PUBLIC_ARENA_ADDRESS (see .env.example).
          </p>
        ) : latest.loading ? (
          <p className="muted">Loading the latest round...</p>
        ) : latest.id === undefined ? (
          <p className="muted">No round has been opened yet.</p>
        ) : round.status === "error" ? (
          <p className="error">Could not read round #{latest.id.toString()} from Base Sepolia.</p>
        ) : round.status !== "ready" || !round.params || !round.phase ? (
          <p className="muted">Reading round #{latest.id.toString()}...</p>
        ) : (
          <RoundBody
            id={latest.id}
            ticker={tickerLabel(round.params.ticker)}
            phase={round.phase}
            countdownSec={round.countdownSec ?? 0}
            closing={round.closing}
          />
        )}
      </section>

      <Link href="/dashboard" className="btn link-btn">
        Gap Dashboard and replay
      </Link>

      <HouseAgents />
    </main>
  );
}

function RoundBody(props: {
  id: bigint;
  ticker: string;
  phase: NonNullable<ReturnType<typeof useRound>["phase"]>;
  countdownSec: number;
  closing: boolean;
}) {
  const action = actionFor(props.phase);
  const terminal = props.phase === "settled" || props.phase === "void";
  return (
    <>
      <PhaseSticker phase={props.phase} roundId={props.id} />
      <p className="stock">
        <span className="ticker">{props.ticker}</span>{" "}
        <span className="muted circled">
          round #{props.id.toString()}
          <ScribbleCircle />
        </span>
      </p>
      <Countdown text={terminal ? (props.phase === "void" ? "Void" : "Final") : formatCountdown(props.countdownSec)} />
      <PhaseTracker phase={props.phase} closing={props.closing} />
      <p className="hint">{action.hint}</p>
      {/* Screens 2 to 4 are wired; the real commit and reveal transactions (and screen 5) are other tasks. */}
      {props.phase === "commit" ? (
        <Link href="/draw" className="btn primary link-btn">
          {action.label}
        </Link>
      ) : props.phase === "market" ? (
        <Link href="/market" className="btn primary link-btn">
          {action.label}
        </Link>
      ) : props.phase === "play" || props.phase === "settled" ? (
        <Link href="/reveal" className="btn primary link-btn">
          {action.label}
        </Link>
      ) : (
        <button type="button" className="btn primary" disabled title="This screen is not available yet">
          {action.label}
        </button>
      )}
      {props.phase !== "commit" && props.phase !== "market" ? (
        <Link href="/market" className="btn link-btn">
          Market and bets
        </Link>
      ) : null}
    </>
  );
}
