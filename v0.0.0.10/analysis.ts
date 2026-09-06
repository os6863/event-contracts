import type { SignalAgreement, HistoryEntry } from "./types.js";
export const MISPRICING_ALERT_THRESHOLD = 0.15;
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

export function naiveProbability(movePct: number, minutesLeft: number, asset: string): number {
  const sigmaAnnual = ASSET_ANNUAL_VOLATILITY[asset] ?? DEFAULT_ANNUAL_VOLATILITY;
  const tYears = Math.max(minutesLeft, 1) / MINUTES_PER_YEAR; // floor at 1 minute — avoid dividing by ~0
  const sigmaOverWindow = sigmaAnnual * Math.sqrt(tYears);
  const z = movePct / 100 / sigmaOverWindow;
  const raw = normalCDF(z);
  return Math.min(NAIVE_PROB_CEILING, Math.max(NAIVE_PROB_FLOOR, raw));
}

export function computeAgreement(
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


/** A successful execution alone is insufficient: the final answer must be intact. */
export function validateLlmResult(raw: bigint, finalAnswer: unknown): number {
  if (raw < 0n || raw > 10000n) throw new Error("LLM result outside 0..10000");
  if (typeof finalAnswer !== "string" || !/^\d{1,5}$/.test(finalAnswer.trim())) {
    throw new Error("LLM final answer missing or malformed; execution success is not a valid probability");
  }
  if (BigInt(finalAnswer.trim()) !== raw) throw new Error("LLM final answer disagrees with ABI result");
  return Number(raw) / 10000;
}
export function remainingMinutes(expirySeconds: number, observedMs = Date.now()): number {
  return (expirySeconds * 1000 - observedMs) / 60000;
}
export function validMarketId(id: unknown): id is string {
  return typeof id === "string" && /^0x[0-9a-fA-F]{64}$/.test(id);
}

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
    if (h.invalidated || h.resolved !== true || h.agreement === "none") continue;
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
