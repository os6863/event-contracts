# EdgeScope
[![Watch Demo Video](https://img.shields.io/badge/Demo%20Video-YouTube-red?logo=youtube)](https://youtu.be/r1ZgjKMuYm8)

**On-chain mispricing and signal intelligence for DreamDEX Event Contracts, powered by Somnia Agents.**

**Live report:** https://os6863.github.io/event-contracts/

EdgeScope is a read-only analytics tool for DreamDEX Event Contracts on Somnia Shannon. It scans live BTC/ETH binary markets, derives DreamDEX's implied probability from the order book, compares it with independently generated probability estimates, and surfaces meaningful divergences with verifiable Somnia Agent receipts.

**What EdgeScope is for.** EdgeScope does not place orders and is not itself a trading front-end — that is a design choice, not a gap (see "No hidden trading behavior" below). It is a **trust and price-discovery layer** other builders on Event Contracts can sit on top of: a market maker deciding where to quote, a trading bot deciding which markets are worth taking, or a consumer app that wants a "is this market mispriced?" signal can all consume the same verifiable divergence evidence EdgeScope produces. The ecosystem case is infrastructure-shaped, not app-shaped — more reliable price discovery across DreamDEX markets benefits every trading application built on Event Contracts.

We haven't built another AI trader; we've built the layer that makes every AI trader's claims verifiable, scoreable, and accountable.

**No wallet? No problem.** `npm run render-report` regenerates the HTML report from the already-committed `data/latest-report.json` — no `PRIVATE_KEY`, no testnet faucet, no network calls. Only `npm run report` (which fetches fresh prices and LLM estimates) needs a funded wallet. See [Run locally](#run-locally).

## What it does

1. Discovers active DreamDEX BTC/ETH Event Contract markets.
2. Reads opening prices and refreshes the live order book before classification.
3. Applies a liquidity gate so one-sided or wide-spread books are not treated as reliable probabilities.
4. Fetches an independent BTC/ETH price as the median of multiple sources, each read through a Somnia JSON API Request Agent call.
5. Computes a deterministic time-scaled probability baseline, using realized volatility from recent price history when available.
6. Requests an additional probability estimate from the Somnia LLM Inference Agent.
7. Verifies the agent result against the receipt and ABI-decoded value.
8. Classifies divergence from DreamDEX as `strong` (both estimators agree it's mispriced), `conflicted` (both flag it but disagree on direction), `weak` (one estimator flags it), or `none`.
9. Stores a timestamped report and signal history.
10. After settlement, scores predictions using on-chain outcomes and Brier scores.

## Why EdgeScope is trustworthy

- **Receipt-checked estimates:** malformed, truncated, out-of-range, or mismatched agent results are rejected.
- **Liquidity-aware:** only two-sided order books with an acceptable spread are used for signal classification.
- **Timestamped evidence:** the report preserves the market quote, price observation, model outputs, request ID, and receipt link used for each signal.
- **On-chain settlement scoring:** resolved outcomes are read from DreamDEX/Somnia state and used to update track-record metrics.
- **No hidden trading behavior:** EdgeScope is analytics only. It does not place orders or manage user funds.

## Architecture

```text
DreamDEX live markets
        |
        v
Order book + opening price
        |
        +--> Liquidity gate
        |
        v
Somnia JSON API Request Agent --> independent BTC/ETH price (median of sources)
        |
        +--> deterministic baseline
        |
        v
Somnia LLM Inference Agent
        |
        +--> receipt + ABI validation
        |
        v
Divergence / agreement classification
        |
        v
Timestamped EdgeScope report + history
        |
        v
On-chain settlement verification + Brier scoring
```

More detail: [Architecture](docs/ARCHITECTURE.md) · [Methodology](docs/METHODOLOGY.md) · [Demo runbook](docs/DEMO.md)

## Run locally

### Requirements

- Node.js 22+
- A fresh disposable Somnia Shannon testnet wallet
- A small amount of testnet STT for Somnia Agent calls

### Install

```bash
npm ci
cp .env.example .env
```

Generate a disposable testnet wallet if needed:

```bash
npm run generate-wallet
```

Add its private key to `.env` and fund only that disposable address from the Somnia testnet faucet.

### Verify the build

```bash
npm run verify
```

This runs TypeScript type checking and the regression test suite.

### Generate a fresh EdgeScope report

```bash
npm run report
```

### Check settled outcomes

```bash
npm run check-outcomes
```

### Read-only integration smoke test

```bash
npm run test:integration
```

Hits the real testnet indexer, RPC, and on-chain market reads (no `PRIVATE_KEY`, no transactions) to catch a broken connection to live infrastructure that the offline unit suite can't see. Also runs on a schedule in CI — see `.github/workflows/integration-smoke.yml`.

### Automatic scheduled refresh

`.github/workflows/refresh-report.yml` runs `check-outcomes` and `report` on a 6-hour schedule and commits the result if anything changed, so the published report doesn't require someone to remember to run it manually. To enable it on a fork: add a `PRIVATE_KEY` repository secret (Settings → Secrets and variables → Actions) holding a funded disposable testnet wallet's private key. Without that secret the workflow runs and fails cleanly at the report step — it never does anything destructive.

### Re-render the saved report without Agent calls

```bash
npm run render-report
```

No wallet, no `PRIVATE_KEY`, no network calls — regenerates `docs/index.html` from the already-committed `data/latest-report.json`. This is the fastest way for someone reviewing the project to see the UI without setting up a testnet wallet.

## Signal methodology

DreamDEX probability is taken from the midpoint of the best bid and ask **only** when both sides exist and the spread is at most 8 percentage points. Otherwise the market is explicitly marked as insufficient liquidity and no mispricing signal is issued.

The independent estimate combines:

- a deterministic probability baseline based on price move, remaining time, and disclosed volatility assumptions; and
- a Somnia LLM Inference Agent estimate using the same timestamped market inputs.

A signal is:

- **Strong** when both estimates diverge by at least 15 percentage points from DreamDEX in the same direction.
- **Weak** when at least one estimate clears the 15-point threshold but the strong condition is not met.
- **None** otherwise.

The deterministic and LLM estimates are **not claimed to be fully independent evidence** because both ultimately use the observed price move. The ensemble is a transparent hackathon signal, not a calibrated financial model.

See [docs/METHODOLOGY.md](docs/METHODOLOGY.md) for formulas and interpretation limits.

## Track record

When a market settles, EdgeScope records the real winning outcome and calculates:

- DreamDEX Brier score
- Ensemble Brier score
- per-observation averages
- equal-weighted per-unique-market averages
- a clearly labeled simulated-edge summary for resolved signals

The simulated-edge section is **not a backtest or profitability claim**. It ignores fees, slippage, execution, and actual trade size and is shown only as a transparent small-sample diagnostic.

## Important limitations

- The independent external price input is the median of up to three off-chain sources (CoinGecko, Binance, Coinbase — configurable via `MULTI_SOURCE_PRICE` in `.env`), each read through its own Somnia Agent call. It is **not** claimed to reproduce DreamDEX's multi-source settlement oracle. The report labels each observation honestly — `verified multi-source`, `degraded multi-source`, or `single-source fallback` — rather than presenting a one-source read as if it were a real median.
- BTC and ETH volatility in the deterministic baseline uses realized volatility computed from 7 days of hourly Binance klines when available (`USE_REALIZED_VOLATILITY`, default on), falling back to a fixed disclosed assumption (BTC 55% / ETH 70% annualized) otherwise. The report shows which one was used for each estimate.
- The LLM and deterministic estimates share the same underlying price-move observation, so their agreement is not full statistical independence — see [Methodology](docs/METHODOLOGY.md).
- The public report is a point-in-time snapshot. A scheduled workflow (`.github/workflows/refresh-report.yml`) can regenerate and publish it automatically on a cron; without that configured, it only updates when `npm run report` is run and the output is committed.
- This is hackathon/testnet software and has not been audited.

## For integrators

EdgeScope's output is a plain JSON file, documented with a JSON Schema, not a private internal format:

- **Snapshot:** [`data/latest-report.json`](data/latest-report.json) — the current run's rows, matching [`schema/report.schema.json`](schema/report.schema.json).
- **History:** [`data/signal-history.json`](data/signal-history.json) — every logged observation, later annotated with settlement outcomes by `npm run check-outcomes`.

```js
// Minimal consumption example — no SDK required.
const res = await fetch("https://raw.githubusercontent.com/os6863/event-contracts/main/data/latest-report.json");
const { version, generatedAt, rows } = await res.json();
const strongSignals = rows.filter(r => r.agreement === "strong");
```

There is no live HTTP API or webhook yet — a builder wiring EdgeScope into their own tooling today fetches the committed JSON file directly (e.g. via the GitHub raw content URL, or their own copy of the repo). The schema is versioned (`version` field) precisely so that changes here don't silently break a consumer.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Methodology](docs/METHODOLOGY.md)
- [Demo runbook](docs/DEMO.md)
- [SDK / documentation feedback](FEEDBACK.md)
- [Engineering changelog](CHANGELOG.md)
- [Security notes](SECURITY.md)

## Repository layout

```text
src/       application logic, scoring, persistence, renderer, tests, and the integration smoke test
schema/    JSON Schema for the report snapshot (data/latest-report.json)
scripts/   disposable testnet wallet helper
data/      latest report snapshot and accumulated signal history
docs/      GitHub Pages report and judge-facing technical documentation
.github/   CI, the read-only integration smoke test, and the scheduled auto-refresh workflow
```

## License

MIT — see [LICENSE](LICENSE).
