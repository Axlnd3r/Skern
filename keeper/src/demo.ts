// Demo mode: one round with 5-minute candles and the README §3 windows (commit 90 s, reveal 30 s, market 60 s),
// the reveal relay, and the loop that drives the round to settlement.
//
// Run (needs a TypeScript runner, for example `pnpm dlx tsx keeper/src/demo.ts`; environment in keeper/.env.example):
//   RPC_URL, CHAIN_ID, ARENA_ADDRESS, KEEPER_PRIVATE_KEY, TWELVEDATA_API_KEY
//   optional: DEMO_TICKER, DEMO_ENTRY_STAKE, DEMO_REPLAY_OFFSET_SEC, KEEPER_STATE_DIR, RELAY_PORT, RELAY_HOST,
//             RELAY_ALLOW_ORIGIN, MINE_ON_TICK (anvil only)
//
// A real-candle demo needs the US session (about 21:30 to 04:00 WIB): outside it the feed has no fresh bars
// and no round is opened. Set DEMO_REPLAY_OFFSET_SEC (a past session shifted into the present) to run a round
// that is labeled "replay" in its source URL and must be presented as a mechanism demo, never as a live prediction.
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Mutex } from "./lock";
import { startLoop, type LoopHandle } from "./loop";
import { FileQueueStore, createRelay, createRelayChain, type Relay } from "./relay";
import { createKeeperDeps, loadKeeperConfig, type KeeperDeps } from "./rounds";
import { replayFeed, type PriceFeed, type RoundTemplate } from "./source";
import { FileStateStore } from "./state";
import { createTwelveDataSource, loadTwelveDataKey, throttleFeed } from "./twelvedata";

/** README §3 demo windows. */
export const DEMO_CANDLE_SEC = 300;
export const DEMO_COMMIT_SEC = 90;
export const DEMO_REVEAL_SEC = 30;
export const DEMO_MARKET_SEC = 60;

export interface DemoTemplateOptions {
  ticker?: string;
  entryStake?: bigint;
  /** Seconds between "now" and the start of the commit window (the open tx lands a block or two later). Default 4. */
  leadSec?: number;
  /** Time after `marketEnd + 3*candleSec` in which the keeper may still post. Default 3600. */
  settleGraceSec?: number;
}

export function demoTemplate(o: DemoTemplateOptions = {}): RoundTemplate {
  return {
    ticker: o.ticker ?? "AAPL",
    candleSec: DEMO_CANDLE_SEC,
    commitSec: DEMO_COMMIT_SEC,
    revealSec: DEMO_REVEAL_SEC,
    marketSec: DEMO_MARKET_SEC,
    leadSec: o.leadSec ?? 4,
    settleGraceSec: o.settleGraceSec ?? 3600,
    entryStake: o.entryStake ?? 10n,
  };
}

export interface DemoOptions {
  env?: Record<string, string | undefined>;
  /** Injected deps and feed (tests); otherwise built from the environment. */
  deps?: KeeperDeps;
  feed?: PriceFeed;
  log?: (msg: string) => void;
}

export interface DemoHandle {
  loop: LoopHandle;
  relay: Relay;
  relayPort: number;
  stop(): Promise<void>;
}

/** Wires relay and loop for one demo round and returns immediately; await `handle.loop.finished` for the end. */
export async function startDemo(o: DemoOptions = {}): Promise<DemoHandle> {
  const env = o.env ?? process.env;
  const log = o.log ?? ((m: string) => console.log(`[demo] ${m}`));
  const deps = o.deps ?? (await createKeeperDeps(loadKeeperConfig(env))); // refuses a key that is not arena.keeper()
  // The loop polls every 5 s; the throttle keeps a failing loop at one provider call per minute so the free plan's
  // daily quota (800 credits) survives a demo started while the US market is closed.
  let feed: PriceFeed = o.feed ?? throttleFeed(createTwelveDataSource({ apiKey: loadTwelveDataKey(env), log: () => {} }));
  if (env.DEMO_REPLAY_OFFSET_SEC) feed = replayFeed(feed, Number(env.DEMO_REPLAY_OFFSET_SEC));
  const stateDir = env.KEEPER_STATE_DIR ?? join(homedir(), ".consensus-path", "keeper");
  const lock = new Mutex();

  const relay = createRelay({
    chain: createRelayChain(deps, lock),
    queueStore: new FileQueueStore(join(stateDir, "relay-queue.json")),
    allowOrigins: (env.RELAY_ALLOW_ORIGIN ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    log,
  });
  const { port } = await relay.listen(Number(env.RELAY_PORT ?? 8787), env.RELAY_HOST ?? "127.0.0.1");
  log(`reveal relay listening on port ${port}; mode ${feed.mode}; points only, Base Sepolia testnet`);

  let loop: LoopHandle;
  try {
    loop = await startLoop({
      deps,
      lock,
      feed,
      store: new FileStateStore(join(stateDir, "keeper-state.json")),
      template: demoTemplate({
        ticker: env.DEMO_TICKER,
        entryStake: env.DEMO_ENTRY_STAKE ? BigInt(env.DEMO_ENTRY_STAKE) : undefined,
      }),
      maxRounds: 1,
      // Candles posted on chain are permanent. Twelve Data can serve the last bars of a window late or partial, so
      // wait 60 s (not the loop default of 15 s) after the window ends before reading them.
      dataDelaySec: 60,
      mineOnTick: env.MINE_ON_TICK === "1",
      log,
    });
  } catch (e) {
    await relay.close();
    throw e;
  }
  return {
    loop,
    relay,
    relayPort: port,
    async stop() {
      await loop.stop();
      await relay.close();
    },
  };
}

export async function runDemo(o: DemoOptions = {}): Promise<void> {
  const h = await startDemo(o);
  try {
    await h.loop.finished;
  } finally {
    await h.stop();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDemo().catch((e: unknown) => {
    // Messages from this code never contain a key; print only the message, not the stack of a wrapped cause.
    console.error(`[demo] fatal: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
