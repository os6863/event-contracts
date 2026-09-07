# EdgeScope

**On-chain mispricing and signal intelligence for DreamDEX Event Contracts, powered by Somnia Agents.**

EdgeScope is a read-only analytics tool for DreamDEX Event Contracts on Somnia Shannon. It scans live BTC/ETH binary markets, derives DreamDEX's implied probability from the order book, compares it with independently generated probability estimates, and surfaces meaningful divergences with verifiable Somnia Agent receipts.

**What EdgeScope is for.** EdgeScope does not place orders and is not itself a trading front-end — that is a design choice, not a gap (see "No hidden trading behavior" below). It is a **trust and price-discovery layer** other builders on Event Contracts can sit on top of: a market maker deciding where to quote, a trading bot deciding which markets are worth taking, or a consumer app that wants a "is this market mispriced?" signal can all consume the same verifiable divergence evidence EdgeScope produces. The ecosystem case is infrastructure-shaped, not app-shaped — more reliable price discovery across DreamDEX markets benefits every trading application built on Event Contracts, including other entries in this same hackathon.

## What it does

1. Discovers active DreamDEX BTC/ETH Event Contract markets.
2. Reads opening prices and refreshes the live order book before classification.
3. Applies a liquidity gate so one-sided or wide-spread books are not treated as reliable probabilities.
4. Fetches an independent BTC/ETH price as the median of multiple sources, each read through a Somnia JSON API Request Agent call.
5. Computes a deterministic time-scaled probability baseline.
6. Requests an additional probability estimate from the Somnia LLM Inference Agent.
7. Verifies the agent result against the receipt and ABI-decoded value.
8. Classifies divergence from DreamDEX as `strong`, `weak`, or `none`.
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

### Re-render the saved report without Agent calls

```bash
npm run render-report
```

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

- The independent external price input is the median of up to three off-chain sources (CoinGecko, Binance, Coinbase — configurable via `MULTI_SOURCE_PRICE` in `.env`), each read through its own Somnia Agent call. It is **not** claimed to reproduce DreamDEX's multi-source settlement oracle, and the report shows exactly how many sources actually backed each median.
- BTC and ETH volatility inputs in the deterministic baseline are fixed disclosed assumptions, not dynamically fitted estimates.
- The LLM and deterministic estimates share the same underlying price-move observation.
- The public report is a reproducible point-in-time snapshot, not a continuously updating trading terminal.
- This is hackathon/testnet software and has not been audited.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Methodology](docs/METHODOLOGY.md)
- [Demo runbook](docs/DEMO.md)
- [SDK / documentation feedback](FEEDBACK.md)
- [Engineering changelog](CHANGELOG.md)
- [Security notes](SECURITY.md)

## Repository layout

```text
src/       application logic, scoring, persistence, renderer, and tests
scripts/   disposable testnet wallet helper
data/      latest report snapshot and accumulated signal history
docs/      GitHub Pages report and judge-facing technical documentation
```

## License

MIT — see [LICENSE](LICENSE).
