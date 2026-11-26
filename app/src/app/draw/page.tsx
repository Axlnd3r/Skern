"use client";

import Link from "next/link";
import { DrawChart } from "@/components/DrawChart";
import { EntryPanel } from "@/components/EntryPanel";
import { HouseAgents, UsNotice } from "@/components/Notices";
import { PhaseTracker } from "@/components/PhaseTracker";
import { PlayerPanel } from "@/components/PlayerPanel";
import { WalletButton } from "@/components/WalletButton";
import { isBusy } from "@/lib/marketTx";
import { PRACTICE_ROUND, flatBaseline } from "@/lib/path";
import { commitPreflight } from "@/lib/player";
import { formatCountdown, tickerLabel, useLatestRoundId, useRound } from "@/lib/round";
import { useEntryActions, usePlayer } from "@/lib/useActions";

/** Screen 2: Draw. A real commit when a round exists; the practice board (labeled, never committable) otherwise. */
export default function Draw() {
  const latest = useLatestRoundId();
  const round = useRound(latest.id);

  const params = round.status === "ready" ? round.params : undefined;
  const phase = round.status === "ready" ? round.phase : undefined;
  const liveId = params && phase && latest.id !== undefined ? latest.id : undefined;
  const live = liveId !== undefined && params !== undefined && phase !== undefined;

  const player = usePlayer(liveId);
  const actions = useEntryActions(liveId, player.address, player.refetch);

  // Reasons the commit is not possible apart from the drawing itself (shown on the button).
  const pre =
    live && params && phase
      ? commitPreflight({
          phase,
          closing: round.closing,
          connected: player.connected,
          correctChain: player.correctChain,
          entryStake: params.entryStake,
          reads: player.reads,
          path: flatBaseline(),
        })
      : null;
  const blocked = pre !== null && !pre.ok ? pre.reason : undefined;

  const practiceWhy = latest.unconfigured
    ? "The Arena contract address is not configured."
    : latest.loading
      ? "Reading the latest round..."
      : latest.id === undefined
        ? "No round has been opened yet."
        : round.status === "loading"
          ? "Reading the latest round..."
          : round.status === "error"
            ? "Could not read the round from Base Sepolia."
            : "Round data is not available.";

  return (
    <main className="page">
      <header className="top">
        <h1>Consensus Path</h1>
        <WalletButton />
      </header>

      <UsNotice />

      <section className="card">
        <h2>
          Draw your path{" "}
          <Link href="/" className="back">
            Back to Today&apos;s Round
          </Link>
        </h2>
        {live && params && phase ? (
          <>
            <p className="stock">
              <span className="ticker">{tickerLabel(params.ticker)}</span>{" "}
              <span className="muted">round #{liveId?.toString()}</span>
            </p>
            <p className="countdown" aria-label="Time left in this phase">
              {phase === "settled" || phase === "void" ? "Final" : formatCountdown(round.countdownSec ?? 0)}
            </p>
            <PhaseTracker phase={phase} closing={round.closing} />
            <p className="muted">
              Entry stake: {params.entryStake.toString()} points, taken when you commit and returned (with any reward) when you
              claim a revealed entry. One transaction, no approval step.
            </p>
          </>
        ) : (
          <p className="sim-label" role="note">
            <span className="tag">simulated</span> Practice round, not a real round. {practiceWhy} Commit is disabled.
          </p>
        )}
        {/* One DrawChart in a fixed position: a drawing in progress survives the round becoming readable. */}
        <DrawChart
          T={live && params ? params.T : PRACTICE_ROUND.T}
          phase={live && phase ? phase : PRACTICE_ROUND.phase}
          closing={live ? round.closing : PRACTICE_ROUND.closing}
          simulated={!live}
          connected={player.connected}
          {...(blocked !== undefined ? { blocked } : {})}
          busy={isBusy(actions.tx)}
          onCommit={(path) => void actions.commit(path)}
        />
        {live && liveId !== undefined && phase ? (
          <EntryPanel roundId={liveId} phase={phase} closing={round.closing} player={player} actions={actions} />
        ) : null}
      </section>

      <section className="card">
        <PlayerPanel player={player} />
      </section>

      <HouseAgents />
    </main>
  );
}
