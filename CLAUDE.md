# Consensus Path: orchestrator rules

Read `README.md` (the blueprint) and `docs/superpowers/plans/2026-11-20-consensus-path.md` (the task list) before doing anything. The plan is the source of truth for task order, file ownership and interfaces.

## Roles

The main session is the **orchestrator**. It dispatches one domain agent per task and never edits outside the files a task lists.

| Agent | Owns | Model |
|---|---|---|
| `contracts-dev` | `contracts/` | sonnet |
| `keeper-dev` | `keeper/` | sonnet |
| `agents-dev` | `agents/` | sonnet |
| `app-dev` | `app/` | sonnet |
| `reviewer` | writes nothing; gate for every task | opus |

Global agents `search`, `grep`, `docs` (Haiku) are for exploration and API lookups.

## Rules

1. One task at a time per domain. Tasks in different domains run in parallel when their dependencies are done.
2. A domain agent touches only the paths its task lists. Cross-domain needs go through `shared/abi/*.json` and `shared/addresses.json`.
3. Consult the advisor before locking the approach of any contract task, after the same failure twice, and before declaring a task or the project done.
4. A task is complete only after its verification command was run and its output read, **and** `reviewer` returned `APPROVE`. No dependent task starts before that.
5. Give the reviewer only: the task text, the Global Constraints, the staged diff of the task (`git add <task paths>` then `git diff --cached`, so new files are included), and raw verification output (rerun with `rtk bypass` if output was condensed; the reviewer needs the real numbers). Never pass the implementer's summary or claims. Record `git status --short` before and after the review; reject the review if it changed anywhere except `.claude/agent-memory/` (the reviewer's own memory).
6. After 3 review rounds without `APPROVE`: stop, consult the advisor, tell the user.
7. **Implementers never run `git commit`.** The orchestrator commits after each approved task on `main`. The user approved pushing to `origin` (`Axlnd3r/Skern`, branch `main`); never force-push. Never commit `.env` or any key.
8. Do not post on X, submit forms, or deploy with real funds without the user's explicit yes.

## Toolchain

Foundry v1.10.0 is installed in `$HOME/.foundry/bin` and is **not** on the permanent PATH. Every Bash call that runs `forge`, `cast` or `anvil` must start with `export PATH="$HOME/.foundry/bin:$PATH"`. pnpm and Node are on the normal PATH. `slither` is installed. The first `forge build` downloads the Solidity compiler.

## Global Constraints

- Network: Base Sepolia only. Points only: no real money, no token launch.
- Units: every path and real candle is **int32 basis points relative to P0**; `open_1 := P0 (0 bp)`, `open_i = close_(i-1)`. Index of a path field = `candle*3 + {0:close, 1:high, 2:low}`.
- Valid path: for each candle `low <= min(open, close)` and `high >= max(open, close)`.
- Score (integer, pinned operation order). Per candle, with all differences taken in `int256`: `C = 10000 - min(10000, |dc|*10000/T)`, `R = 10000 - min(10000, (|dh|+|dl|)*10000/(2*T))`, `D = 10000` if `sign(close-open)` is equal (both flat counts), `5000` if exactly one is flat, else `0`. Per candle `s = 5*C + 2*R + 3*D` (no division). Final `score = floor(sum(s) * 100 / 300000)`, integer 0..100. Every division is floor division of a non-negative number. Cast to `int256` before any subtraction or `abs` (`abs(int32.min)` and `2*T` can overflow narrower types). TypeScript uses `bigint` only; no float ever enters the scoring path.
- Histogram: 201 buckets per field, `width = max(1, ceil(T/10))` bp, bucket index = `clamp(100 + floorDiv(v, width), 0, 200)` with `floorDiv` rounding toward negative infinity (Solidity `/` truncates toward zero, so floor explicitly; `floorDiv(-15, 2) = -8`), bucket `i` represents `(i-100)*width` bp. Median = lowest bucket whose cumulative count >= ceil(n/2).
- Quorum: market opens only if each side has >= 3 reveals. Equal integer consensus scores = tie = refund.
- Points economy: `STARTER_GRANT = 1000`, `AGENT_BOND = 100`. Forfeited stakes of unrevealed entries are burned. Claim reward = `(score - baselineScore) * REWARD_PER_POINT` when score > baseline, else 0.
- Timing: `settleDeadline > marketEnd + 3*candleSec`; `postCandles` only at or after `marketEnd + 3*candleSec`.
- Scoring exists in two implementations only: `ScoreLib.sol` and `shared/score.ts` (integer math, same operation order), tied by a vector-parity test. No other copy.
- Commit hash: `keccak256(abi.encode(path, salt, who))`, `who` = the committing address; `reveal` may be sent by anyone for `who`.
- Hackathon rules (verified 2026-11-20): submission = public X post with a video demo tagging @buildonbase, plus the Submission Form, by 11:59 PM UTC on 5 Dec 2026; testnet allowed; one submission per track; projects that enable trading for US users are not eligible (show a US-user notice, state points-only testnet); never claim rights in an underlying company or imply endorsement by Base, a partner, or an issuer.
- Testnet keys never committed (`.env` ignored). Human gate is a swappable `IHumanGate`; the MVP uses an allowlist. House agents are labeled `house` and never presented as organic users.
- Code, comments and docs in English.
