# Consensus Path (working title)

> Humans draw the next 3 candles. AI agents submit theirs. A market bets on whose consensus gets closer to reality.

**Status:** blueprint v1 (design approved section by section, no code written yet)
**Target:** Base "Stocks Maxxing Season" hackathon, track **Programmable Stock Markets**
**Network:** Base Sepolia (testnet), points only, no token
**Deadline:** submit by **Thu 3 Dec 2026** (official deadline Dec 5; Dec 4 is reserved for a thesis-defense registration)

---

## 1. One-paragraph pitch

For a tokenized stock, every round asks everyone, humans and AI agents alike, to predict the next three candles by committing a 9-number path. After a short reveal window, the on-chain contract computes two consensus paths: the **median of gated humans** (soft gating, see section 8) and the **median of declared agents**. A single two-sided pool then lets anyone bet on which consensus will land closer to the real candles, scored by a deterministic formula. The product is a new market primitive, a tradable **human-vs-agent disagreement**, wrapped in a game people can play in five seconds.

**Defensible claim:** making the human-vs-agent gap a tradable asset, with commit-reveal fairness and deterministic scoring. We do **not** claim that human-vs-AI forecasting has never been done (benchmarks exist), and we do **not** claim a perfect human/agent separation (see section 8).

## 2. Why this fits the track

Programmable Stock Markets asks for "net-new stock market primitives, e.g. custom portfolios, indexes, structured products, financing tools, prediction markets, and market infrastructure." This project is a prediction-market primitive whose resolution is tied directly to tokenized-stock price movement.

Verified from base.org/stocksmaxxing: 1 month, $100,000+ rewards, Nov 5 to Dec 5, build and launch Nov 13 to Dec 5, three tracks, token launch optional, builders are responsible for their own legal compliance, participants must be 18+.

## 3. Round lifecycle

One round is one tokenized stock and the next 3 candles.

```
OPEN -> COMMIT -> REVEAL -> MARKET -> PLAY -> SETTLE
 P0,T    draw      open       bet     candles   score + payout
```

0. **OPEN.** The keeper calls `openRound`, which posts and freezes P0 (reference price), T (tolerance) and the histogram parameters (section 6). Drawers need P0 to commit, so these are fixed at open and immutable afterwards.

1. **COMMIT.** Humans (canvas) and agents (API/MCP) submit `hash(path, salt, msg.sender)`. This prevents copying and herding while people are drawing.
2. **REVEAL.** A short window **before the first candle opens**. All paths are opened and two consensus paths are frozen: `median(humans)` and `median(agents)`. Unrevealed commits forfeit their entry stake and score worst.
3. **MARKET.** With both consensus paths visible, anyone bets on one pool: *"Which consensus lands closer to the real candles, Human or Agent?"* Betting closes when candle 1 opens.
4. **PLAY.** Real candles open one by one over the two paths.
5. **SETTLE.** The keeper posts the 3 real candles, the contract scores everyone, and the pool pays out.

### Timing and anchors

- **Anchor:** all paths and all real candles are expressed in basis points relative to P0, and `open_1 := P0` for scoring on both sides. Any drift between `openRound` and the start of candle 1 therefore counts as part of candle 1's move. This keeps the prediction and the settlement on the same definition.
- **Demo round (5-minute candles):** commit 90 s, reveal 30 s, market 60 s, so candle 1 starts about 3 minutes after open. The gap between P0 and candle 1 is a known, short drift.
- **Production round (1-hour candles):** open about 1 hour before the US session, commit until about 30 min before it, reveal 15 min, market 15 min, candle 1 at the session start. Exact values are round parameters.

**Why reveal before the candles:** if reveal waited for the price, anyone (or one person with many identities) could skip revealing after seeing the price and shift the consensus to manipulate the market. Early reveal closes that hole and lets bettors judge two visible paths.

**Candle interval is configurable.** Production: 1-hour candles in the US session. Demo and video: 5-minute candles with an automated keeper, so a full round fits a recording.

## 4. Path format and scoring

### Path
9 integers per entry: `close`, `high`, `low` for each of 3 candles, in **basis points relative to P0** (the reference price posted at `openRound`). `open_1 = P0`, and `open_i = close_(i-1)`. Constraint: `low <= min(open, close)` and `high >= max(open, close)`.

### Score (per candle, then averaged)

| Component | Formula | Weight |
|---|---|---|
| Close | `max(0, 1 - abs(c_pred - c_real) / T)` | 50% |
| Range | `max(0, 1 - (abs(h_pred - h_real) + abs(l_pred - l_real)) / 2T)` | 20% |
| Direction | 1 if sign(close - open) is the same, 0.5 if exactly one of the two is flat (sign 0), 0 if opposite. Both flat counts as a match | 30% |

**Final score** = average over the 3 candles x 100, integer 0 to 100.

- `T` (tolerance) = 1.5 x the median absolute close-to-close move of the last N candles, computed by the keeper before `openRound` and stored on-chain in the round parameters. It makes scores comparable across stocks and is auditable. The multiplier and N are tunable parameters.
- **Lazy baseline:** the score of a flat "no change" path is computed and displayed. Scoring below baseline means losing to not guessing.
- No DTW: with 3 time-aligned candles a simple integer formula is enough and is fully computable in Solidity.
- AI never scores. Scoring is deterministic and verifiable.

## 5. The market (`GapMarket`)

- **Question:** which consensus has the higher score, Human or Agent?
- **Resolution:** higher score wins. A difference under 1 point is a tie and stakes are refunded.
- **Payout:** parimutuel. The winning side splits the whole pool in proportion to stake. Fee is 0 on testnet.
- **Quorum:** the market opens only if each side has at least N reveals (proposed N = 3). Otherwise it is cancelled and bets are refunded.
- **Gap** (score difference between the two consensuses) is a **display metric** on the dashboard in the MVP. A tradable gap contract like the original Grok idea is roadmap.

**Why this design:** because both consensus paths are fixed before the candles play, the "push a thin book before the checkpoint" attack from the original Divergence Markets idea does not apply. Liquidity is one pool, not three books.

## 6. Smart contracts (Solidity + Foundry, Base Sepolia)

| Contract | Responsibility |
|---|---|
| `ScoreLib` | `pure` integer scoring library, unit and property tested |
| `Registry` | Marks an address as `Human` or `Agent`. Human gate via a swappable `IHumanGate` (MVP: allowlist/mock; later EAS/Coinbase Verifications if available). Agents self-register with metadata and a small bond |
| `Arena` | `openRound -> commit -> reveal -> freezeConsensus -> settle -> claimScore` |
| `GapMarket` | `bet -> resolve -> claim` on the two-sided pool |
| `Points` | Non-transferable points for entry stake, bets and rewards |

**Key mechanisms**
- **Commit hash:** `keccak256(abi.encode(path, salt, msg.sender))`. Including the sender stops copy-pasting someone else's commit. One commit per address per round, with a small points stake. **Stake rules:** a revealed entry gets its stake back at claim; the stake of an unrevealed entry is burned (lazy scoring cannot know the total a pro-rata pot would need). Rewards are minted at claim in proportion to the score above baseline. New users receive a starter grant of points on registration.
- **Consensus without big loops:** per-field histograms (9 fields, 201 buckets, out-of-range values clamped). **Bucket width and range scale with T and are posted at `openRound`:** `width = max(1 bp, ceil(T / 10))`, range = +/-100 buckets (about +/-10T). This keeps quantization error far below T for both 5-minute and 1-hour rounds. Each `reveal` only increments 9 counters. After the reveal window, anyone can call `freezeConsensus(field)` to walk the buckets and find the median. **Resolution limit: about T/10 per bucket.** After taking medians, the consensus path is repaired with `high = max(high, open, close)` and `low = min(low, open, close)`.
- **Lazy scoring:** the keeper posts the 3 real candles once; each participant's score is computed on claim, and the two consensus scores once. Settlement cost is O(1) regardless of participant count.
- **Roles and trust:** the `keeper` opens rounds, posts P0, T and the histogram parameters at `openRound`, and uploads real candles. Parameters are immutable after a round opens and candles can be posted once. The owner can only `pause`, never touch funds.
- **Liveness:** if the keeper does not post candles before a deadline, the round is voided and all stakes and bets are withdrawable.
- **Participant rewards (MVP):** claiming mints points proportional to score above baseline, plus a leaderboard. Tiered payouts and real stakes are roadmap.
- **Tests:** unit tests for `ScoreLib`, property tests for the histogram median and pool invariants (total claims <= total pool), fork tests on Base Sepolia.

## 7. Agent interface

One **MCP server** and one **TypeScript SDK** exposing the same four tools:

| Tool | Purpose |
|---|---|
| `list_rounds` / `get_round` | Stock, P0, T, phase schedule, last 20 candles as context |
| `get_consensus` | Human and agent consensus after reveal; final scores after settle |
| `submit_path` | Takes 9 numbers; the server generates the salt, persists it to disk, commits, and auto-reveals in the window. **The local MCP process must still be running (or be restarted) during the reveal window, otherwise the entry is forfeited.** The SDK also exposes a manual `reveal` using the persisted salt |
| `get_my_results` | Scores and results per round |

The MCP server runs **locally on the agent owner's machine and uses that owner's wallet**. We never hold third-party keys. Registration is `registerAgent` with metadata (name, model, strategy description, operator) and a bond; one entry per address per round.

### House agents
Three built-in agents, each with its own address, labeled `house` in the Registry, never disguised as external agents. They use the exact same MCP/SDK path as outside agents (dogfooding, and sample code for others). Keys are testnet-only, stored in a secret store, never committed.

| Agent | Strategy |
|---|---|
| Momentum | Extrapolate the trend of the last N candles (rule-based) |
| Mean Reversion | Revert toward the mean (rule-based) |
| News LLM | LLM reads headlines and produces a path; output is validated and clamped, with a rule-based fallback if the API fails |

## 8. Human vs agent separation (honest limits)

Perfect separation cannot be proven. Defenses, in layers:
1. **Gates:** humans via `IHumanGate` (soft), agents via bond and declaration.
2. **Cheap to attack, not worth it:** median, quorum, entry stake and per-identity bet caps make sybil attacks costly with small payoff.
3. **Off-chain signals, shown as flags only:** commits within milliseconds of the window opening, overly regular timing, identical paths across addresses, shared funding sources.
4. **Reclassification by the owner** is allowed only before the next round's commit window and is logged as a public event. This is a centralization point and is disclosed.

**Safe pitch wording:** "verified-human vs declared-agent with transparent soft gating", not "pure humans vs pure AI".

## 9. Price data and oracle

- The keeper uploads the 3 real candles with a hash of the source data and a public URL so anyone can check.
- A candle close is defined as a **time-weighted average of the last few samples**, not a single tick, so one spike cannot decide a result.
- The MVP is **centralized (single keeper)** and says so. A decentralized on-chain feed is roadmap, to be selected only after checking what exists on Base.
- **Verified (2026-11-20, see `docs/notes/data-source.md`):** the official **Tokenized Stocks API** has no OHLC or time-series data, covers Base mainnet only, and its reference value (`nav_price`) updates only on a 0.5% deviation or a 24 h heartbeat. It cannot build 5-minute or 1-hour candles. Candles therefore come from an **external intraday market-data provider** for the underlying equity (provider to be chosen). The Tokenized Stocks API is used to display the real mainnet token (name, address, `nav_price`) next to each round. Stocks are referenced on-chain by `bytes32 ticker`, because no tokenized stock exists on Base Sepolia.
- **Off-hours (verified):** the reference feed holds the last close on weekends and holidays, so live rounds must run during the US session, about 21:30 to 04:00 WIB. Thu 26 Nov is closed and Fri 27 Nov closes early. Demo rounds over replayed historical candles must be labeled "replay" and presented as a mechanism demo, never as a live prediction.
- **Open decision:** which intraday data provider to use (free tier, 5-minute bars, terms that allow publishing derived values).

## 10. Frontend (Base mini app)

**Stack:** Next.js (mobile-first), wagmi/viem, packaged as a Base mini app, Coinbase Smart Wallet for seedless onboarding, lightweight-charts with a custom overlay. Mini-app SDK and paymaster details must be checked against current docs at build time; fallback for gas is the Base Sepolia faucet.

| Screen | Content |
|---|---|
| 1. Today's Round | Stock, countdown, phase tracker, phase-appropriate action |
| 2. Draw | Chart with last 20 candles; 3 future slots set with **draggable handles** (close, high, low); faint flat-baseline path for comparison |
| 3. Market | Human (blue) and Agent (orange) consensus overlaid, gap number, pool odds, bet form |
| 4. Reveal | Real candles open one by one over both paths with a live score. **The money shot for the demo video** |
| 5. Result + share card | Score, vs baseline, near-miss line ("87, 3 short of beating the Agent"), shareable image |
| 6. Gap Dashboard (desktop) | Human vs Agent score trend per round, win rate, leaderboard, agent profiles |

- **Handles, not freehand:** it feels like drawing but always yields 9 valid numbers.
- **Replay mode:** completed rounds can be replayed with full animation for recording.
- **Seed data:** dashboard history comes from rounds we really run on testnet. Any simulated data must be labeled "simulated" and never mixed with real data.
- **Habit hook (minimal):** streak counter and share card only.
- **On-chain reads:** view functions and `getLogs` over a limited block range. An indexer (e.g. Ponder) only if the dashboard is slow.
- **Test:** one Playwright E2E for draw -> commit -> reveal on local Anvil.

## 11. Legal and safety posture

- **Points by default.** No real money, no token, testnet only. Real stakes are out of the MVP.
- Builders are responsible for their own licensing for derivatives and prediction markets (stated on the hackathon page). Participants must be 18+.
- The UI carries a clear disclaimer: testnet, not investment advice, not an offer of securities.
- This document is not legal advice. Read the Official Rules before submitting, and ask the partner Telegram groups if unsure about pool mechanics.

## 12. Timeline

Today is Fri 20 Nov 2026.

| Date | Work |
|---|---|
| 20-23 Nov | `ScoreLib` + tests, `Arena`, `Registry`, `Points`, deploy to Base Sepolia |
| 24-26 Nov | `GapMarket`, keeper/oracle, MCP + SDK, 3 house agents. Start running real rounds |
| 27-30 Nov | Frontend screens 1-5, Smart Wallet, share card |
| 1 Dec | Gap Dashboard, replay mode, history from real rounds |
| 2 Dec | Invite at least 3 real humans (quorum), fix bugs, record demo video |
| 3 Dec | X post, submission form, **submit** |
| 4 Dec | Thesis-defense registration. No project work |
| 5 Dec | Emergency buffer only |

**Cut order if time runs short:** dashboard and replay first, MCP last.

## 13. Out of scope (roadmap)

Tradable gap contract (original Grok idea), LMSR, World ID, extra modes (Pattern Pick, Line Shot, Zone Hunter), community battles, real stakes and tiered payouts, user-owned agents, decentralized oracle, indexer.

## 14. Risks

1. **Data/oracle availability** is unverified. First thing to check.
2. **Human quorum at demo time:** needs 3 real people, or clearly labeled "house human" accounts. Never presented as organic users.
3. **Scope vs one builder:** see cut order above.
4. **Unverified hackathon facts** (below).

## 15. Unverified facts (do not state as requirements yet)

- **Now verified** (see `docs/notes/data-source.md`): submission = public X post with a video demo tagging @buildonbase plus the Submission Form by 11:59 PM UTC on 5 Dec 2026; testnet accepted; one submission per track.
- **Still unknown:** the third partner of the Programmable Stock Markets track (the page shows Bankr and BaseStonk but says 3), the Judging Criteria (not on the page), and whether the "no trading for US users" rule needs a real geoblock or only a notice.
- Mini-app SDK specifics, paymaster availability, Builder Codes integration steps, availability of an on-chain human attestation.
- Tuning values: quorum N = 3, T multiplier 1.5, lookback N, bucket width `ceil(T/10)`, window durations.

## 16. Submission checklist

- [ ] Apply at base.org/stocksmaxxing ("Apply Now")
- [ ] Read Official Rules; note the submission cutoff time and timezone
- [ ] Repo, contract addresses and a working mini-app link
- [ ] Builder Codes integrated
- [ ] Demo video, public X post, submission form (confirm the @buildonbase tag requirement)
- [ ] Contact one partner in a Telegram support group for the Partner Track

## 17. Planned repository layout

```
contracts/   Solidity + Foundry (ScoreLib, Registry, Arena, GapMarket, Points)
keeper/      round opener, candle uploader, demo-round automation
agents/      MCP server, TypeScript SDK, sample agent, 3 house agents
app/         Next.js mini app (screens 1-6)
docs/        notes, demo script
```

## 18. Next step

Build orchestration for this project (a project `CLAUDE.md` and per-domain subagents for contracts, scoring, agents, and frontend) comes after this blueprint is reviewed.
