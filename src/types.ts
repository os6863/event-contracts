export type SignalAgreement = "strong" | "conflicted" | "weak" | "none";
export type LiquidityState = "ok" | "one-sided" | "no-book" | "wide-spread";
export type PriceSourceQuality = "verified-multi-source" | "degraded-multi-source" | "single-source-fallback";

export type ReportRow = {
  symbol: string;
  marketId: string;
  question: string;
  asset: string;
  oracleQuestionId?: string | null;
  openingPrice: number | null;
  currentPrice: number | null;
  /** Names of the independent price sources whose median produced `currentPrice` (e.g. ["CoinGecko","Binance"]). */
  priceSources?: string[];
  /** How many sources actually succeeded vs. how many were configured — see priceSourceQuality(). */
  priceSourceQuality?: PriceSourceQuality;
  /** Annualized realized volatility used for the naive baseline, when a measured value was available (null/undefined falls back to the disclosed static assumption). */
  realizedVolAnnual?: number | null;
  movePct: number | null;
  dreamdexUp: number | null;
  liquidityState?: LiquidityState;
  spread?: number | null;
  bestBid?: number | null;
  bestAsk?: number | null;
  naiveEst: number | null;
  llmEst: number | null;
  ensembleEst: number | null;
  llmStatus: "ok" | "failed" | "skipped" | "expired";
  divergence: number | null;
  flagged: boolean;
  agreement: SignalAgreement;
  /** True when the question text explicitly marks this as a test fixture (e.g. "Pricefeed test: ..."), typically created by the hackathon organizers to test their own infrastructure rather than a market meant for EdgeScope's own signal analysis. This reads an explicit label the market creator put in the question — it is not parsing the question to derive price or asset data. */
  isOrganizerTestFixture?: boolean;
  observedAt?: string;
  expiresAt?: string;
  priceObservedAt?: string;
  minutesLeft?: number;
  issue?: string;
  receiptUrl?: string;
  requestId?: string;
  retried?: boolean;
  thinking: string | null;
  reasoningTruncated: boolean;
};

export type HistoryEntry = {
  timestamp: string;
  version?: string;
  requestId?: string;
  receiptUrl?: string;
  invalidated?: boolean;
  excludedReason?: string;
  symbol: string;
  marketId?: string;
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

