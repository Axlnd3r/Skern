"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { DashboardView } from "@/components/DashboardView";
import { HouseAgents, UsNotice } from "@/components/Notices";
import { WalletButton } from "@/components/WalletButton";
import { addresses } from "@/lib/chain";
import { houseAgentConfig } from "@/lib/historySource";
import { simulatedRounds } from "@/lib/history";
import { historyErrorText, useHistory } from "@/lib/useHistory";

// An operator opt-in for demos: shows a clearly labeled sample instead of chain history. Off by default.
const SAMPLE_ENABLED = process.env.NEXT_PUBLIC_DASHBOARD_SAMPLE === "1";

/** Screen 6: Gap Dashboard (desktop), with replay of a settled round. */
export default function Dashboard() {
  const configured = addresses.arena !== undefined;
  const [sample, setSample] = useState(false);
  const history = useHistory(configured && !sample);
  const samples = useMemo(() => (sample ? simulatedRounds() : []), [sample]);

  return (
    <main className="page wide">
      <header className="top">
        <h1>Consensus Path</h1>
        <WalletButton />
      </header>

      <UsNotice />

      <section className="card" aria-live="polite">
        <h2>
          Gap Dashboard{" "}
          <Link href="/" className="back">
            Back to Today&apos;s Round
          </Link>
        </h2>
        <p className="muted">
          Human consensus score against Agent consensus score for each settled round on Base Sepolia, read from contract views
          and reveal logs. Prices are shown only as basis point moves from P0.
        </p>
        <div className="row">
          <button type="button" className="btn" disabled={sample || history.isFetching || !configured} onClick={() => void history.refetch()}>
            {history.isFetching ? "Loading..." : "Reload from chain"}
          </button>
          {SAMPLE_ENABLED ? (
            <button type="button" className="btn ghost" onClick={() => setSample((s) => !s)}>
              {sample ? "Back to chain data" : "Show simulated sample (labeled)"}
            </button>
          ) : null}
        </div>
      </section>

      {sample ? (
        <DashboardView rounds={samples} houseAgents={new Set()} houseError={null} />
      ) : !configured ? (
        <p className="error">The Arena contract address is not configured. Set NEXT_PUBLIC_ARENA_ADDRESS (see .env.example).</p>
      ) : history.isError ? (
        <p className="error" role="alert">
          {historyErrorText(history.error)} Nothing is shown rather than a partial history. Use Reload from chain to retry.
        </p>
      ) : history.data === undefined ? (
        <p className="muted">Reading the round history from Base Sepolia...</p>
      ) : (
        <>
          {history.data.truncated ? (
            <p className="hint">Showing the most recent rounds only; older rounds are not included.</p>
          ) : null}
          <DashboardView rounds={history.data.rounds} houseAgents={houseAgentConfig.addresses} houseError={houseAgentConfig.error} />
        </>
      )}

      <HouseAgents />
    </main>
  );
}
