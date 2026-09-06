# v0.0.0.9 — External code review: time-scaling fix + cleaner reasoning

## Why this version exists
The project was shown to an outside programmer for review before
submission. Their feedback covered five points; each was checked
against the actual code and actual DreamDEX documentation before acting
on it — not accepted or rejected on the reviewer's authority alone.

## Findings and what was done about each

**1. "AI reasoning" shows raw, rambling model output — clean it up.**
Valid. Fixed by rewriting the system prompt to ask the model to
structure its chain-of-thought as three short labeled sections ("Move
assessment", "Time-weight rationale", "Conclusion") instead of
open-ended stream-of-consciousness. `chainOfThought` stays on — this is
still the model's real, unedited reasoning, just asked to think in a
cleaner shape, not a post-hoc rewrite of its output.

**2. The report is static — add a live-updating view.**
Partially valid, not implemented. This project has never made a raw
GraphQL call to the DreamDEX indexer directly (every read has gone
through the `@somnia-chain/markets-sdk`'s own abstractions); writing an
untested client-side fetch against an undocumented query shape, days
before the deadline, risked shipping a broken or silently-failing "live"
widget — a worse outcome than an honest static snapshot. A genuinely
live view would need either a scheduled job holding `PRIVATE_KEY` in CI
secrets (a real security/scope tradeoff already declined once in
v0.0.0.7/CHANGES.md) or every visitor paying their own Somnia Agent
calls from their own wallet (a much bigger product, not a bug fix).
**Not implemented** — documented as a known limitation in README's
"What this project is not" instead of silently ignored.

**3. README lacks architecture/math/contract details.**
Valid — the "Formulas" and "Somnia testnet details" sections were
missing. Added both to README.md: the exact naive/ensemble/divergence
formulas, and a table of every contract address, agent id, and endpoint
this project actually calls.

**4. Add a "Trade YES on DreamDEX" deep-link button next to each signal.**
**Rejected, with evidence.** Checked `docs.dreamdex.io` directly before
deciding: DreamDEX describes itself explicitly as liquidity
infrastructure for third parties to build a frontend on top of ("Third-
party apps are welcome to build on top of our book... and keep... the
user relationship for themselves") — there is no public DreamDEX
trading web app to link to. Searched the docs' outbound links directly;
the only external link found anywhere in the docs is to TradingView,
unrelated. Fabricating a URL like `app.dreamdex.io/market/{id}` without
confirming it exists would ship a broken or misleading link to judges —
exactly the class of mistake this project's whole review process (see
every other version's CHANGES.md) exists to catch, not introduce at the
last minute.

**5. The naive model should scale with time via sqrt(t) (Brownian
motion), not a fixed linear formula.**
Valid, and a real, previously-unnoticed gap: the naive formula
(`0.5 + SENSITIVITY * movePct/100`) had never taken time-to-expiry into
account at all, since v0.0.0.3. The same % move produced the same
estimate whether 15 minutes or 24 hours remained — wrong, since under a
standard random-walk assumption, price-move standard deviation scales
with `√t`, not linearly. **Fixed** — see "The new naive formula" below.

## The new naive formula
```
σ_window = σ_annual(asset) × √(minutes_left / minutes_per_year)
z        = (price_move_% / 100) / σ_window
naive_p  = Φ(z)                          — Φ = standard normal CDF
```
This is the same time-scaling principle behind the "d2" term in
Black-Scholes digital/cash-or-nothing option pricing — not the full
option-pricing machinery (no drift/rate terms), but the missing time
dimension is now real. `σ_annual` (0.55 for BTC, 0.70 for ETH) is an
assumed, round, commonly-cited figure — not fitted from historical
price data, which this project has no pipeline for. A production
version would estimate realized or implied volatility instead.

## Validation
- **`normalCDF`**: the standard Abramowitz & Stegun 7.1.26 erf
  approximation, checked offline against known reference values
  (`CDF(0)=0.5000000005`, `CDF(1.96)=0.9750...`, `CDF(-1)=0.1587...`)
  before use — all matched to ~1e-7, the approximation's documented
  accuracy.
- **Time-scaling behavior**: checked offline that the *same* +0.5% move
  produces meaningfully different estimates depending on time left —
  15 min: 0.9556, 60 min: 0.8026, 240 min: 0.6647, 1440 min (24h):
  0.5689 — confirming more time left correctly pulls the estimate back
  toward 0.5 (more room to reverse), which is exactly the property the
  old linear formula was missing.
- **Zero-move invariance**: a 0% move returns exactly 0.5 regardless of
  time remaining, as it should.
- Two deliberate sabotage tests (a broken `normalCDF` sign branch and a
  reverted `naiveProbability` call signature) both correctly failed
  compilation before being reverted.
- Not yet validated against a live run at the time of writing this file
  — the formula and its behavior are confirmed offline; whether the
  reworded system prompt actually produces cleaner reasoning text still
  needs a real LLM Inference call to see.

## Changes vs. v0.0.0.8
- `naiveProbability()` signature changed from `(movePct)` to
  `(movePct, minutesLeft, asset)` — both call sites updated.
- New constants: `ASSET_ANNUAL_VOLATILITY`, `DEFAULT_ANNUAL_VOLATILITY`,
  `MINUTES_PER_YEAR`; removed `NAIVE_SENSITIVITY` (no longer used).
- New `normalCDF()` helper.
- `buildPrompt()`'s system prompt updated with the structured-reasoning
  instruction.
- `README.md` gained "Formulas" and "Somnia testnet details" sections,
  and two new limitations noted in "What this project is not".
- New npm script: `mispricing-report-v4`; `check-outcomes` now points
  at this version's copy.

## Run
```bash
npm install
npm run mispricing-report-v4
npm run check-outcomes
```

## What this version is *not*
- Does not add a live-updating view or a trade-execution link — see
  findings 2 and 4 above for why, in detail.
- `σ_annual` remains an assumed constant, not a fitted/real volatility
  estimate.
