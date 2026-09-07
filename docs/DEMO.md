# Demo Runbook

This runbook keeps the hackathon demo reproducible and avoids making fresh paid Agent calls unless needed.

## Fast judge path

1. Open the published GitHub Pages report.
2. Show one market card and expand **Verification snapshot**.
3. Point out the DreamDEX order-book probability, independent baseline/LLM estimates, receipt link, timestamps, and liquidity state.
4. Show **Track record** and explain per-observation versus per-unique-market Brier scoring.
5. Show **Simulated edge** only as a transparent small-sample diagnostic, not a profit claim.
6. Open `docs/ARCHITECTURE.md` or `docs/METHODOLOGY.md` for implementation details.

## Local verification

```bash
npm ci
npm run verify
npm run render-report
```

`render-report` rebuilds the HTML from the saved snapshot and signal history without spending testnet STT.

## Fresh testnet run

```bash
cp .env.example .env
npm run generate-wallet
# fund the disposable address with Shannon testnet STT
npm run report
npm run check-outcomes
```

A fresh report run uses Somnia Agents and therefore needs a funded disposable testnet wallet. Outcome checking is read-only.

## Demo claims to keep precise

- Agent execution/receipts are verifiable; the CoinGecko price input is off-chain.
- The external reference is intentionally independent and is not claimed to reproduce DreamDEX's settlement oracle.
- Illiquid books are rejected before signal classification.
- EdgeScope is analytics, not an automated trading bot.
