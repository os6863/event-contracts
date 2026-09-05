/**
 * mispricing-detector.ts — v0.0.0.3
 *
 * Combines v0.0.0.1 (live DreamDEX market scan) with v0.0.0.2 (on-chain
 * Somnia Agent price fetch) to compute the project's first real
 * **mispricing signal**: DreamDEX's own implied probability (from its
 * order book) vs. a naive independent probability estimate derived from
 * how far the current price has moved from each market's opening price.
 *
 * This file started as a pure diagnostic (see CHANGES.md) because the
 * opening price's numeric scale wasn't documented precisely enough to
 * trust blindly — it was confirmed against 6 live markets (raw ÷ 100
 * lines up with the agent's real price) before this calculation was
 * written. The naive probability model here is intentionally simple —
 * a linear nudge from 0.5 based on % price move, no volatility or
 * time-to-expiry modeling — proving the full pipeline end-to-end before
 * v0.0.0.4 swaps in an LLM-based estimate via a second Somnia Agent.
 *
 * Needs the same funded testnet wallet as v0.0.0.2 (PRIVATE_KEY in .env).
 *
 * Run:
 *   npm install
 *   npm run mispricing-detector
 */

import "dotenv/config";
import {
  SomniaMarkets,
  SOMNIA_TESTNET_ADDRESSES,
  isBinaryMarket,
} from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import {
  createPublicClient,
  createWalletClient,
  http,
  fallback,
  encodeFunctionData,
  decodeFunctionResult,
  decodeEventLog,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// --- DreamDEX config (same as v0.0.0.1) ---------------------------------
const INDEXER_URL =
  process.env.SOMNIA_INDEXER_URL ?? "https://dev.smk.somnia.host/v1/graphql";
const WS_RPC_URL =
  process.env.SOMNIA_WS_RPC_URL ?? "wss://api.infra.testnet.somnia.network/ws";
const VENUE_ID = process.env.SOMNIA_VENUE_ID;
const MIN_HEADROOM_FRACTION = 0.1;
const MIN_HEADROOM_FLOOR_SECONDS = 60;
const STATUS_TRADING = 1;

// --- Somnia Agents config (same as v0.0.0.2) ----------------------------
const RPC_URLS = (
  process.env.SOMNIA_AGENT_RPC_URLS ??
  "https://dream-rpc.somnia.network/,https://api.infra.testnet.somnia.network/"
)
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);
const PLATFORM_ADDRESS = (process.env.SOMNIA_AGENTS_CONTRACT ??
  "0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776") as Hex;
const JSON_API_REQUEST_AGENT_ID = 13174292974160097713n;
const PER_AGENT_EXECUTION_COST = 30_000_000_000_000_000n; // 0.03 STT
const SUBCOMMITTEE_SIZE = 3n;
const REQUEST_TIMEOUT_MS = 60 * 1000;
const RECEIPTS_SERVICE_URL =
  process.env.SOMNIA_RECEIPTS_SERVICE_URL ?? "https://receipts.testnet.agents.somnia.host";
const COINGECKO_URL =
  process.env.COINGECKO_URL_PRICES ??
  "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd";
const PRICE_DECIMALS = 8;

// Map DreamDEX's `asset` field ("BTC" / "ETH") to a CoinGecko selector.
// Extend this if DreamDEX lists more assets later.
const ASSET_SELECTORS: Record<string, string> = {
  BTC: "bitcoin.usd",
  ETH: "ethereum.usd",
};

const platformAbi = [
  {
    type: "function",
    name: "createRequest",
    inputs: [
      { type: "uint256", name: "agentId" },
      { type: "address", name: "callbackAddress" },
      { type: "bytes4", name: "callbackSelector" },
      { type: "bytes", name: "payload" },
    ],
    outputs: [{ type: "uint256", name: "requestId" }],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "getRequestDeposit",
    inputs: [],
    outputs: [{ type: "uint256", name: "" }],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "RequestCreated",
    inputs: [
      { type: "uint256", name: "requestId", indexed: true },
      { type: "uint256", name: "agentId", indexed: true },
      { type: "uint256", name: "perAgentBudget", indexed: false },
      { type: "bytes", name: "payload", indexed: false },
      { type: "address[]", name: "subcommittee", indexed: false },
    ],
  },
] as const;

const fetchUintAbi = [
  {
    type: "function",
    name: "fetchUint",
    inputs: [
      { type: "string", name: "url" },
      { type: "string", name: "selector" },
      { type: "uint8", name: "decimals" },
    ],
    outputs: [{ type: "uint256", name: "result" }],
  },
] as const;

type MinimalReceipt = {
  status: "success" | "failed" | "timeout";
  errorMessage?: string;
  agentReceipt?: { result: Hex };
};
type MinimalReceiptsResponse = { count: number; receipts: MinimalReceipt[] };

// Identical logic to v0.0.0.2's fetchPriceViaAgent — see that version's
// CHANGES.md for why it works this way (Receipts Service, not getRequest;
// RPC fallback; retry-on-transient-error).
async function fetchPriceViaAgent(
  publicClient: ReturnType<typeof createPublicClient>,
  walletClient: ReturnType<typeof createWalletClient>,
  selector: string
): Promise<bigint> {
  const payload = encodeFunctionData({
    abi: fetchUintAbi,
    functionName: "fetchUint",
    args: [COINGECKO_URL, selector, PRICE_DECIMALS],
  });

  const reserve = await publicClient.readContract({
    address: PLATFORM_ADDRESS,
    abi: platformAbi,
    functionName: "getRequestDeposit",
  });
  const deposit = reserve + PER_AGENT_EXECUTION_COST * SUBCOMMITTEE_SIZE;

  const hash = await walletClient.writeContract({
    address: PLATFORM_ADDRESS,
    abi: platformAbi,
    functionName: "createRequest",
    args: [JSON_API_REQUEST_AGENT_ID, "0x0000000000000000000000000000000000000000", "0x00000000", payload],
    value: deposit,
    chain: somniaShannon,
    account: walletClient.account!,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const createdLog = receipt.logs.find((log) => {
    try {
      return decodeEventLog({ abi: platformAbi, data: log.data, topics: log.topics }).eventName === "RequestCreated";
    } catch {
      return false;
    }
  });
  if (!createdLog) throw new Error("RequestCreated event not found in transaction logs");
  const decodedCreated = decodeEventLog({ abi: platformAbi, data: createdLog.data, topics: createdLog.topics });
  if (decodedCreated.eventName !== "RequestCreated") throw new Error("Unexpected event decoded");
  const requestId = decodedCreated.args.requestId;

  const pollIntervalMs = 1000;
  const maxConsecutiveErrors = 5;
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  const receiptsUrl = `${RECEIPTS_SERVICE_URL}/agent-receipts?contractAddress=${PLATFORM_ADDRESS}&requestId=${requestId}&type=minimal`;

  const successReceipt = await (async () => {
    let consecutiveErrors = 0;
    for (;;) {
      try {
        const res = await fetch(receiptsUrl);
        if (!res.ok) throw new Error(`Receipts Service HTTP ${res.status}`);
        const data = (await res.json()) as MinimalReceiptsResponse;
        consecutiveErrors = 0;

        const successOne = data.receipts?.find((r) => r.status === "success");
        if (successOne) return successOne;

        const reported = data.receipts ?? [];
        if (reported.length >= 2 && reported.every((r) => r.status !== "success")) {
          const first = reported[0];
          throw new Error(
            first.status === "failed"
              ? `Agent execution failed: ${first.errorMessage ?? "no error message"}`
              : "Request timed out (per receipt)"
          );
        }
      } catch (err) {
        if (
          err instanceof Error &&
          (err.message.startsWith("Agent execution") || err.message.startsWith("Request timed out"))
        ) {
          throw err;
        }
        consecutiveErrors++;
        if (consecutiveErrors > maxConsecutiveErrors) {
          throw new Error(
            `Receipts Service failed ${maxConsecutiveErrors} times in a row: ${err instanceof Error ? err.message : err}`
          );
        }
      }
      if (Date.now() > deadline) throw new Error(`Timed out polling the Receipts Service after ${REQUEST_TIMEOUT_MS / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  })();

  if (!successReceipt.agentReceipt?.result) throw new Error("Receipt reported success but carried no agentReceipt.result");
  const result = decodeFunctionResult({ abi: fetchUintAbi, functionName: "fetchUint", data: successReceipt.agentReceipt.result });
  if (typeof result !== "bigint") throw new Error(`Unexpected decoded result type from fetchUint: ${typeof result}`);
  return result;
}

type ScannedMarket = {
  symbol: string;
  question: string;
  asset: string;
  marketId: string;
  upPrice: number | null;
  secondsLeft: number;
};

async function scanLiveMarkets(exchange: InstanceType<typeof SomniaMarkets>): Promise<ScannedMarket[]> {
  const unifiedMarkets = Object.values(await exchange.loadMarkets(true));
  const now = Date.now() / 1000;
  const results: ScannedMarket[] = [];

  for (const m of unifiedMarkets) {
    if (!m.active) continue;
    if (!isBinaryMarket(m.info)) continue;
    if (VENUE_ID && m.info.venueId?.toLowerCase() !== VENUE_ID.toLowerCase()) continue;

    const onchain = await exchange.client.getMarketOnchain(m.info.marketId);
    if (onchain.status !== STATUS_TRADING) continue;

    const secondsLeft = Number(m.info.expiry) - now;
    const intervalSec = m.info.intervalSec ? Number(m.info.intervalSec) : null;
    const minHeadroom = intervalSec
      ? Math.max(MIN_HEADROOM_FLOOR_SECONDS, intervalSec * MIN_HEADROOM_FRACTION)
      : MIN_HEADROOM_FLOOR_SECONDS;
    if (secondsLeft < minHeadroom) continue;

    const upSymbol = m.outcomes?.[0]?.symbol;
    let upPrice: number | null = null;
    if (upSymbol) {
      try {
        const book = await exchange.fetchOrderBook(upSymbol, 1);
        const bestBid = book.bids[0]?.[0];
        const bestAsk = book.asks[0]?.[0];
        if (bestBid !== undefined && bestAsk !== undefined) upPrice = (bestBid + bestAsk) / 2;
        else if (bestAsk !== undefined) upPrice = bestAsk;
        else if (bestBid !== undefined) upPrice = bestBid;
      } catch {
        // no liquidity yet
      }
    }

    results.push({
      symbol: upSymbol ?? m.symbol,
      question: m.info.question,
      asset: m.info.asset,
      marketId: m.info.marketId,
      upPrice,
      secondsLeft: Math.round(secondsLeft),
    });
  }

  return results;
}

async function main() {
  console.log("\n🔎 Mispricing diagnostic — comparing DreamDEX strike vs Somnia Agent price (testnet)\n");

  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.error("❌ PRIVATE_KEY is not set in .env — see v0.0.0.2/CHANGES.md for how to generate/fund a testnet wallet.");
    process.exit(1);
  }
  const account = privateKeyToAccount(privateKey as Hex);

  const exchange = new SomniaMarkets({
    indexerUrl: INDEXER_URL,
    chain: somniaShannon,
    wsRpcUrl: WS_RPC_URL,
    addresses: SOMNIA_TESTNET_ADDRESSES,
  });

  console.log("Scanning live DreamDEX markets...");
  const markets = await scanLiveMarkets(exchange);

  if (markets.length === 0) {
    console.log("No live markets with enough time left were found — try again later.\n");
    await exchange.close();
    return;
  }
  console.log(`Found ${markets.length} live market(s).\n`);

  // strike is 0 on every reference-question market (confirmed live) —
  // the real opening price for "closes at or above its opening price"
  // markets comes from this separate batch call instead.
  const openingPrices = await exchange.client.getOpeningPrices(markets.map((m) => m.marketId));

  const uniqueAssets = [...new Set(markets.map((m) => m.asset))];
  const transport = fallback(RPC_URLS.map((url) => http(url)));
  const publicClient = createPublicClient({ chain: somniaShannon, transport });
  const walletClient = createWalletClient({ account, chain: somniaShannon, transport });

  const agentPrices: Record<string, number | null> = {};
  for (const asset of uniqueAssets) {
    const selector = ASSET_SELECTORS[asset];
    if (!selector) {
      console.log(`⚠️  No CoinGecko selector mapped for asset "${asset}" — skipping.`);
      agentPrices[asset] = null;
      continue;
    }
    console.log(`Requesting ${asset} price via Somnia Agent...`);
    try {
      const raw = await fetchPriceViaAgent(publicClient, walletClient, selector);
      agentPrices[asset] = Number(raw) / 10 ** PRICE_DECIMALS;
      console.log(`   ✅ ${asset} agent price = $${agentPrices[asset]!.toLocaleString()}\n`);
    } catch (err) {
      console.log(`   ❌ Failed to fetch ${asset} price: ${err instanceof Error ? err.message : err}\n`);
      agentPrices[asset] = null;
    }
  }

  await exchange.close();

  console.log("\n📊 Mispricing signal — DreamDEX implied probability vs. a naive independent estimate:\n");

  // Confirmed from live data (6/6 markets, this run): dividing the raw
  // opening price by 100 lines up with the agent's current price within
  // normal price movement over the window's elapsed time. This is a
  // fixed-point representation with 2 decimal places, not 8 or 18.
  const OPENING_PRICE_SCALE = 100;

  // NAIVE probability model (intentionally simple — see CHANGES.md):
  // if the current price is X% above/below the opening price, nudge the
  // "Up" probability away from 0.5 by SENSITIVITY * X, clamped to a sane
  // range. This has no volatility/time-to-expiry modeling — it is a
  // first-pass estimate to prove the pipeline end-to-end, not a
  // calibrated forecast. v0.0.0.4 replaces this with an LLM-based
  // estimate via a Somnia Agent.
  const SENSITIVITY = 8;
  const PROB_FLOOR = 0.02;
  const PROB_CEILING = 0.98;
  const MISPRICING_ALERT_THRESHOLD = 0.15; // |divergence| above this gets flagged

  const rows = markets.map((m) => {
    const openingRaw = openingPrices[m.marketId.toLowerCase()] ?? null;
    const openingPrice = openingRaw !== null ? Number(openingRaw) / OPENING_PRICE_SCALE : null;
    const currentPrice = agentPrices[m.asset] ?? null;

    let naiveProb: number | null = null;
    let relativeMovePct: number | null = null;
    if (openingPrice !== null && openingPrice > 0 && currentPrice !== null) {
      relativeMovePct = ((currentPrice - openingPrice) / openingPrice) * 100;
      const raw = 0.5 + (SENSITIVITY * relativeMovePct) / 100;
      naiveProb = Math.min(PROB_CEILING, Math.max(PROB_FLOOR, raw));
    }

    const divergence = naiveProb !== null && m.upPrice !== null ? naiveProb - m.upPrice : null;

    return {
      Symbol: m.symbol,
      Opening: openingPrice !== null ? `$${openingPrice.toFixed(2)}` : "n/a",
      Current: currentPrice !== null ? `$${currentPrice.toFixed(2)}` : "n/a",
      "Move %": relativeMovePct !== null ? `${relativeMovePct >= 0 ? "+" : ""}${relativeMovePct.toFixed(2)}%` : "n/a",
      "DreamDEX Up": m.upPrice !== null ? m.upPrice.toFixed(4) : "no liquidity",
      "Naive est.": naiveProb !== null ? naiveProb.toFixed(4) : "n/a",
      Divergence: divergence !== null ? (divergence >= 0 ? "+" : "") + divergence.toFixed(4) : "n/a",
      Signal: divergence !== null && Math.abs(divergence) >= MISPRICING_ALERT_THRESHOLD ? "🔥 possible mispricing" : "",
    };
  });

  console.table(rows);

  const flagged = rows.filter((r) => r.Signal !== "");
  console.log(
    flagged.length > 0
      ? `\n🔥 ${flagged.length} market(s) show divergence ≥ ${MISPRICING_ALERT_THRESHOLD} between DreamDEX and the naive estimate.\n`
      : `\nNo market currently exceeds the ${MISPRICING_ALERT_THRESHOLD} divergence threshold.\n`
  );
}

main().catch((err) => {
  console.error("❌ mispricing-diagnostic failed:\n", err);
  process.exit(1);
});
