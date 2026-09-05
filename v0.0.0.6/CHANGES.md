# v0.0.0.6 — Final polish pass (no new code)

## What this version does
This stage adds no new detection logic — v0.0.0.5 remains the current
functional pipeline. It's a whole-repo review and polish pass ahead of
submission:

1. **Full-repo re-review.** Ran `tsc --noEmit` across all five versions
   together (not just each one in isolation) to confirm nothing in the
   shared config (`tsconfig.json`, `package.json`) regressed as versions
   were added. Re-scanned the entire repository for stray non-English
   text and leftover TODO/FIXME markers. Both came back clean.
2. **Root `README.md` rewritten** for a hackathon judge reading the repo
   for the first time: the pitch, an architecture diagram, a quickstart
   that runs the current version end to end, a table summarizing every
   version's real bugs (linking each version's own `CHANGES.md` for
   detail), a cost breakdown, and the tech stack. Previously the root
   README only described v0.0.0.1's read-only scanner and hadn't been
   updated as later versions added the wallet, the two Somnia Agents, and
   the HTML report.
3. **`package.json` metadata updated** — version bumped to `0.0.0.5` to
   match the current functional stage, description updated to reflect
   the full pipeline instead of the original read-only-scanner-only
   description.

## Why this matters for judging
Every prior version's `CHANGES.md` documents a real bug caught by
building, running, and reviewing against live data — that discipline is
part of what this project is trying to demonstrate. A stale or
incomplete root README would undercut that story for anyone who starts
by reading the front page of the repo rather than the version history.

## What's still manual (not something code can do)
- Recording the demo video.
- Submitting via the DoraHacks hackathon page.

## Post-write finding: SDK version was silently capped below the docs' new floor
A final re-read of `docs.dreamdex.io/developers/event-contracts` (updated
9 hours before this check) added a new warning: **below markets-sdk
0.29.0, `loadMarkets()` silently caps at 10,000 markets** with nothing
to indicate it happened. `package.json` pinned `^0.28.1` — because caret
ranges on a `0.x` package only allow patch bumps, this range could
**never** have resolved to `0.29.0` even via `npm install` alone.
**Fixed:** bumped to `^0.29.0`, reinstalled, and re-ran `tsc --noEmit`
across the whole repo — no breaking API changes affected this project's
usage. Also cross-checked the full Gotchas page against every version's
code: all applicable gotchas (venue scoping, on-chain status gating,
expiry headroom, keying by marketId, not parsing question text) were
already satisfied; the order-placement-specific gotchas don't apply
since this project never places orders on DreamDEX.

## Cost
Zero — no on-chain calls in this version.
