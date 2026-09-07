# EdgeScope — DreamDEX Mispricing & Edge Detector

**Somnia × DreamDEX Event Contracts Hackathon**

EdgeScope is a read-only market-intelligence tool for DreamDEX Event Contracts. It compares DreamDEX's own order-book probability with an independently sourced probability estimate produced through Somnia Agents, then surfaces meaningful divergence with verifiable evidence.

**Live report:** https://os6863.github.io/event-contracts/

## Why EdgeScope

A large probability gap is only useful if the inputs are trustworthy. EdgeScope therefore refuses to classify thin books, validates Agent outputs against their receipts, timestamps the exact inputs used for each estimate, and checks settled outcomes on-chain afterward.

### Trust by construction

- **Liquidity gate** — one-sided, empty, or wide-spread books never become a mispricing signal.
- **Receipt-checked Agent output** — malformed or ABI-mismatched LLM answers are rejected.
- **Timestamped evidence** — market quote, external price, time remaining, and receipt are preserved per observation.
- **On-chain outcome verification** — settled predictions are scored with Brier scores.
- **Unique-market scoring** — repeated observations of one market do not silently dominate the track record.
- **No automated trading** — EdgeScope analyzes; it does not place orders or manage user funds.

## How it works

```text
DreamDEX Event Contract
  ├─ opening price
  ├─ best bid / ask
  └─ on-chain market state
            │
            ▼
      Liquidity gate
            │
      two-sided + tight
            │
            ▼
Somnia JSON API Request Agent
  └─ independent BTC/ETH price (CoinGecko)
            │
            ├──────────────► deterministic time-scaled baseline
            │
            ▼
Somnia LLM Inference Agent
  └─ probability estimate + verifiable receipt
            │
            ▼
   receipt/result validation
            │
            ▼
 baseline + LLM vs DreamDEX probability
            │
       strong / weak / none
            │
            ▼
 snapshot + history + settlement scoring
```

## Signal methodology

The deterministic baseline uses a volatility-scaled, time-aware normal-CDF estimate:

```text
sigma_window = sigma_annual × sqrt(minutes_left / minutes_per_year)
z            = (price_move_% / 100) / sigma_window
baseline_p   = Phi(z)
```

Current disclosed volatility assumptions are BTC `0.55` and ETH `0.70`. They are not fitted historical estimates.

For classification:

- **Strong** — both baseline and LLM differ from DreamDEX by at least 15 percentage points in the same direction.
- **Weak** — at least one clears the 15-point threshold, but the pair does not satisfy the strong condition.
- **None** — neither clears the threshold.
- **Insufficient liquidity** — no signal is issued at all.

The ensemble probability is the simple average of the deterministic baseline and accepted LLM estimate. See [`docs/METHODOLOGY.md`](docs/METHODOLOGY.md) for assumptions and interpretation limits.

## Quickstart

Requirements: Node.js 18+ and a disposable Somnia Shannon testnet wallet for fresh Agent calls.

```bash
git clone https://github.com/os6863/event-contracts.git
cd event-contracts
npm install
cp .env.example .env
npm run generate-wallet
```

Fund the generated address with free Shannon testnet STT, put only that disposable private key in `.env`, then run:

```bash
npm run report
npm run check-outcomes
```

To verify the code and rebuild the published snapshot without new Agent calls:

```bash
npm run verify
npm run render-report
```

## Cost

The project is designed for **zero-dollar testnet use**:

| Step | Approximate cost |
|---|---:|
| DreamDEX market scan | 0 STT |
| JSON price Agent | ~0.03 STT per unique asset |
| LLM inference Agent | ~0.07 STT per market plus platform execution overhead |
| Outcome checking | read-only |

Use `MAX_MARKETS` in `.env` to cap a fresh run while testing.

## Somnia / DreamDEX integration

| Component | Value |
|---|---|
| Network | Somnia Shannon Testnet |
| Chain ID | `50312` |
| DreamDEX SDK | `@somnia-chain/markets-sdk` |
| Somnia Agents contract | `0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776` |
| JSON API Request Agent | `13174292974160097713` |
| LLM Inference Agent | `12847293847561029384` |
| Receipts service | `https://receipts.testnet.agents.somnia.host` |

Agent IDs and testnet endpoints are platform data and may change.

## Repository layout

```text
src/                    final application source and tests
scripts/                disposable-wallet helper
data/                   latest snapshot + signal history
docs/                   GitHub Pages report + technical docs
.github/workflows/      CI typecheck and tests
CHANGELOG.md             engineering notes and live bugs caught
FEEDBACK.md              DreamDEX / SDK documentation feedback
SECURITY.md              testnet wallet and secret-handling guidance
```

## Evidence, not just claims

The repository includes a growing signal history and an on-chain-settlement track record. The report shows:

- raw DreamDEX quote evidence;
- liquidity state and spread;
- baseline and LLM estimates;
- Agent receipt links;
- Oracle Explorer resolution links where available;
- per-observation and per-unique-market Brier scoring;
- hypothetical flat-stake simulated-edge statistics with explicit sample size.

The simulated-edge section is a transparency diagnostic over a small resolved sample, **not a profitability claim or backtest of executed trades**.

## Important limitations

- CoinGecko is an independent off-chain price input consumed through Somnia Agents. It is **not** claimed to reproduce DreamDEX's multi-source settlement oracle.
- Agent execution and receipts are verifiable on Somnia; the underlying CoinGecko price itself is not on-chain data.
- The deterministic baseline and LLM estimate both depend on the same observed price move, so they are not fully independent evidence.
- Annual volatility inputs are fixed disclosed assumptions rather than dynamically estimated realized volatility.
- The published report is a reproducible point-in-time snapshot, not a continuously refreshing dashboard.
- This is unaudited hackathon/testnet software.

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — final data flow and trust boundaries
- [`docs/METHODOLOGY.md`](docs/METHODOLOGY.md) — formulas, signal rules, scoring and limitations
- [`docs/DEMO.md`](docs/DEMO.md) — judge/demo runbook
- [`CHANGELOG.md`](CHANGELOG.md) — engineering evolution and real bugs caught during testnet development
- [`FEEDBACK.md`](FEEDBACK.md) — SDK/documentation feedback
- [`SECURITY.md`](SECURITY.md) — testnet wallet guidance

## Links

- [DoraHacks — Event Contracts Hackathon](https://dorahacks.io/hackathon/event-contracts/detail)
- [DreamDEX Event Contracts docs](https://docs.dreamdex.io/developers/event-contracts)
- [Somnia Agents docs](https://docs.somnia.network/agents)
- [Somnia Agent Explorer](https://agents.testnet.somnia.network)

---

Built for the **Somnia × DreamDEX Event Contracts Hackathon**.
