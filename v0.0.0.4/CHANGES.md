# v0.0.0.4 — Real AI: LLM-based probability estimate replaces the naive formula

## What this version does
Same pipeline as v0.0.0.3, with one core change: the naive linear
`0.5 + SENSITIVITY × move%` formula is replaced by a genuine probability
estimate from a **second Somnia Agent — LLM Inference** (`inferNumber`,
running Qwen3-30B). For each live market, the LLM is given the asset,
question, opening price, current price, % move, and minutes remaining,
and asked to return an integer probability (0–10000, i.e. 0.00%–100.00%)
that the market resolves YES. That estimate is then compared against
DreamDEX's own implied probability to produce the mispricing signal.

This is the point where the project's "on-chain AI oracle" pitch
actually has an AI in it — v0.0.0.2/v0.0.0.3 only ever fetched a raw
price, deterministically, with no model involved.

## Applying lessons learned, proactively this time
v0.0.0.2 discovered two real bugs the hard way: polling `getRequest()`
fails because on-chain request data is pruned almost immediately after
finalization (fix: use the Receipts Service instead), and a single
hardcoded RPC URL can go down (fix: `fallback()` across multiple URLs).
Both fixes were applied to this version **from the first draft**, not
rediscovered — `submitAgentRequest()` (a new, agent-generic helper this
version introduces, since it now talks to two different agents with two
different per-agent execution costs) uses the Receipts Service and the
RPC fallback transport from the start.

## The prompt
```
System: You are a quantitative analyst estimating short-term probability
for a cryptocurrency binary prediction market. Respond with ONLY the
integer probability value requested — no words, no explanation, no
percent sign, no punctuation.

Prompt: Asset: BTC
Market question: "BTC closes at or above its opening price"
Opening price (window start): $80058.98
Current price: $80095.00
Price change since opening: +0.05%
Time remaining until the window closes: 42.3 minutes

Estimate the probability that this market resolves YES ... as an
integer from 0 to 10000 ... Respond with ONLY the integer.
```
`chainOfThought` is set to `false` for speed and lower cost; the agent
supports chain-of-thought reasoning (visible in its receipt) if a future
version wants to inspect *why* it estimated a given value.

## Cost — read before running
Unlike the price fetch (once per unique asset), the LLM estimate runs
**once per live market**, because each market has its own question,
prices, and time-remaining context. At ~0.24 STT per call, 6 live
markets costs roughly 1.4 STT just for this step, on top of the price
calls. **Fund the wallet with several STT, not a single faucet drip,
before running this** — this bit the previous version too (see
v0.0.0.3/CHANGES.md), and this version costs noticeably more per run.

Added `MAX_MARKETS` (optional, in `.env`) to cap how many markets get an
LLM call per run — useful for controlling cost while testing or
recording the demo video without draining the wallet.

## Changes vs. v0.0.0.3
- New `v0.0.0.4/mispricing-detector.ts`.
- New npm script: `mispricing-detector-v2`.
- New `.env` variable: `MAX_MARKETS` (optional).
- Internally: `submitAgentRequest()` generalizes the request/poll/decode
  flow across any agent id + execution cost, instead of duplicating it
  per agent (v0.0.0.3 only ever talked to one agent, so this
  generalization wasn't needed yet).

## Live-run finding: wallet ran dry mid-run (again)
The same funding issue from v0.0.0.3 recurred on the first full attempt
at this version — the wallet had enough for 2 successful LLM calls, then
`createRequest` reverted for the remaining 4 (insufficient balance for
the ~0.24 STT deposit). Re-funded generously (50 STT via the hackathon's
dedicated Telegram dev group, since the wallet needed more than a single
faucet drip) and a full 6-market run completed cleanly afterward.
`MAX_MARKETS` (see above) exists specifically to make testing cheaper
while iterating, but a full run for the actual demo still needs the
wallet properly funded ahead of time.

## What this version is *not*
- Not yet validated against a live run at the time of writing this file
  — the prompt design and cost estimate are informed by the platform's
  own documented behavior and pricing, but the actual LLM output
  quality (sensible estimates vs. nonsense) still needs a real run to
  confirm, same as every other number in this project so far.
- Does not use `chainOfThought` — a later version could surface the
  model's reasoning for transparency/debugging, similar to how receipts
  already expose it for the JSON API Request agent.

## Live-run finding: the model was miscalibrated, not just cautious
Two full runs against live markets surfaced a real quality problem, not
a code bug:

- A market with a **-0.08% move** (price below opening) got an LLM
  estimate of **0.99** — wrong in *direction*, not just overconfident;
  a negative move should never push the estimate above 0.5.
- Four markets with moves ranging from **+0.23% to +0.76%** (a >3x
  spread) all landed within **0.51-0.53** — the estimate barely moved
  despite the input signal varying substantially.

This pointed to the model not reliably grounding its numeric answer in
the actual price-move magnitude/direction from a bare, example-free
prompt. **Fix, in two parts:**

1. Added explicit calibration guidance to the system prompt: a
   near-zero move must produce an estimate near 5000 (50%), and a
   negative move must bias the estimate below 5000, never above —
   stated as hard rules rather than left for the model to infer.
2. Enabled `chainOfThought: true` (no extra STT cost — the per-agent
   execution cost is fixed regardless) and now surface the reasoning
   step's `thinking` field from the receipt in the console output. This
   turns "the model said 0.99, who knows why" into an inspectable
   answer, which matters both for catching future miscalibration early
   and for demoing that this is a real reasoning agent, not a black box.

This is exactly the same pattern as every other bug in this project:
believe the live output over the assumption, diagnose before patching,
and fix the actual mechanism (prompt calibration) rather than papering
over the symptom (e.g. clamping or discarding outlier estimates would
have hidden the problem instead of fixing it).

## Third live-run finding: the reasoning field's actual name/location
After enabling `chainOfThought`, the console never printed a `reasoning:`
line — the code looked for a `thinking` field on the `llm_response` step,
following the docs' prose description. Fetching a real receipt's full
JSON directly (same discipline as v0.0.0.2's `agentReceipt.result` fix)
showed the real shape: reasoning lives in its **own step**, named
`"reasoning"`, under a **`content`** field — not `thinking` on
`llm_response` at all. `llm_response`'s own `content` field is just the
raw string form of the final answer (e.g. `"5100"`), not the reasoning.
**Fixed:** look up the `"reasoning"` step and read `.content`.

## Fourth live-run finding: the calibration fix overcorrected
With the first calibration instruction in place ("near-zero move ->
near 5000"), a full run came back with **five of six estimates at
exactly or almost exactly 5000**, including a market with a **+0.82%**
move — the model had over-applied "stay near 5000" as a default rather
than a guideline for genuinely small moves. A qualitative instruction
("near-zero -> near 5000", "meaningfully large -> move away") gave the
model too little to calibrate *how far* to move for a given size of
move.

**Fix:** replaced the qualitative guidance with concrete numeric
anchor points (e.g. "+0.50% move -> ~7000-7800", "-1.00% move ->
~500-1500"), explicitly framed as reference points to interpolate
between rather than exact lookups, plus an explicit instruction not to
default to 5000 whenever the move is nonzero. LLMs calibrate much more
reliably against concrete numeric examples than descriptive rules —
worth remembering for any future prompt tuning on this project.

## Fifth live-run finding: one shared timeout was wrong for two very different agents
After the calibration fix, a run got 4 sensible, varied estimates
(0.504, 0.657, 0.65 — the fix worked) but **3 of 6 LLM calls timed out**
at 60 seconds. A real receipt fetched earlier already showed a genuine
LLM Inference call taking **~33 seconds of model time alone** (it
generates ~1860 reasoning tokens per call) — and this agent is shared
across every hackathon participant testing against it, so contention
adds further variance. The 60s timeout was sized for JSON API Request's
sub-2-second profile and never re-examined for the much slower LLM
agent. **Fix:** split into `JSON_API_REQUEST_TIMEOUT_MS` (60s, unchanged)
and `LLM_INFERENCE_TIMEOUT_MS` (5 minutes), passed explicitly into the
now-parameterized `submitAgentRequest()`. Also added a "...still
waiting" progress log every 15s during a poll, since a multi-minute
silent wait looks identical to a hang.

## Sixth live-run finding: printing the truncation marker as if it were content
Once reasoning calls stopped timing out, the console printed
`reasoning: <truncated, fetch the receipt URL for complete contents>`
verbatim — the code treated the Receipts Service's own placeholder
string as if it were the model's actual reasoning text. **Fix:** detect
that exact marker and print a clear "(too long for preview)" message
instead of echoing it as content. A full fetch-the-GCS-URL path for the
complete, untruncated reasoning is a reasonable future addition but
wasn't built here — the console preview is enough for this version's
purpose (debugging + demo color), not a permanent audit record.

## Run
```bash
npm install
npm run mispricing-detector-v2
```
Needs the same funded testnet wallet as v0.0.0.2/v0.0.0.3
(`PRIVATE_KEY` in `.env`) — funded generously, per the cost note above.

## Next step (v0.0.0.5 — proposed)
Once the LLM estimate is confirmed sane on live data, turn the console
table into a presentable output (formatted report or simple dashboard)
for the hackathon demo video.
