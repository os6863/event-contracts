/**
 * mispricing-report.ts — v0.0.0.9
 *
 * Same as v0.0.0.8 (marketId-tracked history, Brier-scored track
 * record), plus two fixes from an external code review ahead of
 * submission:
 *
 * 1. The naive baseline is no longer a fixed linear formula
 *    (0.5 + SENSITIVITY * movePct/100, unchanged since v0.0.0.3). That
 *    formula ignored time-to-expiry completely — the same % move always
 *    produced the same estimate whether 15 minutes or 24 hours
 *    remained. It's now volatility-scaled with sqrt(time-remaining)
 *    (standard random-walk / Black-Scholes-style time scaling) via a
 *    normal CDF — see `naiveProbability()` below for the exact formula
 *    and README.md's "Formulas" section for the reasoning.
 * 2. The LLM's chain-of-thought reasoning is now prompted into three
 *    short labeled sections instead of open-ended stream-of-consciousness
 *    — still the model's real, unedited reasoning (chainOfThought is
 *    still on), just asked to think in a cleaner shape.
 *
 * Needs the same funded testnet wallet as v0.0.0.2-v0.0.0.5 (PRIVATE_KEY).
 * No new agent calls vs. v0.0.0.5 — both fixes are local computation /
 * prompt wording, not new on-chain calls.
 *
 * Run:
 *   npm install
 *   npm run mispricing-report-v4
 */

import "dotenv/config";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  return { receipt: successReceipt, requestId };
}

/**
 * The Receipts Service's default (non-"minimal") mode returns a manifest of
 * public GCS URLs instead of inline data — fetching one gives the full,
 * untruncated receipt JSON. Used only when the "minimal" preview truncated
 * a field we actually want in full (the LLM's reasoning text, for the demo
 * report). Two extra HTTP round-trips, no additional on-chain cost.
 */
async function fetchFullReasoning(requestId: bigint): Promise<string | null> {
  try {
    const manifestUrl = `${RECEIPTS_SERVICE_URL}/agent-receipts?contractAddress=${PLATFORM_ADDRESS}&requestId=${requestId}`;
    const manifestRes = await fetch(manifestUrl);
    if (!manifestRes.ok) return null;
    const manifest = (await manifestRes.json()) as { receipts?: string[] };
    const firstReceiptUrl = manifest.receipts?.[0];
    if (!firstReceiptUrl) return null;

    const fullRes = await fetch(firstReceiptUrl);
    if (!fullRes.ok) return null;
    const full = (await fullRes.json()) as { agentReceipt?: { steps?: AgentReceiptStep[] } };
    const reasoningStep = full.agentReceipt?.steps?.find((s) => s.name === "reasoning");
    return reasoningStep?.content ?? null;
  } catch {
    // Best-effort enhancement — if this fails, the caller falls back to
    // whatever the "minimal" preview already had (or the truncation note).
    return null;
  }
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
  const { receipt, requestId } = await submitAgentRequest(
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
  let thinking = rawThinking && !rawThinking.startsWith("<truncated") ? rawThinking : null;
  let reasoningTruncated = rawThinking !== null && thinking === null;

  if (reasoningTruncated) {
    const full = await fetchFullReasoning(requestId);
    if (full) {
      thinking = full;
      reasoningTruncated = false;
    }
    // If the follow-up fetch also fails, reasoningTruncated stays true and
    // the caller falls back to its existing "too long for preview" message.
  }

  return { probability: result, thinking, reasoningTruncated };
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
    "When you think through this, write your reasoning as exactly three short labeled sections, one or two plain " +
    "sentences each, no stream-of-consciousness and no self-correction ('wait, actually...'): " +
    "'Move assessment:' (what the price move and direction imply), 'Time-weight rationale:' (how the remaining " +
    "time adjusts that), 'Conclusion:' (the resulting estimate and why). " +
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

type SignalAgreement = "strong" | "weak" | "none";

type ReportRow = {
  symbol: string;
  marketId: string;
  question: string;
  asset: string;
  openingPrice: number | null;
  currentPrice: number | null;
  movePct: number | null;
  dreamdexUp: number | null;
  naiveEst: number | null;
  llmEst: number | null;
  ensembleEst: number | null;
  llmStatus: "ok" | "failed" | "skipped";
  divergence: number | null;
  flagged: boolean;
  agreement: SignalAgreement;
  thinking: string | null;
  reasoningTruncated: boolean;
};

// Naive baseline estimate — kept as an independent, non-AI reference the
// ensemble cross-checks the LLM against (see v0.0.0.7/CHANGES.md for why
// that matters: it's what downgrades a miscalibrated LLM call from a
// false "strong" signal to "weak").
//
// v0.0.0.3 through v0.0.0.8 used a fixed linear formula
// (0.5 + SENSITIVITY * movePct/100) that ignored time-to-expiry entirely
// — the same % move always produced the same estimate whether 15 minutes
// or 24 hours remained. That's wrong: under a standard random-walk
// assumption, the STANDARD DEVIATION of a price move scales with sqrt(t),
// not linearly, so the same absolute move is far more significant with
// little time left (little room to reverse) than with a lot of time left
// (much more room to reverse). This is the same principle behind the
// "d2" term in Black-Scholes digital/cash-or-nothing option pricing —
// this project doesn't need the full option-pricing machinery, but the
// time-scaling underneath it is real and was missing.
//
// ASSET_ANNUAL_VOLATILITY values are ASSUMED, round, commonly-cited
// figures for BTC/ETH annualized volatility — not fitted from real
// historical price data (this project doesn't have a price-history
// pipeline; see README's "What this version is not" for the honest
// caveat). A production version would estimate realized or implied
// volatility from recent price history instead of a constant.
const ASSET_ANNUAL_VOLATILITY: Record<string, number> = { BTC: 0.55, ETH: 0.7 };
const DEFAULT_ANNUAL_VOLATILITY = 0.6;
const MINUTES_PER_YEAR = 60 * 24 * 365;
const NAIVE_PROB_FLOOR = 0.02;
const NAIVE_PROB_CEILING = 0.98;

// Standard normal CDF via the Abramowitz & Stegun 7.1.26 approximation
// (max error ~1.5e-7) — verified offline against known reference values
// (CDF(0)=0.5, CDF(1.96)≈0.975, CDF(-1)≈0.1587) before use here.
function normalCDF(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

function naiveProbability(movePct: number, minutesLeft: number, asset: string): number {
  const sigmaAnnual = ASSET_ANNUAL_VOLATILITY[asset] ?? DEFAULT_ANNUAL_VOLATILITY;
  const tYears = Math.max(minutesLeft, 1) / MINUTES_PER_YEAR; // floor at 1 minute — avoid dividing by ~0
  const sigmaOverWindow = sigmaAnnual * Math.sqrt(tYears);
  const z = movePct / 100 / sigmaOverWindow;
  const raw = normalCDF(z);
  return Math.min(NAIVE_PROB_CEILING, Math.max(NAIVE_PROB_FLOOR, raw));
}

function computeAgreement(
  naiveEst: number,
  llmEst: number,
  dreamdexUp: number
): SignalAgreement {
  const naiveDiv = naiveEst - dreamdexUp;
  const llmDiv = llmEst - dreamdexUp;
  const naiveFlagged = Math.abs(naiveDiv) >= MISPRICING_ALERT_THRESHOLD;
  const llmFlagged = Math.abs(llmDiv) >= MISPRICING_ALERT_THRESHOLD;
  const sameDirection = Math.sign(naiveDiv) === Math.sign(llmDiv);
  if (naiveFlagged && llmFlagged && sameDirection) return "strong";
  if (naiveFlagged || llmFlagged) return "weak";
  return "none";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function renderRow(r: ReportRow): string {
  const flaggedClass = r.agreement === "strong" ? " ticket--flagged" : r.agreement === "weak" ? " ticket--weak" : "";
  const moveClass = r.movePct !== null && r.movePct < 0 ? "stat-value--down" : "stat-value--up";

  const bars =
    r.llmStatus === "ok" && r.dreamdexUp !== null && r.naiveEst !== null && r.ensembleEst !== null
      ? `
      <div class="bars">
        <div class="bar-row">
          <span class="bar-label">DreamDEX</span>
          <div class="bar-track"><div class="bar-fill bar-fill--market" style="width:${pct(r.dreamdexUp)}"></div></div>
          <span class="bar-value">${r.dreamdexUp.toFixed(4)}</span>
        </div>
        <div class="bar-row">
          <span class="bar-label">Naive</span>
          <div class="bar-track"><div class="bar-fill bar-fill--naive" style="width:${pct(r.naiveEst)}"></div></div>
          <span class="bar-value">${r.naiveEst.toFixed(4)}</span>
        </div>
        <div class="bar-row">
          <span class="bar-label">LLM est.</span>
          <div class="bar-track"><div class="bar-fill bar-fill--ai" style="width:${pct(r.llmEst!)}"></div></div>
          <span class="bar-value">${r.llmEst!.toFixed(4)}</span>
        </div>
        <div class="bar-row bar-row--ensemble">
          <span class="bar-label">Ensemble</span>
          <div class="bar-track"><div class="bar-fill bar-fill--ensemble" style="width:${pct(r.ensembleEst)}"></div></div>
          <span class="bar-value">${r.ensembleEst.toFixed(4)}</span>
        </div>
      </div>`
      : `<p class="ticket-note">${
          r.llmStatus === "failed" ? "LLM estimate failed for this market (naive baseline still shown above)." : "Skipped — missing price data."
        }</p>`;

  const divergenceBlock =
    r.divergence !== null
      ? `<div class="divergence ${r.agreement !== "none" ? "divergence--flagged" : ""}">
          <span class="divergence-label">ensemble divergence</span>
          <span class="divergence-value">${r.divergence >= 0 ? "+" : ""}${r.divergence.toFixed(4)}</span>
        </div>`
      : "";

  const reasoning =
    r.thinking !== null
      ? `<details class="reasoning-details">
          <summary>AI reasoning</summary>
          <p class="reasoning">${escapeHtml(r.thinking)}</p>
        </details>`
      : r.reasoningTruncated
        ? `<p class="reasoning reasoning--muted">Reasoning was generated but could not be retrieved for this report.</p>`
        : "";

  return `
    <article class="ticket${flaggedClass}">
      <header class="ticket-header">
        <div>
          <span class="ticket-asset">${escapeHtml(r.asset)}</span>
          <h2 class="ticket-symbol">${escapeHtml(r.symbol)}</h2>
        </div>
        ${r.agreement === "strong" ? '<span class="flag-badge flag-badge--strong">strong mispricing signal</span>' : r.agreement === "weak" ? '<span class="flag-badge flag-badge--weak">weak signal</span>' : ""}
      </header>
      <p class="ticket-question">${escapeHtml(r.question)}</p>
      <div class="stat-row">
        <div class="stat"><span class="stat-label">opening</span><span class="stat-value">${r.openingPrice !== null ? `$${r.openingPrice.toFixed(2)}` : "n/a"}</span></div>
        <div class="stat"><span class="stat-label">current</span><span class="stat-value">${r.currentPrice !== null ? `$${r.currentPrice.toFixed(2)}` : "n/a"}</span></div>
        <div class="stat"><span class="stat-label">move</span><span class="stat-value ${moveClass}">${r.movePct !== null ? `${r.movePct >= 0 ? "+" : ""}${r.movePct.toFixed(2)}%` : "n/a"}</span></div>
      </div>
      ${bars}
      ${divergenceBlock}
      ${reasoning}
    </article>`;
}

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
  // Filled in later by check-outcomes.ts, once the market has actually
  // closed — absent (undefined) means "not checked yet".
  resolved?: boolean | "voided";
  actualOutcome?: "YES" | "NO";
  dreamdexCorrect?: boolean;
  ensembleCorrect?: boolean;
  dreamdexBrier?: number;
  ensembleBrier?: number;
};

const HISTORY_MAX_ENTRIES = 500;

function repoRootPath(...segments: string[]): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", ...segments);
}

/**
 * Appends this run's successful rows to a repo-root JSON file so the
 * project has a real, growing record of signals over time — not proof
 * any given signal was later correct (that needs a market to actually
 * settle first), just evidence this pipeline has been running against
 * live data across multiple sessions, not staged for a single demo.
 * `resolved`/`actualOutcome`/accuracy fields are filled in later by
 * check-outcomes.ts, once each market has actually closed.
 */
async function appendSignalHistory(rows: ReportRow[]): Promise<string> {
  const historyPath = repoRootPath("data", "signal-history.json");
  const timestamp = new Date().toISOString();

  const newEntries: HistoryEntry[] = rows
    .filter(
      (r): r is ReportRow & { dreamdexUp: number; naiveEst: number; llmEst: number; ensembleEst: number; divergence: number } =>
        r.llmStatus === "ok" && r.dreamdexUp !== null && r.naiveEst !== null && r.llmEst !== null && r.ensembleEst !== null && r.divergence !== null
    )
    .map((r) => ({
      timestamp,
      symbol: r.symbol,
      marketId: r.marketId,
      asset: r.asset,
      dreamdexUp: r.dreamdexUp,
      naiveEst: r.naiveEst,
      llmEst: r.llmEst,
      ensembleEst: r.ensembleEst,
      divergence: r.divergence,
      agreement: r.agreement,
    }));

  let existing: HistoryEntry[] = [];
  try {
    const raw = await readFile(historyPath, "utf-8");
    existing = JSON.parse(raw) as HistoryEntry[];
  } catch {
    // No history file yet, or it's unreadable — start fresh rather than fail the run.
    existing = [];
  }

  const combined = [...existing, ...newEntries].slice(-HISTORY_MAX_ENTRIES);

  await mkdir(dirname(historyPath), { recursive: true });
  await writeFile(historyPath, JSON.stringify(combined, null, 2), "utf-8");
  return historyPath;
}

async function writeHtmlReport(rows: ReportRow[]): Promise<string> {
  const strongCount = rows.filter((r) => r.agreement === "strong").length;
  const weakCount = rows.filter((r) => r.agreement === "weak").length;
  const generatedAt = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";

  let allHistory: HistoryEntry[] = [];
  try {
    const raw = await readFile(repoRootPath("data", "signal-history.json"), "utf-8");
    allHistory = JSON.parse(raw) as HistoryEntry[];
  } catch {
    allHistory = [];
  }
  const historyRows = allHistory.slice(-15).reverse();

  // Track record: only entries check-outcomes.ts has actually resolved
  // (resolved === true, i.e. not "voided" and not still pending) count.
  const resolvedEntries = allHistory.filter((h) => h.resolved === true);
  const trackRecordSection =
    resolvedEntries.length > 0
      ? (() => {
          const dreamdexCorrectCount = resolvedEntries.filter((h) => h.dreamdexCorrect).length;
          const ensembleCorrectCount = resolvedEntries.filter((h) => h.ensembleCorrect).length;
          const avgBrier = (key: "dreamdexBrier" | "ensembleBrier") => {
            const vals = resolvedEntries.map((h) => h[key]).filter((v): v is number => v !== undefined);
            return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
          };
          const dreamdexBrier = avgBrier("dreamdexBrier");
          const ensembleBrier = avgBrier("ensembleBrier");
          return `
    <div class="track-record">
      <h2>Track record (real settlements only)</h2>
      <p class="history-note">Computed only from markets that have actually closed and settled on-chain — checked via <code>check-outcomes.ts</code> against each market's real <code>winningOutcome</code>, not a simulation. ${resolvedEntries.length} settled market(s) so far. Lower Brier score is better (0 = perfect, 1 = worst); it rewards calibrated probabilities, not just picking the right side.</p>
      <div class="track-grid">
        <div class="track-col">
          <h3>DreamDEX (market price)</h3>
          <div class="track-stat"><span class="n">${((dreamdexCorrectCount / resolvedEntries.length) * 100).toFixed(0)}%</span><span class="label">correct side</span></div>
          <div class="track-stat"><span class="n">${dreamdexBrier !== null ? dreamdexBrier.toFixed(4) : "n/a"}</span><span class="label">avg. Brier score</span></div>
        </div>
        <div class="track-col track-col--ours">
          <h3>Our ensemble</h3>
          <div class="track-stat"><span class="n">${((ensembleCorrectCount / resolvedEntries.length) * 100).toFixed(0)}%</span><span class="label">correct side</span></div>
          <div class="track-stat"><span class="n">${ensembleBrier !== null ? ensembleBrier.toFixed(4) : "n/a"}</span><span class="label">avg. Brier score</span></div>
        </div>
      </div>
    </div>`;
        })()
      : `
    <div class="track-record">
      <h2>Track record (real settlements only)</h2>
      <p class="history-note">No markets from the signal history have settled yet — run <code>npm run check-outcomes</code> after some logged markets have actually closed to populate this section. Not shown as 0%/perfect; genuinely absent until real data exists.</p>
    </div>`;

  const historySection =
    historyRows.length > 0
      ? `
    <div class="history">
      <h2>Recent signal history</h2>
      <p class="history-note">Every run this pipeline has made appends here — not proof any signal was later correct on its own (see Track Record above for that), just evidence this has been running against live data across sessions, not staged for one demo.</p>
      <table class="history-table">
        <thead><tr><th>Time (UTC)</th><th>Symbol</th><th>DreamDEX</th><th>Ensemble</th><th>Agreement</th><th>Settled?</th></tr></thead>
        <tbody>
          ${historyRows
            .map((h) => {
              const settled =
                h.resolved === true
                  ? `${h.actualOutcome} · ${h.ensembleCorrect ? "✅" : "❌"}`
                  : h.resolved === "voided"
                    ? "voided"
                    : "pending";
              return `<tr class="${h.agreement !== "none" ? "history-row--flagged" : ""}">
            <td>${escapeHtml(h.timestamp.slice(0, 19).replace("T", " "))}</td>
            <td>${escapeHtml(h.symbol)}</td>
            <td>${h.dreamdexUp.toFixed(4)}</td>
            <td>${h.ensembleEst.toFixed(4)}</td>
            <td>${h.agreement}</td>
            <td>${settled}</td>
          </tr>`;
            })
            .join("\n")}
        </tbody>
      </table>
    </div>`
      : "";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mispricing &amp; Edge Detector — Report</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #0f1420;
    --panel: #171e2e;
    --panel-flagged: #1f1a14;
    --panel-weak: #171d29;
    --border: #2a3346;
    --border-flagged: #4a3a1c;
    --border-weak: #33405a;
    --text: #e8e5dc;
    --muted: #8993a8;
    --amber: #e0a93a;
    --teal: #4fa394;
    --blue: #6e8fd1;
    --violet: #9b8cd1;
    --down: #d16e6e;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: 'IBM Plex Mono', monospace;
    padding: 48px 24px 80px;
  }
  .wrap { max-width: 760px; margin: 0 auto; }
  .masthead { margin-bottom: 40px; }
  .masthead h1 {
    font-family: 'Space Grotesk', sans-serif;
    font-weight: 700;
    font-size: 2rem;
    margin: 0 0 8px;
    letter-spacing: -0.01em;
  }
  .masthead p { color: var(--muted); margin: 0; font-size: 0.9rem; }
  .summary {
    display: flex;
    gap: 24px;
    margin-top: 24px;
    padding: 16px 0;
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
  }
  .summary-item .n { font-size: 1.4rem; font-weight: 600; }
  .summary-item .label { color: var(--muted); font-size: 0.78rem; display: block; }
  .summary-item .n.amber { color: var(--amber); }
  .summary-item .n.violet { color: var(--violet); }

  .tickets { display: flex; flex-direction: column; gap: 16px; }
  .ticket {
    background: var(--panel);
    border: 1px solid var(--border);
    border-left: 3px solid var(--border);
    border-radius: 4px;
    padding: 20px 24px;
  }
  .ticket--flagged {
    background: var(--panel-flagged);
    border-color: var(--border-flagged);
    border-left-color: var(--amber);
  }
  .ticket--weak {
    background: var(--panel-weak);
    border-color: var(--border-weak);
    border-left-color: var(--violet);
  }
  .ticket-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
  .ticket-asset { color: var(--muted); font-size: 0.75rem; letter-spacing: 0.04em; }
  .ticket-symbol {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 1.05rem;
    margin: 2px 0 0;
    font-weight: 500;
    word-break: break-word;
  }
  .flag-badge {
    border-radius: 3px;
    padding: 3px 8px;
    font-size: 0.72rem;
    white-space: nowrap;
    border: 1px solid transparent;
  }
  .flag-badge--strong {
    background: rgba(224, 169, 58, 0.15);
    color: var(--amber);
    border-color: rgba(224, 169, 58, 0.4);
  }
  .flag-badge--weak {
    background: rgba(155, 140, 209, 0.12);
    color: var(--violet);
    border-color: rgba(155, 140, 209, 0.35);
  }
  .ticket-question { color: var(--muted); font-size: 0.85rem; margin: 12px 0 16px; }

  .stat-row { display: flex; gap: 28px; margin-bottom: 16px; }
  .stat { display: flex; flex-direction: column; }
  .stat-label { color: var(--muted); font-size: 0.7rem; margin-bottom: 2px; }
  .stat-value { font-size: 0.95rem; font-weight: 500; }
  .stat-value--down { color: var(--down); }
  .stat-value--up { color: var(--teal); }

  .bars { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }
  .bar-row { display: flex; align-items: center; gap: 10px; }
  .bar-row--ensemble { padding-top: 4px; border-top: 1px dashed var(--border); }
  .bar-label { width: 70px; font-size: 0.72rem; color: var(--muted); flex-shrink: 0; }
  .bar-track { flex: 1; height: 8px; background: rgba(255,255,255,0.06); border-radius: 4px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 4px; }
  .bar-fill--market { background: var(--blue); }
  .bar-fill--naive { background: #6e9fd1; opacity: 0.6; }
  .bar-fill--ai { background: var(--teal); }
  .bar-fill--ensemble { background: var(--violet); }
  .bar-value { width: 56px; text-align: right; font-size: 0.78rem; color: var(--text); flex-shrink: 0; }

  .divergence { display: flex; gap: 8px; align-items: baseline; margin-bottom: 8px; }
  .divergence-label { color: var(--muted); font-size: 0.72rem; }
  .divergence-value { font-size: 1rem; font-weight: 600; color: var(--teal); }
  .divergence--flagged .divergence-value { color: var(--amber); }

  .reasoning {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 0.78rem;
    line-height: 1.5;
    color: var(--muted);
    border-left: 2px solid var(--border);
    padding-left: 12px;
    margin: 12px 0 0;
  }
  .reasoning--muted { font-style: italic; }
  .reasoning-details { margin-top: 12px; }
  .reasoning-details summary {
    cursor: pointer;
    color: var(--muted);
    font-size: 0.75rem;
    letter-spacing: 0.02em;
    list-style: none;
  }
  .reasoning-details summary::-webkit-details-marker { display: none; }
  .reasoning-details summary::before { content: "▸ "; }
  .reasoning-details[open] summary::before { content: "▾ "; }
  .reasoning-details .reasoning { margin-top: 8px; max-height: 260px; overflow-y: auto; white-space: pre-wrap; }
  .ticket-note { color: var(--muted); font-size: 0.85rem; font-style: italic; margin: 0; }

  .track-record { margin-top: 48px; }
  .track-record h2 {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 1.15rem;
    font-weight: 500;
    margin: 0 0 8px;
  }
  .track-record code {
    background: rgba(255,255,255,0.06);
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 0.9em;
  }
  .track-grid { display: flex; gap: 16px; margin-top: 16px; }
  .track-col {
    flex: 1;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 16px 20px;
  }
  .track-col--ours { border-color: var(--violet); }
  .track-col h3 {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 0.85rem;
    font-weight: 500;
    color: var(--muted);
    margin: 0 0 12px;
  }
  .track-stat { margin-bottom: 8px; }
  .track-stat .n { font-size: 1.3rem; font-weight: 600; display: block; }
  .track-stat .label { color: var(--muted); font-size: 0.72rem; }

  .history { margin-top: 48px; }
  .history h2 {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 1.15rem;
    font-weight: 500;
    margin: 0 0 8px;
  }
  .history-note { color: var(--muted); font-size: 0.78rem; margin: 0 0 16px; line-height: 1.5; }
  .history-table { width: 100%; border-collapse: collapse; font-size: 0.78rem; }
  .history-table th {
    text-align: left;
    color: var(--muted);
    font-weight: 500;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
  }
  .history-table td { padding: 6px 10px; border-bottom: 1px solid var(--border); }
  .history-row--flagged td:last-child { color: var(--amber); }

  footer { margin-top: 48px; color: var(--muted); font-size: 0.75rem; text-align: center; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="masthead">
      <h1>Mispricing &amp; Edge Detector</h1>
      <p>DreamDEX Event Contracts vs. an ensemble of a naive baseline and a Somnia Agent (LLM Inference) — Somnia Shannon Testnet — generated ${generatedAt}</p>
      <div class="summary">
        <div class="summary-item"><span class="n">${rows.length}</span><span class="label">markets scanned</span></div>
        <div class="summary-item"><span class="n ${strongCount > 0 ? "amber" : ""}">${strongCount}</span><span class="label">strong signal (both estimates agree)</span></div>
        <div class="summary-item"><span class="n ${weakCount > 0 ? "violet" : ""}">${weakCount}</span><span class="label">weak signal (one estimate only)</span></div>
      </div>
    </div>
    <div class="tickets">
      ${rows.map(renderRow).join("\n")}
    </div>
    ${trackRecordSection}
    ${historySection}
    <footer>Testnet data — not financial advice. Somnia × DreamDEX Event Contracts Hackathon.</footer>
  </div>
</body>
</html>`;

  const outDir = join(dirname(fileURLToPath(import.meta.url)), "output");
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, "report.html");
  await writeFile(outPath, html, "utf-8");

  // Also publish to the repo-root docs/ folder, which GitHub Pages serves
  // directly (Settings -> Pages -> Deploy from branch -> main -> /docs).
  // Same content, just a second, git-tracked location for a live public link.
  const docsDir = repoRootPath("docs");
  await mkdir(docsDir, { recursive: true });
  await writeFile(join(docsDir, "index.html"), html, "utf-8");

  return outPath;
}

async function main() {
  console.log("\n📄 Mispricing report — DreamDEX vs. ensemble (naive + LLM) estimate (testnet)\n");

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

  const rows: ReportRow[] = [];
  for (const m of markets) {
    const openingRaw = openingPrices[m.marketId.toLowerCase()] ?? null;
    const openingPrice = openingRaw !== null ? Number(openingRaw) / 100 : null; // scale confirmed live in v0.0.0.3
    const currentPrice = agentPrices[m.asset] ?? null;

    if (openingPrice === null || currentPrice === null) {
      rows.push({
        symbol: m.symbol,
        marketId: m.marketId,
        question: m.question,
        asset: m.asset,
        openingPrice,
        currentPrice,
        movePct: null,
        dreamdexUp: m.upPrice,
        naiveEst: null,
        llmEst: null,
        ensembleEst: null,
        llmStatus: "skipped",
        divergence: null,
        flagged: false,
        agreement: "none",
        thinking: null,
        reasoningTruncated: false,
      });
      continue;
    }

    const movePct = ((currentPrice - openingPrice) / openingPrice) * 100;
    const minutesLeft = m.secondsLeft / 60;
    const { prompt, system } = buildPrompt({
      asset: m.asset,
      question: m.question,
      openingPrice,
      currentPrice,
      movePct,
      minutesLeft,
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
      const naiveEst = naiveProbability(movePct, minutesLeft, m.asset);
      const ensembleEst = (naiveEst + llmProb) / 2;
      const divergence = m.upPrice !== null ? ensembleEst - m.upPrice : null;
      const agreement = m.upPrice !== null ? computeAgreement(naiveEst, llmProb, m.upPrice) : "none";
      console.log(`   ✅ LLM estimate = ${llmProb.toFixed(4)} (naive baseline = ${naiveEst.toFixed(4)}, ensemble = ${ensembleEst.toFixed(4)})`);
      if (thinking) {
        const consolePreview = thinking.length > 240 ? `${thinking.slice(0, 240)}…` : thinking;
        console.log(`      reasoning: ${consolePreview}`);
      } else if (reasoningTruncated) {
        console.log("      reasoning: (unavailable — Receipts Service preview and full-text fetch both came back empty)");
      }
      console.log("");

      rows.push({
        symbol: m.symbol,
        marketId: m.marketId,
        question: m.question,
        asset: m.asset,
        openingPrice,
        currentPrice,
        movePct,
        dreamdexUp: m.upPrice,
        naiveEst,
        llmEst: llmProb,
        ensembleEst,
        llmStatus: "ok",
        divergence,
        flagged: agreement !== "none",
        agreement,
        thinking,
        reasoningTruncated,
      });
    } catch (err) {
      console.log(`   ❌ LLM estimate failed for ${m.symbol}: ${err instanceof Error ? err.message : err}\n`);
      const naiveEst = naiveProbability(movePct, minutesLeft, m.asset);
      const divergence = m.upPrice !== null ? naiveEst - m.upPrice : null;
      rows.push({
        symbol: m.symbol,
        marketId: m.marketId,
        question: m.question,
        asset: m.asset,
        openingPrice,
        currentPrice,
        movePct,
        dreamdexUp: m.upPrice,
        naiveEst,
        llmEst: null,
        ensembleEst: null,
        llmStatus: "failed",
        divergence,
        flagged: false,
        agreement: "none",
        thinking: null,
        reasoningTruncated: false,
      });
    }
  }

  await exchange.close();

  console.log("\n📊 Mispricing signal — DreamDEX implied probability vs. ensemble (naive + LLM) estimate:\n");
  console.table(
    rows.map((r) => ({
      Symbol: r.symbol,
      Opening: r.openingPrice !== null ? `$${r.openingPrice.toFixed(2)}` : "n/a",
      Current: r.currentPrice !== null ? `$${r.currentPrice.toFixed(2)}` : "n/a",
      "Move %": r.movePct !== null ? `${r.movePct >= 0 ? "+" : ""}${r.movePct.toFixed(2)}%` : "n/a",
      "DreamDEX Up": r.dreamdexUp !== null ? r.dreamdexUp.toFixed(4) : "no liquidity",
      "Naive": r.naiveEst !== null ? r.naiveEst.toFixed(4) : "n/a",
      "LLM": r.llmStatus === "ok" ? r.llmEst!.toFixed(4) : r.llmStatus,
      "Ensemble": r.ensembleEst !== null ? r.ensembleEst.toFixed(4) : "n/a",
      Agreement: r.agreement,
      Signal: r.flagged ? (r.agreement === "strong" ? "🔥 strong mispricing" : "⚠️ weak signal") : "",
    }))
  );

  const strong = rows.filter((r) => r.agreement === "strong");
  const weak = rows.filter((r) => r.agreement === "weak");
  console.log(
    `\n🔥 ${strong.length} market(s) show a STRONG signal (naive baseline and LLM both diverge from DreamDEX in the same direction).` +
      `\n⚠️  ${weak.length} market(s) show a WEAK signal (only one of the two independent estimates diverges).\n`
  );

  const historyPath = await appendSignalHistory(rows);
  console.log(`📈 Signal history updated: ${historyPath}`);

  const reportPath = await writeHtmlReport(rows);
  console.log(`📄 Report written to: ${reportPath}`);
  console.log(`   Open it in a browser (double-click the file, or "start ${reportPath}" on Windows).\n`);
}

main().catch((err) => {
  console.error("❌ mispricing-report failed:\n", err);
  process.exit(1);
});
