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