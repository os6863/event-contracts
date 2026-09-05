# v0.0.0.5 — Presentable HTML report for the demo video

## What this version does
Identical detection pipeline to v0.0.0.4 (scan DreamDEX -> price via
JSON API Request agent -> probability via LLM Inference agent ->
compare). The only addition: after the console table prints, the exact
same data is also written to a styled, self-contained HTML file at
`v0.0.0.5/output/report.html` — one "ticket" per market, with a
DreamDEX-vs-LLM probability bar comparison, the divergence value, and
the LLM's reasoning text when available.

**No new on-chain calls and no extra STT cost** — the report is built
from data already fetched during the same run, not a second pass.

## Why this version exists
Every previous version's output was a console table — fine for
verifying correctness, but a raw terminal table is a weak visual for a
2-3 minute demo video, and Presentation is 15% of the judging criteria
(UX is a separate 20%). A single static HTML file that opens in any
browser, with no server or build step, is the lowest-risk way to get a
presentable visual without spending the little remaining time on a full
web app.

## Design notes
Styled as a data-dense "market ledger" rather than a generic SaaS
dashboard, since the content itself (a list of market tickets with
numeric comparisons) is naturally tabular — not because a template
demanded cards. Monospace (IBM Plex Mono) carries all numeric data for
alignment; Space Grotesk carries headings. Color is used functionally,
not decoratively: amber marks a flagged (possibly mispriced) market,
teal/blue distinguish the two probability sources in the bar chart —
there is no color choice in this file that doesn't encode information.

## Validation
The HTML-generation logic (not the on-chain pipeline, which is
unchanged from v0.0.0.4 and already verified live) was tested offline
with synthetic data covering all four states a row can be in: flagged,
unflagged with truncated reasoning, failed LLM call, and skipped
(missing price data). Confirmed the output never leaks `undefined` or
`NaN` into the page, all HTML tags balance correctly, and `escapeHtml`
correctly neutralizes `&`, `<`, `>`, and `"` — relevant because market
questions and LLM reasoning text are both external, not hardcoded
strings.

## Changes vs. v0.0.0.4
- New `v0.0.0.5/mispricing-report.ts`.
- New npm script: `mispricing-report`.
- `v0.0.0.5/output/` added to `.gitignore` — the report is regenerated
  every run, not a static asset worth committing.
- Internally: row data is now a typed `ReportRow[]` (open price,
  current price, probabilities, etc. as real numbers) instead of a
  `Record<string, string>[]` of pre-formatted display strings, since
  the HTML renderer needs the raw numbers (for bar widths) that a
  string-only row couldn't provide.

## Run
```bash
npm install
npm run mispricing-report
```
Then open `v0.0.0.5/output/report.html` in a browser (double-click it,
or `start v0.0.0.5\output\report.html` on Windows). Needs the same
funded testnet wallet as v0.0.0.2-v0.0.0.4 (`PRIVATE_KEY` in `.env`).

## What this version is *not*
- Not a live-updating dashboard — it's a static snapshot from one run,
  regenerated each time the script is run.
- Not yet confirmed against a real run's actual data at the time of
  writing this file — the HTML-generation logic was validated with
  synthetic data (see Validation above); the underlying pipeline itself
  was already confirmed live in v0.0.0.4.

## Full-text reasoning (added after the first live run of this version)
The first real run confirmed the pipeline and layout work, but every
single reasoning field showed the "too long for preview" placeholder —
the Receipts Service's `type=minimal` mode replaces (not truncates) any
field over its length threshold, and the model's chain-of-thought output
is long enough (up to ~1860 completion tokens) to hit that every time.

Rather than ship a report where the AI's actual reasoning is never
visible — a real loss for the demo, since seeing *why* the model
estimated what it did is much more convincing than the number alone —
added a follow-up fetch: the Receipts Service's default (non-minimal)
mode returns a manifest of public GCS URLs instead of inline data;
fetching one gives the complete, untruncated receipt JSON. This only
runs when the "minimal" preview was actually truncated, and only adds
two extra HTTP calls (no additional on-chain cost) per market that
needs it.

Since full reasoning can run to thousands of characters, the HTML
report now shows it inside a collapsible `<details>` element (closed by
default, with a max-height + scroll once opened) instead of an
always-visible paragraph — keeps the report scannable while still
making the complete reasoning available. The console preview is
separately capped at 240 characters, since a multi-thousand-character
dump per market would flood the terminal.

## Live confirmation
A full run against 6 real live markets produced a correct report:
divergence math matched hand-checked values, the flagged/unflagged
visual distinction (border color, panel background) rendered as
intended in a real browser screenshot, and bar widths lined up with
their numeric labels. Confirmed by reviewing an actual screenshot, not
just the generated HTML source.

## Next step (v0.0.0.6 — proposed)
Final polish pass: tidy the root README, do one more full re-review of
every version, record the demo video, and prepare the DoraHacks
submission.
