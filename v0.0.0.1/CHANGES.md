# v0.0.0.1 — Read-only DreamDEX live-market scanner

## What this version does
A TypeScript script that:
1. Connects to the public DreamDEX indexer on **Somnia Shannon Testnet**
   with no private key and no funded wallet required.
2. Fetches every Event Contract market currently in **Trading** status
   (`exchange.loadMarkets()` + `isBinaryMarket`).
3. Re-checks each market's **on-chain** status before trusting it — the
   indexer lags the chain by a few seconds (Gotcha #1 in the protocol
   docs).
4. Skips markets with too little time left before close, scaled to 10%
   of that market's own cadence (Gotcha #9, refined against
   `dreamdex-bot-kit`'s own notes — see the post-build review below).
5. For the remaining markets, reads the Up (YES) price (best bid/ask
   mid-price on the order book) and prints a summary table.

## Why this is the first step
Before we can compare DreamDEX's price against an independent estimate
(whether from a Somnia Agent or a simple model), we first need a
**reliable** read of "what markets exist right now and what are they
quoting". This version builds exactly that base layer — no comparison
or alerting logic yet.

## Changes vs. the previous version
This is the first version — nothing to diff against.

## Validation (important)
The code was checked with a real `npm install` and `npx tsc --noEmit`
against the **actually installed** package types, not just against the
docs. That process caught a real bug:

The `docs.dreamdex.io` example code showed an `outcomes` field (to read
each outcome's symbol) on the result of `client.listLiveBinaryMarkets()`.
Checking the package's real `.d.ts` files showed `outcomes` only exists
on the **unified tier** (`exchange.loadMarkets()`); the raw
`client.listLiveBinaryMarkets()` result is typed `BinaryMarket` and has
no such field (only `marketId`, `question`, `asset`, `expiry`, ...). The
final code uses `exchange.loadMarkets(true)` + `isBinaryMarket(m.info)`,
which matches the installed package's real types exactly and passes
`tsc --noEmit` with zero errors.

This means the code isn't just "written from the docs" — it's compiled
and verified against the SDK's real, installed types.

## Post-build review (before moving to the next version)
As a standing process, each version now gets a second, independent
review against another source before we move on — not just the docs we
originally coded from. This version was re-checked against
`dreamdex-bot-kit/docs/event-contracts.md` (real bot code from a
previous hackathon), which surfaced two real issues, both fixed here:

1. **Real bug — no venue filtering.** The indexer this scanner connects
   to is shared across "thousands of venues x cadences" (the SDK's own
   type docs). The original code had no venue filter at all, meaning it
   could have silently mixed in markets unrelated to DreamDEX.
   **Fixed:** a required `SOMNIA_VENUE_ID` was added. If it's not set,
   the script no longer guesses — it prints the venue ids actually
   visible on the indexer so the correct one can be chosen. This
   matches the bot kit's own guidance: "the bots will refuse to guess."
2. **Fixed 5-minute threshold was wrong.** Per the bot kit's notes, a
   fixed headroom threshold can reject every market on a venue running
   a short cadence. **Fixed:** the threshold is now 10% of each
   market's own cadence (floored at 60 seconds), not a fixed constant.

A note on `venueId`: the bot kit's own docs say this value has rotated
multiple times in the past. Treat the default shipped in
`.env.example` as a starting point, not a permanent constant — if the
scanner reports zero markets, run it once with `SOMNIA_VENUE_ID` unset
to see the current candidates via the built-in discovery mode.

## Live run confirmation
Beyond type-checking, this version was run against real testnet data
and returned a correctly filtered, correctly formatted table of live
markets — confirming the venue filter, the on-chain status gate, and
the dynamic headroom threshold all work as intended on live data, not
just in theory.

## Technical notes (per the protocol's documented gotchas)
- **Gate on-chain status, not the indexer** — every market is
  re-checked with `getMarketOnchain` before being trusted.
- **Skip markets near expiry** — scaled to each market's own cadence.
- **No private key** — this version only reads, so no funded wallet or
  even a throwaway key is needed.
- A market with an empty order book (no liquidity yet) doesn't crash
  the whole run — it's just shown as "no liquidity".

## Cost
Zero. Only reads against the public testnet indexer — no gas, no paid
API.

## What this version is *not*
- It does not trade.
- It does not compare against any external price (CoinGecko / Somnia
  Agent) — that's **v0.0.0.2**.
- It does not connect to any wallet.

## Run

```bash
npm install
npm run scan
```

## Sample output (shape only — real numbers depend on live markets)
```
📡 DreamDEX Event Contracts — live market scanner (testnet, read-only)

┌─────────┬──────────────────────────────┬───────────────────┬──────────────────┐
│ (index) │ Symbol                       │ Up Price (prob.)  │ Time Left (min)  │
├─────────┼──────────────────────────────┼───────────────────┼──────────────────┤
│ 0       │ 'BTC-0-12AUG26-1600/USDso#YES'│ '0.5420'          │ '42.3'           │
└─────────┴──────────────────────────────┴───────────────────┴──────────────────┘

✅ 1 live, tradable market(s) found.
```

## Next step (v0.0.0.2 — proposed)
Connect to a Somnia Agent (`JSON API Request`) to fetch a live BTC/ETH
price from CoinGecko on-chain and verifiably — the first step toward
building an independent probability estimate.
