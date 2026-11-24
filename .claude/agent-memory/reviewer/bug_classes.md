---
name: bug-classes
description: Bug classes found in Consensus Path reviews (Solidity + TS; cross-round read-site keying, presence vs quorum), reviewer method pitfalls (fuzz FAIL parsing, probes), and forward risks for Tasks 6-13; check first on every diff
metadata:
  type: project
---

Bug classes seen in implementer diffs. Check each one first on every review.

1. **Solidity memory-to-memory struct assignment aliases.** `p[i] = src[i]` with both `Candle[3] memory` copies a pointer, so a later `p[0].high = x` silently mutates `src`. Task 2 (2026-11-20): `GenVectors._withHigh` turned "T=1 one bp high error" into pred == real (100 instead of 96) and corrupted `real` for the next 3 vectors. Fixed in round 2 with a field-by-field copy. Look for builder/clone helpers in scripts, tests and contracts (Arena copying paths).
   **How to apply:** grep for `= src[`, `= p[`, struct copies in helpers; regenerate fixtures in a scratch copy with a field-by-field copy and diff.

2. **Negative test fails for an unrelated reason.** An `assertFalse(isValid(path))` where another candle is also invalid pins nothing. Task 2: down-candle cases used candle 2 `(20,22,8)` after close -10 (low 8 > open -10), so the `low > close` clause was pinned by no test and no vector on either side.
   **How to apply:** for each negative case, check that every other element is valid. Mutate the targeted clause and confirm the test dies with hand tests only (exclude the snapshot test).

3. **Generated snapshot vectors only catch staleness, not correctness.** A Solidity test that recomputes vectors from the same lib cannot detect a shared bug or a mislabeled vector. Require some hand-computed expected values that do not come from the generator, on the TS side too.

4. **JS `Array.prototype.every/some/forEach` skip holes.** A shape check `p.length === 3 && p.every(...)` passes `new Array(3)`, and the later `for..of` then throws a TypeError (Task 2 round 2, `shared/score.ts` `isWellFormed`, rated minor).

5. **Scope creep into orchestrator-owned root files** (`.gitignore` etc., plan Orchestration rule 6) without an explicit grant in the task. Task 2: the orchestrator accepted the `.gitignore` edit explicitly.

6. **Multi-round isolation untested.** Task 4 round 1 (2026-11-24): every reveal test used a single round, or two rounds with identical params. So these mutants survived: the histogram mapping without the round key (`_histogram[0]` everywhere), `reveal` reading `_rounds[roundCount]` (window), `_bucketWidth[roundCount]`, `commit` reading the latest round's stake and window, and histogram writes into the latest round. The plan text says "per-kind per-field histograms" with no "per-round", so dropping the round key is a realistic bug. Rated major.
   **How to apply:** for any per-round state (Arena histograms, consensus, scores, claims; GapMarket pools and bets), require a test that has two live rounds with different T, stake and windows. Act on the older round, then assert the newer round's state is untouched. Mutate the mapping key to `[0]` and to `[roundCount]`.
   **Fixed in Task 4, fix round 1:** `test_roundsAreIsolated` kills all five mutants. It is a good template for Tasks 5 to 7.
   **Recurred in Task 5 round 1 (2026-11-24), rated major:** `test_freezeIsRoundIsolated` existed but used the same per-kind reveal count (3 humans) in both rounds, gave the newer round a superset of kinds, and froze rounds in creation order. Six `[roundCount]` mutants survived: `_revealCount` in `_median` target / `freezeConsensus` NoReveals / `_consensusPath` presence, and `_frozenMask` in AlreadyFrozen / `_freezeAll` skip / `ready`. A "has an isolation test" is not enough. Require: **different per-kind counts across rounds, complementary presence (older round has a kind the newer lacks and vice versa), freeze the newer round first, and assert the older round's `ready` while the newer one is unfrozen.** Mutate EVERY read site of every per-round mapping separately, not just the writes.

   **Fixed in Task 5 fix round 1:** `test_freezeIsRoundIsolatedWithDifferentCountsAndPresence` (built from my probe design) kills all six; it is the template for Tasks 6-7 per-round state (scores, claims, pools).

7. **Presence threshold conflated with quorum.** (Fixed in Task 5 fix round 1 by `test_freezeAllFreezesSidesBelowQuorum`, 1 human + 2 agents, kills `< 3` and `< 2`.) Task 5 round 1: no test ran `freezeAll`/`ready` with a kind of 1 or 2 reveals, so `_revealCount == 0` -> `< 3` survived (major: a below-quorum side must still be frozen and scored, Review Focus 4). **How to apply:** for every "absent iff 0" or "quorum >= 3" check, require tests at 1, 2 and 3; mutate `== 0` to `< 3` and `< 3` to `== 0`.

## Reviewer method pitfalls (my own mistakes)

- **Never test a lint suppression with `forge lint <path>`.** A path argument narrows the lint scope, and some forge lints are interprocedural. `require-revert-in-loop` fires on `ScoreLib.score`'s revert only because `GenVectors._random()` calls the inlined internal function inside a loop. In Task 2 round 1 I wrongly called that suppression dead; the orchestrator disproved it. Always test suppressions with a project-wide `forge lint` (no path) and `forge build --force`.

- **Forward note for Tasks 4-7.** `ScoreLib.sol:45` carries `forge-lint: disable-next-line(require-revert-in-loop)`. Because the warning is reported at the library line, that suppression silences it for every future caller, including any Arena or GapMarket loop over entries. Check revert-in-loop DoS in those loops by hand (one bad entry must not block a batch claim or settle).

- **`forge lint` `missing-events-access-control` fires even when the setter emits an event** (seen on `Points.setMinter/setSpender`, Task 3). Those suppressions are live, not dead. Verified by deleting them in a scratch copy and running a project-wide `forge lint`.
- **sed `\n` in a single-line `s///` silently does nothing.** Detect no-op mutants with `cmp` against the original. Use line-address sed (for example `92{h;d};93{G}` to swap two lines) for reorder mutants.
- **Classify equivalent mutants** (for example `x += 0`) as equivalent in the report, not as survivors or test gaps.
- **Foundry `vm.expectEmit` matches any later event in the call.** A mutant that adds a second, wrong emit next to the correct one is invalid. Move or replace the emit instead of duplicating it.
- **`forge lint` does not report on `test/` files**, not even with an explicit path. `forge-lint` suppressions in tests are inert noise, not live. Check src suppressions by deleting them in a scratch copy and running a project-wide lint.
- **Scratch dirs can be reused by other agents.** Between Task 4 rounds, `scratchpad/mut` was overwritten: the new test file was there, `Arena.sol.orig` was gone, and `script/` and `out/` had been added. Make a fresh, uniquely named copy for each round. Prove file identity with `git ls-files -s` or `git hash-object` against the blob ids in the reviewed diff (`index 0000000..<blob>`), and use `git diff <oldblob> <newblob>` for the fix diff.
- **Slither runs `forge clean` in the target dir.** Afterwards run `forge build` in the repo `contracts/` so `out/` exists again (it is gitignored, so git status stays clean).
- **Fuzz failures break a naive `[FAIL...]` regex.** The counterexample `args=[a, b]]` contains `]`, so `\[FAIL[^]]*\] name` silently drops fuzz failures and reports false SURVIVED. Parse `^\[FAIL` lines with `grep -oE "\] test[A-Za-z0-9_]+"` and also record the `Suite result` line.
- **Probe tests for survivors:** write `contract ReviewerProbe is <TaskTest>` in the scratch `test/` (inherits all helpers), run with `--match-contract ReviewerProbe --match-test test_probe`, and show each survivor dies. That turns "missing test" into a concrete, verified fix.
- **Foundry's fuzz dictionary does hit small edge values** (0, -1, ±100, width 0 to 2) even with `bound(width, 1, uint32.max)`. In Task 4 the fuzz test alone killed every floor and clamp mutant, so do not assume a wide bound means weak fuzz. Measure it with mutants.

## Forward risks to check in later tasks (from Task 3, 2026-11-24)
- **Kind snapshot.** `reclassify` is blocked only while `anyCommitWindowOpen()`, so it is allowed in the reveal and market windows. Task 4 stores `e.kind` at commit, and `test_revealKindSnapshotSurvivesReclassify` pins it. **Tasks 6 and 7 must still read `e.kind`, never `registry.kindOf`, at claim and bet.** Check this with a reclassify-mid-round mutant.
- **`anyCommitWindowOpen()`.** Task 4 implements a running max of `maxCommitEnd` with `now < maxCommitEnd`, the same boundary as `commit`. It is O(1) and pinned. A keeper that writes millisecond timestamps (`Date.now()`) would raise `maxCommitEnd` for good and brick `reclassify` plus that round's stakes forever. Task 9 must use seconds and sanity-bound durations.

## Forward risks from Task 4 (2026-11-24)
- **Task 5:** `freezeConsensus` must reject `field > 8`. The `histogram` and `getHistogram` views return zeros for field > 8, and `histogram` panics for bucket > 200.
- **Tasks 6 and 8:** `commit` burns the stake, so claim and void refunds must re-mint it. Arena needs the **minter** role, which Task 4's setUp does not grant. The deploy test must assert that Arena is a minter and a spender before `lockRoles()`, and that `registry.points() == arena.points()`.
- **Task 10 relay:** anyone can front-run a reveal with identical data. The relay must treat an `AlreadyRevealed` revert as success, with no retry and no alert. A reveal costs up to about 349k gas (9 cold histogram slots plus the path), and the keeper pays it for every human.
- **Tasks 11 and 13:** the client must run `isValid` before `commit`. A committed invalid path can never be revealed, so its stake is burned.
- **Task 8 deploy:** grant the roles to Registry, Arena and GapMarket, then call `Points.lockRoles()`. A deploy test must assert `rolesLocked()` and the exact role set. Until the lock, the owner can grant itself minter or spender and mint or burn anyone's points. The one-way lock plus the set-once `Registry.setArena` means any Arena redeploy forces a Points and Registry redeploy.
- **Spec-level sybil gap (escalated to orchestrator, not an implementer bug):** `registerAgent` is ungated and nets +900 points per fresh address, so an attacker can buy agent-side quorum, the median and pool share for gas alone. Check what Tasks 4, 7 and 19 do about it.
- **`house` label is self-declared metadata, so anyone can spoof it.** Tasks 12 and 17 (the app) must identify house agents by a known address list, not by `metadataURI`.

## Forward risks from Task 5 (2026-11-24)
- **Task 6:** `_freezeAll` has no `knownRound` (unknown id: revealEnd 0 passes, emits 2 `KindAbsent`, writes nothing), so `postCandles` must guard the id itself. Read consensus only through `_consensusPath` (0 is a valid frozen value; only the mask tells). Worst-case `freezeAll` costs about 2.53M gas (both kinds, every walk to bucket 200), so `postCandles` plus scoring needs a keeper gas limit well above that.
- **Task 7 and app:** `consensus()` returns a partial path with `ready == false` (unfrozen fields read 0 and the repair fires on them). `bet` and the UI must gate on `ready` for both sides.
- **Indexers (Tasks 10, 12):** `KindAbsent` repeats on every `freezeAll` call, so dedupe it. An off-chain median must copy `bucketValue` saturation (int32.min is reachable at max T; int32.max is not reachable from reveals).
- Verified by proof: the repair never fires on a fully frozen path from valid reveals (pointwise domination plus monotone `bucketIndex` and `bucketValue`). The fuzz oracle compares the repaired path with the raw medians.

## Review method that worked (Task 2)
- Copy `contracts/` (and `shared/`) to `%TEMP%`.
- Run sed mutants with `forge test --no-match-test <snapshot test>` (hand tests) and with `--match-test` (snapshot), separately.
- For TS, junction the repo `node_modules` into scratch (`MSYS_NO_PATHCONV=1 cmd /c mklink /J ...`) and run vitest there; use `-t` to select hand tests only.
- Remove the junction with `cmd /c rmdir`, NEVER `rm -rf`, which would follow the link into the repo's node_modules. The repo stays untouched.

Related: [[review-protocol]]
