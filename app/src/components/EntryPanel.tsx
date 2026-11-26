"use client";

import { useEffect, useRef } from "react";
import { deriveEntry, type EntryView } from "@/lib/player";
import { isBusy, type TxState } from "@/lib/marketTx";
import { relayText } from "@/lib/relayClient";
import type { RelayState } from "@/lib/actionTx";
import type { Phase } from "@/lib/round";
import { useEntryActions, useSaltLookup, type PlayerView } from "@/lib/useActions";
import { TxStatus } from "./MarketPanel";

export type EntryPanelViewProps = {
  view: EntryView;
  /** The relay already accepted the saved path (from the saved record). */
  relayAck: boolean;
  tx: TxState;
  relay: RelayState;
  onRelay: () => void;
  onReveal: () => void;
  onRecheck: () => void;
};

function RelayLine({ relay, relayAck }: { relay: RelayState; relayAck: boolean }) {
  switch (relay.step) {
    case "sending":
      return (
        <p className="muted" role="status" data-relay="sending">
          Sending your path to the reveal relay...
        </p>
      );
    case "blocked":
      return (
        <p className="muted" role="status" data-relay="blocked">
          {relay.message}
        </p>
      );
    case "done": {
      const o = relay.outcome;
      const cls = o.state === "revealed" || o.state === "queued" || o.state === "pending" ? "ok" : "error";
      return (
        <p className={cls} role="status" data-relay={o.state}>
          {relayText(o)}
        </p>
      );
    }
    case "idle":
      return relayAck ? (
        <p className="muted" data-relay="acknowledged">
          The reveal relay already has your path.
        </p>
      ) : null;
  }
}

/**
 * The player's own entry in the live round: commit status, the keeper relay (decision D1) and the manual
 * reveal fallback. "Revealed" is shown only when the chain says so; relay answers are shown as what they are.
 */
export function EntryPanelView({ view, relayAck, tx, relay, onRelay, onReveal, onRecheck }: EntryPanelViewProps) {
  const busy = isBusy(tx) || relay.step === "sending";
  if (view.stage === "no-wallet" || view.stage === "none" || view.stage === "agent") {
    // Nothing to show before a commit; a commit transaction in progress still needs its status line.
    return tx.step === "idle" && relay.step === "idle" ? null : (
      <div className="entry">
        <RelayLine relay={relay} relayAck={relayAck} />
        <TxStatus tx={tx} onRecheck={onRecheck} />
      </div>
    );
  }
  return (
    <div className="entry" aria-live="polite">
      <h3>Your entry</h3>
      <p data-entry-stage={view.stage}>
        <strong>{view.headline}</strong>
      </p>
      {view.detail ? <p className="muted">{view.detail}</p> : null}
      {view.stage === "committed" ? <RelayLine relay={relay} relayAck={relayAck} /> : null}
      {view.canRelay || view.canReveal ? (
        <div className="row">
          {view.canRelay ? (
            <button type="button" className="btn" data-relay-send disabled={busy} onClick={onRelay}>
              Send my path to the relay
            </button>
          ) : null}
          {view.canReveal ? (
            <button type="button" className="btn" data-reveal-manual disabled={busy} onClick={onReveal}>
              Reveal it myself
            </button>
          ) : null}
        </div>
      ) : null}
      {view.stage === "committed" && (view.canRelay || view.canReveal) ? (
        <p className="hint">
          Your path and salt are saved in this browser. The relay (run by the project) sees your path before the reveal
          window; that is the accepted trade-off for not having to sign twice. Keep this browser&apos;s data until your entry
          is revealed.
        </p>
      ) : null}
      <TxStatus tx={tx} onRecheck={onRecheck} />
    </div>
  );
}

/**
 * Wires the saved record, the chain entry and the actions into the tested view. `actions` is the single
 * `useEntryActions` instance of the screen (the Commit button uses the same one, so they share one status).
 */
export function EntryPanel(props: {
  roundId: bigint;
  phase: Phase;
  closing: boolean;
  player: PlayerView;
  actions: ReturnType<typeof useEntryActions>;
}) {
  const { player, actions } = props;
  const entry = player.reads === undefined || player.reads === null ? (player.reads as null | undefined) : player.reads.entry;
  const entryHash = entry && entry.kind === 1 ? entry.hash : undefined;
  const lookup = useSaltLookup(props.roundId, player.address, entryHash, `${actions.tx.step}:${actions.relay.step}`);
  const view = deriveEntry({
    connected: player.connected,
    correctChain: player.correctChain,
    phase: props.phase,
    closing: props.closing,
    entry,
    lookup,
  });
  const relayAck = lookup?.state === "found" && lookup.record.relayAck === true;

  // After a reload: if the commit is on chain but the relay never acknowledged the path, send it once.
  const auto = useRef<string | null>(null);
  const { resendRelay } = actions;
  const autoKey = `${props.roundId}:${player.address}`;
  const shouldAuto = view.canRelay && lookup?.state === "found" && !relayAck && actions.relay.step === "idle" && !isBusy(actions.tx);
  useEffect(() => {
    if (!shouldAuto || auto.current === autoKey) return;
    auto.current = autoKey;
    void resendRelay();
  }, [shouldAuto, autoKey, resendRelay]);

  return (
    <EntryPanelView
      view={view}
      relayAck={relayAck}
      tx={actions.tx}
      relay={actions.relay}
      onRelay={() => void actions.resendRelay()}
      onReveal={() => void actions.reveal()}
      onRecheck={() => void actions.recheck()}
    />
  );
}
