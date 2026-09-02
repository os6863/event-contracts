/**
 * market-scanner.ts — v0.0.0.1
 *
 * READ-ONLY. No private key, no signing, no funds at risk, zero cost.
 *
 * Connects to DreamDEX (Somnia Shannon testnet) and lists every currently
 * TRADING Event Contract market, with its live Up (YES) price (implied
 * probability) and how much time is left before the window closes.
 *
 * This is the foundation the rest of the project builds on: before we can
 * compare DreamDEX's price to any independent estimate (v0.0.0.2+), we first
 * need a reliable, gotcha-aware read of "what markets exist and what are they
 * quoting right now".
 *
 * Run:
 *   npm install
 *   npm run scan
 *
 * Types below were checked against the installed package
 * (node_modules/@somnia-chain/markets-sdk/dist/*.d.ts), not guessed from
 * docs alone — see CHANGES.md for the mismatch that turned up.
 */

import "dotenv/config";
import { SomniaMarkets, SOMNIA_TESTNET_ADDRESSES, isBinaryMarket } from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";

// --- Config -----------------------------------------------------------
// All defaults are the public DreamDEX/Somnia TESTNET endpoints — nothing
// here requires payment, an API key, or a funded wallet.
const INDEXER_URL =
  process.env.SOMNIA_INDEXER_URL ?? "https://dev.smk.somnia.host/v1/graphql";
const WS_RPC_URL =
  process.env.SOMNIA_WS_RPC_URL ?? "wss://api.infra.testnet.somnia.network/ws";

// IMPORTANT — read before changing this file:
// The Somnia Markets indexer is SHARED infrastructure — "thousands of venues
// x cadences" per the SDK's own type docs. DreamDEX is one venue among many.
// Without filtering by venueId, this scanner would silently mix in binary
// markets from other, unrelated venues. (Confirmed against
// dreamdex-bot-kit/docs/event-contracts.md: "Set VENUE_ID or the bots will
// refuse to guess.")
//
// Venue ids are NOT stable long-term ("Both networks changed venue three
// times in the first week of August" per the same doc) — treat the default
// below as a starting point, not a permanent constant. If this scanner ever
// reports "0 markets for this venue" while the discovery list below shows
// candidates, DreamDEX's testnet venue has rotated — update SOMNIA_VENUE_ID
// in your .env to the new value.
const VENUE_ID = process.env.SOMNIA_VENUE_ID;

// Gotcha #9 (docs.dreamdex.io/.../gotchas): a window minutes from close can
// lock between our snapshot and any later action, so we skip markets with
// too little time left. Per dreamdex-bot-kit's own gotcha notes, a FIXED
// threshold is wrong — it can reject every market on a venue running short
// windows. We scale it instead: 10% of the market's own cadence
// (intervalSec), floored at 60s so we never accept a market with almost no
// time left even on the shortest (15m) cadence.
const MIN_HEADROOM_FRACTION = 0.1;
const MIN_HEADROOM_FLOOR_SECONDS = 60;

// Somnia Markets "Trading" on-chain status (see Market Structure & Lifecycle:
// Listed(0) -> Trading(1) -> Locked(2) -> Resolved(4) | Voided(5)).
const STATUS_TRADING = 1;

type ScannedMarket = {
  symbol: string;
  question: string;
  upPrice: number | null; // implied probability of "Up"/YES, in (0, 1)
  secondsLeft: number;
};

async function main() {
  console.log("\n📡 DreamDEX Event Contracts — live market scanner (testnet, read-only)\n");

  // No `privateKey` passed: this version never signs a transaction, so no
  // wallet — funded or otherwise — is required to run it.
  const exchange = new SomniaMarkets({
    indexerUrl: INDEXER_URL,
    chain: somniaShannon,
    wsRpcUrl: WS_RPC_URL,
    addresses: SOMNIA_TESTNET_ADDRESSES,
  });

  // The unified tier (loadMarkets) is what carries a human-readable outcome
  // symbol ("BTC-...#YES") — the raw client.listLiveBinaryMarkets() rows do
  // NOT have this field, they only have marketId/question/asset/expiry.
  //
  // loadMarkets() has NO filter argument (unlike client.listLiveBinaryMarkets)
  // — it returns every market on the shared indexer, every venue included.
  // We filter to our venue ourselves, right after narrowing to binary.
  const unifiedMarkets = Object.values(await exchange.loadMarkets(true));
  const now = Date.now() / 1000;

  const allBinary = unifiedMarkets.filter((m) => isBinaryMarket(m.info));

  if (!VENUE_ID) {
    // Guided discovery instead of silently scanning every venue on the
    // indexer. Show what's actually out there so the person can pick the
    // right id — never guess.
    const venues = new Map<string, { asset: string; count: number }>();
    for (const m of allBinary) {
      const v = (m.info as { venueId?: string | null }).venueId;
      if (!v) continue;
      const entry = venues.get(v) ?? { asset: (m.info as { asset: string }).asset, count: 0 };
      entry.count += 1;
      venues.set(v, entry);
    }

    console.log("⚠️  SOMNIA_VENUE_ID is not set.\n");
    console.log(
      "This indexer is shared across multiple venues — without a venue filter, this scanner's data could include markets unrelated to DreamDEX.\n"
    );
    if (venues.size > 0) {
      console.log("Venue ids currently visible on this indexer:\n");
      console.table(
        [...venues.entries()].map(([venueId, info]) => ({
          venueId,
          "sample asset": info.asset,
          "market count": info.count,
        }))
      );
      console.log(
        "\nFind the venueId that belongs to DreamDEX (from this list, or the hackathon's dev Telegram group) and set SOMNIA_VENUE_ID in your .env.\n"
      );
    } else {
      console.log("No binary markets are visible on this indexer right now — try again later.\n");
    }
    await exchange.close();
    return;
  }

  const results: ScannedMarket[] = [];

  for (const m of allBinary) {
    if (!m.active) continue;
    if (!isBinaryMarket(m.info)) continue; // narrows m.info for TS below

    // Scope to our venue — see the VENUE_ID comment above for why this is
    // not optional on a shared indexer.
    if (m.info.venueId?.toLowerCase() !== VENUE_ID.toLowerCase()) continue;

    // Gotcha #1: the indexer lags the chain by seconds — always re-check the
    // on-chain status before trusting a market is actually tradable.
    const onchain = await exchange.client.getMarketOnchain(m.info.marketId);
    if (onchain.status !== STATUS_TRADING) continue;

    const secondsLeft = Number(m.info.expiry) - now;

    // Gotcha #9, scaled per dreamdex-bot-kit's own correction: a fixed
    // threshold rejects everything on a short-cadence venue. Use 10% of this
    // market's own interval, floored at MIN_HEADROOM_FLOOR_SECONDS.
    const intervalSec = m.info.intervalSec ? Number(m.info.intervalSec) : null;
    const minHeadroom = intervalSec
      ? Math.max(MIN_HEADROOM_FLOOR_SECONDS, intervalSec * MIN_HEADROOM_FRACTION)
      : MIN_HEADROOM_FLOOR_SECONDS;
    if (secondsLeft < minHeadroom) continue;

    // outcomes[0] is the "Up"/YES side symbol, e.g. "BTC-0-12AUG26-1600/USDso#YES".
    const upSymbol = m.outcomes?.[0]?.symbol;

    let upPrice: number | null = null;
    if (upSymbol) {
      try {
        const book = await exchange.fetchOrderBook(upSymbol, 1);
        const bestBid = book.bids[0]?.[0];
        const bestAsk = book.asks[0]?.[0];
        if (bestBid !== undefined && bestAsk !== undefined) {
          upPrice = (bestBid + bestAsk) / 2; // mid-price
        } else if (bestAsk !== undefined) {
          upPrice = bestAsk;
        } else if (bestBid !== undefined) {
          upPrice = bestBid;
        }
        // If neither side has resting liquidity, upPrice stays null — the
        // market is live but has no quotes yet.
      } catch {
        // No book / no liquidity yet — leave upPrice as null, don't crash the scan.
      }
    }

    results.push({
      symbol: upSymbol ?? m.symbol,
      question: m.info.question,
      upPrice,
      secondsLeft: Math.round(secondsLeft),
    });
  }

  if (results.length === 0) {
    console.log("No live market found for this venue with enough time left.");
    console.log("(Testnet may have no active markets right now, or the venueId has rotated — try again later.)\n");
    await exchange.close();
    return;
  }

  results.sort((a, b) => a.secondsLeft - b.secondsLeft);

  console.table(
    results.map((r) => ({
      Symbol: r.symbol,
      Question: r.question,
      "Up Price (prob.)": r.upPrice !== null ? r.upPrice.toFixed(4) : "no liquidity",
      "Time Left (min)": (r.secondsLeft / 60).toFixed(1),
    }))
  );

  console.log(`\n✅ ${results.length} live, tradable market(s) found.\n`);

  await exchange.close();
}

main().catch((err) => {
  console.error("❌ Scanner failed:\n", err);
  process.exit(1);
});
