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
npm run mispricing-report-v2
```
Then open `v0.0.0.7/output/report.html` in a browser, or — once GitHub
Pages is enabled on this repo (Settings → Pages → Deploy from branch →
`main` → `/docs`) — view the live version at
`https://<username>.github.io/event-contracts/`, no cloning required.

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

Running an earlier version still works — each folder is complete on
its own (`cd` into it isn't required; the root `package.json` has a
script per version). See each version's own `CHANGES.md` for exact run
instructions and sample output.

## Cost breakdown (per full run of v0.0.0.7 — same agent calls as v0.0.0.5)

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

- Not a trading bot — read-only analysis, no order placement.
- The naive/LLM probability estimates are not calibrated financial
  models; they exist to demonstrate a verifiable on-chain AI signal,
  not to be traded on directly.
- Not audited — this is hackathon/testnet code.

## Links

- [DoraHacks hackathon page](https://dorahacks.io/hackathon/event-contracts/detail)
- [DreamDEX Event Contracts docs](https://docs.dreamdex.io/developers/event-contracts)
- [Somnia Agents docs](https://docs.somnia.network/agents)
- [Somnia Agent Explorer (testnet)](https://agents.testnet.somnia.network)
