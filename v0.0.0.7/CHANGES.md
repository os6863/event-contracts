# v0.0.0.7 — Ensemble signal, signal history, and a live public report

## What this version adds
Three additions on top of v0.0.0.5's pipeline, no new on-chain calls or
cost:

### 1. Ensemble signal (naive baseline + LLM, cross-validated)
v0.0.0.3's naive linear estimate was dropped once v0.0.0.4 added the LLM
— this version brings it back, computed alongside the LLM estimate on
every run. The two are averaged into an **ensemble** probability, and a
market is only flagged **"strong"** when both independent estimates
diverge from DreamDEX's own price in the *same direction*. If only one
of the two diverges, it's flagged **"weak"**.

This directly guards against a failure mode this project already hit
live: v0.0.0.4's CHANGES.md documents an LLM call returning `0.99` for a
market that had actually moved *down* — wrong in direction, not just
overconfident. Verified against that exact real number in an offline
test before shipping this version: with the ensemble logic, that same
case now resolves to `weak` (the naive baseline correctly disagreed with
the LLM's direction), not a false `strong` claim. A single miscalibrated
model call can no longer produce a "strong" signal on its own.

### 2. Signal history (not a backtest)
Every run now appends its results to a repo-root `data/signal-history.json`
and shows a "Recent signal history" table in the report. To be precise
about what this is and isn't: **it is not an accuracy claim.** No market
in the history has been checked against how it actually resolved — that
would need waiting for each window to close and reading the settlement.
What it *does* show is that this pipeline has genuinely run against live
data across multiple separate sessions, not been staged once for a demo
recording. History accumulates by running the script again — running it
several times before recording the demo gives it real content to show.

### 3. Live public report (GitHub Pages)
The same HTML is now written to both `v0.0.0.7/output/report.html` (the
existing per-version convention) and repo-root `docs/index.html`. GitHub
Pages can serve the latter directly, so judges can see the current
report from a URL without cloning the repo or running anything.

**One-time manual step (not something a script can do):** in the GitHub
repo, go to Settings → Pages → Source → "Deploy from a branch" → Branch:
`main`, folder: `/docs` → Save. After the next push, the report is live
at `https://<username>.github.io/event-contracts/`.

## Validation
- **Ensemble/agreement logic**: checked by hand against four cases,
  including the exact real numbers from two past live runs (the `0.99`
  miscalibration case and a genuine live agreement case) — see the
  numbers above, matched by an isolated Node script before trusting the
  TypeScript version.
- **History persistence**: tested that three separate simulated runs
  correctly *append* rather than overwrite, confirming multi-session
  accumulation works as intended.
- **HTML rendering**: offline test with synthetic rows covering all five
  states (strong, weak, none, failed LLM call, skipped market) plus a
  seeded two-entry history file — confirmed no `undefined`/`NaN` leaks
  and the history table renders from real file content.
- A deliberate type-sabotage test on the history-entry type guard
  correctly failed compilation before being reverted, confirming the
  filter is genuinely type-checked, not silently `any`. A second
  sabotage attempt (replacing a boolean expression with a string
  literal) did *not* fail — not a masked bug, but a real, worth-noting
  TypeScript limitation: `strict: true` does not enforce
  `strictBooleanExpressions`, so a non-boolean value in an `if` condition
  compiles. The underlying code (`Math.sign(a) === Math.sign(b)`) is a
  correct boolean comparison by inspection; this was a test-methodology
  gap, not a shipped defect.

## Changes vs. v0.0.0.5
- New `v0.0.0.7/mispricing-report.ts`.
- New npm script: `mispricing-report-v2`.
- New repo-root `data/` (created on first run) and `docs/` (placeholder
  committed now, overwritten by each real run) folders.
- `v0.0.0.7/output/` added to `.gitignore` (matches `v0.0.0.5/output/`);
  `docs/` and `data/` are deliberately **not** ignored — they need to be
  committed for the Pages link and the history to be visible on GitHub.

## Run
```bash
npm install
npm run mispricing-report-v2
```
Then commit and push `docs/` and `data/signal-history.json` so the
public report and history update. Needs the same funded testnet wallet
as v0.0.0.2-v0.0.0.5 (`PRIVATE_KEY` in `.env`).

## What this version is *not*
- Not a backtest or accuracy claim — see the History section above.
- Not an automated/scheduled pipeline — each entry requires someone to
  run the script; there's no cron job committing on its own (that would
  need storing `PRIVATE_KEY` in GitHub Actions secrets, a meaningfully
  bigger and riskier scope than the remaining time before submission
  justified).
