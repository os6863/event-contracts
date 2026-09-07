# v0.0.0.10 — Receipt validation, timestamped snapshots, and EdgeScope UI

## Why this version exists

The first live v0.0.0.9 report exposed a data-integrity problem: one successful LLM receipt decoded to probability `0`, while its reasoning concluded near `6500`. Prompt wording also failed to make the original reasoning reliably short.

Version 10 applies the EdgeScope redesign to the current v9 pipeline and rejects unverified estimates instead of presenting them as signals.

## What changed

- The decoded `inferNumber` result must be within `0..10000` and exactly match the receipt's numeric `llm_response`.
- A malformed, missing, truncated, or mismatched response gets at most one new LLM request using the same timestamped inputs and no extended reasoning. A failed retry cannot become a signal or history entry.
- Full receipts are matched to the selected successful ABI result. Request IDs, receipt URLs, and local diagnostic receipts are retained.
- Price observations refresh after 60 seconds. Time left is calculated when each row's inputs are assembled. Rows expiring during inference are excluded.
- Trading status and the YES order book refresh before estimation.
- Existing history is validated before an atomic write. Legacy rows without `marketId` remain visible but are skipped by outcome checks.
- Market discovery retries transient indexer failures three times. A failed scan exits before Agent calls and preserves the previous report/history.
- The new static EdgeScope UI includes a strongest-divergence panel, KPIs, ranked/filterable signal cards, receipt evidence, concise input summaries, methodology, release history, settlement scoring, responsive history, accessible controls, and explicit snapshot/read-only wording.

The v9 normal-CDF baseline, volatility constants, ensemble average, 15-point threshold, and Strong/Weak/None function are unchanged.

## Validation

- `npm install --ignore-scripts`: passed; 0 vulnerabilities.
- `npm run typecheck`: passed.
- `npm test`: 11/11 passed, including direct calculation parity with v9.
- Microsoft Edge passed at 320, 360, 375, 390, 412, 430, 768, 1024, 1280, and 1440px: no horizontal overflow or browser errors; filters, details, empty states, and 44px targets passed.
- Live execution: passed against six real DreamDEX markets. All six LLM final answers matched their successful receipts (`0.430`, `0.435`, `0.590`, `0.717`, `0.500`, and `0.650`); no retry was needed. Earlier timeout/HTTP 403 discovery failures preserved the previous report and history before this successful run.
- `npm run check-outcomes`: passed with zero lookup failures; four legacy records without a valid market ID were preserved and skipped, two real prediction records were settled, and the Track Record was regenerated.

## Run

```bash
npm run mispricing-report-v5
npm run check-outcomes
```

`npm run render-report` regenerates HTML from an existing v10 snapshot without Agent calls or a history append.

## Post-submission addition: Oracle Explorer deep link

Each market row already carries `oracleQuestionId` (per the SDK's `BinaryMarket` type). The Market Structure & Lifecycle docs note this is worth surfacing in any interface built on Event Contracts, since it deep-links to the oracle's own resolution graph — the price sources, the median, and the receipt behind a market's settlement. No prior version exposed it.

- Threaded `oracleQuestionId` through `ScannedMarket` → `ReportRow` (optional, since the SDK types it nullable for markets discovered from the realtime tail before the next indexer snapshot fills it in).
- `report-ui.ts` validates the id is a plain decimal string (its documented uint256-as-string shape) before building a URL from it — same discipline as the existing receipt-URL validation, applied to a second externally-sourced field.
- Rendered as a second evidence link per market card, alongside the existing receipt link, only when a valid id is present.
- New test: a valid id renders the link; non-digit, empty, negative, and injection-shaped values render no oracle link and never reach the HTML output.
- `npm run typecheck`: passed. `npm test`: 12/12 passed (11 prior + 1 new).

## Post-submission addition: simulated edge panel

Every resolved, signaled history entry (`agreement !== "none"`) already carries what's needed to answer "would following this signal have paid?" — `dreamdexUp`, `ensembleEst`, `divergence`, and the real `actualOutcome`. No prior version computed this.

- New `computeSimulatedEdge()` in `analysis.ts`: for each resolved, non-voided, signaled entry, simulates staking exactly 1 unit on the side the ensemble diverged toward (the sign of `divergence`), at DreamDEX's own quoted price for that side at observation time. Reports sample size, win rate, average return per signal, and net payoff, broken out by `strong` vs `weak` signal class. A zero-cost side (a 0 or 1 quoted price) is excluded — no real stake is possible there.
- Explicitly not a backtest of executed trades: no fees, no slippage, no liquidity check, no real order. The report copy says this outright, twice, since "simulated" alone wasn't judged strong enough given how easily this class of number gets over-read.
- New "Simulated edge" section in the HTML report, directly under Track Record, using the existing `score-grid`/`edge-data` styling — no new CSS.
- New tests: hand-verified payoff/return math for a backed-UP win, a backed-UP loss, and a backed-DOWN win; confirms `none`-agreement, non-resolved, invalidated, zero-divergence, and zero-cost entries are all excluded from the simulation; confirms the report renders the panel when data exists and an explicit "no resolved signals yet" state otherwise.
- Caught in review before shipping: the empty-bucket copy read "No resolved weak signals signals yet." (title already contained "signals", the template appended it again) — fixed to a class-agnostic message.
- `npm run typecheck`: passed. `npm test`: 14/14 passed (12 prior + 2 new).
- Sanity-checked against this repo's own real `data/signal-history.json` (not just synthetic fixtures): ran cleanly, returned `{n: 2, wins: 0, avgReturnPct: -100%}` for strong signals — an honestly bad small-sample result, which is exactly the kind of number this panel exists to surface without softening.

## Post-submission addition: liquidity gate, unique-market scoring, wording precision

Prompted by a third-party technical review of the submission. Verified every specific code-level claim against the actual source before acting on it (not taken on faith) — see the review conversation for what was checked and what was declined with reasons (a full "Edge Confidence Engine" composite score and multi-source oracle pricing were judged too large/risky for the remaining time, not rejected as bad ideas).

**Liquidity gate (confirmed real, not a hypothetical concern):** the order-book code that produces `dreamdexUp` — the number every signal is compared against — previously fell back to a single-sided quote (`ask ?? bid`) when only one side of the book was posted, and had no spread check at all. A one-sided `ask = 0.95` with no bid would have been read as "DreamDEX prices this at 95%," which is a real number but not a real market view.

- New `classifyLiquidity()` in `analysis.ts`: `ok` (two-sided, spread ≤ `MAX_SPREAD_FOR_SIGNAL` = 0.08), `wide-spread`, `one-sided`, or `no-book`.
- Wired into the real signal-generation path in `mispricing-report.ts` (not the earlier, display-only pre-scan table). Below `ok`, `dreamdexUp` stays `null` — never smuggled in as a number — and the paid LLM Agent call is skipped entirely, since there's nothing reliable to compare it against. This also saves testnet gas on illiquid markets.
- Raw bid/ask/spread are still shown in the report's evidence panel for transparency, explicitly labeled as not used for classification.
- New report explanation state distinguishing "insufficient liquidity" from "no signal found" — these were previously indistinguishable to a reader.

**Unique-market Brier scoring:** the existing Track Record score averaged every logged observation equally, so a market observed 3 times counted 3x as much as one observed once. New `computeUniqueMarketBrier()` averages within a market first, then across markets, and is shown side-by-side with the original per-observation number in the report.

**Wording precision (README only, no code change):** "independent, on-chain probability estimate" softened to reflect that only the Agent execution/receipt is on-chain — the CoinGecko price input itself is not. Added explicit, upfront disclosure that this project's independent price reference is not claimed to equal DreamDEX's own multi-source settlement oracle (by design — an independent check that matched the thing it's checking wouldn't be independent), and that the naive/LLM estimates share the same underlying price-move input rather than being fully independent evidence of each other.

**Static-snapshot reframe (README only):** added a lead-in sentence positioning the snapshot report as an immutable, reproducible artifact, without removing the existing honest explanation of why it isn't live-updating.

**Declined, with reasons, for this submission:**
- Multi-source price (Binance/Coinbase/Kraken median) — real improvement, but conflicts with the project's stated zero-cost/no-API-key design goal and adds three new network dependencies this close to the deadline.
- Dynamic realized volatility from candles — legitimate weakness (already disclosed in README), but real new code with real new bug surface, better suited to a post-hackathon v0.0.0.11.
- A composite "Confidence: 87/100" scoring engine — declined specifically because it would bake in undisclosed, hand-picked weights, which is the same methodological problem (manual, uncalibrated anchors) the review itself flagged elsewhere. The liquidity gate above solves the same underlying problem with an explicit boolean state instead of an opaque score.

**Testing:** two real bugs were caught and fixed during this work before being shipped — an orphaned test block from a bad edit, and a floating-point-fragile boundary assertion (`0.54 - 0.46` is not exactly `0.08` in JS float arithmetic; rewritten to test clearly-under/over values instead of the exact boundary). Final: `npm run typecheck` passed; `npm test` — **17/17** passed (14 prior + 3 new: liquidity classification, unique-market Brier, and insufficient-liquidity report rendering).
## Post-submission addition: multi-source median price (reopens a declined item, narrower than originally scoped)

The prior entry above declined "multi-source price (Binance/Coinbase/Kraken median)" as conflicting with the zero-cost/no-API-key design goal and adding three new network dependencies this close to the deadline. Revisited under direct instruction to build and locally verify it before pushing, with two changes from the original proposal:

- **Kraken dropped.** Its ticker response keys the price under a pair-specific field name (`XXBTZUSD`, `XETHZUSD`, ...) that the `fetchUint` agent's fixed JSON-path selector can't address without a hardcoded lookup table — untested against the live agent, not worth the risk this close to the deadline. Binance and Coinbase both expose a fixed field name regardless of pair, so only those two join CoinGecko.
- **The "new network dependency" framing was more pessimistic than the actual design.** Every source is fetched through the same on-chain JSON API Request Agent call the original CoinGecko price already used — the HTTP fetch happens in the Agent's own infrastructure, not from this script's process, so no new local network dependency or API key is introduced. The real cost is on-chain Agent-call load: up to 3x the JSON API Request Agent calls (and STT cost) per unique asset instead of 1x, on an agent already noted elsewhere in this file as shared and contention-prone under hackathon load. That is the actual risk this change adds, and it is a different risk than the one originally declined.

**What changed:**
- New `PRICE_SOURCES` config (CoinGecko, Binance, Coinbase per asset) and `fetchMultiSourcePrice()`, which queries all configured sources in parallel via `Promise.allSettled` and takes the median of whichever succeed. Requires only one successful source to produce a price — never fails the market closed over a single flaky source — but always reports which sources actually contributed.
- New `medianOf()` in `analysis.ts`, unit-tested independently (single value, even/odd counts, and an outlier-source case confirming one bad reading can't dominate a 3-source median).
- `MULTI_SOURCE_PRICE` env flag, defaulting **on**. Setting it to `false` reverts to the exact original single-source behavior with no code change — an explicit safety valve given the added on-chain load, not a hedge against the source logic itself.
- `ReportRow.priceSources` threaded through to the report UI: the verification snapshot now shows "median of N: <names>" per market, so a degraded (1- or 2-source) reading is visibly distinguishable from a full 3-source median rather than presented as uniformly verified.
- README, ARCHITECTURE.md and METHODOLOGY.md updated everywhere they described CoinGecko as the sole independent price input.

**Explicitly not done:** this does not touch `naiveProbability`'s volatility model. A separate, related proposal — deriving realized volatility from DreamDEX's own market candles — was evaluated and set aside: `getCandles` on a binary pool returns YES-probability candles (via `priceToProbability`), not underlying BTC/ETH price candles, so feeding their movement into a model that expects underlying-asset log-return volatility would be a unit/category error, not a refinement. Multi-source pricing and volatility calibration are independent changes and should not be conflated.

**Validation:**
- `npm run typecheck`: passed.
- `npm test`: **19/19** passed (17 prior + 2 new: `medianOf` behavior, and the report rendering the source count/names).
- **Not yet validated against the live Somnia Agent / testnet.** `fetchPriceFromSource`'s selectors for Binance (`price`) and Coinbase (`data.amount`) are inferred from each exchange's public REST response shape, not confirmed against a real `fetchUint` agent call — this needs a funded testnet wallet to actually exercise, which this session does not have. Run `MAX_MARKETS=1 npm run report` locally with a funded disposable wallet before relying on this in a demo; keep `MULTI_SOURCE_PRICE=false` as an immediate fallback if a source's selector turns out to be wrong on the live agent.

### Bug caught by the first live run against the real testnet Agent

The first `MAX_MARKETS=1` run against the live Somnia Agent showed 2/3 price sources fail (CoinGecko and Coinbase) while only Binance succeeded — with CoinGecko, reliable across every prior version's live runs, failing at the exact same moment as Coinbase. That pattern is a nonce race, not three independent source outages: `fetchMultiSourcePrice` originally fired all three sources' `submitAgentRequest` calls concurrently via `Promise.allSettled`, and each one signs and sends a real wallet transaction — concurrent writes from the same account race viem's nonce lookup, so two calls can read the same pending nonce before either transaction is tracked, silently dropping one.

Fixed by making the per-source calls sequential (a plain `for` loop with `await`), matching every other write path in this file, which never has more than one wallet write in flight at a time. Costs a few extra seconds per price refresh (each JSON API Request Agent call is ~2s per the docs) in exchange for not racing the account's own nonce. Console output also now prints each failed source's actual error message, not just its name, so a genuine future source failure is diagnosable without re-instrumenting.

`npm run typecheck` passed; `npm test` — 19/19 passed (no test change; this is a live-agent concurrency bug the local test suite cannot catch, since it doesn't mock wallet writes — the pure-function tests around `medianOf` and the fallback/rendering logic were correct throughout).
