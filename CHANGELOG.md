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