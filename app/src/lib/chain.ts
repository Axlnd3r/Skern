import { createConfig, http } from "wagmi";
import { coinbaseWallet } from "wagmi/connectors";
import { baseSepolia } from "wagmi/chains";
import { isAddress, type Abi, type Address } from "viem";
import ArenaJson from "../../../shared/abi/Arena.json";

/** Base Sepolia is the only supported network (README Global Constraints). */
export const CHAIN = baseSepolia;
export const BASE_SEPOLIA_CHAIN_ID = 84532;

/** Arena ABI from the single source of truth, `shared/abi`. Results are validated by callers (untrusted). */
export const arenaAbi = ArenaJson as unknown as Abi;

export type Addresses = {
  arena: Address | undefined;
  points: Address | undefined;
  registry: Address | undefined;
  gapMarket: Address | undefined;
};

/** Returns the address only if the string is a well-formed 20-byte hex address. */
export function parseAddress(value: string | undefined): Address | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  return isAddress(v, { strict: false }) ? (v as Address) : undefined;
}

export function parseAddresses(env: Record<string, string | undefined>): Addresses {
  return {
    arena: parseAddress(env.arena),
    points: parseAddress(env.points),
    registry: parseAddress(env.registry),
    gapMarket: parseAddress(env.gapMarket),
  };
}

// Next.js only inlines NEXT_PUBLIC_* when accessed by literal name, so list them explicitly.
// shared/addresses.json does not exist until deployment; these env vars stand in for it.
export const addresses: Addresses = parseAddresses({
  arena: process.env.NEXT_PUBLIC_ARENA_ADDRESS,
  points: process.env.NEXT_PUBLIC_POINTS_ADDRESS,
  registry: process.env.NEXT_PUBLIC_REGISTRY_ADDRESS,
  gapMarket: process.env.NEXT_PUBLIC_GAP_MARKET_ADDRESS,
});

/** Optional RPC override; falls back to the public Base Sepolia endpoint. */
const rpcUrl = process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL || undefined;

export const wagmiConfig = createConfig({
  chains: [CHAIN],
  ssr: true,
  connectors: [
    // Coinbase Smart Wallet only: seedless passkey onboarding, no extension or seed phrase.
    coinbaseWallet({ version: "4", appName: "Consensus Path", preference: "smartWalletOnly" }),
  ],
  transports: { [CHAIN.id]: http(rpcUrl) },
});
