/**
 * mispricing-detector.ts — v0.0.0.4
 *
 * Same pipeline as v0.0.0.3 (scan DreamDEX -> fetch price via Somnia Agent
 * -> compare against DreamDEX's implied probability), but the naive linear
 * probability estimate is now replaced by a genuine estimate from a SECOND
 * Somnia Agent: **LLM Inference** (`inferNumber`, Qwen3-30B under the hood).
 * This is the point where the project's "on-chain AI oracle" pitch actually
 * has an AI in it, not just a raw price feed.
 *
 * The LLM Inference integration below started from the exact TypeScript
 * snippet Somnia's own Agent Explorer generates for this agent id
 * (https://agents.testnet.somnia.network/agent/12847293847561029384,
 * "TypeScript" tab, inferNumber method) — same process as v0.0.0.2's JSON
 * API Request integration. Two corrections were applied proactively this
 * time, from lessons already paid for in v0.0.0.2 (see that version's
 * CHANGES.md): result is read via the Receipts Service, not by polling
 * `getRequest()` (which prunes shortly after finalization), and RPC calls
 * go through a multi-URL fallback transport, not a single hardcoded URL.
 *
 * COST WARNING: unlike the price fetch (once per unique asset), the LLM
 * estimate is called ONCE PER LIVE MARKET, because each market has its own
 * question/prices/time-remaining context. At ~0.24 STT per call, 6 live
 * markets costs ~1.4 STT just for this step, on top of the price-agent
 * calls. Fund the wallet generously (a few STT, not just one faucet drip)
 * before running this. Set MAX_MARKETS in .env to cap how many markets are
 * analyzed per run if you want to control cost while testing.
 *
 * Needs the same funded testnet wallet as v0.0.0.2/v0.0.0.3 (PRIVATE_KEY).
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

// --- DreamDEX config (same as v0.0.0.1 / v0.0.0.3) -----------------------
const INDEXER_URL =
  process.env.SOMNIA_INDEXER_URL ?? "https://dev.smk.somnia.host/v1/graphql";
const WS_RPC_URL =
  process.env.SOMNIA_WS_RPC_URL ?? "wss://api.infra.testnet.somnia.network/ws";
const VENUE_ID = process.env.SOMNIA_VENUE_ID;
const MIN_HEADROOM_FRACTION = 0.1;
const MIN_HEADROOM_FLOOR_SECONDS = 60;
const STATUS_TRADING = 1;

// --- Somnia Agents platform config (same as v0.0.0.2 / v0.0.0.3) --------
const RPC_URLS = (
  process.env.SOMNIA_AGENT_RPC_URLS ??
  "https://dream-rpc.somnia.network/,https://api.infra.testnet.somnia.network/"
)
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);
const PLATFORM_ADDRESS = (process.env.SOMNIA_AGENTS_CONTRACT ??
  "0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776") as Hex;
const RECEIPTS_SERVICE_URL =
  process.env.SOMNIA_RECEIPTS_SERVICE_URL ?? "https://receipts.testnet.agents.somnia.host";
const SUBCOMMITTEE_SIZE = 3n;
// JSON API Request typically resolves in under 2s (v0.0.0.2 CHANGES.md).
// LLM Inference is much slower — a real receipt showed ~33s of actual
// model time alone (generating ~1860 reasoning tokens), and this agent is
// shared across every hackathon participant testing against it, so
// contention can push real-world latency higher still. One shared
// timeout tuned for the fast agent was too short for the slow one.
const JSON_API_REQUEST_TIMEOUT_MS = 60 * 1000;
const LLM_INFERENCE_TIMEOUT_MS = 5 * 60 * 1000;

// --- JSON API Request agent (price fetch — same as v0.0.0.2/v0.0.0.3) ---
const JSON_API_REQUEST_AGENT_ID = 13174292974160097713n;
const JSON_API_REQUEST_EXECUTION_COST = 30_000_000_000_000_000n; // 0.03 STT — this agent's own cost
const COINGECKO_URL =
  process.env.COINGECKO_URL_PRICES ??
  "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd";
const PRICE_DECIMALS = 8;
const ASSET_SELECTORS: Record<string, string> = { BTC: "bitcoin.usd", ETH: "ethereum.usd" };

// --- LLM Inference agent (new in this version) --------------------------
// Verify this id still resolves at https://agents.testnet.somnia.network
// if requests start failing — agent ids are platform data, not permanent
// (same caveat as DreamDEX's venueId and the JSON API Request agent id).
const LLM_INFERENCE_AGENT_ID = 12847293847561029384n;
const LLM_INFERENCE_EXECUTION_COST = 70_000_000_000_000_000n; // 0.07 STT — this agent's own cost (higher than JSON API Request)
const PROBABILITY_SCALE = 10_000n; // inferNumber returns an integer; we ask for 0-10000 "basis points" = 0.00%-100.00%

const MAX_MARKETS = process.env.MAX_MARKETS ? Number(process.env.MAX_MARKETS) : undefined;
const MISPRICING_ALERT_THRESHOLD = 0.15;

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

const inferNumberAbi = [
  {
    type: "function",
    name: "inferNumber",
    inputs: [
      { type: "string", name: "prompt" },
      { type: "string", name: "system" },
      { type: "int256", name: "minValue" },
      { type: "int256", name: "maxValue" },
      { type: "bool", name: "chainOfThought" },
    ],
    outputs: [{ type: "int256", name: "response" }],
  },
] as const;

type AgentReceiptStep = {
  name: string;
  content?: string;
};

type MinimalReceipt = {
  status: "success" | "failed" | "timeout";
  errorMessage?: string;
  agentReceipt?: { result: Hex; steps?: AgentReceiptStep[] };
};
type MinimalReceiptsResponse = { count: number; receipts: MinimalReceipt[] };

/**
 * Submits a request to any agent on the platform and returns the raw
 * ABI-encoded response bytes once consensus succeeds. Generalized over
 * v0.0.0.2/v0.0.0.3's single-agent version because this file now talks to
 * two different agents with two different per-agent execution costs.
 */
async function submitAgentRequest(
  publicClient: ReturnType<typeof createPublicClient>,
  walletClient: ReturnType<typeof createWalletClient>,
  agentId: bigint,
  perAgentExecutionCost: bigint,
  payload: Hex,
  timeoutMs: number
): Promise<MinimalReceipt> {
  const reserve = await publicClient.readContract({
    address: PLATFORM_ADDRESS,
    abi: platformAbi,
    functionName: "getRequestDeposit",
  });
  const deposit = reserve + perAgentExecutionCost * SUBCOMMITTEE_SIZE;

  const hash = await walletClient.writeContract({
    address: PLATFORM_ADDRESS,
    abi: platformAbi,
    functionName: "createRequest",
    args: [agentId, "0x0000000000000000000000000000000000000000", "0x00000000", payload],
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

  // Receipts Service, not getRequest() — see v0.0.0.2/CHANGES.md for why:
  // on-chain request data is pruned almost immediately after finalization.
  const pollIntervalMs = 1000;
  const maxConsecutiveErrors = 5;
  const deadline = Date.now() + timeoutMs;
  const receiptsUrl = `${RECEIPTS_SERVICE_URL}/agent-receipts?contractAddress=${PLATFORM_ADDRESS}&requestId=${requestId}&type=minimal`;

  const successReceipt = await (async () => {
    let consecutiveErrors = 0;
    let lastProgressLog = Date.now();
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
      if (Date.now() > deadline) throw new Error(`Timed out polling the Receipts Service after ${timeoutMs / 1000}s`);
      if (Date.now() - lastProgressLog > 15_000) {
        console.log(`      ...still waiting (${Math.round((Date.now() - (deadline - timeoutMs)) / 1000)}s elapsed)`);
        lastProgressLog = Date.now();
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  })();

  if (!successReceipt.agentReceipt?.result) throw new Error("Receipt reported success but carried no agentReceipt.result");
  return successReceipt;
}

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
  const receipt = await submitAgentRequest(
    publicClient,
    walletClient,
    JSON_API_REQUEST_AGENT_ID,
    JSON_API_REQUEST_EXECUTION_COST,
    payload,
    JSON_API_REQUEST_TIMEOUT_MS
  );
  const result = decodeFunctionResult({ abi: fetchUintAbi, functionName: "fetchUint", data: receipt.agentReceipt!.result });
  if (typeof result !== "bigint") throw new Error(`Unexpected decoded result type from fetchUint: ${typeof result}`);
  return result;
}

async function fetchProbabilityViaLLM(
  publicClient: ReturnType<typeof createPublicClient>,
  walletClient: ReturnType<typeof createWalletClient>,
  prompt: string,
  system: string
): Promise<{ probability: bigint; thinking: string | null; reasoningTruncated: boolean }> {
  const payload = encodeFunctionData({
    abi: inferNumberAbi,
    functionName: "inferNumber",
    args: [prompt, system, 0n, PROBABILITY_SCALE, true],
  });
  const receipt = await submitAgentRequest(
    publicClient,
    walletClient,
    LLM_INFERENCE_AGENT_ID,
    LLM_INFERENCE_EXECUTION_COST,
    payload,
    LLM_INFERENCE_TIMEOUT_MS
  );
  const result = decodeFunctionResult({
    abi: inferNumberAbi,
    functionName: "inferNumber",
    data: receipt.agentReceipt!.result,
  });
  if (typeof result !== "bigint") throw new Error(`Unexpected decoded result type from inferNumber: ${typeof result}`);

  // Confirmed against a real receipt: reasoning lives in its own step
  // named "reasoning" (field `content`) — NOT a `thinking` field on the
  // "llm_response" step, despite how the docs' prose reads. `content` can
  // be truncated by the Receipts Service at 1024 chars in "minimal" mode;
  // fine for a console preview, not treated as the full permanent record.
  const reasoningStep = receipt.agentReceipt?.steps?.find((s) => s.name === "reasoning");
  const rawThinking = reasoningStep?.content ?? null;
  // The Receipts Service's "minimal" mode sometimes replaces a long field
  // with this exact marker string instead of a truncated preview — treat
  // it as "not available here", not as literal content to display.
  const thinking = rawThinking && !rawThinking.startsWith("<truncated") ? rawThinking : null;

  return { probability: result, thinking, reasoningTruncated: rawThinking !== null && thinking === null };
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

function buildPrompt(args: {
  asset: string;
  question: string;
  openingPrice: number;
  currentPrice: number;
  movePct: number;
  minutesLeft: number;
}): { prompt: string; system: string } {
  const system =
    "You are a quantitative analyst estimating short-term probability for a cryptocurrency binary prediction market. " +
    "Use these approximate calibration anchors for a BTC/ETH move over a short window (adjust for time remaining — " +
    "more time left means more room to reverse, so pull your estimate closer to 5000; very little time left means " +
    "less room to reverse, so lean closer to the anchor or beyond it):\n" +
    "  0.00% move -> ~5000\n" +
    "  +0.25% move -> ~6000-6500\n" +
    "  +0.50% move -> ~7000-7800\n" +
    "  +1.00% move -> ~8500-9500\n" +
    "  -0.25% move -> ~3500-4000\n" +
    "  -0.50% move -> ~2200-3000\n" +
    "  -1.00% move -> ~500-1500\n" +
    "These are reference points, not exact lookups — interpolate between them, and do not simply default to 5000 " +
    "whenever the move is nonzero. A negative move must always give an estimate below 5000. " +
    "Respond with ONLY the integer probability value requested — no words, no explanation, no percent sign, no punctuation.";

  const prompt = `Asset: ${args.asset}
Market question: "${args.question}"
Opening price (window start): $${args.openingPrice.toFixed(2)}
Current price: $${args.currentPrice.toFixed(2)}
Price change since opening: ${args.movePct >= 0 ? "+" : ""}${args.movePct.toFixed(2)}%
Time remaining until the window closes: ${args.minutesLeft.toFixed(1)} minutes

Estimate the probability that this market resolves YES (price closes at or above its opening price) as an integer from 0 to 10000, where 10000 = 100% certain YES and 0 = 100% certain NO. ${args.asset} is a volatile asset — a short window leaves real room for the price to move further or reverse before closing. Respond with ONLY the integer.`;

  return { prompt, system };
}

async function main() {
  console.log("\n🤖 Mispricing detector v2 — DreamDEX vs. LLM-estimated probability (testnet)\n");

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
  let markets = await scanLiveMarkets(exchange);
  if (markets.length === 0) {
    console.log("No live markets with enough time left were found — try again later.\n");
    await exchange.close();
    return;
  }
  if (MAX_MARKETS && markets.length > MAX_MARKETS) {
    console.log(`Found ${markets.length} live market(s); capping to the first ${MAX_MARKETS} (MAX_MARKETS in .env).`);
    markets = markets.slice(0, MAX_MARKETS);
  } else {
    console.log(`Found ${markets.length} live market(s).`);
  }
  console.log(
    `⚠️  This run will make ~${new Set(markets.map((m) => m.asset)).size} price-agent call(s) and ${markets.length} LLM-agent call(s) — budget accordingly.\n`
  );

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
    console.log(`Requesting ${asset} price via Somnia Agent (JSON API Request)...`);
    try {
      const raw = await fetchPriceViaAgent(publicClient, walletClient, selector);
      agentPrices[asset] = Number(raw) / 10 ** PRICE_DECIMALS;
      console.log(`   ✅ ${asset} agent price = $${agentPrices[asset]!.toLocaleString()}\n`);
    } catch (err) {
      console.log(`   ❌ Failed to fetch ${asset} price: ${err instanceof Error ? err.message : err}\n`);
      agentPrices[asset] = null;
    }
  }

  const rows: Record<string, string>[] = [];
  for (const m of markets) {
    const openingRaw = openingPrices[m.marketId.toLowerCase()] ?? null;
    const openingPrice = openingRaw !== null ? Number(openingRaw) / 100 : null; // scale confirmed live in v0.0.0.3
    const currentPrice = agentPrices[m.asset];

    if (openingPrice === null || currentPrice === null || currentPrice === undefined) {
      rows.push({
        Symbol: m.symbol,
        Opening: openingPrice !== null ? `$${openingPrice.toFixed(2)}` : "n/a",
        Current: currentPrice ? `$${currentPrice.toFixed(2)}` : "n/a",
        "LLM est.": "skipped (missing price data)",
        "DreamDEX Up": m.upPrice !== null ? m.upPrice.toFixed(4) : "no liquidity",
        Divergence: "n/a",
        Signal: "",
      });
      continue;
    }

    const movePct = ((currentPrice - openingPrice) / openingPrice) * 100;
    const { prompt, system } = buildPrompt({
      asset: m.asset,
      question: m.question,
      openingPrice,
      currentPrice,
      movePct,
      minutesLeft: m.secondsLeft / 60,
    });

    console.log(`Requesting LLM probability estimate for ${m.symbol}...`);
    try {
      const { probability: raw, thinking, reasoningTruncated } = await fetchProbabilityViaLLM(
        publicClient,
        walletClient,
        prompt,
        system
      );
      const llmProb = Number(raw) / Number(PROBABILITY_SCALE);
      const divergence = m.upPrice !== null ? llmProb - m.upPrice : null;
      console.log(`   ✅ LLM estimate = ${llmProb.toFixed(4)}`);
      if (thinking) console.log(`      reasoning: ${thinking}`);
      else if (reasoningTruncated) console.log("      reasoning: (too long for preview — full text available via the Receipts Service's non-minimal endpoint)");
      console.log("");

      rows.push({
        Symbol: m.symbol,
        Opening: `$${openingPrice.toFixed(2)}`,
        Current: `$${currentPrice.toFixed(2)}`,
        "Move %": `${movePct >= 0 ? "+" : ""}${movePct.toFixed(2)}%`,
        "DreamDEX Up": m.upPrice !== null ? m.upPrice.toFixed(4) : "no liquidity",
        "LLM est.": llmProb.toFixed(4),
        Divergence: divergence !== null ? (divergence >= 0 ? "+" : "") + divergence.toFixed(4) : "n/a",
        Signal: divergence !== null && Math.abs(divergence) >= MISPRICING_ALERT_THRESHOLD ? "🔥 possible mispricing" : "",
      });
    } catch (err) {
      console.log(`   ❌ LLM estimate failed for ${m.symbol}: ${err instanceof Error ? err.message : err}\n`);
      rows.push({
        Symbol: m.symbol,
        Opening: `$${openingPrice.toFixed(2)}`,
        Current: `$${currentPrice.toFixed(2)}`,
        "Move %": `${movePct >= 0 ? "+" : ""}${movePct.toFixed(2)}%`,
        "DreamDEX Up": m.upPrice !== null ? m.upPrice.toFixed(4) : "no liquidity",
        "LLM est.": "failed",
        Divergence: "n/a",
        Signal: "",
      });
    }
  }

  await exchange.close();

  console.log("\n📊 Mispricing signal — DreamDEX implied probability vs. LLM-estimated probability:\n");
  console.table(rows);

  const flagged = rows.filter((r) => r.Signal !== "");
  console.log(
    flagged.length > 0
      ? `\n🔥 ${flagged.length} market(s) show divergence ≥ ${MISPRICING_ALERT_THRESHOLD} between DreamDEX and the LLM estimate.\n`
      : `\nNo market currently exceeds the ${MISPRICING_ALERT_THRESHOLD} divergence threshold.\n`
  );
}

main().catch((err) => {
  console.error("❌ mispricing-detector (v2) failed:\n", err);
  process.exit(1);
});
