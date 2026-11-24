---
name: bug-classes
description: Bug classes found in Consensus Path reviews (Solidity + TS), reviewer method pitfalls, and forward risks for later tasks (Kind snapshot, lockRoles, sybil); check first on every diff
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

## Reviewer method pitfalls (my own mistakes)

- **Never test a lint suppression with `forge lint <path>`.** A path argument narrows the lint scope, and some forge lints are interprocedural. `require-revert-in-loop` fires on `ScoreLib.score`'s revert only because `GenVectors._random()` calls the inlined internal function inside a loop. In Task 2 round 1 I wrongly called that suppression dead; the orchestrator disproved it. Always test suppressions with a project-wide `forge lint` (no path) and `forge build --force`.

- **Forward note for Tasks 4-7.** `ScoreLib.sol:45` carries `forge-lint: disable-next-line(require-revert-in-loop)`. Because the warning is reported at the library line, that suppression silences it for every future caller, including any Arena or GapMarket loop over entries. Check revert-in-loop DoS in those loops by hand (one bad entry must not block a batch claim or settle).

- **`forge lint` `missing-events-access-control` fires even when the setter emits an event** (seen on `Points.setMinter/setSpender`, Task 3). Those suppressions are live, not dead. Verified by deleting them in a scratch copy and running a project-wide `forge lint`.
- **sed `\n` in a single-line `s///` silently does nothing.** Detect no-op mutants with `cmp` against the original. Use line-address sed (for example `92{h;d};93{G}` to swap two lines) for reorder mutants.
- **Classify equivalent mutants** (for example `x += 0`) as equivalent in the report, not as survivors or test gaps.

## Forward risks to check in later tasks (from Task 3, 2026-11-24)
- **Task 4 Arena must snapshot `Registry.kindOf` at `commit`.** `reclassify` is blocked only while `anyCommitWindowOpen()`, so it is allowed in the reveal and market windows. If Arena or GapMarket re-reads `kindOf` at reveal, claim or bet, the owner can move a user to the other side mid-round.
- **`anyCommitWindowOpen()` must use the same boundary as `commit`** (if `commit` accepts `== commitEnd`, the view must return true at `commitEnd`). It must cover every live round, not only the latest. It must be O(1), with no loop over rounds.
- **Task 8 deploy:** grant the roles to Registry, Arena and GapMarket, then call `Points.lockRoles()`. A deploy test must assert `rolesLocked()` and the exact role set. Until the lock, the owner can grant itself minter or spender and mint or burn anyone's points. The one-way lock plus the set-once `Registry.setArena` means any Arena redeploy forces a Points and Registry redeploy.
- **Spec-level sybil gap (escalated to orchestrator, not an implementer bug):** `registerAgent` is ungated and nets +900 points per fresh address, so an attacker can buy agent-side quorum, the median and pool share for gas alone. Check what Tasks 4, 7 and 19 do about it.
- **`house` label is self-declared metadata, so anyone can spoof it.** Tasks 12 and 17 (the app) must identify house agents by a known address list, not by `metadataURI`.

## Review method that worked (Task 2)
- Copy `contracts/` (and `shared/`) to `%TEMP%`.
- Run sed mutants with `forge test --no-match-test <snapshot test>` (hand tests) and with `--match-test` (snapshot), separately.
- For TS, junction the repo `node_modules` into scratch (`MSYS_NO_PATHCONV=1 cmd /c mklink /J ...`) and run vitest there; use `-t` to select hand tests only.
- Remove the junction with `cmd /c rmdir`, NEVER `rm -rf`, which would follow the link into the repo's node_modules. The repo stays untouched.

Related: [[review-protocol]]
