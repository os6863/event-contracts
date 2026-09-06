# SDK & Documentation Feedback — Somnia × DreamDEX Event Contracts Hackathon

Submitted alongside **Event Contracts — Mispricing & Edge Detector**
(`os6863/event-contracts`).

Everything below was hit while building against `@somnia-chain/markets-sdk`
and the Somnia Agents platform across ten live development iterations —
not guessed from reading the docs, and not filed until reproduced against
real testnet data. Each item names the exact behavior, why it cost time,
and what would have prevented it. Full context for any item is in the
corresponding version's `CHANGES.md` in this repo.

## Documentation gaps that cost real debugging time

**1. `docs.dreamdex.io`'s example code shows an `outcomes` field on the
result of `client.listLiveBinaryMarkets()`.** The raw client tier's
`BinaryMarket` type has no such field — `outcomes` only exists on the
**unified tier** (`exchange.loadMarkets()`). Caught by type-checking
against the SDK's real, installed `.d.ts` files rather than the docs'
prose; would not have been caught by reading the docs alone.
*Suggestion: either add `outcomes` to the raw tier's returned shape, or
make the two tiers' field availability explicit in the Recipes page's
tier table.*

**2. The Receipts Service response shape isn't documented beyond an
abbreviated example.** We initially read `receipt.response.result`
(guessed from the docs' prose), which is actually metadata about the
agent's *outbound HTTP call* (`{ status, size }`). The real ABI-decoded
return value lives at `receipt.agentReceipt.result`. Separately, the
model's reasoning text is not on the `llm_response` step's `content`
field (as the prose implies) — it lives in its own step, named
`"reasoning"`, under `content`. Both were only found by fetching one
real receipt's full JSON and reading it directly.
*Suggestion: publish one complete, real (not illustrative) receipt JSON
for both a JSON API Request agent and an LLM Inference agent call, with
every field annotated.*

**3. `BinaryMarket.strike` reads as `0` on every "closes at or above its
opening price" market, and the type comment ("raw, in the oracle's price
scale") doesn't say this.** The correct call for this market type is
`exchange.client.getOpeningPrices(marketIds)`, keyed by **lowercased**
marketId — a detail also not stated in the field's own doc comment.
*Suggestion: the Gotchas page already documents several market-field
traps (§13, don't parse question text) — this one belongs alongside
them: "for reference-question markets, `strike` is unused; read
`getOpeningPrices()` instead."*

**4. The Somnia Agents Receipts Service's `type=minimal` mode silently
*replaces* a long field with a placeholder string instead of truncating
it**, and nothing in the docs says a second, non-minimal fetch (which
returns a manifest of GCS URLs) is the documented way to get the full
value. We only found this by noticing the placeholder string was being
printed as if it were real content.
*Suggestion: document the two-step "minimal preview → full fetch on
demand" pattern explicitly, since any consumer of long LLM outputs
(chain-of-thought reasoning, especially) will hit this.*

## Behavior that's correct but easy to get wrong on first contact

**5. `npm` caret ranges on a `0.x` package (e.g. `^0.28.1`) can never
resolve to a new minor floor (`0.29.0`) — by semver definition, but this
bites people who assume `npm install` alone keeps them current.** We
carried a stale, silently-broken version pin for a full version cycle
before catching it in a whole-repo review, purely by re-reading the docs
a second time rather than because anything failed loudly.
*Suggestion: when a new floor version is announced on the Event
Contracts docs page (as the 0.29.0 / 10,000-market cap note was), also
call out explicitly that a caret-pinned `0.x` dependency needs a manual
bump — a one-line callout would have saved us a full iteration.*

**6. On-chain agent-request data (`getRequest()`) is pruned almost
immediately after finalization, and the correct read path — the
Receipts Service — is only mentioned deep in the Somnia Agents docs, not
cross-linked from anywhere in the DreamDEX Event Contracts docs even
though every non-trivial bot built on Event Contracts will need both.**
We initially polled `getRequest()`, got `RequestNotFound`, and spent a
full iteration diagnosing it as RPC flakiness before finding the actual
cause.
*Suggestion: since Event Contracts docs already assume Somnia Agents
usage patterns (per the hackathon's own framing), a one-line
cross-reference from the Event Contracts page to the Receipts Service
page would shortcut this for the next builder.*

## What worked well (worth keeping, not just complaints)

- **The Somnia Agent Explorer's auto-generated call snippet** (from the
  deployed contract's ABI) was a reliable, correct starting point for
  the first integration — better than hand-writing the ABI from prose.
- **Types ship with the SDK package**, so editor autocomplete plus
  `tsc --noEmit` caught several of the issues above before a single
  testnet call was made — this is genuinely good practice already in
  place.
- **The Gotchas page is unusually honest** ("all of these were hit and
  verified in real testing") — every item on it matched something we
  independently hit or would have hit. More pages like this, for the
  Agents platform specifically, would help.
- **`fallback()` transport support in viem worked exactly as expected**
  once we adopted it for RPC redundancy — no surprises there.

## Not included here

Anything already fully covered by the current Gotchas page (on-chain
status gating, tick/lot sizing, order expiry, pool recycling, etc.) is
omitted — this report only lists friction that isn't already documented
there as of this writing.
