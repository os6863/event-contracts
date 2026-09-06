# v0.0.0.8 — Real outcome verification and Brier-scored track record

## Why this version exists
While reviewing the hackathon's other submissions before the deadline,
one entry ("Oracle-follow Calibration") turned out to be doing exactly
the piece this project had deliberately scoped out: logging predictions,
checking them against real settlement, and surfacing a Brier score to
catch overconfidence. Rather than leave that gap, this version closes
it — using the same standard scoring approach (Brier score), not
something invented to look similar.

## What this version adds
1. **`marketId` now travels with every history entry** (v0.0.0.7 only
   stored `symbol`, which isn't enough to reliably look a market back up
   later).
2. **`check-outcomes.ts`** — a new, entirely **read-only** script (no
   wallet, no cost) that, for every logged market not yet checked,
   reads its **real on-chain settlement**
   (`exchange.client.getMarketOnchain(marketId).winningOutcome`) and
   records:
   - the actual outcome (YES/NO) — straight from the chain, not assumed
   - whether DreamDEX's own market price picked the correct side
   - whether our ensemble estimate picked the correct side
   - a **Brier score** for both: `(predicted_probability_of_YES −
     actual)²`, averaged (0 = perfect, 1 = worst) — this rewards a
     well-calibrated probability, not just guessing the right side,
     which is exactly the axis "Oracle-follow Calibration" competes on.
3. **"Track record" section in the HTML report**, computed only from
   markets `check-outcomes.ts` has confirmed genuinely settled. If
   nothing has settled yet, it says so explicitly — the report never
   fabricates a 0%-error placeholder for data that doesn't exist yet.
4. The "Recent signal history" table now shows a **Settled?** column
   (`YES · ✅`, `NO · ❌`, `voided`, or `pending`) per row.

## What this version deliberately does NOT do
- No automated/scheduled checking — `check-outcomes.ts` has to be run
  manually, same reasoning as v0.0.0.7's decision not to store
  `PRIVATE_KEY` in GitHub Actions secrets on a hackathon deadline.
  Running `npm run check-outcomes` a few times as markets close before
  recording the demo is what actually populates this section — the code
  can't manufacture settled markets that haven't settled yet.
- Voided markets are excluded from scoring entirely (there's no "right
  side" to be scored against on a void) rather than counted as
  incorrect for either predictor.

## Validation
- **Field access**: `getMarketOnchain`'s real installed type (SDK
  0.29.0) was read directly (`MarketOnchain.winningOutcome: number`,
  `isResolved: boolean`, `isVoided: boolean`) before writing any of this
  — same discipline as every other real-data field in this project.
- **Brier/accuracy math**: hand-verified against four synthetic
  resolved-market cases in an isolated Node script before trusting the
  TypeScript version — confirmed the ensemble can score a *better*
  (lower) Brier value than DreamDEX even at identical accuracy, which is
  the whole point of using Brier scoring instead of a plain win-rate.
- **Type safety**: two deliberate sabotage tests (typo'd
  `winningOutcome` and a `HistoryEntry.resolved` field) both correctly
  failed compilation before being reverted.
- Not yet validated against a real settled market at the time of writing
  this file — that requires an actual logged market's expiry to pass,
  which needs real elapsed time, not more code.

## Changes vs. v0.0.0.7
- `v0.0.0.7/mispricing-report.ts` copied to `v0.0.0.8/mispricing-report.ts`;
  `ReportRow`/`HistoryEntry` gained `marketId` and resolution fields.
- New `v0.0.0.8/check-outcomes.ts`.
- New npm scripts: `mispricing-report-v3`, `check-outcomes`.
- `v0.0.0.8/output/` added to `.gitignore`.

## Run
```bash
npm install
npm run mispricing-report-v3   # logs predictions (needs PRIVATE_KEY, same as v0.0.0.2+)
npm run check-outcomes          # checks real settlements (read-only, no wallet needed)
```
Run `check-outcomes` again periodically — each run only advances the
entries whose markets have actually closed since the last check.

## Next step (v0.0.0.9 / final — proposed)
Run both scripts several times over the remaining time before the demo
so the Track Record section has genuinely settled markets to show, then
record the demo and submit.
