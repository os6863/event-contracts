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

## Say this before a judge asks it

- **"Why doesn't this trade?"** — Lead with the positioning, don't wait to be asked: EdgeScope is a trust/price-discovery layer other Event Contracts builders (market makers, bots, consumer apps) can build on, not a competing end-user trading app. State this in the first 30 seconds.
- **"Your sample size is tiny / your win rate is 0%."** — Point at the Simulated Edge panel yourself before a judge does. Say plainly: this is a transparency diagnostic on a small testnet sample, not a profitability claim, and the panel is designed to show an honest bad number rather than hide one. Do not let the panel's small-sample honesty read as the product failing.
- **"All the signals say 'None' — is this thing even working?"** — This is expected, not a malfunction, and the report now says so directly (an inline note appears whenever every usable market currently agrees within the 15-point threshold). Explain it yourself before a judge asks: most of the time, DreamDEX's price and the independent estimate genuinely agree — a "strong"/"weak"/"conflicting" signal means real divergence was found, and real divergence is the exception, not the norm. A run with zero flagged markets is the liquidity gate and the ensemble doing their job, not evidence of a broken pipeline. If it's useful, point to the "Recent signal history" table, which usually has older signaled rows even when the live run doesn't.
- EdgeScope is analytics, not an automated trading bot.
