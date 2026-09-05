# v0.0.0.2 — On-chain BTC/ETH price via a real Somnia Agent

## What this version does
Two scripts:

1. **`generate-wallet.ts`** — a small helper that creates a fresh,
   disposable testnet wallet (address + private key) without needing
   MetaMask or any other tool. Prints the address to fund from the
   faucet and the key to paste into `.env`.
2. **`price-oracle-agent.ts`** — fetches the live BTC and ETH prices via
   a real **Somnia Agent** call (the "JSON API Request" base agent,
   agent id `13174292974160097713`), not a plain HTTP request:
   - The agent itself fetches CoinGecko's free `simple/price` endpoint.
   - Several independent validator nodes execute it.
   - They reach consensus on the result.
   - Only the consensus value is written on-chain and read back here.

This is the first step toward an independent probability estimate that
is verifiable on-chain — not a number our own backend just claims to
have fetched.

## Why this is the next step
v0.0.0.1 gave us a reliable read of DreamDEX's own implied probability.
Before we can flag "mispricing", we need an independent estimate to
compare it against. Using a Somnia Agent for that (instead of our own
backend calling CoinGecko directly) means the comparison itself becomes
demonstrably on-chain and auditable — which is also the whole point of
using this hackathon's flagship new primitive rather than just wrapping
the DreamDEX SDK.

## Changes vs. v0.0.0.1
- New `v0.0.0.2/` folder — v0.0.0.1 is untouched.
- `.env.example` gained: `SOMNIA_AGENTS_CONTRACT`, `SOMNIA_AGENT_RPC_URL`,
  `SOMNIA_AGENT_WS_URL`, `PRIVATE_KEY` (now required, was optional),
  `COINGECKO_URL_PRICES`.
- `package.json` gained two scripts: `generate-wallet`, `price-agent`.

## Important: this version writes to the chain
Unlike v0.0.0.1 (pure read, no wallet needed), calling an agent is a
transaction (`createRequest`), so this version needs a **funded testnet
wallet**. Setup:

```bash
npm run generate-wallet
```
This prints a fresh address and private key. Fund the address with free
STT at the Google Cloud Web3 faucet for Somnia Shannon (confirmed
working live — `testnet.somnia.network`'s own faucet button did not):
https://cloud.google.com/application/web3/faucet/somnia/shannon. Then
put the private key in `.env` as `PRIVATE_KEY`.

⚠️ Use only a fresh, disposable key here — never a real wallet's key.
This is standard practice for any script that signs transactions, testnet
or not.

Still zero dollars: STT is free testnet gas, and the deposit an agent
call requires is paid in STT too.

## Validation
The integration code was **not** hand-written from the docs' prose. It
started from the exact TypeScript snippet Somnia's own Agent Explorer
(`agents.testnet.somnia.network`) generates for this specific agent id —
generated directly from the deployed contract's ABI — then generalized
into a reusable function and type-checked (`tsc --noEmit`) against
viem's real types, the same process used for v0.0.0.1.

That process caught two real issues, both fixed before this version was
considered done:

1. **Runtime bug (would have crashed on first successful response).**
   The result-decoding step originally read:
   ```ts
   const [result] = decodeFunctionResult({ ... }) as unknown as [bigint];
   ```
   An isolated type-check proved `decodeFunctionResult` returns the
   value **directly** for a single-output ABI function (`fetchUint` has
   exactly one output) — not wrapped in a tuple. The `as unknown as
   [bigint]` cast hid this from `tsc`, but at runtime, destructuring a
   plain `bigint` with `[result] = ...` throws (a bigint isn't
   iterable). **Fixed:** removed the destructure and the unsafe cast;
   added a real runtime check (`typeof result !== "bigint"`) that fails
   loudly instead of silently miscomputing a price if the agent's ABI
   ever changes shape.
2. **Confirmed the type-checker was actually checking, not just
   silently passing.** Deliberately swapped a `bigint` argument for a
   `string` and reran `tsc --noEmit` — it correctly failed
   (`Type 'string' is not assignable to type 'bigint'`) — before
   reverting. This is worth doing whenever a return type looks
   suspiciously easy to satisfy (as `unknown`/forced casts do), so a
   green type-check isn't mistaken for a real guarantee.

## Live-testing bug (found after a real run, not by type-checking)
The first real run on testnet sent a valid transaction and got a
`requestId`, then hung — no output for minutes, well past what should be
needed. Checking the Agent Explorer's own request history directly
(`agents.testnet.somnia.network`) showed the request had actually
**succeeded in ~500ms**. The bug was entirely on our side.

**Root cause:** the original code opened a `watchContractEvent`
subscription for `RequestFinalized` *after* the transaction was already
confirmed. Since real finalization latency is well under a second — far
faster than a fresh WebSocket subscription reliably attaches — the event
could fire before our listener was even set up, and the script would
then wait uselessly until the timeout.

**Fix:** replaced event-watching with direct polling of `getRequest()`
(a plain view call, no subscription, no race) every second until the
status leaves `Pending`/`None`. This is both more robust and simpler —
it also let the WebSocket transport be dropped entirely in favor of
plain HTTP, removing a dependency and a failure mode. The safety-margin
timeout was reduced from 3 minutes to 60 seconds to match reality, while
still leaving generous headroom over the ~1-2s typically observed.

This is exactly the kind of bug that type-checking cannot catch — it's
a timing/concurrency issue, not a type error — which is why live testing
against the real network remained part of the review even after `tsc`
was clean.

## Second live-testing finding: transient testnet RPC flakiness
After the polling fix, a run still failed — `getRequest` reverted with
an undecodable custom error (`0x4ec726c7`) almost immediately. Before
assuming this was another code bug, it was checked against Somnia's own
Agent Explorer, which at that exact moment was showing its own error
banner for the **same agent**, hitting the **same kind of failure**
against its own RPC endpoint (`api.infra.testnet.somnia.network`):
`HTTP request failed ... Details: Failed to fetch`. That confirms the
issue was transient testnet infrastructure flakiness, not a bug in this
script's logic.

**Fix (robustness, not a bug fix):** the polling loop now tolerates up
to 5 consecutive RPC-level failures (network errors, undecodable
reverts) with a short retry, only giving up and surfacing an error if
the RPC keeps failing past that bound. A single transient blip no longer
kills the whole price fetch.

**Practical implication:** if `price-agent` fails with an RPC/network
error, retrying a bit later is a reasonable first response — the
testnet's own infrastructure is not always fully stable, independent of
anything in this codebase.

## Fourth finding: the real root cause was on-chain pruning, not RPC flakiness
Once the RPC fallback (above) made connectivity reliable, the exact same
`getRequest` revert kept happening — consistently, every time, not
intermittently. That ruled out "flaky RPC" as the explanation. Decoding
the revert's 4-byte selector (`0x4ec726c7`) against the public Ethereum
signature database identified it precisely: **`RequestNotFound(uint256)`**.

**Root cause:** the platform contract deletes a request's on-chain data
almost immediately after it finalizes (for gas refunds) — confirmed by
cross-referencing the Agent Explorer's UI, which can still show results
for requests days old. That's only possible because the Explorer reads
from its own durable off-chain index, not from a live contract call —
exactly the clue that on-chain storage doesn't persist post-finalization.
Polling `getRequest()` was therefore never going to work reliably: by
the time our first poll fired, the request could already be finalized
*and* pruned.

**Fix:** switched to the officially documented **Receipts Service**
(`docs.somnia.network/agents/invoking-agents/receipts`) — a keyless
HTTP API backed by durable storage, built specifically for reading a
request's result after the fact. The script now polls
`GET {receiptsService}/agent-receipts?contractAddress=...&requestId=...&type=minimal`
instead of calling the contract, and decodes `response.result` from the
first receipt with `status: "success"`. This is not a workaround; it is
the intended way to retrieve a result without deploying a callback
receiver contract.

This also simplified the code: `getRequest` and `RequestFinalized` are
no longer part of the ABI this script needs at all — only
`createRequest`, `getRequestDeposit`, and `RequestCreated` remain.

## Fifth finding: guessed field name on the Receipts Service response was wrong
The Receipts Service integration above was correct in *approach*, but a
field name was guessed from the docs' abbreviated example rather than a
real response, and it was wrong: the code originally read
`receipt.response.result`. A live request's real raw JSON showed the
actual shape:

- `receipt.response` is metadata about the agent's own **outbound HTTP
  call** — `{ "status": 200, "size": 32 }` — nothing to do with the
  contract's return value.
- The ABI-encoded return value is actually at **`receipt.agentReceipt.result`**.

**Fix:** read `agentReceipt.result` instead. Verified end-to-end against
the real response: decoding
`0x0000000000000000000000000000000000000000000000000000074681653a00`
with 8 decimals gives `79994.0` — a plausible real BTC price, confirming
the full pipeline (request → Receipts Service → decode) actually works,
not just that it stopped throwing.

**Also hardened while fixing this:** receipt selection now looks for
the first receipt with `status: "success"` among however many have
reported in, rather than just inspecting whichever receipt happens to
be first in the array. It only concludes the request failed once at
least 2 validators (the consensus threshold) have reported and **none**
succeeded — a single straggler reporting late or failing doesn't cause
a false failure.

**Takeaway for the rest of this project:** when a third-party service's
docs show an abbreviated/illustrative example rather than a full real
response, don't trust field names from it without checking a live
response at least once — this is now the second time in this version
that "matches the docs' example" and "matches reality" turned out to be
different things.

## Third finding: a dead RPC needs automatic failover, not a manual swap
Live testing then hit `dream-rpc.somnia.network` returning a hard HTTP
403 for every call — confirmed independently by loading that URL
directly in a browser (same 403), while the chain itself (checked via
the public block explorer) was healthy and producing blocks every ~5
seconds. So this was a single dead RPC gateway, not a dead network.

Asking the person to manually edit `.env` and swap RPC URLs by hand
every time one goes down doesn't scale and shouldn't be necessary.
**Fixed:** switched to viem's built-in `fallback()` transport across a
list of RPC URLs (`SOMNIA_AGENT_RPC_URLS`, comma-separated, both
official testnet RPCs by default). If one URL errors, viem automatically
tries the next — no code change or manual `.env` edit needed when a
single provider has a bad day.

## What this version is *not*
- It does not yet compare the agent's price against DreamDEX's implied
  probability — that's v0.0.0.3.
- It does not use an LLM — this is the JSON API Request base agent only.
  LLM Inference (for a genuine probability estimate rather than a raw
  price) is a later step.
- No callback contract is used — the script polls for the
  `RequestFinalized` event directly, which is simpler for a script that
  isn't itself a smart contract.

## Run
```bash
npm install
npm run generate-wallet   # first time only
```
Fund the printed address with free STT — `testnet.somnia.network`'s own
page has no working faucet button as of this writing (confirmed live);
use the **Google Cloud Web3 faucet** instead:
https://cloud.google.com/application/web3/faucet/somnia/shannon
(network is pre-set to "Somnia Shannon" — just paste the address and
click "Get 1 Shannon STT", no wallet connection needed). Then paste the
private key into `.env` as `PRIVATE_KEY` and run:
```bash
npm run price-agent
```

Each price fetch is a real on-chain request. Live testing showed
finalization in well under 2 seconds; the script polls every second
with a 60-second safety-margin timeout — if it ever takes noticeably
longer, that's worth investigating, not waiting out.

## Sample output (shape only — real prices vary)
```
🤖 Somnia Agent — on-chain BTC/ETH price fetch (testnet)

Using wallet: 0x1234...

Requesting BTC price via Somnia Agent (JSON API Request)...
   tx: 0xabc... — waiting for confirmation...
   requestId: 13011429 — polling the Receipts Service for consensus...
   ✅ BTC = $76,808.00

Requesting ETH price via Somnia Agent (JSON API Request)...
   tx: 0xdef... — waiting for confirmation...
   requestId: 13011436 — polling the Receipts Service for consensus...
   ✅ ETH = $2,381.37

┌─────────┬───────┬──────────────┐
│ (index) │ Asset │ Price (USD)  │
├─────────┼───────┼──────────────┤
│ 0       │ 'BTC' │ 76808        │
│ 1       │ 'ETH' │ 2381.37      │
└─────────┴───────┴──────────────┘

✅ Fetched 2/2 price(s) via a consensus-validated on-chain Somnia Agent call — not a plain HTTP request.
```

## Next step (v0.0.0.3 — proposed)
Combine v0.0.0.1 and v0.0.0.2: for each live DreamDEX market found by the
scanner, fetch the matching asset's on-chain agent price, derive a naive
independent probability estimate from it, and compute the divergence
against DreamDEX's own implied probability — the first real "mispricing
signal".
