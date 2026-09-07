# EdgeScope Architecture

EdgeScope is a read-only market-intelligence pipeline for DreamDEX Event Contracts on Somnia Shannon.

## Data flow

1. Discover live DreamDEX BTC/ETH binary markets.
2. Read opening prices and refresh the order book immediately before classification.
3. Apply a liquidity gate: only two-sided books with spread <= 8 percentage points are treated as a market probability.
4. Fetch an independent BTC/ETH price through a Somnia JSON API Request Agent.
5. Compute a deterministic time-scaled baseline probability.
6. Request a probability estimate from the Somnia LLM Inference Agent.
7. Validate the agent result against the receipt and ABI-decoded value.
8. Compare both estimates against the DreamDEX midpoint and classify agreement as strong, weak, or none.
9. Persist a timestamped snapshot and signal history.
10. After settlement, read the on-chain outcome and update Brier scores.

## Trust boundaries

- DreamDEX order-book data is venue data and is not substituted with the external price source.
- CoinGecko is an independent off-chain price input consumed through Somnia Agents; it is not claimed to reproduce DreamDEX's settlement oracle.
- Agent execution and receipts are verifiable; malformed or mismatched final answers are rejected.
- Thin, one-sided, or wide-spread books never produce a mispricing signal.
- Settlement scoring uses on-chain market state.

## Repository layout

- `src/` — final application source, scoring, persistence, renderer, and tests.
- `scripts/` — local developer helpers.
- `data/` — latest reproducible snapshot and accumulated signal history.
- `docs/` — GitHub Pages artifact and technical documentation.
- `CHANGELOG.md` — final-build engineering notes and bugs caught during live testnet development.
