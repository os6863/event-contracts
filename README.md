# Event Contracts — Mispricing & Edge Detector

**Somnia × DreamDEX Event Contracts Hackathon**

An analytics tool — not a trading bot — that scans live DreamDEX Event
Contract markets (Up/Down prediction markets on BTC/ETH), compares each
market's own implied probability against an **independent, on-chain**
probability estimate, and surfaces markets where the two disagree by a
meaningful margin.

The independent estimate isn't a number our own backend just claims to
have computed. It comes from two real **Somnia Agents** — consensus-
validated, on-chain compute jobs — chained together: one fetches a live
price, the other (an LLM) reasons about it. Both the computation and the
result are verifiable on-chain, not a black box.

## Cost

**Zero dollars.** Everything runs on testnet:
- DreamDEX: Somnia Shannon Testnet (chain 50312), tUSDC collateral
- Somnia Agents: same testnet, gas paid in free STT
- External price data: CoinGecko's free tier (no key)

The only "cost" is free testnet STT, obtained from a faucet (see
Setup below).

## How it works

```
 DreamDEX indexer                Somnia Agents platform
┌──────────────────┐   ┌─────────────────────────────────────────┐
│  live Up/Down     │   │  JSON API Request agent                  │
│  markets, order   │   │   → fetches BTC/ETH price from CoinGecko │
│  book, opening    │   │     (3 validators reach consensus)       │
│  price            │   │                                          │
└─────────┬─────────┘   │  LLM Inference agent (Qwen3-30B)         │
          │             │   → given opening price, current price,  │
          │             │     % move, time remaining → estimates   │
          │             │     probability of YES, with reasoning   │
          │             └───────────────────┬───────────────────────┘
          │                                 │
          └───────────────┬─────────────────┘
                           ▼
              compare DreamDEX's own implied
              probability vs. the Agent-derived
              estimate → flag large divergence
                           │
                           ▼
              console table + styled HTML report
```

## Formulas

**Naive baseline** — a volatility-scaled, time-aware estimate (not a
plain linear guess; see [v0.0.0.9/CHANGES.md](v0.0.0.9/CHANGES.md) for
why the earlier linear version was wrong):

```
σ_window = σ_annual(asset) × √(minutes_left / minutes_per_year)
z        = (price_move_% / 100) / σ_window
naive_p  = Φ(z)                          — Φ = standard normal CDF
```
`σ_annual` is an assumed constant per asset (BTC 0.55, ETH 0.70) — not
fitted from historical price data, which this project doesn't collect.
The `√t` scaling matches standard random-walk / Black-Scholes practice:
the same % move is far more significant with little time left than with
a lot of time left.

**LLM estimate** — from the Somnia LLM Inference agent (Qwen3-30B),
prompted with the same opening price, current price, % move, and time
remaining, plus calibration anchor points (see
[v0.0.0.4/CHANGES.md](v0.0.0.4/CHANGES.md) for how those anchors were
tuned against real miscalibration bugs).

**Ensemble & divergence:**
```
ensemble_p = (naive_p + llm_p) / 2
divergence = ensemble_p − dreamdex_implied_p
```
A market is flagged **strong** only when both `naive_p` and `llm_p`
individually diverge from DreamDEX's price by ≥ 0.15 **in the same
direction** — not just the averaged ensemble. **weak** means only one of
the two diverges. See
[v0.0.0.7/CHANGES.md](v0.0.0.7/CHANGES.md) for the real case (an LLM
call returning 0.99 for a market that had moved *down*) this guard was
built to catch.

## Somnia testnet details

| | |
|---|---|
| Chain | Somnia Shannon Testnet, chain id `50312` |
| Somnia Agents platform contract | `0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776` |
| JSON API Request agent id | `13174292974160097713` |
| LLM Inference agent id | `12847293847561029384` |
| Receipts Service | `https://receipts.testnet.agents.somnia.host` |
| DreamDEX indexer (via SDK) | `https://dev.smk.somnia.host/v1/graphql` |
| Agent Explorer | https://agents.testnet.somnia.network |

Agent ids and the venue id used to filter DreamDEX's markets are
platform data, not guaranteed permanent — see
[v0.0.0.1/CHANGES.md](v0.0.0.1/CHANGES.md) and
[v0.0.0.2/CHANGES.md](v0.0.0.2/CHANGES.md) for what to do if a script
ever reports zero markets/agents unexpectedly (the scripts have
built-in discovery fallbacks for exactly this).

## Quickstart (run the current version)

```bash
git clone https://github.com/os6863/event-contracts.git
cd event-contracts
npm install
cp .env.example .env
```

Two setup steps before the first real run:

**1. Get a wallet.** Read-only steps (scanning markets) don't need one,
but every version from v0.0.0.2 onward writes to the chain and needs a
funded, disposable testnet wallet:
```bash
npm run generate-wallet
```
This prints a fresh address and private key — never reuse a real wallet
here. Paste the private key into `.env` as `PRIVATE_KEY`.

**2. Fund it with free testnet STT.** The most reliable faucet found
during development is Google Cloud's:
https://cloud.google.com/application/web3/faucet/somnia/shannon —
paste the printed address, no wallet connection needed. Get **several
STT**, not just one drip — a full run of the latest version costs
roughly 1.5-2 STT (see Cost breakdown below).

**3. Run the latest version:**
```bash
npm run mispricing-report-v5
npm run check-outcomes
```
Then open `v0.0.0.10/output/report.html` in a browser, or — once GitHub
Pages is enabled on this repo (Settings → Pages → Deploy from branch →
`main` → `/docs`) — view the live version at
`https://os6863.github.io/event-contracts/`, no cloning required.
Run `check-outcomes` again periodically as logged markets close, to
grow the real, Brier-scored track record.

## Versioned development history

Each stage of this project is a self-contained folder — the code plus
a `CHANGES.md` describing what it does, why it exists, and (honestly)
every real bug a live run caught before moving on. Every version was
independently re-reviewed against a second source before advancing, and
every fix below was found by running real code against the real
testnet, not by guessing.

| Version | What it adds | Real bugs caught before advancing |
|---|---|---|
| [v0.0.0.1](v0.0.0.1/CHANGES.md) | Read-only scanner for live DreamDEX markets | Missing venue filter on a shared indexer (would have mixed in unrelated markets); a fixed expiry-headroom threshold that breaks on short-cadence markets |
| [v0.0.0.2](v0.0.0.2/CHANGES.md) | On-chain BTC/ETH price via a real Somnia Agent (JSON API Request) | A destructuring bug that would crash on the first real response; on-chain request data gets pruned right after finalization (switched to the official Receipts Service); a single hardcoded RPC can go down (added multi-URL fallback) |
| [v0.0.0.3](v0.0.0.3/CHANGES.md) | First real mispricing signal (DreamDEX vs. price move) | A market field (`strike`) that reads as `0` for this market type; the real fix was a different SDK call (`getOpeningPrices`) |
| [v0.0.0.4](v0.0.0.4/CHANGES.md) | Naive formula replaced by a genuine LLM (Qwen3-30B) probability estimate | Wrong field name for the model's reasoning text; a qualitative calibration prompt that over/under-corrected twice before numeric anchor points fixed it; one shared timeout that was fine for a fast agent and far too short for a slow one |
| [v0.0.0.5](v0.0.0.5/CHANGES.md) | Presentable HTML report for the demo, plus full (untruncated) AI reasoning | The Receipts Service's fast preview mode replaces long fields with a placeholder instead of a snippet — added a follow-up fetch for the complete text |
| [v0.0.0.6](v0.0.0.6/CHANGES.md) | Final polish — no new detection logic | Whole-repo re-review (all versions type-checked together); this README hadn't been updated since v0.0.0.1 and still described only the read-only scanner; caught that `package.json`'s `^0.28.1` range could never resolve to the docs' newly-required `0.29.0` floor |
| [v0.0.0.7](v0.0.0.7/CHANGES.md) | Ensemble signal (naive + LLM cross-validated), a growing signal history, and a live GitHub Pages report | An LLM outlier (`0.99` for a market that moved *down*) would have produced a false "strong" signal alone — the ensemble check downgrades it to "weak" since the naive baseline disagrees |
| [v0.0.0.8](v0.0.0.8/CHANGES.md) | Real outcome verification against on-chain settlement + Brier-scored track record | None — this version's own honest limitation is that it can't validate against a real settled market until one actually closes, which needs elapsed time, not more code |
| [v0.0.0.9](v0.0.0.9/CHANGES.md) | Time-aware (√t-scaled) naive baseline replacing the old fixed-linear formula; structured AI reasoning output | The naive formula had ignored time-to-expiry entirely since v0.0.0.3 — same % move always gave the same estimate whether 15 minutes or 24 hours remained, caught by external review |
| [v0.0.0.10](v0.0.0.10/CHANGES.md) | Receipt-checked estimates, timestamped inputs, safe legacy history, and the responsive EdgeScope report | A successful receipt decoded to `0` while its reasoning concluded `6500`; v10 rejects mismatched/malformed final answers and never promotes them to signals |

Running an earlier version still works — each folder is complete on
its own (`cd` into it isn't required; the root `package.json` has a
script per version). See each version's own `CHANGES.md` for exact run
instructions and sample output.

## Cost breakdown (per full run of v0.0.0.10; `check-outcomes` is free/read-only)

| Step | Somnia Agent calls | Approx. STT |
|---|---|---|
| Scan live markets | 0 (read-only) | 0 |
| Fetch BTC/ETH price | 1 per unique asset (~2) | ~0.24 |
| LLM probability estimate | 1 per live market (~6) | ~1.44 |
| **Total** | | **~1.7 STT** |

All free testnet STT — set `MAX_MARKETS` in `.env` to cap cost while
testing.

## Tech stack

- **DreamDEX**: `@somnia-chain/markets-sdk` (TypeScript)
- **Somnia Agents**: JSON API Request (price) + LLM Inference (Qwen3-30B, probability estimate)
- **Chain interaction**: `viem`
- **Runtime**: Node.js 18+, `tsx` (no build step)

## What this project is *not*

- Not a trading bot — read-only analysis, no order placement, and no
  "trade this" link. A public DreamDEX trading interface exists at
  `app.dreamdex.io`, but linking to it correctly would require
  confirming the exact URL mapping from this project's testnet symbols
  to the app's own market paths, and confirming a testnet version of
  the app exists (the one found was mainnet, quoting mainnet USDso
  prices — this project trades tUSDC on testnet). A guessed mapping
  would risk sending someone to the wrong market or the wrong network,
  which this project treats as a real bug, not a missing feature.
- Not a live-updating dashboard. The report is a snapshot from the most
  recent run — `npm run mispricing-report-v5` (or the current latest
  script) followed by a commit/push is what refreshes it. A true
  auto-refreshing version would need either a scheduled job holding
  `PRIVATE_KEY` in CI secrets, or every visitor paying their own Somnia
  Agent calls from their own wallet — both are larger scope changes than
  the remaining time before this hackathon's deadline could responsibly
  absorb without introducing an untested new failure mode.
- The naive/LLM probability estimates are not calibrated financial
  models; they exist to demonstrate a verifiable on-chain AI signal,
  not to be traded on directly. `ASSET_ANNUAL_VOLATILITY` in
  v0.0.0.10's naive formula is an assumed constant, not fitted from real
  price history.
- Not audited — this is hackathon/testnet code.

## Links

- [DoraHacks hackathon page](https://dorahacks.io/hackathon/event-contracts/detail)
- [DreamDEX Event Contracts docs](https://docs.dreamdex.io/developers/event-contracts)
- [Somnia Agents docs](https://docs.somnia.network/agents)
- [Somnia Agent Explorer (testnet)](https://agents.testnet.somnia.network)
