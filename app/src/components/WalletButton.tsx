"use client";

import { useState } from "react";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { BASE_SEPOLIA_CHAIN_ID } from "@/lib/chain";
import { connectErrorText, switchErrorText, walletChoices, type WalletChoice } from "@/lib/wallet";

function short(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export type WalletViewProps = {
  address: string | undefined;
  connected: boolean;
  correctChain: boolean;
  choices: WalletChoice[];
  /** Id of the connector that is connecting right now. */
  pendingId: string | undefined;
  switching: boolean;
  /** Plain-language text of the last failed connect or switch (never raw RPC text). */
  errorText: string | undefined;
  onConnect: (id: string) => void;
  onSwitch: () => void;
  onDisconnect: () => void;
};

/** Presentational wallet control: choose a wallet, switch to Base Sepolia, disconnect. */
export function WalletView(props: WalletViewProps) {
  const [open, setOpen] = useState(false);
  const { address, connected, choices, pendingId } = props;

  if (!connected || !address) {
    return (
      <div className="wallet-wrap">
        <div className="wallet">
          <button
            type="button"
            className="btn"
            aria-expanded={open}
            aria-controls="wallet-menu"
            disabled={pendingId !== undefined}
            onClick={() => setOpen((o) => !o)}
          >
            {pendingId !== undefined ? "Connecting..." : "Connect wallet"}
          </button>
        </div>
        {open || pendingId !== undefined ? (
          <div id="wallet-menu" className="wallet-menu" role="group" aria-label="Choose a wallet">
            {choices.map((c) => (
              <button
                key={c.id}
                type="button"
                className="btn"
                data-wallet={c.id}
                disabled={pendingId !== undefined}
                onClick={() => props.onConnect(c.id)}
              >
                {pendingId === c.id ? "Connecting..." : c.label}
              </button>
            ))}
            <p className="hint">
              Coinbase Smart Wallet needs access to keys.coinbase.com. If your network blocks it, use a browser wallet such as
              MetaMask. Base Sepolia only; testnet points.
            </p>
          </div>
        ) : null}
        {props.errorText ? (
          <p className="error" role="alert">
            {props.errorText}
          </p>
        ) : null}
      </div>
    );
  }

  if (!props.correctChain) {
    return (
      <div className="wallet-wrap">
        <div className="wallet">
          <button type="button" className="btn warn" disabled={props.switching} onClick={props.onSwitch}>
            {props.switching ? "Switching..." : "Switch to Base Sepolia"}
          </button>
          <button type="button" className="btn ghost" onClick={props.onDisconnect}>
            Disconnect
          </button>
        </div>
        <p className="hint" role="status">
          Your wallet is on another network. Nothing is sent until it is on Base Sepolia (chain id 84532).
        </p>
        {props.errorText ? (
          <p className="error" role="alert">
            {props.errorText}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="wallet-wrap">
      <div className="wallet">
        <span className="addr" title={address}>
          {short(address)}
        </span>
        <button type="button" className="btn ghost" onClick={props.onDisconnect}>
          Disconnect
        </button>
      </div>
    </div>
  );
}

/** Wallet control wired to wagmi: Coinbase Smart Wallet or any browser wallet, Base Sepolia only. */
export function WalletButton() {
  const { address, chainId, isConnected } = useAccount();
  const { connect, connectors, isPending, error, variables } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching, error: switchError } = useSwitchChain();

  const choices = walletChoices(connectors.map((c) => ({ id: c.id, name: c.name, type: c.type })));
  const pendingId = isPending ? ((variables?.connector as { id?: string } | undefined)?.id ?? "") : undefined;
  const chosenId = (variables?.connector as { id?: string } | undefined)?.id;
  const kind = choices.find((c) => c.id === chosenId)?.kind ?? "browser";

  const correctChain = chainId === BASE_SEPOLIA_CHAIN_ID;
  const errorText = isConnected
    ? switchError
      ? switchErrorText(switchError)
      : undefined
    : error
      ? connectErrorText(error, kind)
      : undefined;

  return (
    <WalletView
      address={address}
      connected={isConnected}
      correctChain={correctChain}
      choices={choices}
      pendingId={pendingId}
      switching={switching}
      errorText={errorText}
      onConnect={(id) => {
        const connector = connectors.find((c) => c.id === id);
        if (connector) connect({ connector, chainId: BASE_SEPOLIA_CHAIN_ID });
      }}
      onSwitch={() => switchChain({ chainId: BASE_SEPOLIA_CHAIN_ID })}
      onDisconnect={() => disconnect()}
    />
  );
}
