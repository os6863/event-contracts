/** v0.0.0.10: receipt-checked estimates, timestamped snapshots, EdgeScope renderer. */
import { naiveProbability, computeAgreement, validateLlmResult, remainingMinutes } from "./analysis.js";
import type { ReportRow } from "./types.js";
import { appendSignalHistory, readHistory } from "./history.js";
import { writeReport } from "./report-ui.js";
import "dotenv/config";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
): Promise<{ receipt: MinimalReceipt; requestId: bigint }> {
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
  await mkdir(join(dirname(fileURLToPath(import.meta.url)), "output", "receipts"), { recursive: true });
  await writeFile(join(dirname(fileURLToPath(import.meta.url)), "output", "receipts", `${requestId}.json`),
    JSON.stringify({ requestId: String(requestId), transactionHash: hash, receipt: successReceipt }, null, 2), "utf-8");
  return { receipt: successReceipt, requestId };
}

/**
 * The Receipts Service's default (non-"minimal") mode returns a manifest of
 * public GCS URLs instead of inline data — fetching one gives the full,
 * untruncated receipt JSON. Used only when the "minimal" preview truncated
 * a field we actually want in full (the LLM's reasoning text, for the demo
 * report). Two extra HTTP round-trips, no additional on-chain cost.
 */
async function fetchFullReceipt(requestId: bigint, expectedResult: Hex): Promise<MinimalReceipt | null> {
  try {
    const res = await fetch(`${RECEIPTS_SERVICE_URL}/agent-receipts?contractAddress=${PLATFORM_ADDRESS}&requestId=${requestId}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const manifest = await res.json() as { receipts?: string[] };
    for (const url of manifest.receipts ?? []) {
      const fullRes = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!fullRes.ok) continue;
      const full = await fullRes.json() as MinimalReceipt;
      // Do not combine a failed/different validator result with the selected successful result.
      if (full.status === "success" && full.agentReceipt?.result === expectedResult) {
        await writeFile(join(dirname(fileURLToPath(import.meta.url)), "output", "receipts", `${requestId}-full.json`), JSON.stringify(full, null, 2), "utf-8");
        return full;
      }
    }
  } catch { /* Optional evidence enhancement; caller fails closed if final answer is absent. */ }
  return null;
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
  const { receipt } = await submitAgentRequest(
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

class InvalidEstimate extends Error {
  constructor(message: string, public requestId: string, public receiptUrl: string, public thinking: string | null) { super(message); }
}
async function fetchProbabilityViaLLM(
  publicClient: ReturnType<typeof createPublicClient>,
  walletClient: ReturnType<typeof createWalletClient>,
  prompt: string,
  system: string,
  withReasoning = true
): Promise<{ probability: number; thinking: string | null; reasoningTruncated: boolean; requestId: string; receiptUrl: string }> {
  const payload = encodeFunctionData({ abi: inferNumberAbi, functionName: "inferNumber",
    args: [prompt, system, 0n, PROBABILITY_SCALE, withReasoning] });
  const { receipt, requestId } = await submitAgentRequest(publicClient, walletClient,
    LLM_INFERENCE_AGENT_ID, LLM_INFERENCE_EXECUTION_COST, payload, LLM_INFERENCE_TIMEOUT_MS);
  const raw = decodeFunctionResult({ abi: inferNumberAbi, functionName: "inferNumber", data: receipt.agentReceipt!.result });
  let steps = receipt.agentReceipt?.steps ?? [];
  const content = (name: string) => steps.find(s => s.name === name)?.content;
  if (!content("llm_response") || content("llm_response")?.startsWith("<truncated") || content("reasoning")?.startsWith("<truncated")) {
    const full = await fetchFullReceipt(requestId, receipt.agentReceipt!.result);
    if (full?.agentReceipt?.steps) steps = full.agentReceipt.steps;
  }
  const reasoning = content("reasoning") ?? null;
  const reasoningTruncated = reasoning?.startsWith("<truncated") ?? false;
  const thinking = reasoningTruncated ? null : reasoning;
  const receiptUrl = `${RECEIPTS_SERVICE_URL}/agent-receipts?contractAddress=${PLATFORM_ADDRESS}&requestId=${requestId}`;
  try {
    if (typeof raw !== "bigint") throw new Error("Unexpected inferNumber result type");
    const probability = validateLlmResult(raw, content("llm_response"));
    return { probability, thinking, reasoningTruncated, requestId: String(requestId), receiptUrl };
  } catch (error) {
    throw new InvalidEstimate(error instanceof Error ? error.message : "Invalid response", String(requestId), receiptUrl, thinking);
  }
}

type ScannedMarket = {
  symbol: string;
  question: string;
  asset: string;
  marketId: string;
  oracleQuestionId: string | null;
  upPrice: number | null;
  secondsLeft: number;
  expiry: number;
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
      // Null on a market discovered from the realtime tail — the indexer
      // fills it in on the next snapshot (docs: Market Structure & Lifecycle).
      oracleQuestionId: m.info.oracleQuestionId ?? null,
      upPrice,
      secondsLeft: Math.round(secondsLeft),
      expiry: Number(m.info.expiry),
    });
  }

  return results;
}

async function scanLiveMarketsWithRetry(
  exchange: InstanceType<typeof SomniaMarkets>,
  attempts = 3
): Promise<ScannedMarket[]> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await scanLiveMarkets(exchange);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      const delayMs = attempt * 2_000;
      console.log(`DreamDEX indexer read failed (attempt ${attempt}/${attempts}); retrying in ${delayMs / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
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
    "Respond with ONLY the integer probability value requested as your final answer — no words, no explanation, " +
    "no percent sign, no punctuation.";

  const prompt = `Asset: ${args.asset}
Market question: "${args.question}"
Opening price (window start): $${args.openingPrice.toFixed(2)}
Current price: $${args.currentPrice.toFixed(2)}
Price change since opening: ${args.movePct >= 0 ? "+" : ""}${args.movePct.toFixed(2)}%
Time remaining until the window closes: ${args.minutesLeft.toFixed(1)} minutes

Estimate the probability that this market resolves YES (price closes at or above its opening price) as an integer from 0 to 10000, where 10000 = 100% certain YES and 0 = 100% certain NO. ${args.asset} is a volatile asset — a short window leaves real room for the price to move further or reverse before closing. Respond with ONLY the integer.`;

  return { prompt, system };
}


const versionDir = dirname(fileURLToPath(import.meta.url));
const root = join(versionDir, "..");

type PriceObservation = { price: number; observedMs: number };

async function main() {
  if (process.argv.includes("--render-only")) {
    const snapshot = JSON.parse(await readFile(join(root, "data", "latest-report.json"), "utf-8"));
    if (snapshot.version !== "0.0.0.10" || !Array.isArray(snapshot.rows) || typeof snapshot.generatedAt !== "string") throw new Error("Invalid v10 snapshot");
    await writeReport(snapshot.rows, await readHistory(root), snapshot.generatedAt);
    console.log("Rendered saved snapshot without agent calls or history append.");
    return;
  }
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error("PRIVATE_KEY is not set in .env");
  const account = privateKeyToAccount(privateKey as Hex);
  const exchange = new SomniaMarkets({ indexerUrl: INDEXER_URL, chain: somniaShannon,
    wsRpcUrl: WS_RPC_URL, addresses: SOMNIA_TESTNET_ADDRESSES });
  const transport = fallback(RPC_URLS.map(url => http(url)));
  const publicClient = createPublicClient({ chain: somniaShannon, transport });
  const walletClient = createWalletClient({ account, chain: somniaShannon, transport });
  const rows: ReportRow[] = [];
  // Check history before spending testnet funds. Invalid JSON must never erase previous runs.
  await readHistory(root);
  try {
    console.log("Scanning DreamDEX markets for EdgeScope v10...");
    let markets = await scanLiveMarketsWithRetry(exchange);
    if (MAX_MARKETS) markets = markets.slice(0, MAX_MARKETS);
    console.log(`${markets.length} market(s). Price observations refresh after 60s; invalid LLM answers get at most one retry.`);
    const openingPrices = markets.length ? await exchange.client.getOpeningPrices(markets.map(m => m.marketId)) : {};
    const prices = new Map<string, PriceObservation>();
    for (const m of markets) {
      const row: ReportRow = { symbol: m.symbol, marketId: m.marketId, question: m.question, asset: m.asset,
        oracleQuestionId: m.oracleQuestionId,
        openingPrice: null, currentPrice: null, movePct: null, dreamdexUp: null, naiveEst: null,
        llmEst: null, ensembleEst: null, llmStatus: "skipped", divergence: null, flagged: false,
        agreement: "none", thinking: null, reasoningTruncated: false, expiresAt: new Date(m.expiry * 1000).toISOString() };
      rows.push(row);
      try {
        if (remainingMinutes(m.expiry) <= 1) { row.issue = "Market expired or too close to expiry before estimation."; continue; }
        const openingRaw = openingPrices[m.marketId.toLowerCase()] ?? null;
        row.openingPrice = openingRaw !== null ? Number(openingRaw) / 100 : null;
        if (row.openingPrice === null || !Number.isFinite(row.openingPrice) || row.openingPrice <= 0) {
          row.openingPrice = null; row.issue = "Opening price unavailable."; continue;
        }
        const selector = ASSET_SELECTORS[m.asset];
        if (!selector) { row.issue = "No price source for this asset."; continue; }
        let observation = prices.get(m.asset);
        if (!observation || Date.now() - observation.observedMs > 60000) {
          console.log(`Requesting ${m.asset} price via Somnia Agent...`);
          const raw = await fetchPriceViaAgent(publicClient, walletClient, selector);
          const price = Number(raw) / 10 ** PRICE_DECIMALS;
          if (!Number.isFinite(price) || price <= 0) throw new Error("Invalid price-agent value");
          observation = { price, observedMs: Date.now() };
          prices.set(m.asset, observation);
        }
        row.currentPrice = observation.price;
        row.priceObservedAt = new Date(observation.observedMs).toISOString();
        // Refresh the venue quote and trading status immediately before preparing the estimate.
        const onchain = await exchange.client.getMarketOnchain(m.marketId as Hex);
        if (onchain.status !== STATUS_TRADING) { row.issue = "Market is no longer trading."; continue; }
        try {
          const book = await exchange.fetchOrderBook(m.symbol, 1);
          const bid = book.bids[0]?.[0]; const ask = book.asks[0]?.[0];
          const p = bid !== undefined && ask !== undefined ? (bid + ask) / 2 : ask ?? bid;
          row.dreamdexUp = p !== undefined && Number.isFinite(p) && p >= 0 && p <= 1 ? p : null;
        } catch { row.dreamdexUp = null; }
        const observedMs = Date.now();
        if (observedMs - observation.observedMs > 60000) { row.issue = "Price observation became stale while reading the market."; continue; }
        row.observedAt = new Date(observedMs).toISOString();
        row.minutesLeft = remainingMinutes(m.expiry, observedMs);
        if (row.minutesLeft <= 1) { row.issue = "Too close to expiry after fetching inputs."; continue; }
        row.movePct = ((row.currentPrice - row.openingPrice) / row.openingPrice) * 100;
        row.naiveEst = naiveProbability(row.movePct, row.minutesLeft, m.asset);
        const { prompt, system } = buildPrompt({ asset: m.asset, question: m.question,
          openingPrice: row.openingPrice, currentPrice: row.currentPrice, movePct: row.movePct, minutesLeft: row.minutesLeft });
        console.log(`Requesting LLM estimate for ${m.symbol} (${row.minutesLeft.toFixed(1)} minutes left)...`);
        let estimate;
        try { estimate = await fetchProbabilityViaLLM(publicClient, walletClient, prompt, system); }
        catch (error) {
          if (!(error instanceof InvalidEstimate)) throw error;
          row.requestId = error.requestId; row.receiptUrl = error.receiptUrl; row.thinking = error.thinking;
          if (remainingMinutes(m.expiry) <= 1) throw error;
          console.log(`Rejected malformed response for request ${error.requestId}; retrying once without extended reasoning.`);
          row.retried = true;
          // Same timestamped prediction inputs: retry fixes response format, never changes the estimate by guessing.
          estimate = await fetchProbabilityViaLLM(publicClient, walletClient, prompt, system, false);
        }
        row.llmEst = estimate.probability;
        row.requestId = estimate.requestId; row.receiptUrl = estimate.receiptUrl;
        row.thinking = estimate.thinking; row.reasoningTruncated = estimate.reasoningTruncated;
        row.ensembleEst = (row.naiveEst + row.llmEst) / 2;
        row.divergence = row.dreamdexUp !== null ? row.ensembleEst - row.dreamdexUp : null;
        if (remainingMinutes(m.expiry) <= 0) {
          row.llmStatus = "expired"; row.issue = "Market expired during inference; excluded from signals and history.";
        } else {
          row.llmStatus = "ok";
          row.agreement = row.dreamdexUp !== null ? computeAgreement(row.naiveEst, row.llmEst, row.dreamdexUp) : "none";
          row.flagged = row.agreement !== "none";
        }
        console.log(`  ${row.llmStatus}: LLM=${row.llmEst.toFixed(4)}, ensemble=${row.ensembleEst.toFixed(4)}, ${row.agreement}`);
      } catch (error) {
        row.llmStatus = "failed";
        row.issue = error instanceof Error ? error.message : "Estimate unavailable";
        if (error instanceof InvalidEstimate) { row.requestId = error.requestId; row.receiptUrl = error.receiptUrl; row.thinking = error.thinking; }
        console.log(`  Unavailable: ${row.issue}`);
      }
    }
  } finally { await exchange.close(); }
  // Earlier rows can expire while later agent requests finish.
  const generatedAt = new Date().toISOString();
  for (const row of rows) {
    if (row.llmStatus === "ok" && row.expiresAt && Date.parse(row.expiresAt) <= Date.parse(generatedAt)) {
      row.llmStatus = "expired"; row.agreement = "none"; row.flagged = false;
      row.issue = "Market expired before report completion; excluded from signals and history.";
    }
  }
  await appendSignalHistory(root, rows);
  await mkdir(join(root, "data"), { recursive: true });
  await writeFile(join(root, "data", "latest-report.json"), JSON.stringify({ version: "0.0.0.10", generatedAt, rows }, null, 2), "utf-8");
  const path = await writeReport(rows, await readHistory(root), generatedAt);
  console.log(`EdgeScope report: ${path}`);
  if (rows.length && !rows.some(r => r.llmStatus === "ok")) {
    console.error("No usable estimates in this run; inspect the saved report and receipts.");
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(() => process.exit(process.exitCode ?? 0)).catch(error => { console.error(error instanceof Error ? error.message : "Report failed"); process.exit(1); });
}
