/**
 * Read-only integration smoke test. Unlike src/tests.test.ts (pure-function
 * unit tests that run offline in CI on every push), this hits the real
 * Somnia testnet: the DreamDEX indexer, the RPC, and on-chain market reads.
 * It needs no PRIVATE_KEY and never signs or sends a transaction — it exists
 * to catch "the indexer/RPC/market shape changed and nothing noticed" before
 * a live report run does, which the unit suite structurally cannot do since
 * it never touches the network.
 *
 * Run manually: npm run test:integration
 * Not part of `npm test` and not required to pass for a docs/logic-only PR —
 * see .github/workflows/integration-smoke.yml for how CI runs this
 * separately and non-blockingly, since a transient testnet RPC hiccup
 * (which has happened in a real run — see CHANGELOG.md) shouldn't fail an
 * unrelated pull request.
 */
import "dotenv/config";
import { SomniaMarkets, SOMNIA_TESTNET_ADDRESSES, isBinaryMarket } from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { createPublicClient, http, fallback } from "viem";
import { INDEXER_URL, WS_RPC_URL, RPC_URLS } from "./mispricing-report.js";

let failures = 0;
async function check(name: string, fn: () => Promise<unknown>): Promise<void> {
  const start = Date.now();
  try {
    const result = await fn();
    console.log(`ok   ${name} (${Date.now() - start}ms)${result !== undefined ? ` — ${JSON.stringify(result)}` : ""}`);
  } catch (error) {
    failures++;
    console.log(`FAIL ${name} (${Date.now() - start}ms): ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main() {
  const transport = fallback(RPC_URLS.map((url) => http(url)));
  const publicClient = createPublicClient({ chain: somniaShannon, transport });
  const exchange = new SomniaMarkets({ indexerUrl: INDEXER_URL, chain: somniaShannon, wsRpcUrl: WS_RPC_URL, addresses: SOMNIA_TESTNET_ADDRESSES });

  let firstBinaryMarketId: string | null = null;
  let firstUpSymbol: string | null = null;

  await check("RPC reachable (getBlockNumber)", () => publicClient.getBlockNumber().then((n) => Number(n)));

  await check("Indexer reachable, market discovery returns a shape we recognize (loadMarkets)", async () => {
    const markets = Object.values(await exchange.loadMarkets(true));
    let binaryCount = 0;
    for (const m of markets) {
      if (!isBinaryMarket(m.info)) continue;
      binaryCount++;
      if (!firstBinaryMarketId) { firstBinaryMarketId = m.info.marketId; firstUpSymbol = m.outcomes?.[0]?.symbol ?? null; }
    }
    return { totalMarkets: markets.length, binaryMarkets: binaryCount };
  });

  if (firstBinaryMarketId) {
    await check("On-chain market state read (getMarketOnchain) — settlement state is reachable", async () => {
      const onchain = await exchange.client.getMarketOnchain(firstBinaryMarketId as `0x${string}`);
      return { status: onchain.status, isResolved: onchain.isResolved, isVoided: onchain.isVoided };
    });
    await check("Opening prices read (getOpeningPrices)", async () => {
      const prices = await exchange.client.getOpeningPrices([firstBinaryMarketId as `0x${string}`]);
      return { found: Object.keys(prices).length > 0 };
    });
  } else {
    console.log("skip On-chain market state / opening price checks — no live binary market found this run");
  }

  if (firstUpSymbol) {
    await check("Order book reachable (fetchOrderBook)", async () => {
      const book = await exchange.fetchOrderBook(firstUpSymbol as string, 1);
      return { hasBid: book.bids.length > 0, hasAsk: book.asks.length > 0 };
    });
  } else {
    console.log("skip Order book check — no live market symbol found this run");
  }

  console.log(failures === 0 ? "\nAll integration checks passed." : `\n${failures} integration check(s) failed.`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("Integration smoke test crashed:", error);
  process.exitCode = 1;
});
