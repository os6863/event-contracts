# v0.0.0.3 — First real mispricing signal (DreamDEX vs. Somnia Agent)

## What this version does
Combines the two previous versions for the first time:
1. Scans live DreamDEX markets (same logic as v0.0.0.1).
2. For each **unique** underlying asset among those live markets (BTC
   and/or ETH), fetches the current price **once** via the Somnia Agent
   (same logic as v0.0.0.2) — not once per market, to avoid paying for
   the same price twice in a single run.
3. Fetches each market's real **opening price** via
   `exchange.client.getOpeningPrices(marketIds)`.
4. Computes a naive independent probability estimate from how far the
   current price has moved from the opening price, and compares it
   against DreamDEX's own implied probability (order book mid) — the
   project's first actual **mispricing signal**.

## Why this took two passes to get right
This version was built and verified in the order the bugs actually
surfaced, not written clean the first time:

**1. `strike` is 0 on every live market — confirmed real, not a
misreading.** The SDK's own type docs describe `BinaryMarket.strike`
only as *"raw, in the oracle's price scale"*, and it seemed like the
obvious field to use for "opening price". A live run returned
`strike: "0"` on all 6 live markets. These are all "closes at or above
its **opening** price" markets — a reference-question design where the
resolution price isn't fixed at creation, it's whatever the oracle
posts once trading starts. `strike` is simply unused for this market
type. **Fix:** switched to `exchange.client.getOpeningPrices(marketIds)`
— the SDK's dedicated batch call for exactly this case (keyed by
**lowercased** marketId, per its own docs). This is the third time this
project has caught a wrong assumption about a field by checking real
data instead of trusting an abbreviated type comment (see v0.0.0.1's
`outcomes` field and v0.0.0.2's `response.result` vs `agentReceipt.result`).

**2. `createRequest` reverted for both BTC and ETH on the next run.**
Checking the wallet's balance directly on the block explorer showed only
`0.078 STT` left — below the ~0.12 STT a single request needs.
Several successful `price-agent` runs during v0.0.0.2 development had
already spent down the original 1 STT faucet drip. Not a code bug — the
fix was re-funding the same disposable wallet from the faucet
(`cloud.google.com/application/web3/faucet/somnia/shannon`). Worth
remembering for the demo video: fund generously beforehand, since
testing burns through STT faster than a single demo run would suggest.

**3. Scale confirmed, then the calculation was finalized.** A re-run
(after re-funding) returned real opening prices for all 6 markets.
Dividing each by 100 landed within a fraction of a percent of the
agent's current price for the same asset, consistently across both BTC
and ETH — confirming the opening price is fixed-point with **2 decimal
places** (`rawValue / 100 = USD`), not 8 or 18. Only once that was
confirmed against live numbers did the actual mispricing formula get
written.

## The mispricing calculation
Per live market:
- **Opening price** and **current price** (agent), in USD.
- **% move** between them.
- A **naive probability estimate**: `0.5 + SENSITIVITY × (% move) / 100`,
  clamped to `[0.02, 0.98]`. `SENSITIVITY = 8` is a placeholder constant,
  not a calibrated value — this model has no volatility or
  time-to-expiry awareness. It exists to prove the pipeline works
  end-to-end, not to be taken as a serious forecast.
- **Divergence** = naive estimate − DreamDEX's own implied probability.
  Flagged when `|divergence| ≥ 0.15`.

The formula's arithmetic was cross-checked by hand (a standalone Node
one-liner, outside the script) against the exact numbers from a real
run before trusting the script's own table — the same discipline as the
type-check sanity tests in earlier versions, applied to a math formula
instead of a type.

**A pattern worth noting, not a bug:** in the first real run, nearly
every market got flagged — DreamDEX's Up price sat around 0.6–0.8 even
on markets where the price had moved a fraction of a percent from
opening. On a low-liquidity testnet, order-book prices likely reflect a
handful of test orders rather than efficient pricing — which is exactly
the kind of divergence this tool exists to surface. It is not evidence
the naive model or the opening-price scale is wrong.

## Changes vs. v0.0.0.2
- New `v0.0.0.3/mispricing-detector.ts` — self-contained (duplicates the
  scanning logic from v0.0.0.1 and the agent-fetch logic from v0.0.0.2
  rather than importing across version folders, matching this project's
  "each version is complete on its own" convention).
- New npm script: `mispricing-detector`.
- No `.env` changes — reuses every variable already defined for
  v0.0.0.1 and v0.0.0.2.

## Cost
Same as v0.0.0.2: free testnet STT, one Somnia Agent call per unique
asset seen (typically 1-2 calls total, not one per market).

## Run
```bash
npm install
npm run mispricing-detector
```
Needs the same funded testnet wallet as v0.0.0.2 (`PRIVATE_KEY` in `.env`).

## What this version is *not*
- The naive probability model is not calibrated — it's a linear
  placeholder to validate the pipeline, explicitly flagged as such in
  the code and here.
- It does not yet use an LLM or any volatility/time modeling.

## Next step (v0.0.0.4 — proposed)
Replace the naive linear estimate with a genuine probability estimate
from a second Somnia Agent (LLM Inference) — the point where this
project's "on-chain AI oracle" pitch actually gets an AI in it, not just
a raw price feed.
