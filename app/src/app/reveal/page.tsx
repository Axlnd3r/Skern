"use client";

import Link from "next/link";
import { useAccount } from "wagmi";
import { ArenaClaim, MarketClaim } from "@/components/ClaimPanel";
import { HouseAgents, UsNotice } from "@/components/Notices";
import { PhaseTracker } from "@/components/PhaseTracker";
import { ResultSectionView } from "@/components/ResultCard";
import { RevealPlayer } from "@/components/RevealPlayer";
import { WalletButton } from "@/components/WalletButton";
import { deriveReveal, type RevealReads } from "@/lib/reveal";
import { formatCountdown, tickerLabel, useLatestRoundId, useRound } from "@/lib/round";
import { useMyEntry } from "@/lib/useMyEntry";
import { useRevealReads } from "@/lib/useReveal";

/** Screen 4: Reveal. */
export default function Reveal() {
  const latest = useLatestRoundId();
  const round = useRound(latest.id);
  const reads = useRevealReads(latest.id, round.phase === "settled");

  return (
    <main className="page">
      <header className="top">
        <h1>Consensus Path</h1>
        <WalletButton />
      </header>

      <UsNotice />

      <section className="card" aria-live="polite">
        <h2>
          Reveal{" "}
          <Link href="/" className="back">
            Back to Today&apos;s Round
          </Link>
        </h2>
        {latest.unconfigured ? (
          <p className="muted">The Arena contract address is not configured. Set NEXT_PUBLIC_ARENA_ADDRESS (see .env.example).</p>
        ) : latest.loading ? (
          <p className="muted">Loading the latest round...</p>
        ) : latest.id === undefined ? (
          <p className="muted">No round has been opened yet, so there is nothing to reveal.</p>
        ) : round.status === "error" ? (
          <p className="error">Could not read round #{latest.id.toString()} from Base Sepolia.</p>
        ) : round.status !== "ready" || !round.params || !round.phase ? (
          <p className="muted">Reading round #{latest.id.toString()}...</p>
        ) : (
          <RevealBody
            id={latest.id}
            ticker={tickerLabel(round.params.ticker)}
            T={round.params.T}
            entryStake={round.params.entryStake}
            phase={round.phase}
            countdownSec={round.countdownSec ?? 0}
            closing={round.closing}
            reads={reads}
          />
        )}
      </section>

      <HouseAgents />
    </main>
  );
}

function RevealBody(props: {
  id: bigint;
  ticker: string;
  T: number;
  entryStake: bigint;
  phase: NonNullable<ReturnType<typeof useRound>["phase"]>;
  countdownSec: number;
  closing: boolean;
  reads: ReturnType<typeof useRevealReads>;
}) {
  const view = deriveReveal({ phase: props.phase, reads: props.reads });
  const terminal = props.phase === "settled" || props.phase === "void";
  return (
    <>
      <p className="stock">
        <span className="ticker">{props.ticker}</span> <span className="muted">round #{props.id.toString()}</span>
      </p>
      <p className="countdown" aria-label="Time left in this phase">
        {terminal ? (props.phase === "void" ? "Void" : "Final") : formatCountdown(props.countdownSec)}
      </p>
      <PhaseTracker phase={props.phase} closing={props.closing} />
      {view.state === "ready" && view.reads ? (
        <RevealPlayer
          // A new round or new reads restart the replay from candle 0.
          key={`${props.id}-${view.reads.sourceHash}`}
          real={view.reads.real}
          human={view.reads.human}
          agent={view.reads.agent}
          T={props.T}
          {...(view.reads.scores ? { onchain: view.reads.scores } : {})}
          {...(view.reads.baseline !== undefined ? { baseline: view.reads.baseline } : {})}
          sourceHash={view.reads.sourceHash}
        />
      ) : (
        <p className={view.state === "error" ? "error" : "muted"}>{view.message}</p>
      )}
      <ResultSection
        key={String(props.id)}
        id={props.id}
        phase={props.phase}
        ticker={props.ticker}
        T={props.T}
        reads={view.state === "ready" ? view.reads : undefined}
      />
      {props.phase === "settled" || props.phase === "void" ? (
        <ArenaClaim
          key={`claim-${props.id}`}
          roundId={props.id}
          phase={props.phase}
          T={props.T}
          entryStake={props.entryStake}
          reads={view.state === "ready" ? view.reads : undefined}
        />
      ) : null}
      {props.phase === "play" || props.phase === "settled" || props.phase === "void" ? (
        <MarketClaim key={`market-claim-${props.id}`} roundId={props.id} phase={props.phase} />
      ) : null}
      <Link href="/market" className="btn link-btn">
        Market and bets
      </Link>
    </>
  );
}

/** Screen 5: wires the wallet and the entry read into the tested view. */
function ResultSection(props: {
  id: bigint;
  phase: ReturnType<typeof useRound>["phase"];
  ticker: string;
  T: number;
  reads: RevealReads | undefined;
}) {
  const { address, isConnected } = useAccount();
  const entry = useMyEntry(props.id, address, isConnected && props.phase === "settled");
  if (props.phase === undefined) return null;
  return (
    <ResultSectionView
      phase={props.phase}
      reads={props.reads}
      T={props.T}
      roundId={props.id}
      ticker={props.ticker}
      connected={isConnected}
      entry={entry}
    />
  );
}
