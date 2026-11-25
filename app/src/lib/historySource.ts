// Chain adapter for the dashboard history: a read-only viem client on Base Sepolia, the Arena ABI from
// shared/abi and the deploy block and house agent list from shared/addresses.json. Kept out of
// history.ts so the pure logic and its tests do not need a client. Nothing here signs or sends.

import { createPublicClient, http, type Abi, type AbiEvent } from "viem";
import { baseSepolia } from "viem/chains";
import deployed from "../../../shared/addresses.json";
import { addresses, arenaAbi } from "./chain";
import { parseHouseAgents, roundCallSpecs, ROUND_CALL_COUNT, type HistorySource, type RawLog } from "./history";

const rpcUrl = process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL || undefined;

const REVEALED = arenaAbi.find((x): x is AbiEvent => x.type === "event" && x.name === "Revealed");

/** The deploy block from `shared/addresses.json`: the earliest block a log scan needs. */
export function deployBlock(): bigint {
  const b: unknown = deployed.deployBlock;
  if (typeof b !== "number" || !Number.isSafeInteger(b) || b < 0) {
    throw new Error("shared/addresses.json has no valid deployBlock");
  }
  return BigInt(b);
}

/** House agent addresses (optional `houseAgents` in the deployment file), validated. */
export const houseAgentConfig = parseHouseAgents((deployed as { houseAgents?: unknown }).houseAgents);

/** A read-only source for the Arena in `shared/addresses.json` (or the env override). */
export function createChainSource(): HistorySource {
  const arena = addresses.arena;
  if (arena === undefined) throw new Error("The Arena contract address is not configured.");
  const client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  return {
    async head() {
      const b = await client.getBlock({ blockTag: "latest" });
      return { number: b.number, time: b.timestamp };
    },
    async blockTime(n) {
      return (await client.getBlock({ blockNumber: n })).timestamp;
    },
    roundCount: () => client.readContract({ address: arena, abi: arenaAbi, functionName: "roundCount" }),
    async getRevealLogs(id, from, to): Promise<RawLog[]> {
      if (REVEALED === undefined) throw new Error("The Revealed event is missing from the Arena ABI.");
      const logs = await client.getLogs({
        address: arena,
        event: REVEALED,
        args: { id },
        fromBlock: from,
        toBlock: to,
      } as never);
      return (logs as unknown as { eventName?: unknown; args?: unknown; blockNumber?: unknown }[]).map((l) => ({
        eventName: typeof l.eventName === "string" ? l.eventName : "",
        args: l.args,
        blockNumber: typeof l.blockNumber === "bigint" ? l.blockNumber : null,
      }));
    },
    async readRounds(ids) {
      const contracts = ids.flatMap((id) =>
        roundCallSpecs(id).map((c) => ({ address: arena, abi: arenaAbi as Abi, functionName: c.functionName, args: c.args })),
      );
      const out = (await client.multicall({ contracts: contracts as never, allowFailure: true })) as unknown[];
      return ids.map((_, i) => out.slice(i * ROUND_CALL_COUNT, (i + 1) * ROUND_CALL_COUNT));
    },
  };
}
