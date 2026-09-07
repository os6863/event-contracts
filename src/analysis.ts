import type { SignalAgreement, HistoryEntry, PriceSourceQuality } from "./types.js";
export const MISPRICING_ALERT_THRESHOLD = 0.15;
// Above this spread, a two-sided quote is treated as too thin to trust as
// a probability, not just an academic quibble: an empty book can print a
// midpoint (e.g. bid .20 / ask .80 -> "50%") that reflects a lack of
// quotes, not a market view. 0.08 is a starting point, not a fitted value.
export const MAX_SPREAD_FOR_SIGNAL = 0.08;
const ASSET_ANNUAL_VOLATILITY: Record<string, number> = { BTC: 0.55, ETH: 0.7 };
const DEFAULT_ANNUAL_VOLATILITY = 0.6;
const MINUTES_PER_YEAR = 60 * 24 * 365;
const NAIVE_PROB_FLOOR = 0.02;
const NAIVE_PROB_CEILING = 0.98;

// Standard normal CDF via the Abramowitz & Stegun 7.1.26 approximation
// (max error ~1.5e-7) — verified offline against known reference values
// (CDF(0)=0.5, CDF(1.96)≈0.975, CDF(-1)≈0.1587) before use here.
export function normalCDF(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

/**
 * `realizedVolAnnual`, when a finite positive number, overrides the fixed
 * disclosed BTC/ETH assumption below with a measured value (see
 * `computeRealizedVolatility`). Omitting it — every existing call site
 * before this change — reproduces the original fixed-assumption behavior
 * exactly; this is additive, not a replacement of the disclosed baseline.
 */
export function naiveProbability(movePct: number, minutesLeft: number, asset: string, realizedVolAnnual?: number): number {
  const sigmaAnnual = realizedVolAnnual !== undefined && Number.isFinite(realizedVolAnnual) && realizedVolAnnual > 0
    ? realizedVolAnnual
    : ASSET_ANNUAL_VOLATILITY[asset] ?? DEFAULT_ANNUAL_VOLATILITY;
  const tYears = Math.max(minutesLeft, 1) / MINUTES_PER_YEAR; // floor at 1 minute — avoid dividing by ~0
  const sigmaOverWindow = sigmaAnnual * Math.sqrt(tYears);
  const z = movePct / 100 / sigmaOverWindow;
  const raw = normalCDF(z);
  return Math.min(NAIVE_PROB_CEILING, Math.max(NAIVE_PROB_FLOOR, raw));
}

/**
 * Annualized realized volatility from a series of prices (oldest first,
 * evenly spaced `periodMinutes` apart), via the sample standard deviation
 * of log returns scaled to a year. Returns `null` on fewer than 3 prices
 * (need at least 2 returns for a variance) or any non-positive price,
 * rather than throwing or returning a poisoned number — the caller is
 * expected to fall back to the disclosed static assumption on `null`.
 */
export function computeRealizedVolatility(closes: number[], periodMinutes: number): number | null {
  if (closes.length < 3 || !(periodMinutes > 0)) return null;
  const logReturns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    const cur = closes[i];
    if (!(prev > 0) || !(cur > 0)) return null;
    logReturns.push(Math.log(cur / prev));
  }
  const mean = logReturns.reduce((s, v) => s + v, 0) / logReturns.length;
  const variance = logReturns.reduce((s, v) => s + (v - mean) ** 2, 0) / (logReturns.length - 1);
  const periodsPerYear = MINUTES_PER_YEAR / periodMinutes;
  const annualized = Math.sqrt(variance * periodsPerYear);
  return Number.isFinite(annualized) ? annualized : null;
}

/**
 * "Both estimators clear the threshold" used to collapse two genuinely
 * different situations into one "strong" case, and "only one clears it"
 * used to cover both "the other is silent" and "the other actively
 * disagrees" under one "weak" label. Now: both-flagged-same-direction is
 * `strong`; both-flagged-OPPOSITE-direction is `conflicted` — the models
 * disagree with each other, not just with the market, which is a materially
 * different (and less actionable) situation than one model being silent.
 * `weak` is now exactly "one estimator flagged, the other didn't".
 */
export function computeAgreement(
  naiveEst: number,
  llmEst: number,
  dreamdexUp: number
): SignalAgreement {
  const naiveDiv = naiveEst - dreamdexUp;
  const llmDiv = llmEst - dreamdexUp;
  const naiveFlagged = Math.abs(naiveDiv) >= MISPRICING_ALERT_THRESHOLD;
  const llmFlagged = Math.abs(llmDiv) >= MISPRICING_ALERT_THRESHOLD;
  if (naiveFlagged && llmFlagged) return Math.sign(naiveDiv) === Math.sign(llmDiv) ? "strong" : "conflicted";
  if (naiveFlagged || llmFlagged) return "weak";
  return "none";
}

export type LiquidityState = "ok" | "one-sided" | "no-book" | "wide-spread";
/**
 * A midpoint is only a meaningful probability when both sides of the book
 * are present and reasonably close together. One-sided or wide-spread
 * quotes are real numbers but not a trustworthy market view — the caller
 * must not treat them as `dreamdexUp` for signal classification, only
 * (optionally) display them as the raw quote they are.
 */
export function classifyLiquidity(bestBid: number | undefined, bestAsk: number | undefined): { state: LiquidityState; spread: number | null } {
  if (bestBid === undefined && bestAsk === undefined) return { state: "no-book", spread: null };
  if (bestBid === undefined || bestAsk === undefined) return { state: "one-sided", spread: null };
  const spread = bestAsk - bestBid;
  return { state: spread <= MAX_SPREAD_FOR_SIGNAL ? "ok" : "wide-spread", spread };
}


/** A successful execution alone is insufficient: the final answer must be intact. */
export function validateLlmResult(raw: bigint, finalAnswer: unknown): number {
  if (raw < 0n || raw > 10000n) throw new Error("LLM result outside 0..10000");
  if (typeof finalAnswer !== "string" || !/^\d{1,5}$/.test(finalAnswer.trim())) {
    throw new Error("LLM final answer missing or malformed; execution success is not a valid probability");
  }
  if (BigInt(finalAnswer.trim()) !== raw) throw new Error("LLM final answer disagrees with ABI result");
  return Number(raw) / 10000;
}
/** Exponential backoff delay (ms) before retry attempt `attempt` (1-indexed): base, base*2, base*4, ... */
export function indexerBackoffDelayMs(attempt: number, baseMs: number): number {
  return baseMs * 2 ** (attempt - 1);
}

/** Median of one or more values. Even-length inputs average the two middle values. */
/**
 * Trims whitespace, adds a missing "0x" prefix, and validates the result is
 * exactly 32 bytes of hex before handing it to viem — replacing viem's own
 * generic "invalid private key, expected hex or 32 bytes, got string" (which
 * gives no hint what was actually wrong) with a specific, actionable message.
 * Caught live: a GitHub Actions secret pasted without its "0x" prefix hit
 * exactly this error with no clue as to the cause.
 */
export function normalizePrivateKey(raw: string | undefined): `0x${string}` {
  const trimmed = raw?.trim();
  if (!trimmed) throw new Error("PRIVATE_KEY is not set.");
  const withPrefix = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(withPrefix)) {
    throw new Error(
      `PRIVATE_KEY is not a valid 32-byte private key: expected "0x" followed by 64 hex characters, ` +
      `got ${withPrefix.length} characters after trimming whitespace and adding "0x" if missing. ` +
      `Check for stray whitespace, quotes, or a truncated copy-paste — a value generated by ` +
      `"npm run generate-wallet" is already correctly formatted and can be pasted as-is.`
    );
  }
  return withPrefix as `0x${string}`;
}

export function medianOf(values: number[]): number {
  if (!values.length) throw new Error("medianOf: empty array");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
export function remainingMinutes(expirySeconds: number, observedMs = Date.now()): number {
  return (expirySeconds * 1000 - observedMs) / 60000;
}
export function validMarketId(id: unknown): id is string {
  return typeof id === "string" && /^0x[0-9a-fA-F]{64}$/.test(id);
}

export type BrierScoreSummary = { n: number; uniqueMarkets: number; avgPerMarket: number };
/**
 * Equal-weights each distinct market rather than each observation: first
 * averages Brier within a market (if it was observed more than once),
 * then averages those per-market means across markets. Without this, a
 * market that happened to get logged five times counts five times as
 * much as one logged once — inflating or deflating the headline score
 * without reflecting five times the real predictive evidence.
 */
export function computeUniqueMarketBrier(history: HistoryEntry[], key: "dreamdexBrier" | "ensembleBrier"): BrierScoreSummary | null {
  const resolved = history.filter(h => !h.invalidated && h.resolved === true && typeof h[key] === "number" && Number.isFinite(h[key]) && typeof h.marketId === "string" && h.marketId);
  if (!resolved.length) return null;
  const byMarket = new Map<string, number[]>();
  for (const h of resolved) {
    const list = byMarket.get(h.marketId!) ?? [];
    list.push(h[key]!);
    byMarket.set(h.marketId!, list);
  }
  const perMarketMeans = [...byMarket.values()].map(list => list.reduce((s, v) => s + v, 0) / list.length);
  return {
    n: resolved.length,
    uniqueMarkets: byMarket.size,
    avgPerMarket: perMarketMeans.reduce((s, v) => s + v, 0) / perMarketMeans.length,
  };
}

/**
 * A "median" of one reading is not a multi-source median — it's a single
 * source that happened to survive. Label it as what it actually is so the
 * report never implies more independent confirmation than it has.
 * `configuredCount` is how many sources were attempted (from `PRICE_SOURCES`),
 * `successCount` is how many actually returned a usable price.
 */
export function priceSourceQuality(successCount: number, configuredCount: number): PriceSourceQuality {
  if (successCount >= configuredCount && successCount >= 2) return "verified-multi-source";
  if (successCount >= 2) return "degraded-multi-source";
  return "single-source-fallback";
}
export const PRICE_SOURCE_QUALITY_LABEL: Record<PriceSourceQuality, string> = {
  "verified-multi-source": "verified multi-source",
  "degraded-multi-source": "degraded multi-source",
  "single-source-fallback": "single-source fallback",
};

export type SimulatedEdgeBucket = {
  n: number;
  wins: number;
  winRate: number;
  avgReturnPct: number;
  totalPayoff: number;
};
export type SimulatedEdgeSummary = { strong: SimulatedEdgeBucket | null; weak: SimulatedEdgeBucket | null; combined: SimulatedEdgeBucket | null };

/**
 * Hypothetical, not a backtest of real trades: for every resolved, non-void
 * history entry that actually carried a signal (agreement !== "none"),
 * simulate staking exactly 1 unit on the side the ensemble diverged
 * toward, at DreamDEX's own quoted price for that side, and see what a
 * flat-1-unit-per-signal strategy would have paid out. This is a
 * transparency tool for a small sample, not a profitability claim — the
 * caller is responsible for surfacing sample size alongside any number
 * this returns.
 */
export function computeSimulatedEdge(history: HistoryEntry[]): SimulatedEdgeSummary {
  type Trade = { won: boolean; payoff: number; returnPct: number };
  const trades: { strong: Trade[]; weak: Trade[] } = { strong: [], weak: [] };
  for (const h of history) {
    if (h.invalidated || h.resolved !== true || h.agreement === "none" || h.agreement === "conflicted") continue;
    if (typeof h.actualOutcome !== "string" || (h.actualOutcome !== "YES" && h.actualOutcome !== "NO")) continue;
    if (!Number.isFinite(h.dreamdexUp) || h.dreamdexUp < 0 || h.dreamdexUp > 1) continue;
    if (!Number.isFinite(h.divergence) || h.divergence === 0) continue;
    const backingUp = h.divergence > 0;
    const cost = backingUp ? h.dreamdexUp : 1 - h.dreamdexUp;
    if (!(cost > 0)) continue; // no real stake possible at a 0-priced side
    const won = backingUp ? h.actualOutcome === "YES" : h.actualOutcome === "NO";
    const payoff = (won ? 1 : 0) - cost;
    const trade: Trade = { won, payoff, returnPct: payoff / cost };
    if (h.agreement === "strong") trades.strong.push(trade);
    else if (h.agreement === "weak") trades.weak.push(trade);
  }
  const summarize = (list: Trade[]): SimulatedEdgeBucket | null => {
    if (!list.length) return null;
    const wins = list.filter(t => t.won).length;
    return {
      n: list.length,
      wins,
      winRate: wins / list.length,
      avgReturnPct: list.reduce((s, t) => s + t.returnPct, 0) / list.length,
      totalPayoff: list.reduce((s, t) => s + t.payoff, 0),
    };
  };
  return { strong: summarize(trades.strong), weak: summarize(trades.weak), combined: summarize([...trades.strong, ...trades.weak]) };
}
