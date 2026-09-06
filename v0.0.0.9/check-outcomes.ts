/**
 * check-outcomes.ts — v0.0.0.9
 *
 * Companion to mispricing-report.ts. Reads data/signal-history.json,
 * and for every logged market that hasn't been checked yet, reads its
 * REAL on-chain settlement (`getMarketOnchain(marketId).winningOutcome`)
 * — not a simulation, not an assumption. If the market has actually
 * resolved, this records:
 *   - the actual outcome (YES/NO)
 *   - whether DreamDEX's own market price picked the right side
 *   - whether our ensemble estimate picked the right side
 *   - a Brier score for both: (predicted_probability_of_YES - actual)^2,
 *     averaged over 0 (perfect) to 1 (worst) — this rewards a
 *     well-calibrated probability, not just guessing the right side.
 *     (Brier scoring is the same standard approach a couple of other
 *     hackathon entries in this space are also using — not something
 *     invented for this project.)
 *
 * This script is entirely READ-ONLY — no private key, no wallet, no
 * cost. A market only shows up as resolved once it has genuinely
 * closed and DreamDEX's own oracle has settled it, so this can't be run
 * "early" to fabricate a track record; it can only report what has
 * actually happened.
 *
 * Run this periodically (there's no automated cron — see
 * v0.0.0.7/CHANGES.md for why) as logged markets' expiry times pass.
 *
 * Run:
 *   npm install
 *   npm run check-outcomes
 */

import "dotenv/config";
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SomniaMarkets, SOMNIA_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import type { Hex } from "viem";

const INDEXER_URL =
  process.env.SOMNIA_INDEXER_URL ?? "https://dev.smk.somnia.host/v1/graphql";
const WS_RPC_URL =
  process.env.SOMNIA_WS_RPC_URL ?? "wss://api.infra.testnet.somnia.network/ws";

type SignalAgreement = "strong" | "weak" | "none";

// Same shape as mispricing-report.ts's HistoryEntry — duplicated rather
// than imported, matching this project's "each version is self-contained"
// convention (see README.md).
type HistoryEntry = {
  timestamp: string;
  symbol: string;
  marketId: string;
  asset: string;
  dreamdexUp: number;
  naiveEst: number;
  llmEst: number;
  ensembleEst: number;
  divergence: number;
  agreement: SignalAgreement;
  resolved?: boolean | "voided";
  actualOutcome?: "YES" | "NO";
  dreamdexCorrect?: boolean;
  ensembleCorrect?: boolean;
  dreamdexBrier?: number;
  ensembleBrier?: number;
};

function repoRootPath(...segments: string[]): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", ...segments);
}

function brier(predictedYesProb: number, actualYes: 0 | 1): number {
  return (predictedYesProb - actualYes) ** 2;
}

async function main() {
  console.log("\n🔎 Checking real settlement outcomes for logged markets (testnet, read-only)\n");

  const historyPath = repoRootPath("data", "signal-history.json");
  let history: HistoryEntry[];
  try {
    history = JSON.parse(await readFile(historyPath, "utf-8")) as HistoryEntry[];
  } catch {
    console.log("No data/signal-history.json found yet — run the report script first to log some predictions.\n");
    return;
  }

  const uncheckedMarketIds = [...new Set(history.filter((h) => h.resolved === undefined).map((h) => h.marketId))];

  if (uncheckedMarketIds.length === 0) {
    console.log("Every logged market has already been checked (resolved, voided, or previously confirmed still open).\n");
    return;
  }

  console.log(`${uncheckedMarketIds.length} unique unchecked market(s) in history. Reading on-chain status...\n`);

  const exchange = new SomniaMarkets({
    indexerUrl: INDEXER_URL,
    chain: somniaShannon,
    wsRpcUrl: WS_RPC_URL,
    addresses: SOMNIA_TESTNET_ADDRESSES,
  });

  let newlyResolved = 0;
  let newlyVoided = 0;
  let stillOpen = 0;

  for (const marketId of uncheckedMarketIds) {
    const matchingEntries = history.filter((h) => h.marketId === marketId && h.resolved === undefined);
    try {
      const onchain = await exchange.client.getMarketOnchain(marketId as Hex);

      if (onchain.isVoided) {
        for (const entry of matchingEntries) entry.resolved = "voided";
        newlyVoided += matchingEntries.length;
        console.log(`   ⚪ ${matchingEntries[0].symbol} — voided (excluded from scoring)`);
        continue;
      }

      if (!onchain.isResolved) {
        stillOpen += matchingEntries.length;
        console.log(`   ⏳ ${matchingEntries[0].symbol} — not settled yet, will check again next run`);
        continue;
      }

      const actualOutcome: "YES" | "NO" = onchain.winningOutcome === 0 ? "YES" : "NO";
      const actualYes: 0 | 1 = onchain.winningOutcome === 0 ? 1 : 0;

      for (const entry of matchingEntries) {
        const dreamdexSide: "YES" | "NO" = entry.dreamdexUp > 0.5 ? "YES" : "NO";
        const ensembleSide: "YES" | "NO" = entry.ensembleEst > 0.5 ? "YES" : "NO";
        entry.resolved = true;
        entry.actualOutcome = actualOutcome;
        entry.dreamdexCorrect = dreamdexSide === actualOutcome;
        entry.ensembleCorrect = ensembleSide === actualOutcome;
        entry.dreamdexBrier = brier(entry.dreamdexUp, actualYes);
        entry.ensembleBrier = brier(entry.ensembleEst, actualYes);
      }
      newlyResolved += matchingEntries.length;
      console.log(
        `   ✅ ${matchingEntries[0].symbol} — resolved ${actualOutcome} (DreamDEX ${matchingEntries[0].dreamdexCorrect ? "correct" : "wrong"}, ensemble ${matchingEntries[0].ensembleCorrect ? "correct" : "wrong"})`
      );
    } catch (err) {
      console.log(`   ❌ Failed to check ${matchingEntries[0]?.symbol ?? marketId}: ${err instanceof Error ? err.message : err}`);
    }
  }

  await exchange.close();
  await writeFile(historyPath, JSON.stringify(history, null, 2), "utf-8");

  console.log(
    `\n📈 Updated ${historyPath}: ${newlyResolved} newly resolved, ${newlyVoided} newly voided, ${stillOpen} still open.\n`
  );

  const allResolved = history.filter((h) => h.resolved === true);
  if (allResolved.length > 0) {
    const acc = (key: "dreamdexCorrect" | "ensembleCorrect") =>
      ((allResolved.filter((h) => h[key]).length / allResolved.length) * 100).toFixed(0);
    const avgBrier = (key: "dreamdexBrier" | "ensembleBrier") => {
      const vals = allResolved.map((h) => h[key]).filter((v): v is number => v !== undefined);
      return (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(4);
    };
    console.log(`📊 Track record across all ${allResolved.length} settled market(s) so far:`);
    console.log(`   DreamDEX:     ${acc("dreamdexCorrect")}% correct side, avg. Brier ${avgBrier("dreamdexBrier")}`);
    console.log(`   Our ensemble: ${acc("ensembleCorrect")}% correct side, avg. Brier ${avgBrier("ensembleBrier")}\n`);
  } else {
    console.log("No markets have settled yet — nothing to score. Run this again after some logged markets close.\n");
  }
}

main().catch((err) => {
  console.error("❌ check-outcomes failed:\n", err);
  process.exit(1);
});
