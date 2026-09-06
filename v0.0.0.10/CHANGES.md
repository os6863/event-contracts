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