"use client";

import Link from "next/link";
import { useState } from "react";
import { useAccount } from "wagmi";
import { DrawChart } from "@/components/DrawChart";
import { HouseAgents, UsNotice } from "@/components/Notices";
import { PhaseTracker } from "@/components/PhaseTracker";
import { WalletButton } from "@/components/WalletButton";
import { PRACTICE_ROUND } from "@/lib/path";
import { formatCountdown, tickerLabel, useLatestRoundId, useRound } from "@/lib/round";

/** Screen 2: Draw. */
export default function Draw() {
  const { isConnected } = useAccount();
  const latest = useLatestRoundId();
  const round = useRound(latest.id);
  const [notice, setNotice] = useState<string | null>(null);

  const practiceWhy = latest.unconfigured
    ? "The Arena contract address is not configured."
    : latest.loading || round.status === "loading"
      ? "Reading the latest round..."
      : round.status === "error"
        ? "Could not read the round from Base Sepolia."
        : latest.id === undefined
          ? "No round has been opened yet."
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
        {round.status === "ready" && round.params && round.phase ? (
          <>
            <p className="stock">
              <span className="ticker">{tickerLabel(round.params.ticker)}</span>{" "}
              <span className="muted">round #{latest.id?.toString()}</span>
            </p>
            <p className="countdown" aria-label="Time left in this phase">
              {round.phase === "settled" || round.phase === "void" ? "Final" : formatCountdown(round.countdownSec ?? 0)}
            </p>
            <PhaseTracker phase={round.phase} closing={round.closing} />
            <DrawChart
              T={round.params.T}
              phase={round.phase}
              closing={round.closing}
              simulated={false}
              connected={isConnected}
              onCommit={() =>
                setNotice(
                  "Commit is a stub: the real commit transaction and the keeper relay are not wired yet. Nothing was sent.",
                )
              }
            />
          </>
        ) : (
          <>
            <p className="sim-label" role="note">
              <span className="tag">simulated</span> Practice round, not a real round. {practiceWhy} Commit is disabled.
            </p>
            <DrawChart
              T={PRACTICE_ROUND.T}
              phase={PRACTICE_ROUND.phase}
              closing={PRACTICE_ROUND.closing}
              simulated={PRACTICE_ROUND.simulated}
              connected={isConnected}
              onCommit={() => undefined}
            />
          </>
        )}
        {notice ? (
          <p className="error" role="status">
            {notice}
          </p>
        ) : null}
      </section>

      <HouseAgents />
    </main>
  );
}
