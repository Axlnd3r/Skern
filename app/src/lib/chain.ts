import { createConfig, http } from "wagmi";
import { coinbaseWallet } from "wagmi/connectors";
import { baseSepolia } from "wagmi/chains";
import { isAddress, type Abi, type Address } from "viem";
import ArenaJson from "../../../shared/abi/Arena.json";
import GapMarketJson from "../../../shared/abi/GapMarket.json";
import PointsJson from "../../../shared/abi/Points.json";
import deployed from "../../../shared/addresses.json";

/** Base Sepolia is the only supported network (README Global Constraints). */
export const CHAIN = baseSepolia;
export const BASE_SEPOLIA_CHAIN_ID = 84532;

/** Arena ABI from the single source of truth, `shared/abi`. Results are validated by callers (untrusted). */
export const arenaAbi = ArenaJson as unknown as Abi;
export const gapMarketAbi = GapMarketJson as unknown as Abi;
export const pointsAbi = PointsJson as unknown as Abi;

/** Error fragments of an ABI, so a revert raised in another contract can still be decoded. */
function errorsOf(abi: Abi) {
  return abi.filter((x) => x.type === "error");
}

/**
 * ABI used to dry-run and decode GapMarket calls: GapMarket itself plus the errors of Points (a bet
 * calls `Points.spend`) and Arena (`UnknownRound`), deduplicated by signature. Without these a
 * revert such as `InsufficientBalance` cannot be decoded from a simulation of a GapMarket call.
 */
export const gapMarketCallAbi: Abi = (() => {
  const seen = new Set<string>();
  const out: Abi[number][] = [];
  for (const item of [...gapMarketAbi, ...errorsOf(pointsAbi), ...errorsOf(arenaAbi)]) {
    if (item.type === "error") {
      const key = `${item.name}(${item.inputs.map((i) => i.type).join(",")})`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(item);
  }
  return out;
})();

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

/**
 * The raw address string to use: the override when it is set (even if malformed, so a typo is visible
 * as "not configured" instead of silently using another address), the deployed default only when the
 * override is unset or an empty string.
 */
export function overrideOrDefault(override: string | undefined, fallback: string): string {
  return override === undefined || override === "" ? fallback : override;
}

// Addresses default to the Base Sepolia deployment in shared/addresses.json (public data). A
// NEXT_PUBLIC_* variable overrides one address (for example a local Anvil deployment). Next.js only
// inlines NEXT_PUBLIC_* when accessed by literal name, so list them explicitly. An override that is
// set but malformed yields `undefined` (the screen shows "not configured") instead of silently
// falling back to the deployed address.
export const addresses: Addresses = parseAddresses({
  arena: overrideOrDefault(process.env.NEXT_PUBLIC_ARENA_ADDRESS, deployed.contracts.Arena),
  points: overrideOrDefault(process.env.NEXT_PUBLIC_POINTS_ADDRESS, deployed.contracts.Points),
  registry: overrideOrDefault(process.env.NEXT_PUBLIC_REGISTRY_ADDRESS, deployed.contracts.Registry),
  gapMarket: overrideOrDefault(process.env.NEXT_PUBLIC_GAP_MARKET_ADDRESS, deployed.contracts.GapMarket),
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
