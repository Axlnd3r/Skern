"use client";

import { deriveJoin, type JoinState } from "@/lib/player";
import { isBusy, type TxState } from "@/lib/marketTx";
import { useJoinAction, type PlayerView } from "@/lib/useActions";
import { TxStatus } from "./MarketPanel";

export type JoinPanelViewProps = {
  join: JoinState;
  correctChain: boolean;
  tx: TxState;
  onJoin: () => void;
  onRecheck: () => void;
};

/** Registration and points balance of the connected wallet. Text only; all decisions come from `deriveJoin`. */
export function JoinPanelView({ join, correctChain, tx, onJoin, onRecheck }: JoinPanelViewProps) {
  const busy = isBusy(tx);
  return (
    <div className="player" aria-live="polite">
      <h3>Your account</h3>
      {join.state === "unconfigured" ? <p className="muted">The contract addresses are not configured (see .env.example).</p> : null}
      {join.state === "no-wallet" ? <p className="muted">Connect a wallet to join and play. Testnet points only.</p> : null}
      {join.state === "loading" ? <p className="muted">Reading your account...</p> : null}
      {join.state === "error" ? <p className="error">Could not read your account from Base Sepolia.</p> : null}
      {join.state === "registered" ? (
        <p>
          Registered as human. Points balance: <strong data-balance={join.balance.toString()}>{join.balance.toString()}</strong>{" "}
          <span className="muted">(testnet points, no cash value)</span>
        </p>
      ) : null}
      {join.state === "agent" ? (
        <p>
          This wallet is registered as an agent, so it cannot play as a human. Points balance:{" "}
          <strong data-balance={join.balance.toString()}>{join.balance.toString()}</strong>
        </p>
      ) : null}
      {join.state === "not-allowlisted" ? (
        <p data-not-allowlisted>
          This wallet is not on the human allowlist, so it cannot join as a human yet. This is a closed testnet beta: ask the
          project to add your address. You can still practice drawing.
        </p>
      ) : null}
      {join.state === "can-join" ? (
        <>
          <p>
            This wallet is on the human allowlist.{" "}
            {join.grant !== null ? `Joining gives you ${join.grant.toString()} testnet points (no cash value).` : "Joining gives you starter testnet points."}
          </p>
          <button type="button" className="btn primary" data-join disabled={busy || !correctChain} onClick={onJoin}>
            {busy ? "Working..." : "Join as human"}
          </button>
          {!correctChain ? <p className="hint">Switch your wallet to Base Sepolia to join.</p> : null}
        </>
      ) : null}
      <TxStatus tx={tx} onRecheck={onRecheck} />
    </div>
  );
}

/** Join and balance for the connected wallet. `player` comes from `usePlayer` (shared with the screen). */
export function PlayerPanel({ player }: { player: PlayerView }) {
  const { tx, join, recheck } = useJoinAction(player.address, player.refetch);
  const state = deriveJoin({ configured: player.configured, connected: player.connected, reads: player.reads });
  return <JoinPanelView join={state} correctChain={player.correctChain} tx={tx} onJoin={() => void join()} onRecheck={() => void recheck()} />;
}
