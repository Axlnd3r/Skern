"use client";

import Link from "next/link";
import { MarketPanel } from "@/components/MarketPanel";
import { HouseAgents, UsNotice } from "@/components/Notices";
import { PhaseTracker } from "@/components/PhaseTracker";
import { WalletButton } from "@/components/WalletButton";
import { formatCountdown, tickerLabel, useLatestRoundId, useRound } from "@/lib/round";

/** Screen 3: Market. */
export default function Market() {
  const latest = useLatestRoundId();
  const round = useRound(latest.id);

  return (
    <main className="page">
      <header className="top">
        <h1>Consensus Path</h1>
        <WalletButton />
      </header>

      <UsNotice />

      <section className="card" aria-live="polite">
        <h2>
          Market{" "}
          <Link href="/" className="back">
            Back to Today&apos;s Round
          </Link>
        </h2>
        {latest.unconfigured ? (
          <p className="muted">The Arena contract address is not configured. Set NEXT_PUBLIC_ARENA_ADDRESS (see .env.example).</p>
        ) : latest.loading ? (
          <p className="muted">Loading the latest round...</p>
        ) : latest.id === undefined ? (
          <p className="muted">No round has been opened yet, so there is no market.</p>
        ) : round.status === "error" ? (
          <p className="error">Could not read round #{latest.id.toString()} from Base Sepolia.</p>
        ) : round.status !== "ready" || !round.params || !round.phase ? (
          <p className="muted">Reading round #{latest.id.toString()}...</p>
        ) : (
          <>
            <p className="stock">
              <span className="ticker">{tickerLabel(round.params.ticker)}</span>{" "}
              <span className="muted">round #{latest.id.toString()}</span>
            </p>
            <p className="countdown" aria-label="Time left in this phase">
              {round.phase === "settled" ? "Final" : round.phase === "void" ? "Void" : formatCountdown(round.countdownSec ?? 0)}
            </p>
            <PhaseTracker phase={round.phase} closing={round.closing} />
            <MarketPanel roundId={latest.id} T={round.params.T} phase={round.phase} closing={round.closing} />
            {round.phase === "play" || round.phase === "settled" ? (
              <Link href="/reveal" className="btn primary link-btn">
                {round.phase === "settled" ? "See the reveal and scores" : "Watch for the real candles"}
              </Link>
            ) : null}
          </>
        )}
      </section>

      <HouseAgents />
    </main>
  );
}
