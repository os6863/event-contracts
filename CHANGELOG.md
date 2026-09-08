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

## v0.1.0 — external review pass: honest labels, measured inputs, integration surface

An external technical review of the live report (with the project no longer being submitted to the hackathon, now being finished as a standalone portfolio piece) identified ten issues. All ten were acted on; none were left as "future work" hand-waving.

**Fixed as code, verified with `npm run typecheck` / `npm test` (24/24 passing):**

- **Conflicting-direction signals were mislabeled "weak."** When both estimators cleared the mispricing threshold but disagreed with each other about direction, the old classifier called that "weak" — the same label as one estimator being silent. That's model disagreement, not a directional signal. Added a fourth class, `conflicted`, with its own badge, filter, KPI tile, and explanation text; excluded from the Simulated Edge staking simulation, since there is no coherent "side the ensemble diverged toward" when the two models actively disagree.
- **"Median of 1" implied more verification than it had.** A single surviving source (after the other two failed) was displayed with the same "median of N" phrasing as a real 3-source median. Added `priceSourceQuality()`: `verified-multi-source` (all configured sources succeeded), `degraded-multi-source` (2+ succeeded, not all), or `single-source-fallback` (exactly one) — labeled honestly in the verification snapshot, never implying agreement that didn't happen.
- **Fixed volatility assumption, not a measured one.** `naiveProbability` now accepts an optional realized-volatility override; when available, it's computed from 7 days of hourly Binance klines (`computeRealizedVolatility` — sample stdev of log returns, annualized) via a plain HTTPS call, not a Somnia Agent call (this is a calibration input, not evidence requiring on-chain verification, and is labeled as such in the report). Falls back to the original fixed disclosed constant automatically on any fetch failure — `USE_REALIZED_VOLATILITY=false` reverts to the old behavior with no code change. The report now shows which one was used for each estimate. `naiveProbability`'s existing call signature is preserved exactly (the override is optional), so this is additive, not a replacement.
- **"Our model beat the market" framing risk.** The hero copy and KPI row now state plainly that EdgeScope is "an evidence and accountability layer, not a profitability engine" — addressed in the product's own copy, not left to a demo script to frame correctly.
- **No integration surface.** Added `schema/report.schema.json` (JSON Schema, draft-07) documenting `data/latest-report.json`'s shape, with a test (`report.schema.json's required reportRow fields...`) that checks the schema's required fields actually exist on a real row, so schema and implementation can't silently drift apart. Added a "For integrators" README section with a minimal fetch/parse example. This is a documented static schema, not a live HTTP API — that limitation is stated, not hidden.
- **No read-only integration smoke test.** Added `src/integration-smoke.ts` (`npm run test:integration`) — hits the real indexer (`loadMarkets`), RPC (`getBlockNumber`), on-chain market state (`getMarketOnchain`), opening prices, and the order book, all read-only with no `PRIVATE_KEY`. Wired into a separate, non-blocking scheduled CI workflow (`.github/workflows/integration-smoke.yml`, `continue-on-error: true`) so a transient testnet hiccup (the same kind of RPC error logged earlier in this file) never fails an unrelated pull request.
- **Report is a manual snapshot.** Added `.github/workflows/refresh-report.yml`: runs `check-outcomes` then `report` on a 6-hour schedule and commits the result if it changed. Requires a `PRIVATE_KEY` repository secret the user must add themselves (a workflow file cannot grant itself secrets) — documented in README. Without that secret it fails cleanly at the report step; it never does anything destructive.
- **Stale command references.** `check-outcomes.ts`'s fallback message referenced a script name (`mispricing-report-v5`) that hasn't existed for several versions; fixed to `npm run report`.
- **Unconventional version string.** `0.0.0.10` renamed to `0.1.0` throughout (`package.json`, the snapshot `version` field written to `data/latest-report.json`, and the guard that validates it on read). Existing snapshots must be regenerated once (`npm run report`) after upgrading — the version guard intentionally does not accept both old and new strings indefinitely.
- **Render-only path wasn't prominent enough.** `npm run render-report` (no wallet, no network calls, regenerates the HTML from the already-committed JSON) already existed but was buried; it's now called out at the top of the README for a reviewer who doesn't want to set up a testnet wallet just to look at the UI.
- **Missing competitive framing.** Added directly to the README: "We haven't built another AI trader; we've built the layer that makes every AI trader's claims verifiable, scoreable, and accountable."

**Explicitly not done, and why:**

- **Settlement backlog ("Pending verification" markets).** Fixing stale history requires running `npm run check-outcomes` against the live chain with a funded wallet — this is an execution step, not a code change, and has to be run by whoever holds the wallet. The new scheduled workflow prevents the backlog from recurring, but clearing the existing backlog is a one-time manual (or first-scheduled-run) action.
- **Replacing the LLM with a non-LLM primary estimator** (realized volatility / Brownian model / order-flow momentum, as the review suggested as alternatives). Realized volatility was added to the *existing* deterministic baseline, which materially reduces reliance on the weaker LLM component without removing it — removing Somnia LLM Inference Agent usage entirely would remove EdgeScope's stated headline differentiator (built on the Somnia Agents platform itself), which is a product decision, not a bug fix, and was out of scope for this pass.

**Validation:** `npm run typecheck` passed; `npm test` — 24/24 passed (5 new: `computeRealizedVolatility` edge cases and monotonicity, `priceSourceQuality` labeling, the schema-consistency check, the honest price-quality-label rendering, and the realized-vol/fixed-assumption display — plus 2 existing tests updated to assert the new, deliberately-changed `conflicted` behavior instead of the old mislabeling). The Binance klines fetch and the two new GitHub Actions workflows have not been exercised against live infrastructure from this environment — see the handoff notes for what to verify locally.

### Follow-up, caught by a live run: indexer retry window was too short

Live `npm run report` runs after v0.1.0 landed hit `RegistryMarkets failed: The operation was aborted due to timeout` on three separate attempts across several minutes — not a single blip, a genuinely degraded indexer window (the DreamDEX indexer is shared testnet infrastructure and its reliability outside the hackathon's main window is not guaranteed). The retry window at the time (3 attempts, linear 2s/4s backoff — under 6s total) wasn't built for that; a briefly degraded service needs more time to recover than a one-off packet loss does.

Fixed: `INDEXER_RETRY_ATTEMPTS` (default 5) and `INDEXER_RETRY_BASE_DELAY_MS` (default 3000) are now env-configurable, with exponential backoff (`indexerBackoffDelayMs`, unit-tested) instead of linear — default window is ~45s across 5 attempts, and can be raised further with no code change if the indexer needs longer. `npm run typecheck` passed; `npm test` — 25/25 passed (1 new test for the backoff formula).

### Follow-up, caught by the first real GitHub Actions run: check-outcomes hung for 16+ minutes in CI

The first manual run of the new scheduled workflow showed `npm run check-outcomes`'s own output complete successfully (all markets settled, "16 resolved prediction records, 0 lookup failures" printed) while the GitHub Actions step itself stayed "in progress" for 16+ minutes with no further output. This did not reproduce locally, where the same command returns control to the shell promptly — the difference is that `check-outcomes.ts` never force-exited the Node process, unlike `mispricing-report.ts`, which already did. A lingering open handle (most likely the `SomniaMarkets` WebSocket transport not fully tearing down in the CI network environment even after `exchange.close()`) can keep Node's event loop alive indefinitely once the script's actual work is done, and GitHub Actions waits for the process to exit, not for output to stop.

Fixed in both `check-outcomes.ts` and `src/integration-smoke.ts` (which had the same latent risk and, worse, never called `exchange.close()` at all) by force-exiting after `main()` settles — `main().then(() => process.exit(...)).catch(...)`, matching the pattern `mispricing-report.ts` already used. Safe in both cases: every async write (`saveHistory`, `writeReport`) is already awaited before `main()` resolves, so nothing is cut short. `npm run typecheck` passed; `npm test` — 25/25 passed (no test change; this is a process-lifecycle issue the unit suite, which never spawns the script as a subprocess, cannot observe).

### Follow-up, caught by the second live CI run: unhelpful private-key error

After the hang fix, the scheduled workflow's `npm run report` step failed with viem's generic `invalid private key, expected hex or 32 bytes, got string` — no hint which of several possible causes it was (missing `0x` prefix, wrong length, stray whitespace from copy-pasting into a GitHub secret field). Root cause: the `PRIVATE_KEY` GitHub Actions secret had been pasted without its `0x` prefix — easy to do, since some wallet UIs display keys without it, while `generatePrivateKey()` (and therefore `npm run generate-wallet`) always includes it. Fixed on GitHub by correcting the secret value directly.

As defense-in-depth (not the fix that unblocked the workflow — the corrected secret did that — but worth having so a future misconfiguration is diagnosable): extracted `normalizePrivateKey()`, which trims whitespace, adds a missing `0x` prefix, and validates the result is exactly 32 bytes of hex with a specific, actionable error message naming what's wrong, instead of leaving viem's opaque error as the only signal. `npm run typecheck` passed; `npm test` — 26/26 passed (1 new test covering the missing-prefix case, whitespace, and length validation).

## Response to a friend's technical audit — one real bug, one enhancement, one rejected suggestion

A developer friend reviewed the live report and produced a written audit with 4 findings. Each was independently verified against the actual code and live data before acting — one of the suggested fixes, if applied as written, would have broken currently-correct data.

**Real bug, fixed (but not as originally suggested):** the audit correctly identified that two long-dated markets (`*-19OCT26`) showed an opening price roughly 1,000,000x too large (e.g. $79,610,750,000 instead of ~$79,611), producing a fabricated ~-100% price move and a false "strong signal". Verified against live `data/latest-report.json`: this affected exactly 2 of 10 markets in that run — the other 8 (`*-07SEP26`, `*-08SEP26`) had correctly-scaled opening prices. The audit's proposed fix (divide every opening price by a fixed `10^6`) would have corrected the 2 broken markets but corrupted the 8 correct ones (turning a correct $79,244 into $0.079244). Implemented instead: `isImplausibleOpeningPrice()`, comparing the on-chain opening price against the independently-fetched current price (which is verified-correct by construction) — if the ratio exceeds 50x in either direction, the market is skipped with a clear issue message rather than analyzed on fabricated data, regardless of which specific decimals convention caused the mismatch. This fixes the reported defect without any risk to the markets that were never broken.

**Enhancement, implemented:** the audit's suggestion to show which side's prediction was actually closer to a settled outcome, per-record — implemented as a new "Closer call" column on the existing Recent signal history table (a per-record view of the same DreamDEX-vs-Ensemble comparison the Track Record Brier scores already summarize in aggregate), rather than as a separate duplicate table.

**Suggestion evaluated and rejected:** the audit proposed adding "Buy YES/NO on DreamDEX" deep-link buttons to each market card, framed as boosting Ecosystem Impact. Not implemented, for two reasons: (1) it reverses this project's explicit, repeatedly-stated positioning as a read-only evidence/accountability layer rather than a trading tool — see "What EdgeScope is for" in README; (2) more importantly, it would be actively poor advice given the project's own Track Record: on the current settled sample, DreamDEX's own pricing has a *lower* (better) Brier score than EdgeScope's ensemble (0.0846 vs 0.1745 per unique market) — recommending trades against a market the tool's own numbers show it currently disagrees with less accurately than the market itself would be irresponsible.

**Two other findings evaluated and found already resolved:** the audit's suggestion to replace the "fixed volatility assumption" with a realized-volatility model was already shipped in v0.1.0 (`computeRealizedVolatility` from Binance klines) — the audit's screenshot appears to be from a market instance where that fetch happened to be unavailable, not a missing feature. The audit's claim of an empty `role="group"` filter container was checked against the current deployed `docs/index.html` and found already populated with working filter buttons (All/Strong/Conflicting/Weak/No signal), also shipped in v0.1.0 — likely a stale cached page.

**Validation:** `npm run typecheck` passed; `npm test` — 28/28 passed (2 new: `isImplausibleOpeningPrice` using the exact real numbers from the live bug plus the 8 markets that must not be flagged, and the "Closer call" column rendering).

### Follow-up, confirmed by comparing a local run against the CI-generated snapshot: Binance blocks the realized-volatility fetch from GitHub Actions

Comparing `data/latest-report.json` as committed by the scheduled GitHub Actions workflow against a local run showed every market in the CI-generated snapshot silently falling back to the fixed disclosed volatility assumption, while the identical code produced real realized-volatility figures locally. Root cause: Binance blocks requests from many cloud-datacenter IP ranges (including GitHub Actions runners) for regulatory reasons — this is a known, structural restriction, not a transient outage, so it would have silently degraded every scheduled run indefinitely.

Fixed by trying CoinGecko's `market_chart` endpoint first (no equivalent IP restriction, and already used elsewhere in this file as a price source), falling back to Binance's klines endpoint as a second attempt for environments where it is reachable, before finally falling back to the fixed disclosed assumption if both external sources fail. Each failure is now logged with its actual reason instead of being silently swallowed, and the log line reports which source actually succeeded (`... 7d, CoinGecko`), which matters for diagnosing exactly this class of environment-dependent reachability issue in the future. `npm run typecheck` passed; `npm test` — 28/28 passed (no test change: the fetch orchestration itself isn't unit-tested, consistent with how `fetchMultiSourcePrice` is handled elsewhere in this file — only the pure `computeRealizedVolatility` math is unit-tested, and it is unchanged).

### Two small operational fixes from live use

**Unsupported-asset markets producing an all-`n/a` card.** The scanner picked up every active binary market on the venue, including non-BTC/ETH markets (observed live: `BOTNAV-*`, agent-NAV markets like "Will agent Kestrel 7 close session #11 with a higher NAV?"). EdgeScope has no price source for anything but BTC/ETH, so these always rendered a full card of `n/a` fields with "Incomplete or stale inputs prevented estimation" — correct behavior (no fabricated number), but cluttered the report with cards that could never show a signal. `scanLiveMarkets` now skips any market whose asset isn't in `ASSET_SELECTORS` (the same BTC/ETH list every price-fetch path already uses) before it's ever turned into a row, rather than turning it into an all-`n/a` card.

**Settlement lag up to 6 hours.** The scheduled workflow ran every 6 hours, so a market could sit at "Pending verification" for up to 6 hours after it genuinely resolved on-chain, purely because the next scheduled check hadn't run yet — not a bug, just latency, confirmed by checking live `data/signal-history.json` against the current time (every "Pending" entry had a genuinely future expiry; every already-past-expiry entry was already correctly "Resolved"). `.github/workflows/refresh-report.yml`'s cron changed from `0 */6 * * *` to `7 * * * *` — hourly, offset 7 minutes past the hour to avoid GitHub's on-the-hour scheduling crunch. Reduces the maximum lag from 6 hours to 1.

`npm run typecheck` passed; `npm test` — 28/28 passed (no test change: the asset filter is inside `scanLiveMarkets`, which — like the rest of the live-SDK scanning path — isn't unit-tested, consistent with the rest of this file; the cron change has no unit-testable surface).

## Response to a second developer review — one real fix, two claims that didn't hold up, one decision left with the user

**Verified false against the live deployed page:** the review claimed AI reasoning is "displayed raw and directly" — checked the live DOM: the reasoning section is a native `<details>` element, collapsed by default (`open: false`), and its content already leads with a clean "INPUT SUMMARY · GENERATED FROM REPORT DATA" block (move, time, comparison) before the raw "Original agent reasoning" text, clearly labeled and visually secondary. Both structural safeguards the review suggested already existed. Not changed: the raw reasoning's actual wording (hedging, uncertainty) — editing the LLM's genuine uncertainty to sound more confident for judges would be manufacturing false confidence, directly against this project's evidence-and-accountability positioning.

**Real, fixed:** a run where every usable market agrees within the 15-point threshold (0 strong, 0 conflicting, 0 weak — confirmed live: exactly this state, 4/12 usable markets, all "none") can read as the tool not working. Rejected the review's suggested fix (keep a curated "nicer" snapshot alongside live data — this is presenting cherry-picked data as representative, which contradicts the whole point of an accountability layer). Instead added an honest inline note directly in the report — appears only when every usable market is unflagged, explains plainly that agreement is the expected common case and a signal means real divergence was found — plus a matching demo talking point in docs/DEMO.md so it's addressed proactively, not just reactively in the UI.

**Left for the user to decide, not silently overridden:** the review flagged the two "Pricefeed test" markets rendering `n/a` cards as clutter — but this was already discussed and explicitly decided against removing, since they're the hackathon organizers' own test fixtures, not EdgeScope's to filter out. Noted for the user rather than acted on unilaterally.

**Already correctly represents reality, no action:** the decimals/units bug on the two October markets — the review's own framing (system catches and skips it, root cause is upstream in the indexer) already matches what the report says; there's no indexer-level fix available from this codebase. Testnet-wallet dependency for a fresh report — already mitigated by `render-report`, and the review itself called this a minor point.

`npm run typecheck` passed; `npm test` — 29/29 passed (1 new: the zero-signal note renders only when every usable market is unflagged, and stays silent when there's at least one signal or when there are no usable markets at all — a different situation with its own existing empty-state message).

### Pricefeed-test markets: labeled, not removed — the decision the user actually made

Two "Pricefeed test" markets (hackathon-organizer fixtures, not standard EdgeScope-relevant contracts) were rendering as unexplained all-`n/a` cards. Removing them was explicitly considered and rejected earlier (they aren't this project's fixture to remove, and doing so risks running afoul of a rule this repo doesn't have visibility into) — leaving them unlabeled was also rejected, since an unexplained `n/a` card reads as EdgeScope failing on a real market, undermining the same "evidence and accountability" claim this project is built on.

Landed the middle option: `ReportRow.isOrganizerTestFixture` is set from an explicit "test" marker the market creator put in the question text (e.g. "Pricefeed test: ...") — this reads a label the creator chose, not parsing the question to derive price or asset data, which the SDK docs specifically warn against. When true, the card shows a visible "ORGANIZER TEST FIXTURE" tag in the header (no need to expand anything to see it) and a specific explanation: this is the organizers' own infrastructure test, not part of EdgeScope's live signal data, kept in the report rather than filtered. Same pattern already used for the opening-price plausibility guard: disclose plainly rather than silently drop or silently render.

`npm run typecheck` passed; `npm test` — 30/30 passed (1 new: the tag and explanation appear only when `isOrganizerTestFixture` is set).
