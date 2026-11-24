# Consensus Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Base Sepolia mini app where humans and AI agents commit 3-candle paths for a tokenized stock, two consensus paths are computed on-chain, and a parimutuel pool bets on which consensus scores closer.

**Architecture:** Five Solidity contracts (`ScoreLib`, `Points`, `Registry`, `Arena`, `GapMarket`) hold all rules. A TypeScript keeper opens rounds and posts real candles. A TypeScript MCP server/SDK plus three house agents act as the agent side. A Next.js mini app is the human side. The contract ABIs in `shared/abi/` are the only integration surface between domains.

**Tech Stack:** Solidity ^0.8.24 + Foundry; TypeScript + viem + vitest; MCP TypeScript SDK; Next.js + wagmi + lightweight-charts + Playwright; Base Sepolia.

**Spec:** `README.md` (sections referenced as "README §N").

## Global Constraints

- Network: Base Sepolia only. Points only: no real money, no token launch.
- Units: every path and real candle is **int32 basis points relative to P0**; `open_1 := P0 (0 bp)`, `open_i = close_(i-1)`. Index of a path field = `candle*3 + {0:close, 1:high, 2:low}`.
- Valid path: for each candle `low <= min(open, close)` and `high >= max(open, close)`.
- Score (integer, pinned operation order). Per candle, with all differences taken in `int256`: `C = 10000 - min(10000, |dc|*10000/T)`, `R = 10000 - min(10000, (|dh|+|dl|)*10000/(2*T))`, `D = 10000` if `sign(close-open)` is equal (both flat counts), `5000` if exactly one is flat, else `0`. Per candle `s = 5*C + 2*R + 3*D` (no division). Final `score = floor(sum(s) * 100 / 300000)`, integer 0..100. Every division is floor division of a non-negative number. Cast to `int256` before any subtraction or `abs`. TypeScript uses `bigint` only; no float ever enters the scoring path.
- Histogram: 201 buckets per field, `width = max(1, ceil(T/10))` bp, bucket index = `clamp(100 + floorDiv(v, width), 0, 200)` where `floorDiv` rounds toward negative infinity (Solidity `/` truncates toward zero, so floor explicitly; e.g. `floorDiv(-15, 2) = -8`), bucket `i` represents `(i-100)*width` bp. Median = lowest bucket whose cumulative count >= ceil(n/2).
- Quorum: market opens only if each side has >= 3 reveals. Equal integer consensus scores = tie = refund.
- Points economy: `STARTER_GRANT = 1000`, `AGENT_BOND = 100`. Forfeited stakes of unrevealed entries are **burned** (lazy scoring cannot know the total needed for a pro-rata pot). Claim reward = `(score - baselineScore) * REWARD_PER_POINT` when score > baseline, else 0.
- Timing: `settleDeadline > marketEnd + 3*candleSec`; `postCandles` is allowed only at or after `marketEnd + 3*candleSec`.
- Scoring exists in two implementations only: `ScoreLib.sol` and `shared/score.ts` (integer math, same operation order), tied by a vector-parity test. No other copy.
- Commit hash: `keccak256(abi.encode(path, salt, who))` where `who` is the committing address (`msg.sender` at `commit`); `reveal` may be sent by anyone for `who` (D1).
- Hackathon rules (verified 2026-11-20): submission = a public X post with a video demo (e.g. Loom) tagging @buildonbase, plus the Submission Form, by 11:59 PM UTC on 5 Dec 2026; testnet is allowed and not judged less favorably; one submission per track; projects that enable trading for US users are not eligible, so the app shows a US-user notice and the submission states points-only testnet; never claim rights in an underlying company or imply endorsement by Base, a partner, or an issuer.
- Testnet keys never committed (`.env` ignored). Human gate is a swappable `IHumanGate`; the MVP uses an allowlist. House agents are labeled `house` and never presented as organic users.
- Code, comments and docs in English. Commit after every task on `main`.

## Review Focus

Failure modes the spec implies that no happy-path test covers. Each has a pinning test in the owning task.

1. **A human misses the reveal window** and loses the stake: delegated reveal through the keeper relay (D1) with the salt also persisted locally as a fallback (Tasks 4, 10, 11, 13).
2. **A brand-new user has 0 points** and cannot commit: registration grants `STARTER_GRANT` (Task 3).
3. **Invalid, tampered, late or double actions:** `high < close`, wrong salt, another address's commit, second commit, reveal outside the window all revert (Task 4).
4. **A side is missing:** fewer than 3 reveals, one side with 0 reveals, or a one-sided pool cancels the market with full refunds, and `postCandles` still succeeds so everyone is scored (Tasks 5, 6, 7).
5. **Keeper no-show or degenerate numbers:** no candles by `settleDeadline` lets anyone void and withdraw; `T = 0` is rejected; flat real candles and `T = 1` never divide by zero or break the bucket width (Tasks 2, 4, 6).

## Orchestration (how this plan is executed)

The main session is the **orchestrator**. It reads this plan, dispatches one domain agent per task, and never edits outside what a task lists.

| Agent (`.claude/agents/`) | Owns | Model |
|---|---|---|
| `contracts-dev` | `contracts/` | sonnet |
| `keeper-dev` | `keeper/` | sonnet |
| `agents-dev` | `agents/` | sonnet |
| `app-dev` | `app/` | sonnet |
| `reviewer` (perfectionist gate) | writes nothing; reviews every task's diff (see Reviewer protocol) | opus, `effort: xhigh`, `memory: project` |

Existing global agents `search`, `grep`, `docs` (Haiku) are used for exploration and API lookups.

Rules for the orchestrator (written to the project `CLAUDE.md` in Task 1):
1. One task at a time per domain; tasks in different domains run in parallel when their dependencies are done.
2. A domain agent may touch only the paths its task lists. Cross-domain needs go through `shared/abi/*.json` and `shared/addresses.json`.
3. Consult the advisor before locking the approach of any contract task, after the same failure twice, and before declaring a task or the project done.
4. A task is complete only after its verification command was run and its output read, **and** `reviewer` returned APPROVE under the Reviewer protocol. No dependent task starts, and nothing is committed as "done", before that.
5. **Implementers never run `git commit`.** Every "Commit" step in a task is executed by the orchestrator after APPROVE. The user approved pushing to `origin/main`; never force-push. The reviewer gets `git diff --cached` of the task's staged paths.
6. The orchestrator, not a domain agent, owns repo-root files (`package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitmodules`, `.gitignore`, `.gitattributes`). A task that needs one (for example `forge install` writing `.gitmodules`) says so, and the dispatch grants it explicitly.
7. Toolchain: every Bash call using `forge`/`cast`/`anvil` starts with `export PATH="$HOME/.foundry/bin:$PATH"` (not on the permanent PATH).

## Reviewer protocol (Opus, perfectionist)

The implementers are Sonnet; the reviewer is a different, stronger model with a fresh context, so it does not share their blind spots.

**Independence.** The orchestrator gives the reviewer only: the task text from this plan, the Global Constraints, the diff (`git diff` of the task), and the raw output of the verification commands. It does **not** pass the implementer's summary or claims. The reviewer reads the code itself.

**Tools.** Read, Grep, Glob, plus Bash for verification only: `forge build/test/coverage/fmt`, `slither` (if installed), `pnpm vitest/tsc/lint`. It never edits files. After every review the orchestrator runs `git status` and rejects the review if the working tree changed.

**Stance.** Assume the code is wrong until shown otherwise. For each finding the reviewer must give: severity (`blocker` breaks funds/rules/spec, `major` wrong behavior or missing test, `minor` style), `file:line`, a **concrete failing scenario** (exact input -> wrong output), and the test that would catch it. A finding without a scenario is dropped, which keeps noise down without lowering the bar. Suspected blockers are re-checked once with `fp-check` before they are reported.

**Checks every review (all tasks):**
1. Spec conformance: each Global Constraint and each line of the task's Interfaces block is met exactly (names, types, units, rounding, window boundaries).
2. Test quality: for every new test ask "would this fail if the bug existed?". Flag tautological tests, missing negative cases, and assertions that only check "does not revert".
3. Review Focus: every Review Focus line owned by the task has a test that pins it.
4. Scope: only the paths the task lists were touched; no secrets, no `.env`, no leftover debug code.

**Extra for contracts (Tasks 2-8):** access control on every state-changing function; reentrancy and CEI order; `int32`/`uint` casts, overflow and truncation (including `abs` of `int32.min`); off-by-one on every time boundary (`==` at `commitEnd`, `revealEnd`, `marketEnd`); state-machine ordering and double-action; DoS by loop or griefing (any path where one user can block others); front-running of commit/reveal; accounting invariants (total claims <= total pool, no stranded or double-spent points); event completeness; gas of the O(1) settlement claim. Required numbers: `forge test` all green, fuzz runs >= 10,000 (`[fuzz] runs = 10000`), line coverage >= 95% per contract and 100% for `ScoreLib`, `forge fmt --check` clean, no new `slither` high/medium findings. Use the installed `solidity-auditor`, `sharp-edges` and `differential-review` skills when available.

**Extra for keeper/agents:** private-key handling, salt persisted before any transaction, behavior on RPC failure and restarts, retries that could double-send, and every transaction path being idempotent. **For the app:** untrusted chain data is never trusted for layout or math, units are bps end to end, and no float in the scoring path.

**Verdict.** The reviewer ends with exactly one of `APPROVE` or `CHANGES REQUIRED`. `APPROVE` is only allowed with zero open blockers and zero open majors. After fixes the same reviewer re-reviews the new diff. After 3 rounds without APPROVE the orchestrator stops, consults the advisor, and tells the user instead of looping.

**Learning.** With `memory: project` the reviewer records each bug class it found (for example "forgot the boundary at revealEnd") and checks for it first in later tasks.

**Cost note.** Every review runs Opus at high effort and may also call the Opus advisor. That is intentional for this project; the orchestrator batches small tasks into one review only when they touch the same contract.

## File Structure

```
.claude/agents/{contracts-dev,keeper-dev,agents-dev,app-dev,reviewer}.md
CLAUDE.md                          orchestrator rules (project-level)
docs/notes/data-source.md          Task 0 output
contracts/src/{ScoreLib,Points,Registry,Arena,GapMarket}.sol
contracts/src/interfaces/{IHumanGate,IArenaState}.sol
contracts/test/*.t.sol   contracts/script/Deploy.s.sol
shared/abi/*.json   shared/addresses.json   shared/score.ts   shared/score.test.ts   contracts/test/vectors/score.json
package.json   tsconfig.json   vitest.config.ts   (repo root, owned by the orchestrator)
keeper/src/{t,candles,rounds,demo}.ts   keeper/test/*.test.ts
agents/src/{sdk,mcp,salt}.ts   agents/src/house/{momentum,meanReversion,newsLlm}.ts   agents/test/*.test.ts
app/src/...   app/e2e/*.spec.ts
```

---

### Task 0: Verify data source and hackathon facts (spike, no product code)

**Files:** Create `docs/notes/data-source.md`

**Interfaces:** Produces the decision every keeper task uses. **Result (2026-11-20):** the official API has no OHLC and its reference value updates only on a 0.5% deviation or a 24 h heartbeat, so candles come from an external intraday market-data provider behind `interface CandleSource { bars(ticker: string, fromTs: number, toTs: number, intervalSec: number): Promise<Bar[]> }`. The provider is **an open decision for the user**; Tasks 9-10 are blocked until it is chosen. Stocks are referenced by `bytes32 ticker` (no tokenized stock exists on Base Sepolia). Details in `docs/notes/data-source.md`.

- [ ] **Step 1:** Read the Tokenized Stocks API docs (use the `docs` agent). Answer in `docs/notes/data-source.md`: (a) is OHLC history offered, (b) what resolution, (c) how the price behaves outside US hours and on 26-27 Nov, (d) rate limits.
- [ ] **Step 2:** The orchestrator does this itself with Chrome (the page is JS-rendered and the FAQ accordions need clicking; a subagent cannot). Read the FAQ accordions and Official Rules on base.org/stocksmaxxing. Record: submission requirements, whether testnet is accepted, cutoff time and timezone, the 3 partners of the Programmable Stock Markets track.
- [ ] **Step 3:** State the scheduling consequence: if the reference price does not move outside US hours, demo rounds and the video must run during the US session (about 21:30 to 04:00 WIB). Then state the decision. Default if (a) is "no": keeper samples the reference value every 30 s and builds candles itself, close = mean of the last 5 samples.
- [ ] **Step 4:** Commit `docs: record data source and hackathon facts`. Update README §15 to mark what is now verified.

### Task 1: Orchestrator setup

**Files:** Create `CLAUDE.md`, `.claude/agents/{contracts-dev,keeper-dev,agents-dev,app-dev,reviewer}.md`

**Interfaces:** Produces the agent names above. Frontmatter per file: `name`, `description`, `tools`, `model` (`reviewer`: `tools: Read, Grep, Glob, Bash, Skill`, `model: opus`, `effort: xhigh`, `memory: project`, `maxTurns: 40`; others `model: sonnet` with full edit tools).

- [ ] **Step 1:** Write `CLAUDE.md` containing the Orchestration rules above verbatim, the Global Constraints, and "read README.md and this plan first".
- [ ] **Step 2:** Write each agent file. Implementer body = ownership paths, the Global Constraints that apply to its domain, "do not edit outside owned paths", "report changed files and the verification output". `reviewer` body = the full Reviewer protocol section above, verbatim, plus "you never edit files; Bash is for verification commands only".
- [ ] **Step 3:** Verify: after saving, the harness announces five new agent types (as it did for the global agents), or `/agents` lists them. Expected: five project agents visible.
- [ ] **Step 4:** Commit `chore: add orchestrator and domain agents`.

### Task 2: Foundry scaffold + `ScoreLib`

**Files:** Create `contracts/foundry.toml` (with `[fuzz] runs = 10000` and `fs_permissions = [{ access = "read-write", path = "./test/vectors" }]`), `contracts/src/ScoreLib.sol`, `contracts/test/ScoreLib.t.sol`, `contracts/script/GenVectors.s.sol`, `contracts/test/vectors/score.json`, `shared/score.ts`, `shared/score.test.ts`. The dispatch also grants: `forge install foundry-rs/forge-std` (writes `.gitmodules` and `contracts/lib/`). The orchestrator has already created the repo-root `package.json`, `tsconfig.json`, `vitest.config.ts`.

**Interfaces:** Produces
```solidity
struct Candle { int32 close; int32 high; int32 low; }
library ScoreLib {
  function isValid(Candle[3] memory p) internal pure returns (bool);
  function closeTerm(uint256 absDc, uint256 T) internal pure returns (uint256);   // C, 0..10000
  function score(Candle[3] memory pred, Candle[3] memory real, uint32 T) internal pure returns (uint8);
}
```

- [ ] **Step 1: Write failing tests** (`forge test --match-contract ScoreLibTest`):
  - `test_perfectPathScores100`: real `close=[10,20,30] high=[12,22,32] low=[-2,8,18]`, pred identical, `T=20` -> `100`.
  - `test_flatBaselineScores29`: same real, pred all zeros, `T=20` -> `29` (per candle .53/.20/.15, mean .2933, floor).
  - `test_bothFlatDirectionIsMatch`, `test_oneFlatDirectionIsHalf`, `test_oppositeDirectionIsZero`.
  - `test_isValidRejectsHighBelowClose`, `test_isValidRejectsLowAboveOpen`.
  - `testFuzz_scoreNeverExceeds100`, `testFuzz_closeTermIsMonotone` (a smaller absolute close error never lowers `closeTerm`). The total score is deliberately **not** asserted monotone in a single close: `open_(i+1) = close_i`, so moving one close can flip the next candle's direction and lower the total (counterexample with T=100: real closes 10, 12; pred closes 0, 5 with h1=8 l1=0 h2=8 l2=5; moving pred c1 from 0 to 8 raises candle 1 but flips candle 2's direction).
  - `test_TZeroReverts`.
- [ ] **Step 2:** Run; expected FAIL (library missing).
- [ ] **Step 3:** Implement exactly the pinned formula in Global Constraints (`C`, `R`, `D` in 0..10000, `s = 5C + 2R + 3D`, `score = floor(sum(s)*100/300000)`), casting to `int256` before any subtraction or `abs`. Check against the two vectors above: perfect = 100 (per-candle s = 100000), flat baseline = 29 (s = 53000, 20000, 15000; sum 88000).
- [ ] **Step 4:** Run; expected all PASS.
- [ ] **Step 5: Shared TypeScript scoring.** `GenVectors.s.sol` writes `contracts/test/vectors/score.json` (at least 20 pred/real/T cases including negative values and flat candles, each with the Solidity result). `shared/score.ts` exports `isValid(p: Candle[3]): boolean` and `score(pred: Candle[3], real: Candle[3], T: number): number` using `bigint` only, in the same operation order as `ScoreLib`. `shared/score.test.ts` reads `../contracts/test/vectors/score.json` and asserts parity for every vector. Run `pnpm vitest run shared`; expected PASS.
- [ ] **Step 6:** Commit `feat: ScoreLib and shared TypeScript scoring with parity vectors`.

### Task 3: `Points` and `Registry`

**Files:** Create `contracts/src/{Points,Registry}.sol`, `contracts/src/interfaces/{IHumanGate,IArenaState}.sol`, `contracts/test/{Points,Registry}.t.sol`

**Interfaces:** Consumes nothing. Produces
```solidity
interface IHumanGate { function isHuman(address) external view returns (bool); }
interface IArenaState { function anyCommitWindowOpen() external view returns (bool); }
enum Kind { None, Human, Agent }
// Points: non-transferable
function mint(address to, uint256 amt) external;          // minters only
function spend(address from, uint256 amt) external;       // spenders only (Arena, GapMarket, Registry)
function balanceOf(address) external view returns (uint256);
// Registry
function registerHuman() external;                         // reverts if !gate.isHuman(msg.sender); mints STARTER_GRANT
function registerAgent(string calldata metadataURI) external; // mints STARTER_GRANT, then takes AGENT_BOND points
function kindOf(address) external view returns (Kind);
function reclassify(address who, Kind k) external;         // owner only, reverts while arena.anyCommitWindowOpen()
```

- [ ] **Step 1: Write failing tests:** `test_pointsNotTransferable`, `test_onlyMinterMints`, `test_registerHumanRequiresGate`, `test_registerGrantsStarterPoints`, `test_registerAgentTakesBondAndStoresURI`, `test_cannotRegisterTwice`, `test_reclassifyBlockedDuringCommitWindow`, `test_reclassifyEmitsEvent`.
- [ ] **Step 2:** Run; expected FAIL.
- [ ] **Step 3:** Implement. `AllowlistGate` (owner-managed) ships as the default `IHumanGate`.
- [ ] **Step 4:** Run; expected PASS. **Step 5:** Commit `feat(contracts): Points and Registry`.

### Task 4: `Arena` open, commit, reveal

**Files:** Create `contracts/src/Arena.sol`, `contracts/test/ArenaCommitReveal.t.sol`

**Interfaces:** Consumes `ScoreLib`, `Registry.kindOf`, `Points.spend`. Produces
```solidity
struct RoundParams { bytes32 ticker; uint256 p0; uint32 T; uint64 commitEnd; uint64 revealEnd;
                     uint64 marketEnd; uint32 candleSec; uint64 settleDeadline; uint256 entryStake; }
function openRound(RoundParams calldata p) external returns (uint256 id);   // keeper only; T>0; times strictly increasing; settleDeadline > marketEnd + 3*candleSec
function hashPath(Candle[3] memory path, bytes32 salt, address who) public pure returns (bytes32);
function commit(uint256 id, bytes32 h) external;     // registered users only, one per address, takes entryStake
function reveal(uint256 id, address who, Candle[3] calldata path, bytes32 salt) external; // callable by anyone; hash is checked against `who` (D1)
function revealCount(uint256 id, Kind k) external view returns (uint256);
function bucketWidth(uint256 id) external view returns (uint32);
```
`bucketWidth = max(1, ceil(T/10))`, set at open and immutable.

- [ ] **Step 1: Write failing tests:** `test_openRoundStoresParamsAndWidth` (T=15 -> width 2; T=1 -> width 1), `test_openRoundRejectsTZero`, `test_openRoundRejectsDeadlineBeforeCandlesEnd`, `test_commitTakesStakeOnce`, `test_secondCommitReverts`, `test_commitAfterCommitEndReverts`, `test_revealWrongSaltReverts`, `test_revealWithWrongWhoReverts`, `test_anyoneCanRevealForAnotherAddress`, `test_revealWithAnotherAddressesSaltReverts`, `test_revealInvalidPathReverts`, `test_revealOutsideWindowReverts`, `test_revealIncrementsCountByKind`, `test_histogramClampsOutOfRange`, `test_negativeValueUsesFloorDivision` (v = -15, width 2 lands in bucket 92, not 93).
- [ ] **Step 2:** Run; expected FAIL. **Step 3:** Implement; per-kind per-field `uint32[201]` histograms updated in `reveal` (9 increments). **Step 4:** Run; PASS. **Step 5:** Commit `feat(contracts): Arena open/commit/reveal`.

### Task 5: `Arena` consensus

**Files:** Modify `contracts/src/Arena.sol`; Create `contracts/test/ArenaConsensus.t.sol`

**Interfaces:** Consumes Task 4 state. Produces
```solidity
function freezeConsensus(uint256 id, Kind k, uint8 field) external;   // permissionless, after revealEnd, field 0..8
function freezeAll(uint256 id) external;   // freezes all 9 fields of both kinds in one call; a kind with 0 reveals is marked absent
function consensus(uint256 id, Kind k) external view returns (Candle[3] memory path, bool ready);
```
`ready` is true once all 9 fields of that kind are frozen, and false for an absent kind (0 reveals); the path is repaired with `high = max(high, open, close)`, `low = min(low, open, close)`.

- [ ] **Step 1: Write failing tests:** `test_medianOfOddCount` (reveals with field-0 closes 10,30,20 and width 1 -> 20), `test_medianOfEvenCountTakesLower`, `test_freezeBeforeRevealEndReverts`, `test_freezeTwiceReverts`, `test_consensusNotReadyUntilAllNineFields`, `test_repairKeepsHighAboveCloseAndLowBelow`, `test_freezeAllWithZeroRevealsMarksSideAbsent`, `test_freezeAllFreezesBothKinds`.
- [ ] **Step 2:** Run; FAIL. **Step 3:** Implement bucket walk. **Step 4:** Run; PASS. **Step 5:** Commit `feat(contracts): histogram median consensus`.

### Task 6: `Arena` settle, claim, void

**Files:** Modify `contracts/src/Arena.sol`; Create `contracts/test/ArenaSettle.t.sol`

**Interfaces:** Produces
```solidity
function postCandles(uint256 id, Candle[3] calldata real, bytes32 sourceHash) external; // keeper only, once, at or after marketEnd + 3*candleSec; succeeds even if a side is absent
function consensusScores(uint256 id) external view returns (uint8 human, uint8 agent, bool humanPresent, bool agentPresent);
function baselineScore(uint256 id) external view returns (uint8);  // flat path scored against the real candles
function claim(uint256 id) external;        // returns stake if revealed; mints (score - baselineScore) * REWARD_PER_POINT points if score > baseline
function voidRound(uint256 id) external;    // anyone, after settleDeadline if no candles
function isVoid(uint256 id) external view returns (bool);
function settled(uint256 id) external view returns (bool);
```
Forfeited stakes of unrevealed commits are burned.

- [ ] **Step 1: Write failing tests:** `test_postCandlesOnceOnly`, `test_postCandlesBeforeCandlesEndReverts`, `test_postCandlesSucceedsWithEmptySide`, `test_consensusScoresStored`, `test_baselineScoreStored`, `test_claimReturnsStakeForRevealed`, `test_unrevealedStakeIsBurned`, `test_rewardMintedOnlyAboveBaseline`, `test_voidAfterDeadlineRefundsAllStakes`, `test_voidBeforeDeadlineReverts`, `test_claimTwiceReverts`.
- [ ] **Step 2:** Run; FAIL. **Step 3:** Implement; scores computed lazily at `claim`, consensus scores at `postCandles`. **Step 4:** Run; PASS. **Step 5:** Commit `feat(contracts): Arena settlement, claim and void`.

### Task 7: `GapMarket`

**Files:** Create `contracts/src/GapMarket.sol`, `contracts/test/GapMarket.t.sol`

**Interfaces:** Consumes `Arena.revealCount`, `consensusScores`, `settled`, `isVoid`, `marketEnd`. Produces
```solidity
enum Side { Human, Agent }
function bet(uint256 id, Side s, uint256 amt) external;   // between revealEnd and marketEnd, requires consensus ready
function status(uint256 id) external view returns (uint8); // 0 open,1 cancelled,2 resolved,3 tie
function claim(uint256 id) external;
```
Cancelled when either side has < 3 reveals, when the round is void, when only one side has bets, or on a tie: everyone gets the stake back.

- [ ] **Step 1: Write failing tests:** `test_betOutsideWindowReverts`, `test_cancelledWhenSideBelowQuorum`, `test_oneSidedPoolRefunds`, `test_humanWinPaysProRata` (A bets 100 on Human, B bets 50 on Agent, Human wins -> A claims 150), `test_tieRefunds`, `test_voidRoundRefunds`, `test_claimTwiceReverts`, `testInvariant_totalClaimsNeverExceedPool`.
- [ ] **Step 2:** Run; FAIL. **Step 3:** Implement. **Step 4:** Run; PASS. **Step 5:** Commit `feat(contracts): GapMarket parimutuel pool`.

### Task 8: Deploy and export

**Files:** Create `contracts/script/Deploy.s.sol`, `shared/abi/*.json`, `shared/addresses.json`

**Interfaces:** Produces the ABI and address files all other domains import.

- [ ] **Step 1:** Run `forge test` on the whole suite; expected all PASS.
- [ ] **Step 2:** Deploy to Base Sepolia with `forge script ... --broadcast` using a testnet key from `.env` (never committed). Expected: addresses printed.
- [ ] **Step 3:** Write ABIs and `addresses.json` by script (`contracts/script/export-abi.sh`). Verify the contracts on the block explorer.
- [ ] **Step 4:** Commit `chore: deploy to Base Sepolia and export ABIs`.

### Task 9: Keeper core (`T`, candles, rounds)

**Files:** Create `keeper/src/{t,candles,rounds}.ts`, `keeper/test/{t,candles}.test.ts`

**Interfaces:** Consumes `shared/abi`, Task 0 decision, `shared/score.ts` (`isValid`). Produces
```ts
export function computeT(closes: number[]): number;           // median abs close-to-close move in bp, x1.5, ceil, min 1
export function toBps(price: number, p0: number): number;     // round((price-p0)/p0*10000)
export function buildCandles(samples: {t:number; p:number}[], startTs: number, intervalSec: number): Candle[3];
export async function openRound(cfg: RoundConfig): Promise<bigint>;
export async function postCandles(id: bigint, real: Candle[3], sourceUrl: string): Promise<void>;
```

- [ ] **Step 1: Write failing tests (vitest):** `computeT([100,100.10,100.05,100.20]) === 15`, `computeT(flatSeries) === 1`, `toBps(100.10,100) === 10`, `buildCandles` closes = mean of last 5 samples of each interval, high/low from the samples, `real` passes the on-chain validity rule.
- [ ] **Step 2:** `pnpm vitest run keeper`; FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(keeper): T, candle builder, round calls`.

### Task 10: Keeper automation and demo rounds

**Files:** Create `keeper/src/{loop,demo}.ts`, `keeper/test/loop.e2e.ts`

**Interfaces:** Consumes Task 9. Produces `startLoop(cfg)`, which also calls `freezeAll(id)` right after `revealEnd`, and a relay endpoint `POST /reveal {id, who, path, salt}` that checks `isValid` and the commit hash before sending `reveal(id, who, path, salt)`; `demo` runs a 5-minute-candle round with windows commit 90 s, reveal 30 s, market 60 s (README §3). Voiding a round is permissionless and not the keeper's job; the keeper only logs a missed `settleDeadline`.

- [ ] **Step 1:** Write `loop.e2e.ts` against local Anvil: a full round opens, 3 humans and 3 agents (quorum) commit and reveal, `freezeAll` runs, a bet is placed, candles post, `GapMarket` resolves. Expected assertions: `settled(id) === true` and `GapMarket.status(id) === 2`.
- [ ] **Step 2:** Run; FAIL. **Step 3:** Implement the scheduler. **Step 4:** Run; PASS. **Step 5:** Commit `feat(keeper): round loop and demo mode`.

### Task 11: Agent SDK and MCP server

**Files:** Create `agents/src/{salt,sdk,mcp}.ts`, `agents/test/{salt,sdk}.test.ts`

**Interfaces:** Consumes `shared/abi` and `shared/score.ts` (`isValid`). Produces
```ts
export async function submitPath(id: bigint, path: Candle[3]): Promise<void>; // persists salt BEFORE commit tx, schedules reveal
export async function reveal(id: bigint): Promise<void>;                      // manual, uses persisted salt
export function hashPath(path: Candle[3], salt: Hex, who: Address): Hex;      // must equal Arena.hashPath
```
MCP tools: `list_rounds`, `get_round`, `get_consensus`, `submit_path`, `get_my_results` (README §7).

- [ ] **Step 1: Write failing tests:** `salt is written to disk before the commit transaction is sent`, `hashPath matches Arena.hashPath on Anvil for a fixed vector`, `reveal after a process restart uses the persisted salt`, `submitPath rejects an invalid path before sending any transaction`.
- [ ] **Step 2:** Run; FAIL. **Step 3:** Implement SDK then MCP wrappers. **Step 4:** PASS. **Step 5:** Commit `feat(agents): SDK and MCP server`.

### Task 12: House agents

**Files:** Create `agents/src/house/{momentum,meanReversion,newsLlm}.ts`, `agents/test/house.test.ts`

**Interfaces:** Consumes Task 11. Produces `predict(ctx: RoundContext): Promise<Candle[3]>` per agent; each registers with metadata `{"role":"house"}`.

- [ ] **Step 1: Write failing tests:** `momentum output always passes isValid` (property test over random histories), `meanReversion output passes isValid`, `newsLlm falls back to rule-based when the API throws`, `newsLlm clamps out-of-range model output`.
- [ ] **Step 2:** Run; FAIL. **Step 3:** Implement; the LLM agent calls the Claude API (`claude-sonnet-5-5`) with the key from `.env`. **Step 4:** PASS. **Step 5:** Commit `feat(agents): three house agents`.

### Task 13: App scaffold, wallet, Today's Round (screen 1)

**Files:** Create `app/` (Next.js), `app/src/lib/{chain,round}.ts`, `app/src/app/page.tsx`

**Interfaces:** Consumes `shared/abi`, `shared/addresses.json`. Produces `useRound(id)` returning `{params, phase: 'commit'|'reveal'|'market'|'play'|'settled'|'void', countdownSec}`.

- [ ] **Step 1:** Write failing vitest for `phaseAt(params, now)` covering each boundary. **Step 2:** FAIL. **Step 3:** Implement `phaseAt`, wallet connect with Smart Wallet, screen 1 with the phase tracker. **Step 4:** PASS. **Step 5:** Commit `feat(app): scaffold, wallet, round screen`.

### Task 14: Draw screen (screen 2)

**Files:** Create `app/src/lib/path.ts`, `app/src/components/DrawChart.tsx`, `app/src/lib/path.test.ts`

**Interfaces:** Consumes `isValid` and `score` from `shared/score.ts` (also used for the live score in Task 15). Produces `handlesToPath(h: Handle[9]): Candle[3]` and `clampHandle(h, index, ctx): number` enforcing the validity rule.

- [ ] **Step 1: Write failing tests:** `dragging a high below the close clamps to the close`, `handlesToPath output always passes isValid` (property test), `flat baseline path is all zeros`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement the pure functions, then the chart with draggable handles and the faint baseline. **Step 4:** PASS. **Step 5:** Commit `feat(app): draw screen with valid-by-construction handles`.

### Task 15: Market and Reveal (screens 3, 4)

**Files:** Create `app/src/components/{MarketPanel,RevealPlayer}.tsx`, `app/src/lib/odds.ts`, `app/src/lib/odds.test.ts`

**Interfaces:** Produces `impliedOdds(humanPool: bigint, agentPool: bigint): {human: number; agent: number}` (0 pools -> 0.5/0.5).

- [ ] **Step 1: Write failing tests:** `odds with equal pools are 0.5/0.5`, `odds with empty pools do not divide by zero`, `RevealPlayer shows candle n only after n steps`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement overlay of both consensus paths, bet form, animated reveal with live score. **Step 4:** PASS. **Step 5:** Commit `feat(app): market panel and reveal player`.

### Task 16: Result and share card (screen 5)

**Files:** Create `app/src/components/ResultCard.tsx`, `app/src/app/api/card/route.ts`, `app/src/lib/near.ts`

**Interfaces:** Produces `nearMissLine(myScore: number, opponentScore: number): string`.

- [ ] **Step 1: Write failing tests:** `nearMissLine(87, 90) === "87, 3 short of beating the Agent"`, `nearMissLine(95, 90)` returns a win line, and the card route returns a PNG with status 200.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(app): result screen and share card`.

### Task 17: Gap Dashboard and replay (screen 6)

**Files:** Create `app/src/app/dashboard/page.tsx`, `app/src/lib/history.ts`, `app/src/lib/history.test.ts`

**Interfaces:** Produces `loadHistory(fromBlock: bigint): Promise<RoundSummary[]>` and `winRate(rounds): {human: number; agent: number}`. Simulated rows must carry `simulated: true` and render with a visible label.

- [ ] **Step 1: Write failing tests:** `winRate ignores void and tie rounds`, `simulated rows are labeled`, `replay renders the same frames as live reveal for a settled round`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement dashboard, trend chart, leaderboard, replay mode. **Step 4:** PASS. **Step 5:** Commit `feat(app): gap dashboard and replay`.

### Task 18: End-to-end and submission

**Files:** Create `app/e2e/round.spec.ts`

- [ ] **Step 1:** Playwright spec on local Anvil: draw -> commit -> reveal -> market -> settle shows a result. Run `pnpm playwright test`; expected PASS.
- [ ] **Step 2:** Run 1-2 real rounds on Base Sepolia with 3 invited humans; confirm quorum and market resolution.
- [ ] **Step 3:** Record the demo video from replay mode; post on X, fill the form, and submit (README §16). Check the user's approval before any push or post.
- [ ] **Step 4:** Commit `chore: submission build`.

### Task 19: Final audit gate (must pass before Task 18 step 3, the submission)

**Files:** Create `docs/notes/audit.md`

- [ ] **Step 1:** `reviewer` audits all of `contracts/src` as one system, not task by task: `audit-context-building` first, then `solidity-auditor`, then a threat-model pass against README §8 (sybil, selective reveal, keeper abuse, owner reclassification, points inflation). Output goes to `docs/notes/audit.md` with each finding's scenario and status.
- [ ] **Step 2:** Run `forge test` with 50,000 fuzz runs, `forge coverage`, `slither`; paste the output into `docs/notes/audit.md`.
- [ ] **Step 3:** Every blocker and major is fixed by `contracts-dev` with a pinning test, then re-reviewed. Minor findings are listed, not required.
- [ ] **Step 4:** Commit `docs: final audit results`. Expected: `docs/notes/audit.md` ends with "0 open blocker, 0 open major".

## Review follow-ups (open minors carried forward)

- **From Task 2, M1:** `shared/score.ts` `isValid(new Array(3))` and `isValid([z, , z])` throw a `TypeError` instead of returning false, because `Array.prototype.every` skips holes. Fix by checking indices 0..2 explicitly and add `expect(isValid(new Array(3) as unknown as Path)).toBe(false)`. Do it in the first task that edits `shared/score.ts` (Task 9 or 11), before the keeper relay (Task 10) trusts `isValid` on untrusted input.
- **From Task 2, M2:** the comment above the `require-revert-in-loop` suppression in `ScoreLib.sol` says "checked once, before the loop", but the lint actually fires because callers (for example `GenVectors._random`) loop over `score`. Reword it: "callers loop over score; T is constant per call, so this revert cannot be triggered per item."
- **Forward risk for Tasks 4-7:** that suppression sits at the library line, so it also silences the lint for any future `Arena` or `GapMarket` loop that calls `ScoreLib.score`. The reviewer must check revert-in-loop and loop-DoS by hand in those tasks. Prefer calling `score` once per claim (lazy scoring), never inside a loop over participants.

- **From Task 3, M1:** the NatSpec at `Points.sol:7-8` says the owner "never touches funds", which is false until `lockRoles()` runs (the owner can grant itself minter/spender). Reword to "until `lockRoles()`, the owner can grant roles, including to itself". Do it in Task 8 (or any task that edits `Points.sol`).
- **From Task 3, M2 (optional hardening):** `Registry.setArena` is set-once but unchecked; a wrong address (for example `Points`) bricks every `reclassify` and, after `lockRoles()`, forces a full redeploy. Call `arena_.anyCommitWindowOpen()` inside `setArena` and test that a contract without it reverts.
- **Forward requirements for Task 4 (Arena):** store each entry's `Kind` at `commit` and never re-read `kindOf` at reveal, claim or bet (`reclassify` is allowed after `commitEnd`). `anyCommitWindowOpen()` must use the same boundary comparison as `commit` (including `== commitEnd`), cover every live round, and run in O(1).
- **Forward requirement for Task 7:** Points can mint without limit, so `GapMarket` itself must enforce total claims <= pool.
- **Forward requirement for Task 8:** `Deploy.s.sol` grants minter/spender to Registry, Arena and GapMarket, wires `setArena`, and only then calls `lockRoles()`; a deploy test asserts `rolesLocked() == true` and the exact role set. An Arena redeploy after the lock forces redeploying Points and Registry.
- **Forward requirement for Tasks 12 and 17:** the `house` label lives in self-declared `metadataURI`, so the app must identify house agents from a known address list, never from the URI.
- **Open spec issue from Task 3 (needs a user decision before Task 4 locks Arena stake rules): free sybil identities.** `registerAgent` has no gate and the bond is paid from the grant minted in the same call, so every new address nets 900 points for the cost of gas. A factory contract deploying N children gains N x 900 points, enough to reach the 3-reveal quorum, set the agent median and flood the `GapMarket` pool. This weakens README §8 ("bond", "sybil costly"). Options: (a) no starter grant for agents, so the bond must come from points earned or granted by the owner; (b) agent grant minted only after the bond is paid from an external top-up; (c) accept it for the testnet MVP and disclose it; (d) add a cap on bet size per identity. Also relevant to Task 19's threat model.

## Resolved decisions

- **D1 (approved by the user): delegated reveal.** As written, a person must sign a second transaction inside the reveal window (30 s in demo rounds, 15 min in production) or lose the stake. Proposed change: `reveal(id, who, path, salt)` callable by anyone; the hash already binds `who`, so nobody else can build a valid commit for that address. The app sends path and salt to the keeper, which reveals for the user. Trade-off: the keeper sees human paths before the reveal window (it is already a trusted party). Task 4 therefore uses `reveal(id, who, path, salt)`, Task 10 adds a keeper reveal relay, and the app (Task 13) submits path and salt to that relay right after the commit. The SDK still persists the salt locally as a fallback.

## Dependency order

`0 -> 1`; `2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8`; keeper `9 -> 10` and agents `11 -> 12` start after 8; app `13 -> 14 -> 15 -> 16 -> 17` starts after 8 (Task 13 can start after 4 against Anvil); `19` (final audit) after 17; `18` last, and its submission step needs 19 passed. Cut order if late: 17 and replay first, 11-12 last.

## Self-review notes

- Spec coverage: README §3 (Tasks 4-7, 10), §4 (2), §5 (7), §6 (2-8), §7 (11), §8 (3, 12), §9 (0, 9), §10 (13-17), §11 (Global Constraints), §12 (dependency order), §16 (18). Orchestrator ask covered by Orchestration and Task 1.
- Type names (`Candle`, `RoundParams`, `Kind`, `Side`) are used identically across tasks.
