/** Read-only chain access. Updates local settlement history and re-renders the saved snapshot. */
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SomniaMarkets, SOMNIA_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import type { Hex } from "viem";
import { readHistory, saveHistory, uncheckedIds, settleEntries } from "./history.js";
import { validMarketId } from "./analysis.js";
import { writeReport } from "./report-ui.js";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
async function main() {
  const history = await readHistory(root);
  const legacyCount = history.filter(h => !validMarketId(h.marketId)).length;
  console.log(`Skipping ${legacyCount} legacy record(s) without a valid market ID; originals are preserved.`);
  const ids = uncheckedIds(history);
  let failures = 0;
  if (ids.length) {
    const exchange = new SomniaMarkets({
      indexerUrl: process.env.SOMNIA_INDEXER_URL ?? "https://dev.smk.somnia.host/v1/graphql",
      wsRpcUrl: process.env.SOMNIA_WS_RPC_URL ?? "wss://api.infra.testnet.somnia.network/ws",
      chain: somniaShannon, addresses: SOMNIA_TESTNET_ADDRESSES });
    try {
      for (const id of ids) {
        try {
          const state = await exchange.client.getMarketOnchain(id as Hex);
          const entries = history.filter(h => h.marketId === id && h.resolved === undefined);
          settleEntries(entries, state);
          console.log(`${entries[0]?.symbol}: ${state.isVoided ? "voided" : state.isResolved ? "settled" : "pending"}`);
        } catch (error) { failures++; console.error(`Settlement lookup failed for ${id}: ${error instanceof Error ? error.message : "unknown error"}`); }
      }
    } finally { await exchange.close(); }
    await saveHistory(root, history);
  }
  // No fresh agent calls needed to update the Track Record in both HTML outputs.
  try {
    const snapshot = JSON.parse(await readFile(join(root, "data", "latest-report.json"), "utf-8"));
    if (snapshot.version !== "0.1.0" || !Array.isArray(snapshot.rows)) throw new Error("Invalid report snapshot (expected version 0.1.0)");
    await writeReport(snapshot.rows, history, snapshot.generatedAt);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    console.log("No v10 snapshot yet; run `npm run report` to generate the UI.");
  }
  console.log(`${history.filter(h => h.resolved === true).length} resolved prediction records. ${failures} lookup failure(s).`);
  if (failures) process.exitCode = 1;
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Outcome check failed"); process.exitCode = 1; });
