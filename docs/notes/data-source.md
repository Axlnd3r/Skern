# Task 0: data source and hackathon facts

Verified 2026-11-20. Sources: base.org/stocksmaxxing (page, FAQ, `/rules`) read in Chrome; docs.base.org pages read by the `docs` agent through a summarizing fetcher. Exact strings from the fetcher may not be character-exact; re-check with `curl` before relying on them in code.

## Tokenized Stocks API (official)

- Base URL `https://api.coinbase.com`, paths under `/v1/tokenized-stocks`, all GET, **no API key**, read-only reference data. Rate limits: not documented.
- Endpoints: `/` (list, paginated), `/chains`, `/total-supply/{contract_address}`, `/metadata/{ticker}`, `/images/{symbol}`, `/prospectus/{ticker}`, `/prospectuses`, `/corporate-actions/{id}`.
- Token fields: `contract_address`, `symbol` (with a `c` suffix, e.g. `TSLAc`), `name`, `decimals`, `total_supply` (already normalized), `multiplier` (1.0 = no adjustment), `nav_price`, `nav_price_updated_at`, `paused_features`, `first_mint_date`.
- **Chain coverage: Base mainnet only** (`chain_id` 8453). No Base Sepolia tokens, feeds or API entries are documented. Treat testnet as unsupported.
- The overview says availability is limited to eligible jurisdictions outside the US and integrators must apply restrictions themselves.

### Answers to the four Task 0 questions

| Question | Answer |
|---|---|
| (a) OHLC or candle history? | **No.** No OHLC or time-series endpoint exists. The integration guide says to use market-data providers or Chainlink round history for OHLC. Resolution and depth: not stated |
| (b) Reference value cadence | `nav_price` is the latest Chainlink-based NAV (total-return reference, not a live bid/ask). During market hours the feed updates on a **0.5% price deviation or at least every 24 h (heartbeat)**. `nav_price_updated_at` can lag by minutes to many hours |
| (c) Off-hours and holidays | The feed "runs 24/5, holds the last close on weekends and holidays, and freezes during corporate actions". It is **not** a 24/7 on-chain price, and the token's DEX price does not feed the oracle. Live snapshot showed updates in the evening ET, but the schedule is undocumented |
| (d) Rate limits | Not stated on any page read |

Chainlink proxy feeds on Base mainnet (8 decimals, `latestRoundData()`): AAPL `0x787f13dEa48Db0897CbCDD985de77809D837F988`, NVDA `0x04689a41629776563E6822F76f2e57D148d28513`, TSLA `0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4` (full list of 10 in the docs). Not documented for Base Sepolia.

Builder Codes: attribution via viem `dataSuffix` (requires viem >= 2.45.0). No requirement tied to the Tokenized Stocks API is documented.

## Consequences for the design

1. **The official feed cannot build 5-minute or 1-hour candles.** A 0.5% deviation trigger means most intervals contain no update, so keeper-built candles would be flat, `T` would collapse to 1 bp, and scores would be noise. The default fallback written in the plan (sample the reference value every 30 s) is **invalid**.
2. **Candles must come from an external intraday market-data provider** for the underlying equity (token price = underlying price x multiplier). The contract is unaffected: it only sees bps relative to P0, the 3 real candles, and a `sourceHash`.
3. **Stocks are referenced by ticker, not by an on-chain token.** No tokenized stock exists on Base Sepolia. `RoundParams` therefore carries `bytes32 ticker`. The UI displays the real mainnet token's name, address and `nav_price` from the API as the "tokenized stock" being predicted, and says clearly that settlement is a testnet stand-in.
4. **Demo and video scheduling.** The underlying market is open about 09:30 to 16:00 US Eastern = **21:30 to 04:00 WIB**. Rounds with real candles must run in that window. Thu 26 Nov (Thanksgiving) is closed and Fri 27 Nov closes early. 5-minute demo rounds can use **replayed historical candles** (labeled "replay"), but then the human cannot be predicting the future, so a replay round must be presented as a demo of the mechanism, never as a live prediction.
5. **US users.** The FAQ says projects that enable trading for US users are not eligible, and the API overview asks integrators to restrict the US. The app needs a US-user notice and the submission must say: testnet, points only.

## Decision needed from the user

Which intraday data provider to use (free tier, 5-minute bars, terms that allow publishing derived bps values and a source hash). Candidates are unverified: Alpaca market data, Twelve Data, Finnhub. Until chosen, Tasks 9-10 are blocked and `candles.ts` stays behind an adapter interface:
`interface CandleSource { bars(ticker: string, fromTs: number, toTs: number, intervalSec: number): Promise<Bar[]> }`.

## Hackathon facts (verified from the page, FAQ and Official Rules)

| Topic | Fact |
|---|---|
| Dates | Apply opens Nov 5; build Nov 13 to Dec 5; submit by **11:59 PM UTC on Dec 5, 2026** (06:59 WIB Dec 6) |
| How to submit | Public X post with a video demo (e.g. Loom) tagging **@buildonbase**, plus the Submission Form with the post link and Track(s). "Didn't register? You can still submit" |
| Testnet | Allowed, "will not be judged less favorably" |
| Entries | One Submission per Track; a project can win a prize in only one Track, but may win a Track prize and a Partner Track prize |
| Eligibility | 18+, not a resident of an OFAC-sanctioned region; teams of up to 5; same identity throughout; winners go through identity verification and tax forms; prizes paid in USDC on Base |
| Prizes | $100,000+: $50,000 Base-track, $48,000 partner, $6,000 community-voted build-in-public award. Programmable Stock Markets Base pool: **$20,000** |
| Partners shown for this track | Bankr ($1,000 rewards, mentorship) and BaseStonk (no listing fee, creator-fee sharing). The page says "3 partners" but shows two |
| Track idea list | Build-your-own stock indexes, covered call and put desks, borrow against your stocks, **earnings prediction markets** |
| Content rules | Must comply with laws (derivatives, gaming, prediction markets, sanctions); must not claim rights in an underlying company or imply endorsement by Base, a partner or an issuer |
| Judging criteria | **Not shown** on the page ("scored against the criteria included on the Quest Page, weighted equally"). Ask in a partner Telegram group |
