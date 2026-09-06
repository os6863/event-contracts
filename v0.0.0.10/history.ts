import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { HistoryEntry, ReportRow } from "./types.js";
import { validMarketId } from "./analysis.js";

export async function readHistory(root: string): Promise<HistoryEntry[]> {
  let raw: string;
  try { raw = await readFile(join(root, "data", "signal-history.json"), "utf-8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const data: unknown = JSON.parse(raw);
  if (!Array.isArray(data) || data.some(h => !h || typeof h !== "object" || typeof h.timestamp !== "string" || typeof h.symbol !== "string")) {
    throw new Error("Invalid signal history; refusing to overwrite it.");
  }
  return data as HistoryEntry[];
}
export async function saveHistory(root: string, history: HistoryEntry[]) {
  await mkdir(join(root, "data"), { recursive: true });
  const path = join(root, "data", "signal-history.json");
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(history, null, 2), "utf-8");
  await rename(temp, path);
}
export async function appendSignalHistory(root: string, rows: ReportRow[]) {
  const existing = await readHistory(root);
  const added: HistoryEntry[] = [];
  for (const r of rows) {
    const values = [r.dreamdexUp, r.naiveEst, r.llmEst, r.ensembleEst];
    if (r.llmStatus !== "ok" || !validMarketId(r.marketId) || !r.observedAt ||
      values.some(v => typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) ||
      typeof r.divergence !== "number" || !Number.isFinite(r.divergence)) continue;
    added.push({ timestamp: r.observedAt, version: "0.0.0.10", symbol: r.symbol, marketId: r.marketId,
      asset: r.asset, dreamdexUp: r.dreamdexUp!, naiveEst: r.naiveEst!, llmEst: r.llmEst!,
      ensembleEst: r.ensembleEst!, divergence: r.divergence, agreement: r.agreement,
      requestId: r.requestId, receiptUrl: r.receiptUrl });
  }
  await saveHistory(root, [...existing, ...added].slice(-500));
}
export function uncheckedIds(history: HistoryEntry[]): string[] {
  return [...new Set(history.filter(h => !h.invalidated && h.resolved === undefined && validMarketId(h.marketId)).map(h => h.marketId!))];
}
export function settleEntries(entries: HistoryEntry[], state: { isVoided: boolean; isResolved: boolean; winningOutcome: number }) {
  if (state.isVoided) { for (const h of entries) h.resolved = "voided"; return; }
  if (!state.isResolved) return;
  if (state.winningOutcome !== 0 && state.winningOutcome !== 1) throw new Error("Unexpected binary winning outcome");
  const actual = state.winningOutcome === 0 ? 1 : 0;
  for (const h of entries) {
    if (![h.dreamdexUp, h.ensembleEst].every(v => Number.isFinite(v) && v >= 0 && v <= 1)) continue;
    h.resolved = true; h.actualOutcome = actual ? "YES" : "NO";
    h.dreamdexCorrect = (h.dreamdexUp > 0.5) === Boolean(actual);
    h.ensembleCorrect = (h.ensembleEst > 0.5) === Boolean(actual);
    h.dreamdexBrier = (h.dreamdexUp - actual) ** 2;
    h.ensembleBrier = (h.ensembleEst - actual) ** 2;
  }
}
