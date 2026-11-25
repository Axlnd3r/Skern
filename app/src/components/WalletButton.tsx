"use client";

import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { BASE_SEPOLIA_CHAIN_ID } from "@/lib/chain";

function short(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

/** Coinbase Smart Wallet connect, Base Sepolia only. */
export function WalletButton() {
  const { address, chainId, isConnected } = useAccount();
  const { connect, connectors, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();

  if (!isConnected || !address) {
    const connector = connectors[0];
    return (
      <div className="wallet">
        <button
          type="button"
          className="btn"
          disabled={!connector || isPending}
          onClick={() => connector && connect({ connector, chainId: BASE_SEPOLIA_CHAIN_ID })}
        >
          {isPending ? "Connecting..." : "Connect Smart Wallet"}
        </button>
        {error ? <p className="error">Could not connect: {error.message.split("\n")[0]}</p> : null}
      </div>
    );
  }

  if (chainId !== BASE_SEPOLIA_CHAIN_ID) {
    return (
      <div className="wallet">
        <button
          type="button"
          className="btn warn"
          disabled={switching}
          onClick={() => switchChain({ chainId: BASE_SEPOLIA_CHAIN_ID })}
        >
          Switch to Base Sepolia
        </button>
      </div>
    );
  }

  return (
    <div className="wallet">
      <span className="addr" title={address}>
        {short(address)}
      </span>
      <button type="button" className="btn ghost" onClick={() => disconnect()}>
        Disconnect
      </button>
    </div>
  );
}
