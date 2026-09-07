export type SignalAgreement = "strong" | "weak" | "none";
export type LiquidityState = "ok" | "one-sided" | "no-book" | "wide-spread";

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

