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

**Interfaces:** Produces the decision every keeper task uses. **Result (2026-11-20):** the official API has no OHLC and its reference value updates only on a 0.5% deviation or a 24 h heartbeat, so candles come from an external intraday market-data provider behind `interface CandleSource { bars(ticker: string, fromTs: number, toTs: number, intervalSec: number): Promise<Bar[]> }`. The provider is **an open decision for the user**; Task 9 was built against the `CandleSource` interface only (done, commit `91e4c40`), and Task 10 is blocked until the provider is chosen. Stocks are referenced by `bytes32 ticker` (no tokenized stock exists on Base Sepolia). Details in `docs/notes/data-source.md`.

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

### Task 20: Public hosting and invited-user beta (added 2026-11-24)

**Why:** the plan so far only guarantees a demo video and 1-2 real rounds with 3 invited humans (Task 18). For other people to try the app on their own, it needs a public URL and a keeper that keeps running.

**Files:** Create `app/vercel.json` (or the chosen host's config), `keeper/src/server.ts` (process entry), `keeper/Dockerfile` or `keeper/README.md` (run guide), `docs/notes/hosting.md`; extend `contracts/.env.example` and add `keeper/.env.example`.

**Interfaces:** Consumes Task 8 phase B (`shared/addresses.json`), Task 10 (`startLoop`, relay endpoint), Task 13-17 (the app). Produces a public app URL, a long-running keeper (VPS, Fly/Railway-style container, or equivalent) and an allowlist procedure.

- [ ] **Step 1: Host the app** on a public URL (Vercel or equivalent), with env set to the Base Sepolia addresses; mobile-first check on a real phone. The US-user notice and the "points only, testnet" statement are visible on the first screen.
- [ ] **Step 2: Run the keeper as a service** (not on a laptop): `KEEPER_PRIVATE_KEY` as a host secret, restart policy, health check, log of each `openRound`/`postCandles`/`freezeAll`, alert on a missed `settleDeadline`. Real-candle rounds only during the US session (about 21:30 to 04:00 WIB); outside it, run labeled "replay" rounds.
- [ ] **Step 3: Gas decision:** verify paymaster support for Smart Wallet on Base Sepolia against current docs (use the `docs` agent); if unavailable, ship a faucet instruction on the join screen.
- [ ] **Step 4: Invited-user flow:** a documented procedure to add a tester to `AllowlistGate` (owner `setAllowed`), a small script `contracts/script/AllowHumans.s.sol` taking addresses from env, and a join page that explains "ask for access". Open human onboarding (EAS or Coinbase Verifications) stays roadmap.
- [ ] **Step 5:** Smoke test as an invited outsider on a fresh browser profile: connect, play one round end to end, claim. Record the result in `docs/notes/hosting.md`. Commit `chore: public hosting and invited beta`.

**Gate:** needs the user's explicit yes before any deploy that is publicly reachable or any server rental (rule 8). Keys live only in host secrets, never in the repo.

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
- **From Task 4 review (forward requirements):**
  - **Task 5:** `freezeConsensus` must reject `field > 8` (the `histogram`/`getHistogram` views do not validate inputs). Per-round histogram isolation is pinned by `test_roundsAreIsolated`; keep it green when refactoring.
  - **Tasks 6 and 8:** `commit` burns the stake, so `claim` and `voidRound` must mint it back. Arena therefore needs the **minter** role as well as spender: the Task 8 deploy test asserts Arena is minter and spender before `lockRoles()`, and that `registry.points() == arena.points()`. Tasks 6 and 7 read `entry.kind` (the commit-time snapshot), never `registry.kindOf`.
  - **Task 9 (keeper):** timestamps are **seconds**, never `Date.now()` milliseconds. A millisecond `commitEnd` would make `maxCommitEnd` huge forever, so `anyCommitWindowOpen()` stays true and `reclassify` reverts permanently. Add a keeper-side sanity check (`commitEnd - now` below a few days). An on-chain upper bound (for example `commitEnd <= now + 30 days`) is a possible spec change, not yet decided.
  - **Task 10 relay:** a reveal can be front-run with identical data, so the relay treats an `AlreadyRevealed` revert as success (no retry, no alert). A reveal costs up to about 349k gas, paid by the relay for every human.
  - **Tasks 11 and 13:** the client must run `isValid` before `commit`: an invalid committed path can never be revealed and its stake is lost.
- **Task 5 design rulings (advisor-reviewed, 2026-11-24):** a side is present iff `revealCount(id,k) > 0` (never a stored flag, so freezing field by field cannot leave an absent side unmarked); freezing is internal `_freezeAll(id)` with **no upper time bound** (the histogram cannot change after `revealEnd`); the repaired path is built in one internal `_consensusPath(id,k)` used by the `consensus()` view and by Task 6 scoring; `freezeAll` is idempotent and skips frozen fields; frozen state is keyed per round.
- **Task 6 forward requirement:** `postCandles` calls `_freezeAll(id)` itself so consensus scores exist whether or not anyone froze (Review Focus 4), and must succeed with an absent side. `consensusScores` reads presence from `revealCount`, and scores from `_consensusPath`.
- **Contract size watch (Task 5 report, decision before Task 6):** Base deploys enforce 24,576 bytes. If `Arena` is near 20 KB after Task 5, decide the split or the optimizer setting before Task 6 adds settle, claim and void.
- **Task 6 design rulings (advisor-reviewed, 2026-11-24):** see the amended D2 rows. `consensusScores` and `baselineScore` revert `NotSettled` before candles are posted (0 is a legal score, so zeros would be ambiguous). `realCandles(id)` returns the candles and `sourceHash` for the app (Tasks 15 and 17). `postCandles` requires `ScoreLib.isValid(real)`; a reverted call does not use up the one-shot. **`REWARD_PER_POINT = 1` as a public constant (orchestrator ruling; tunable and unverified until playtested, like the bet cap).** `claim` pays the stake back to a revealed entry and `(score - baseline) * REWARD_PER_POINT` when score > baseline; on a void round every committer, revealed or not, gets only the stake back; an unrevealed entry on a settled round reverts (stake already burned). Arena needs the minter role. Accounting invariant to test and fuzz: settled round `totalSupply == supplyBeforeCommits - sum(unrevealed stakes) + sum(rewards)`; void round `totalSupply == supplyBeforeCommits`. Use Task 2 vectors (real closes `[10,20,30]`, T=20: perfect path 100, flat path 29) for known-answer scores.
- **Task 9 forward requirement (keeper, candle widening):** `postCandles` requires `isValid(real)`, so the keeper must widen the candles it builds: candle 1's open is P0 (0 bp), so candle-1 high is `max(sampledHigh, 0)` and low `min(sampledLow, 0)`; each later candle's open is the previous close (a mean of 5 samples that can lie outside the next interval's sampled range), so every candle's high and low must be widened to include its open. Without this `postCandles` reverts whenever price trends and the round voids.
- **Task 8 split (orchestrator, 2026-11-24):** **Phase A** (committed `387fb50`, reviewer APPROVE): `Deploy.s.sol`, `export-abi.sh`, `Deploy.t.sol`, `shared/abi/{Points,Registry,Arena,GapMarket,AllowlistGate}.json`, Points NatSpec fix; no key, no network. Task 9 may start on these ABIs. **Phase B** (needs the user's funded Base Sepolia testnet key in `.env`): broadcast, `shared/addresses.json`, explorer verification, commit `chore: deploy to Base Sepolia and export ABIs`.
- **From Task 9 review (2 rounds, APPROVE; commit `91e4c40`):**
  - **Scope accepted by the orchestrator:** `package.json` and `pnpm-lock.yaml` (viem 2.58.4), `shared/score.ts` and `shared/score.test.ts` (Task 2 M1 fix, now done), and the tests `keeper/test/rounds.{unit,send,anvil}.test.ts`. `postCandles`/`buildCandles` take `Path` (not `Candle[3]`), an optional trailing `deps` argument, and integer-bp samples.
  - **Task 10 forward requirements:** take `startTs`, the ticker and the `toBps` p0 from `getRound(id)` in one code path (the right candles on the wrong id are permanent); `RoundConfig.p0` is a raw on-chain bigint while `toBps` takes a float p0, so document one scale; persist `cfg` before sending (dedup only matches an identical tuple) and run the scheduler single-flight; `POSTED_DIFFERENT` is terminal and must never be retried; an anvil demo needs `--block-time` or periodic `evm_mine` (block time goes stale); at the `settleDeadline` edge a send can revert after a passing dry run (gas only); recover a lost round id from `RoundOpened` logs.
  - **Env names:** the keeper reads `RPC_URL`, `CHAIN_ID`, `ARENA_ADDRESS`, `KEEPER_PRIVATE_KEY` from `process.env` only (no dotenv). The deploy script reads `PRIVATE_KEY`, `KEEPER_ADDRESS`, `BASE_SEPOLIA_RPC_URL` from `contracts/.env`. Phase B must document both, and the keeper key must be a different wallet from the deployer.
  - **Test environment:** `pnpm test` needs `anvil` and `forge` in `~/.foundry/bin` (affects agents-dev and app-dev). `pnpm install --frozen-lockfile` exits 1 with `ERR_PNPM_IGNORED_BUILDS esbuild@0.21.5`; fix with `pnpm.onlyBuiltDependencies` in `package.json` (or `pnpm approve-builds`) so a fresh clone installs cleanly. Not fixed yet.
  - **ABI:** `Arena.json` lists the error `ZeroT` twice (harmless, noted for Task 13 consumers).
- **From Task 8 phase A review (forward requirements for Phase B):**
  - **Keeper:** `Arena.setKeeper` is owner-only, set-once, rejects address 0 and is not covered by `lockRoles()`. `Deploy.run()` reads `KEEPER_ADDRESS` (default 0, which skips `setKeeper` and logs a warning). Until a keeper is set, `openRound` and `postCandles` revert `NotKeeper`. A wrong keeper address is permanent. Decide and pass the keeper address before broadcasting.
  - **RPC alias (minor):** the usage line in `Deploy.s.sol:14` says `--rpc-url base_sepolia`, but `foundry.toml` has no `[rpc_endpoints]`. In Phase B either add `base_sepolia = "${BASE_SEPOLIA_RPC_URL}"` to `foundry.toml` (grant that path) or change the doc line to `--rpc-url $BASE_SEPOLIA_RPC_URL`. Run the documented command once as written.
  - **`run()` test (minor, optional):** `DeployTest` calls `deploy()` only, so the mutant `owner = msg.sender` in `run()` survives it; the key-only simulation catches it (`NotOwner()` at `setArena`). Optional test: `vm.setEnv("PRIVATE_KEY", ...)`, call `run()`, assert `points.owner() == vm.addr(pk)`.
  - **Addresses:** `broadcast/` is gitignored. Write `shared/addresses.json` from `broadcast/Deploy.s.sol/84532/run-latest.json` and check the chain id and addresses against what was broadcast. Pass `--chain-id 84532` explicitly in the simulation too.
  - **Line endings:** git warns about LF to CRLF on `shared/abi/*.json` (`* text=auto`). Consider `*.json text eol=lf` in `.gitattributes`.
- **From Task 7 review (forward requirements and gate lesson):**
  - **Gate lesson (orchestrator):** the "no new high/medium slither findings" gate is checked on the **impact field** of every result (`slither . --filter-paths "lib|test|script" --json -`), not by reading detector names. `unused-return` is Medium and was missed once. `forge-lint` disable comments do not silence Slither; use `// slither-disable-start/end <detector>`.
  - **Task 8:** `GapMarket` needs both minter and spender on Points before `lockRoles()`, or every claim reverts permanently. The deploy test asserts the exact role set for Registry, Arena and GapMarket, and also asserts `market.points() == arena.points()`.
  - **Task 19 / any Points change:** `GapMarket.claim` sets `_claimed` before `points.mint`. That order is safe today only because Points has no hooks or callbacks; keep it if Points ever gains callbacks.
  - **Task 15 and indexers:** `Claimed` carries no refund-versus-win flag and status changes emit no event; read `status()`.
  - **Task 19 threat model:** a keeper that has bet can withhold `postCandles`, so the round voids and the stake returns (no loss for the keeper); price drift from P0 up to `marketEnd` counts toward candle 1 and is visible to late bettors; sybils are capped (200 per address) but not prevented.
- **From Task 6 review (forward requirements):**
  - **Task 7, indexers and app:** a derived void (deadline passed, nothing posted) emits no event. Read `isVoid()`, never the `voided` flag or `RoundVoided`. A `Claimed` event on a void round reports score 0, so the app checks `isVoid` before showing a score.
  - **Task 9 (keeper):** gas limit at least 3.5M for `postCandles` (worst case about 2.7M); dry-run each post with `eth_call`; treat `AlreadyPosted` as final and never re-post with different data. A wrong but valid `real`, or the right candles on the wrong id, is permanent (one-shot spec, keeper trust model).
  - **Indexers (Tasks 10, 12, 17):** `CandlesPosted` omits the real candles; call `realCandles(id)` per round.
  - **Task 19 threat model (spec-level):** a revealed entry can never lose points (stake back plus `max(0, score - baseline)`), so every identity has a free shot at rewards; combined with free sybils (D3) an attacker can mint rewards for gas alone. List it as "accepted for the testnet MVP, disclosed", and consider whether the per-address bet cap (D3) is enough to keep this from distorting `GapMarket`.
- **From Task 5 review (forward requirements):**
  - **Standing test requirement for Tasks 6 and 7 (the second time this bug class appeared):** every function that reads per-round state needs a test with two live rounds that differ in reveal counts, kinds present, and freeze order (older round frozen after the newer one). Equal counts or a superset in round 2 hide `roundCount` and wrong-key bugs.
  - **Task 6:** `postCandles` must guard the round id (`knownRound`) before calling `_freezeAll` (`_freezeAll` itself has no round check); it reads consensus only through `_consensusPath` (0 is a valid frozen value, so only the mask says "ready"); its gas includes the roughly 2.53M-gas `_freezeAll`, so the keeper gas limit must allow for it.
  - **Task 7 and the app:** gate on `consensus().ready`, because the repair fires on partial paths. An off-chain median in the app must copy the `bucketValue` saturation.
  - **Tasks 10 and 12 (indexers):** `KindAbsent` is emitted on every `freezeAll` call for a zero-reveal kind; dedupe it.
  - **Ruling R1 (orchestrator):** the stateless repeating `KindAbsent` is accepted. **R2:** `_freezeAll` has no `knownRound` check; external callers guard it.
- **From Task 13 review (2 rounds, APPROVE; commit `cffcfc0`):**
  - **Scope accepted by the orchestrator:** `app/` has its own `pnpm-workspace.yaml` (`allowBuilds`, fixes `ERR_PNPM_IGNORED_BUILDS` inside `app/`; the root install is still not fixed) and `app/.env.example`; addresses come from `NEXT_PUBLIC_*` env vars until `shared/addresses.json` exists. `phaseAt(params, now, status?)` takes `{settled, isVoid}` from the contract views.
  - **Open minors:** (M1) `useRound` keeps cached data when the RPC fails for good, so the countdown can freeze with no error: add a `stale` flag when a read failed but data is cached, and show it. (M2) the "cached data wins, otherwise error" branch lives in the hook and is untested: move it into `deriveRound(reads, blockTime, failed)` and pin it with a test.
  - **Tasks 14-15:** show the `closing` state (last 6 s of commit, reveal, market) and disable submit there, because a tx lands about 2 s after the latest block; read quorum (>= 3 reveals per side) before offering a bet (`bet` reverts `MarketCancelled`); run `isValid` before `commit`; send path and salt to the keeper relay right after the commit (D1).
  - **Task 20:** the app imports `../shared/abi`, so the Vercel build root must be the repo root, not `app/`. House agents must be matched by a known address list; the static "House agents" list on screen 1 shows no per-round data.
- **From Task 14 review (1 round, APPROVE; commit `fdc594a`):**
  - **Open minors:** (1) `toInt32` in `app/src/lib/path.ts` does not catch `undefined` (`handlesToPath(new Array(9))` yields NaN fields): test `Number.isFinite(Number(v))` and add `isValid(handlesToPath(new Array(9)))`. (2) The live Commit button should read "Commit (stub, nothing is sent)" until Task 15 makes it real. (3) The ternary in `draw/page.tsx` mounts a new `DrawChart` when the live round becomes readable, so a drawing in progress resets; give the chart a stable position or key. (4) The `clampHandle` docstring says the result is always within the chart limits, but the validity limit wins; reword.
  - **Task 15 (real commit):** `onCommit` receives only the path, so also pass the round id; re-read the phase at click time (not the last render); keep the `closing` margin; save the salt before sending the commit; `commit` burns the stake and an invalid or unrevealed entry loses it. Chart half-range is `5*T` bp (an app choice; the plan sets no bound).
- **From Task 11 review (2 rounds, APPROVE; commit `c50d1bc`):**
  - **Scope accepted by the orchestrator:** root `package.json`/`pnpm-lock.yaml` (`@modelcontextprotocol/sdk` 1.32.2, `zod` 4.6.7, exact pins) and a root `pnpm-workspace.yaml` (`packages: ["."]`, `allowBuilds: { esbuild: true }`), which fixes the root `pnpm install --frozen-lockfile` (the old open item). `sdk.test.ts` runs `forge script` with private `FOUNDRY_CACHE_PATH/OUT/BROADCAST` dirs so it cannot collide with `keeper/test/rounds.anvil.test.ts`; any new test that runs `forge script` against `contracts/` must do the same.
  - **Env names (agents):** `RPC_URL`, `CHAIN_ID` (84532 or 31337 only), `ARENA_ADDRESS`, `AGENT_PRIVATE_KEY`, optional `AGENT_SALT_DIR` (default `~/.consensus-path/salts`). A salt file holds the salt in clear text; the private key is never written.
  - **Open minors:** (1) the dry run, window check and "already done?" check run before the send lock and are not repeated inside it (concurrent same-path retries or a manual `reveal` next to `autoReveal` can send a stale tx that reverts, gas only; a reveal can wait up to 120 s behind a lost-receipt commit): re-read `entryOf` and chain time inside the lock. (2) `resumePending` silently skips a `pending` record when `entryOf` throws once: log it and schedule anyway. (3) the `main()` fatal handler in `mcp.ts` prints a raw `e.message` (RPC URL with API key): use `shortMessage`. (4) the `mayLand=false` path for a reverted tx is untested (cosmetic).
  - **Task 12:** needs a `registerAgent` call (Registry) that the SDK deliberately lacks; add it there, with the house-agent address list for the app (never matched through `metadataURI`). `get_round` returns `recentCandles` only when a `candleContext` dep is injected (the chain has no candle history; this depends on the Alpaca feed, D4). Real stdio use against an MCP host is untested. The fsync of the salt directory is skipped on Windows.
- **From Task 8 phase B (broadcast 2026-11-25, user approved; reviewer APPROVE):** deployed to Base Sepolia (84532), blocks 63274211-63274214, 14 txs all status 1, deployer nonce 14. Addresses are in `shared/addresses.json` (Points `0xF6FD…8644`, AllowlistGate `0x959f…B472`, Registry `0xe6D0…Dce37`, Arena `0x4Da1…9AB7`, GapMarket `0x8b28…25fa`); `arena.keeper()` is the separate keeper wallet `0x5765…Ade4` (permanent), Points roles locked, totalSupply 0, on-chain code sizes equal the build artifacts.
  - **Open:** (1) explorer verification not done (no `BASESCAN_API_KEY`; Sourcify needs no key but publishes source, so it needs the user's yes); do it before the demo so judges can read the source. (2) The keeper wallet has 0 ETH: fund it before Task 10 runs live. (3) Before going live check `cast wallet address --private-key $KEEPER_PRIVATE_KEY` equals the on-chain keeper (a wrong or lost key means redeploying everything). (4) `app/src/lib/chain.ts` reads only `NEXT_PUBLIC_*_ADDRESS` env vars and its `.env.example`/comment still say addresses are not available: update in Task 15 (copy the four addresses from `addresses.json`). (5) Add `keeper/.env.example` (Task 10) and `agents/.env.example` (Task 12): `RPC_URL`, `CHAIN_ID=84532`, `ARENA_ADDRESS`, own private key; `deployBlock` is in `addresses.json` for log scans. (6) `Deploy.s.sol:15` still shows `--rpc-url base_sepolia` (no alias in `foundry.toml`); `.env.example` now documents the working command.
- **From Task 12 review (1 round, APPROVE):**
  - **Scope accepted by the orchestrator:** `registerAgent` in `agents/src/sdk.ts`, `agents/src/house/types.ts`, `agents/.env.example`, the Task 11 minors (`shortMessage` in the `mcp.ts` fatal handler; `resumePending` schedules anyway when `entryOf` throws), and `@anthropic-ai/sdk` pinned at 1.10.0 (1.14.0 is rejected by the pnpm `minimumReleaseAge` policy; do not loosen `pnpm-workspace.yaml`).
  - **Open minors:** (1) `newsLlm.ts:98,103` a headline can close the `<data>` block because `JSON.stringify` does not escape `<`: escape `<` and `>` as `<`/`>` and test that the user content has exactly one `</data>`. (2) `types.ts:158` `isAddress(raw, { strict: false })` accepts a mixed-case address with a bad checksum (a typo means the real house wallet gets no `house` label): use `strict: true` and test that a one-character typo throws. (3) no mocked-send test for `registerAgent`'s uncertain paths (send throws, lost receipt, reverted status, in-lock kind re-check). (4) `registeredKind`/`registryAddress`/post-receipt kind reads are not wrapped, so a raw viem error (RPC URL with a key) can reach the house runner: wrap with `shortMessage`. (5) a mined-but-reverted tx is reported as `SEND_UNCERTAIN` ("may still be pending"): report a revert.
  - **Forward notes:** the app must not import `agents/` (rule 2; `types.ts` imports `node:fs`): add a `houseAgents` address array to `shared/addresses.json` once the house wallets exist, and the app applies the same checksum, dedupe and fail-loud rules (Task 17). No runner yet wires `predict` to `submitPath` each round and the Alpaca history/headline feed is not built (`recentCandlesBp` comes later through the `candleContext` dep); the real Anthropic call and `registerAgent` on Base Sepolia are untested (the wrapper only compiles against the SDK types).
- **From Task 15 review (2 rounds, APPROVE):**
  - **Scope accepted by the orchestrator:** pages `app/src/app/{market,reveal}/page.tsx`, libs `market.ts`, `marketTx.ts`, `reveal.ts`, `chainData.ts`, `useMarket.ts`, `useReveal.ts`, `PathChart.tsx`; `chain.ts` defaults addresses from `shared/addresses.json` (env overrides, malformed override -> undefined); `jsdom` 31.0.1 as an app devDependency for component tests (no install scripts). The real commit transaction and relay are still NOT built (Task 14 stub).
  - **Open minors:** (1) tx state lives only in React state: after a lost receipt a reload, navigation or second tab lets the user bet again before the first tx mines (cost bounded by the 200 cap, testnet points); persist `{roundId, hash}` in localStorage and restore it as `unconfirmed`. (2) a late success after `unconfirmed` is not detected on its own: poll the receipt in the background. (3) jsdom 31 needs Node `^22.22.2 || ^24.15.0 || >=26` and `app/package.json` has no `engines` field: pin Node 24 for CI and Vercel in Task 20. (4) cosmetic cancel reason during read lag (`market.ts:106-108`, status 1, quorum met, one empty pool, phase still `market` is a void seen through lagging reads).
  - **Note:** the live score at reveal steps 1-2 is an estimate (hidden candles assumed to follow the path); only step 3 equals the contract score and is cross-checked with `consensusScores`. `awaiting-freeze` needs the keeper to call `freezeAll` after the reveal window (Task 10). No bet or claim tx was exercised on a populated market; Task 18 e2e must.
- **D4 (orchestrator ruling on the user's instruction "most accurate and easiest", 2026-11-25): candle data provider is Alpaca Market Data (free Basic plan).** Use `feed=iex` explicitly (default `sip` returns 403 for recent data on Basic); IEX is real-time but single-exchange, free SIP is consolidated but 15 minutes late. Alpaca forbids redistributing its API data and is silent on display: show only bp moves relative to P0 with a source line, never raw prices, and ask Alpaca for written confirmation before the public submission. Keys (`APCA-API-KEY-ID`, `APCA-API-SECRET-KEY`) live only in the keeper's environment. Task 10 starts when the user supplies the keys.
- **RESOLVED by D3 (option c plus d). Original issue from Task 3 ( it does not block Task 4, because options a and b change Registry and option d changes GapMarket, while Task 4 only spends the stake): free sybil identities.** `registerAgent` has no gate and the bond is paid from the grant minted in the same call, so every new address nets 900 points for the cost of gas. A factory contract deploying N children gains N x 900 points, enough to reach the 3-reveal quorum, set the agent median and flood the `GapMarket` pool. This weakens README §8 ("bond", "sybil costly"). Options: (a) no starter grant for agents, so the bond must come from points earned or granted by the owner; (b) agent grant minted only after the bond is paid from an external top-up; (c) accept it for the testnet MVP and disclose it; (d) add a cap on bet size per identity. Also relevant to Task 19's threat model.
- **From Task 10 (review: REJECT round 1, APPROVE round 2):**
  - **Fixed in review:** relay no longer drops a queued reveal after N transient failures (terminal answers only, capped backoff until `revealEnd`, worker pool `maxInFlight`); 202 PENDING keeps the entry until the chain shows `revealed`; the global rate bucket is charged only after parse + `isValid`; the relay reveals for `Kind.Human` only (agents reveal with their own wallet).
  - **Open, fix before the public beta (Task 20):** (1) each flush worker waits for its own receipt (`waitReveal`, up to 60 s), so about `maxInFlight` reveals go out per receipt time; with ~150 queued humans in a 30 s demo window the tail is dropped and those stakes burn. Limit only the pre-send RPC calls or wait for receipts outside the worker slot, and add a test (20 entries, short send delay, long receipt delay, all sent within one receipt time). (2) The keeper imports `hashPath` from `agents/src/salt` (`relay.ts:24`); move it to `shared/` (rule 2) in the next task that edits `shared/`. (3) The demo commit window is 90..149 s, not exactly 90 s, because `openRound` aligns to the bar grid (`source.ts:162-163`); delay the send until the aligned start if the video needs exactly 90 s. (4) An uncertain `openRound` that mines after a `BAD_ROUND` retry leaves an orphan round that nobody drives (`loop.ts:122-130`; stakes return through void, cost is gas). (5) After the pending TTL (120 s) an unmined first reveal can be sent a second time (gas only, `AlreadyRevealed`). (6) `retryAt` keeps a key after a direct-path dequeue (small, bounded leak, `relay.ts:362-366`). (7) A direct request answers 202 PENDING within the TTL even after the reveal is on chain (cosmetic).
  - **Not yet exercised:** live Alpaca calls (no keys yet), live Base Sepolia run (keeper wallet has 0 ETH). Verified on Anvil with a mocked feed only.
- **From Task 16 (review: REJECT round 1, APPROVE round 2):**
  - **Fixed in review:** the PNG footer is built from `disclaimer.ts` (includes not an offer of securities, no rights in any underlying company, no endorsement); the card says it is self-reported and to verify the round on Base Sepolia; unknown query params return 400; `ResultSectionView` is extracted and tested.
  - **Open:** (1) no claim button or reward amount exists in the app (the plan did not list it): Task 18 e2e needs `Arena.claimScore` and `GapMarket.claim` UI or a script, otherwise rewards never mint. (2) `/api/card` has no rate limit and its valid URL space (round x ticker) is large: add rate limiting on the host in Task 20. Anyone can still forge a card's scores; the card says so. (3) No test renders the card and checks that `CARD_FOOTER` and `cardVerifyLine` appear in the image; the thin `ResultSection` wrapper (`useAccount` + `useMyEntry`) is untested; the page was never exercised in a browser with a wallet and a settled round. (4) `useMyEntry` starts reading as soon as the round is settled and a wallet is connected (one extra RPC read before the click).
- **From Task 17 (review: REJECT round 1, APPROVE round 2):**
  - **Fixed in review:** rounds with fewer than 3 reveals on a side are "below quorum, not counted" (no outcome, no trend point, no win-rate count); log reads split only on a range-limit error and back off otherwise; the leaderboard is keyed by address and kind.
  - **Open:** (1) add a checksummed `houseAgents` array to `shared/addresses.json` before any public demo round, otherwise house agents show as plain agent rows (the page warns). (2) `loadHistory` is all or nothing: one bad round puts the whole dashboard in an error state; make it per-round tolerant before the public beta (Task 20). (3) No test pins the argument order of `roundCallSpecs` (human/agent `revealCount` at indices 8/9): add `expect(roundCallSpecs(1n)[8].args)` style assertions. (4) Replaying a below-quorum round ends with "The Human consensus scored higher" without a quorum caveat (same on the live reveal screen). (5) The quorum 3 is hard-coded in `history.ts` (`market.ts` reads `MIN_REVEALS` from chain). (6) `/dashboard` was never opened in a browser; the populated state was never seen against live data (no rounds on chain yet). (7) Public RPC limits `eth_getLogs` to 200 blocks and Base Sepolia runs about 5 blocks/s: widest scannable reveal window is about 33 min; use a paid RPC for the public beta.
- **From D5 (Twelve Data adapter; review: REJECT round 1, APPROVE round 2):**
  - **Fixed in review:** a real API key had been pasted into the tracked `keeper/.env.example` (caught before any commit); daily quota budget and throttle added so the 5 s loop cannot burn 800 credits in ~2 h 15 min.
  - **Open minors:** (1) `demo.ts` wiring (`throttleFeed`, `dataDelaySec: 60`) is not pinned by a test. (2) The daily count is in memory, so repeated restarts in one UTC day can exceed 700; provider quota reset time (UTC vs New York midnight) is unverified. (3) The partial-window safety relies on `candleSec = 300` (5 one-minute bars, `MIN_LAST_SAMPLES`); re-check if `candleSec` changes. (4) A throttled reuse can shift `T` slightly in `planRound` (P0 up to ~2 min old; STALE is judged at 600 s). (5) Real 429/403 error bodies from Twelve Data were never seen (mapped by status). (6) `agents/src/house/types.ts:30` and `docs/notes/data-source.md` still mention Alpaca/D4 (agents-dev owns the first; fix in the next agents task). (7) Rotate the Twelve Data key if it was shared outside this machine (it appeared once in a reviewer report in this session).
- **From Task 10b and 12b (review: REJECT round 1, APPROVE round 2 each):**
  - **Fixed in review:** `/context/:id` no longer emits a history candle built from a cut-off interval; the house runner no longer freezes an empty history when the keeper answers 404 just after `openRound` (retries until the last 30 s of the commit window), fails once on insufficient points, reuses a stored salt path after a restart and reads the keeper response as a capped stream.
  - **Open (fix before the demo round):** (1) the runner's cap of 3 identical failures (`run.ts` `MAX_IDENTICAL_FAILURES`) also ends transient `RPC`/`PENDING_TX`/`SEND_UNCERTAIN` errors, so 3 identical 429s from the public RPC in a row make an agent sit out the round; apply the cap to `SIMULATION` only and test 3 identical `RPC` failures followed by a success. (2) `historyCandles` counts distinct timestamps but never checks minute-grid alignment (`t % 60`), so an interval with an off-grid bar and a missing minute could count as complete (unlikely with the real feed). (3) `/context/:id` serves a round as soon as it has an id, before the loop's first chain check (one tick). (4) The runner script itself was never run against Base Sepolia (tests use anvil and a stub keeper); the documented command is `pnpm dlx tsx agents/src/house/run.ts`.

## Resolved decisions

- **D1 (approved by the user): delegated reveal.** As written, a person must sign a second transaction inside the reveal window (30 s in demo rounds, 15 min in production) or lose the stake. Proposed change: `reveal(id, who, path, salt)` callable by anyone; the hash already binds `who`, so nobody else can build a valid commit for that address. The app sends path and salt to the keeper, which reveals for the user. Trade-off: the keeper sees human paths before the reveal window (it is already a trusted party). Task 4 therefore uses `reveal(id, who, path, salt)`, Task 10 adds a keeper reveal relay, and the app (Task 13) submits path and salt to that relay right after the commit. The SDK still persists the salt locally as a fallback.

- **D2 (orchestrator ruling, advisor-reviewed, 2026-11-24): Arena time boundaries and storage.** Every task uses these exact comparisons:

  | Action | Allowed when |
  |---|---|
  | `commit` | `now < commitEnd` |
  | `reveal` | `commitEnd <= now < revealEnd` |
  | `freezeConsensus` / `freezeAll` | `now >= revealEnd` |
  | `GapMarket.bet` | `revealEnd <= now < marketEnd` |
  | `postCandles` | `marketEnd + 3*candleSec <= now <= settleDeadline` (amended 2026-11-24, advisor: posting is the exact complement of the void rule, so late posting cannot race a void) |
  | `isVoid(id)` | `voided \|\| (!posted && now > settleDeadline)` (derived; no transaction needed to make refunds possible) |
  | `voidRound` | `now > settleDeadline` and no candles posted; only records the flag and emits `RoundVoided` |

  `openRound` requires `entryStake > 0`, `T > 0`, `candleSec > 0`, `now < commitEnd < revealEnd < marketEnd`. Round ids start at 1. `anyCommitWindowOpen() == (now < maxCommitEnd)` where `maxCommitEnd` is a running max over all rounds. Each entry stores `{hash, kind (snapshot at commit), revealed, path}` so Task 6 can score lazily from `claim(id)` alone. `bucketWidth` is computed in `uint256` (`(uint256(T)+9)/10`, minimum 1) and narrowed after, so `T = type(uint32).max` works. `setKeeper` is owner-only and set-once (a lost keeper key means a redeploy; a conscious testnet choice). `Arena` exposes `getRound(id)` and emits `RoundOpened`, `Committed(id, who, kind)`, `Revealed(id, who, kind, path)`.

- **D3 (decided by the user, 2026-11-24): free sybil identities are accepted and disclosed, with a per-identity bet cap.** The open issue from Task 3 is resolved as option (c) plus (d). (c) `Registry` stays as built: no agent gate, so a fresh address nets `STARTER_GRANT - AGENT_BOND = 900` points; this is a known testnet limitation and must be stated in the README, the app footer and the submission video script. (d) `GapMarket` (Task 7) enforces a per-address cap on the total bet per round: constant `MAX_BET_PER_ADDRESS = 200` points (summed over both sides), `bet` reverts `BetCapExceeded()` above it; tests pin `== cap` allowed, `cap + 1` reverts, and that the cap is per address per round. The cap only reduces the impact of sybils, it does not prevent them. Task 19's threat model must list sybil explicitly as "accepted, disclosed, capped" and must not mark it as fixed. The 200 value is a tunable constant and counts as unverified until playtested.
- **D5 (orchestrator ruling, 2026-11-25; supersedes D4's provider): candle data provider is Twelve Data (free Basic plan).** The user cannot open Alpaca. Verified with a real key: 5-minute and 1-minute US stock bars work on the free plan, 1 credit per call, `datetime` is the bar open time and `timezone=UTC` is honored; limits 8 credits/min and 800/day. The adapter (`keeper/src/twelvedata.ts`) caps itself at 6/min and a 700/day budget (error code `QUOTA`), throttles repeated identical windows to once a minute and uses `dataDelaySec: 60`. The key lives only in `keeper/.env` (`TWELVEDATA_API_KEY`); `keeper/test/envexample.test.ts` fails if a secret is ever filled in `.env.example`. The same D4 rule applies: show only bp moves relative to P0 and get written confirmation of the redistribution/display terms from Twelve Data before the public submission (terms not yet read).


## Dependency order

`0 -> 1`; `2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8`; keeper `9 -> 10` and agents `11 -> 12` start after 8; app `13 -> 14 -> 15 -> 16 -> 17` starts after 8 (Task 13 can start after 4 against Anvil); `19` (final audit) after 17; `20` (public hosting and invited beta) after 8 phase B, 10 and 16; `18` last, and its submission step needs 19 passed. Cut order if late: 17 and replay first, 11-12 last; 20 keeps steps 1-2 (public URL and a running keeper) and drops steps 3-5 last.

## Self-review notes

- Spec coverage: README §3 (Tasks 4-7, 10), §4 (2), §5 (7), §6 (2-8), §7 (11), §8 (3, 12), §9 (0, 9), §10 (13-17), §11 (Global Constraints), §12 (dependency order), §16 (18). Orchestrator ask covered by Orchestration and Task 1.
- Type names (`Candle`, `RoundParams`, `Kind`, `Side`) are used identically across tasks.
- **From Task 14b review (2 rounds, APPROVE; commit `db241b2`):** round 1 REJECT (salt of a commit could be overwritten by a second attempt), fixed with per-hash salt records, separate in-flight slots, production keeper URL rule and replaced-tx detection. Open minors:
  - **Before the demo round (stake-burn risk):** `EntryPanel.tsx:60,133` with `useActions.ts:182-191`: the relay is blocked while the entry tx state is `pending`, even if the chain entry hash already equals a saved record. After a wallet speed-up plus reload, `waitForTransactionReceipt` waits 180 s on the old hash and the 30 s demo reveal window closes. Fix: when the chain entry hash matches a saved record, do not let the tx state block the relay (`AlreadyRevealed` counts as success). Add an EntryPanel wiring test (tx pending, chain hash matches, relay fires).
  - `app/.env.example:25`: `NEXT_PUBLIC_KEEPER_URL=http://127.0.0.1:8787` is not commented out; copying it to `.env.production` brings localhost back. Comment it out or leave it empty.
  - `marketTx.ts:79-80`: the "replaced" message is misleading for a speed-up that landed (cosmetic).
  - Two tabs share one in-flight key; one tab's release clears the other's record (the salt-store check still blocks a double commit).
  - Round 1 minors not fixed: the gate address comes from `addresses.json` `AllowlistGate`, not `Registry.gate()` (wrong allowlist status after `setGate`); auto-relay after an expired in-flight record depends on EntryPanel's single auto-send per mount.
- **From Task 14c review (APPROVE; commit `101eabd`):** the stale-pending relay block and the other two 14b follow-ups are fixed. Open minors: (1) in the normal no-reload commit flow the 6 s poll can show the entry on chain before viem's receipt returns while the step is still `pending`, so the auto-relay and `afterCommit` can POST the same path and salt twice (harmless: the keeper dedups and treats `ALREADY_REVEALED` as success); pin with a test or skip the `afterCommit` post when `relay.step` is not idle. (2) `unconfirmed` and `checking` still block the relay (the user must click "Check again"). (3) While a manual reveal tx is pending the relay button is enabled, so the keeper may reveal first and the user's own reveal shows `failed` with `AlreadyRevealed` (no points lost). (4) The replaced-tx text "Checking the chain for the result…" sits in a terminal `failed` state; reword to "Check the chain status below."
- **From Task 12c review (APPROVE):** the cap now applies to SIMULATION only and `historyCandles` skips off-grid bars (done). Open minors: (1) no test covers the streak reset (sequence SIMULATION, RPC, SIMULATION, SIMULATION with the same message); (2) non-`AgentError` failures (code `ERROR`, for example a bad model API key in `player.predict`) now retry up to `maxAttempts` (20) instead of 3, bounded and costing only calls; decide explicitly whether to cap them.
- **From restyle stage 1 review (2 rounds, APPROVE):** CSS-only theme (tokens, fonts, `globals.contrast.test.ts`). Carry forward: **Stage 2:** `.dash-table` uses `display:block` (wrap the table in an `overflow-x:auto` div instead); `.wallet-wrap .error` is 0.85rem (raise to 0.9rem); use `.note-hand` (Caveat) only for short annotations. **Stage 3:** up/down candles differ by color only (add hatch direction `///` vs `\\` and a shape cue); move TSX hard-coded chart colors (`MarketPanel.tsx` HUMAN/AGENT, `RevealPlayer.tsx` HUMAN/AGENT/REAL, `api/card/route.ts` dark theme) to tokens and extend the contrast test to cover them; the SVG axis label "P0 (0 bp), flat baseline" is only about 7.7 px effective at 360 px (move/shorten it, needs markup change; export `LEFT_X`, `SLOT_X`, `DX`, `HANDLE_R` from `DrawChart` and compute the axis test from them). **Test hardening:** replace the fixed selector list with a whole-stylesheet guard (every rule that uses `--f-hand` must be exactly `.note-hand`); make the `@media` guard also flag custom properties, `fill`, `stroke` and `border-color`.
