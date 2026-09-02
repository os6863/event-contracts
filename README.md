# Event Contracts — Mispricing & Edge Detector

Built for the **Somnia × DreamDEX Event Contracts Hackathon**.

## Idea
An analytics tool (not a trading bot) that scans live DreamDEX Event
Contract markets (Up/Down prediction markets on BTC/ETH), compares the
market's implied probability against an independent estimate, and
surfaces markets with high divergence (mispricing).

From the next version onward, the independent estimate is produced
via **Somnia Agents** (JSON API Request + LLM Inference) instead of an
off-chain backend — computed on-chain and verifiable.

## Cost
Zero dollars. Everything runs on **testnet**:
- DreamDEX: Somnia Shannon Testnet (chain 50312), tUSDC collateral from
  the Telegram faucet
- Somnia Agents: same testnet, gas paid in free STT from the Somnia
  faucet
- External price data: CoinGecko free tier (no key required)
- No paid service is used anywhere in this project

## Versioning layout
Each development stage is its own folder:

```
v0.0.0.1/   ← Stage 1: read-only scan of live DreamDEX markets
v0.0.0.2/   ← Stage 2: ...
```

Inside each version folder:
- The full, runnable code for that stage (not a diff)
- A `CHANGES.md` describing what this version does and what changed
  since the previous version

Each version's code is self-contained — just `cd` into its folder to
run it.

## Shared setup (all versions)

```bash
npm install
cp .env.example .env
```

Recommended Node.js version: 18+

## Pushing to GitHub

```bash
git init
git remote add origin https://github.com/os6863/event-contracts.git
git add .
git commit -m "v0.0.0.1: read-only DreamDEX market scanner"
git branch -M main
git push -u origin main
```

(For later versions, just repeat `git add .`, `git commit -m "..."`,
`git push`.)
