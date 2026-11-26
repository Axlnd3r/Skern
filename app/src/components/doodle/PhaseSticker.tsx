import type { Phase } from "@/lib/round";
import { fillRing } from "./helpers";
import { Sticker, Star } from "./index";

const WORD: Record<Phase, string> = {
  commit: "COMMIT",
  reveal: "REVEAL",
  market: "MARKET",
  play: "PLAY",
  settled: "SETTLED",
  void: "VOID",
};

/** The text that runs around the stamp. Pure so it can be tested: it names the round and repeats the testnet note. */
export function ringFor(roundId: bigint): string {
  return fillRing(`ROUND ${roundId.toString()} · TESTNET POINTS ONLY · `);
}

/**
 * The phase as a rubber stamp. It floats to the right of the round heading so text wraps around it and nothing
 * ever sits under it. The `key` makes a new phase mount a new stamp, which plays the "stamp lands" animation.
 */
export function PhaseSticker({ phase, roundId }: { phase: Phase; roundId: bigint }) {
  return (
    <div className="sticker-wrap" aria-hidden="true">
      <Sticker key={phase} label={WORD[phase]} ring={ringFor(roundId)} />
      <Star className="sticker-star" size={22} rotate={14} />
    </div>
  );
}
