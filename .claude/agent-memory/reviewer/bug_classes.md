---
name: bug-classes
description: Bug classes found in Consensus Path reviews (Solidity + TS) plus reviewer method pitfalls; check these first on every new task diff
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

## Review method that worked (Task 2)
- Copy `contracts/` (and `shared/`) to `%TEMP%`.
- Run sed mutants with `forge test --no-match-test <snapshot test>` (hand tests) and with `--match-test` (snapshot), separately.
- For TS, junction the repo `node_modules` into scratch (`MSYS_NO_PATHCONV=1 cmd /c mklink /J ...`) and run vitest there; use `-t` to select hand tests only.
- Remove the junction with `cmd /c rmdir`, NEVER `rm -rf`, which would follow the link into the repo's node_modules. The repo stays untouched.

Related: [[review-protocol]]
