import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalCDF, naiveProbability, computeAgreement, validateLlmResult, remainingMinutes, computeSimulatedEdge, classifyLiquidity, computeUniqueMarketBrier, medianOf } from "./analysis.js";
import { renderReport, formatProbability } from "./report-ui.js";
import { readHistory, saveHistory, appendSignalHistory, uncheckedIds, settleEntries } from "./history.js";
import type { ReportRow, HistoryEntry } from "./types.js";
const id = `0x${"a".repeat(64)}`;
const row: ReportRow = { symbol: "BTC-TEST", marketId: id, question: "BTC closes above opening", asset: "BTC", openingPrice: 100, currentPrice: 101, movePct: 1, dreamdexUp: .3, naiveEst: .7, llmEst: .65, ensembleEst: .675, llmStatus: "ok", divergence: .375, flagged: true, agreement: "strong", thinking: "Original model explanation", reasoningTruncated: false, observedAt: "2026-09-06T20:00:00Z" };
const entry: HistoryEntry = { timestamp: row.observedAt!, symbol: row.symbol, marketId: id, asset: "BTC", dreamdexUp: .3, naiveEst: .7, llmEst: .65, ensembleEst: .675, divergence: .375, agreement: "strong" };

// Frozen pre-refactor baseline. Keeping the reference implementation in this
// test preserves the regression guarantee without requiring deleted version
// snapshot folders to remain in the production repository.
const baselineVol: Record<string, number> = { BTC: 0.55, ETH: 0.7 };
function baselineNormalCDF(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}
function baselineNaiveProbability(movePct: number, minutesLeft: number, asset: string): number {
  const sigmaAnnual = baselineVol[asset] ?? 0.6;
  const tYears = Math.max(minutesLeft, 1) / (60 * 24 * 365);
  const raw = baselineNormalCDF((movePct / 100) / (sigmaAnnual * Math.sqrt(tYears)));
  return Math.min(0.98, Math.max(0.02, raw));
}
function baselineAgreement(naiveEst: number, llmEst: number, dreamdexUp: number) {
  const naiveDiv = naiveEst - dreamdexUp;
  const llmDiv = llmEst - dreamdexUp;
  const naiveFlagged = Math.abs(naiveDiv) >= 0.15;
  const llmFlagged = Math.abs(llmDiv) >= 0.15;
  const sameDirection = Math.sign(naiveDiv) === Math.sign(llmDiv);
  if (naiveFlagged && llmFlagged && sameDirection) return "strong";
  if (naiveFlagged || llmFlagged) return "weak";
  return "none";
}

test("pre-refactor baseline and agreement remain identical across a grid of inputs", () => {
  for (const asset of ["BTC", "ETH", "OTHER"]) for (const minutes of [0, 1, 15, 60, 240, 1440]) for (const move of [-2, -.5, 0, .5, 2]) {
    assert.equal(naiveProbability(move, minutes, asset), baselineNaiveProbability(move, minutes, asset));
  }
  for (const naive of [.1,.3,.5,.7,.9]) for (const llm of [.1,.3,.5,.7,.9]) for (const market of [.1,.3,.5,.7,.9]) assert.equal(computeAgreement(naive,llm,market), baselineAgreement(naive,llm,market));
});
test("CDF reference and time direction", () => {
  assert.ok(Math.abs(normalCDF(1.96) - .9750021) < 1e-6);
  assert.ok(naiveProbability(.5,15,"BTC") > naiveProbability(.5,1440,"BTC"));
  assert.ok(Math.abs(naiveProbability(0,15,"BTC") - .5) < 1e-8);
  assert.equal(computeAgreement(.8,.2,.5), "weak");
});
test("malformed final response can never turn into probability zero", () => {
  for (const final of [undefined, null, "", "0.65", "6500 words", "<truncated>", "6500\n0"]) assert.throws(() => validateLlmResult(0n,final));
  assert.throws(() => validateLlmResult(0n,"6500"));
  assert.throws(() => validateLlmResult(10001n,"10001"));
  assert.throws(() => validateLlmResult(-1n,"-1"));
  assert.equal(validateLlmResult(6500n,"6500"), .65);
  assert.equal(validateLlmResult(0n,"0"), 0);
});
test("remaining time uses the observation clock rather than scan headroom", () => {
  assert.equal(remainingMinutes(600, 300000),5);
  assert.equal(remainingMinutes(600, 660000),-1);
});
test("legacy IDs skipped, pending outcomes retried, voided excluded", () => {
  const legacy = {...entry, marketId: undefined}; const pending = {...entry};
  assert.deepEqual(uncheckedIds([legacy,pending,pending,{...pending,invalidated:true}]),[id]);
  settleEntries([pending], {isVoided:false,isResolved:false,winningOutcome:0});
  assert.equal(pending.resolved,undefined);
  settleEntries([pending], {isVoided:true,isResolved:true,winningOutcome:0});
  assert.equal(pending.resolved,"voided"); assert.equal(pending.ensembleBrier,undefined);
});
test("real binary outcome math and invalid outcomes", () => {
  const yes = {...entry}; settleEntries([yes],{isVoided:false,isResolved:true,winningOutcome:0});
  assert.equal(yes.actualOutcome,"YES"); assert.equal(yes.ensembleCorrect,true); assert.equal(yes.dreamdexCorrect,false);
  assert.ok(Math.abs(yes.ensembleBrier! - .105625) < 1e-12);
  const no = {...entry}; settleEntries([no],{isVoided:false,isResolved:true,winningOutcome:1});
  assert.equal(no.actualOutcome,"NO"); assert.equal(no.dreamdexBrier,.09);
  assert.throws(()=>settleEntries([{...entry}],{isVoided:false,isResolved:true,winningOutcome:2}));
});
test("simulated edge only counts resolved, signaled trades and picks the diverged side", () => {
  const strongWin = {...entry, resolved: true as const, actualOutcome: "YES" as const};
  const summary1 = computeSimulatedEdge([strongWin]);
  assert.equal(summary1.strong!.n, 1); assert.equal(summary1.strong!.wins, 1);
  assert.ok(Math.abs(summary1.strong!.totalPayoff - 0.7) < 1e-9);
  assert.ok(Math.abs(summary1.strong!.avgReturnPct - (0.7/0.3)) < 1e-9);
  assert.equal(summary1.weak, null);
  const strongLoss = {...entry, resolved: true as const, actualOutcome: "NO" as const};
  const summary2 = computeSimulatedEdge([strongLoss]);
  assert.equal(summary2.strong!.wins, 0); assert.ok(Math.abs(summary2.strong!.totalPayoff - (-0.3)) < 1e-9);
  const backsDown = {...entry, dreamdexUp: .9, ensembleEst: .7, divergence: -.2, agreement: "weak" as const, resolved: true as const, actualOutcome: "NO" as const};
  const summary3 = computeSimulatedEdge([backsDown]);
  assert.equal(summary3.weak!.n, 1); assert.equal(summary3.weak!.wins, 1);
  assert.ok(Math.abs(summary3.weak!.totalPayoff - 0.9) < 1e-9);
  assert.equal(summary3.strong, null);
  const excluded = [
    {...entry, agreement: "none" as const, resolved: true as const, actualOutcome: "YES" as const},
    {...entry, resolved: undefined, actualOutcome: undefined},
    {...entry, resolved: "voided" as const},
    {...entry, invalidated: true, resolved: true as const, actualOutcome: "YES" as const},
    {...entry, divergence: 0, resolved: true as const, actualOutcome: "YES" as const},
    {...entry, dreamdexUp: 0, divergence: .5, resolved: true as const, actualOutcome: "YES" as const},
  ];
  const summaryEmpty = computeSimulatedEdge(excluded);
  assert.equal(summaryEmpty.strong, null); assert.equal(summaryEmpty.weak, null); assert.equal(summaryEmpty.combined, null);
});
test("history preserves legacy rows and only appends usable observations", async () => {
  const dir=await mkdtemp(join(tmpdir(),"edgescope-test-"));
  try {
    await saveHistory(dir,[{...entry,marketId:undefined}]);
    await appendSignalHistory(dir,[row,{...row,llmStatus:"failed"},{...row,llmStatus:"expired"}]);
    const h=await readHistory(dir);assert.equal(h.length,2);assert.equal(h[0].marketId,undefined);assert.equal(h[1].timestamp,row.observedAt);
    await writeFile(join(dir,"data","signal-history.json"),"{broken");
    await assert.rejects(()=>appendSignalHistory(dir,[row]));
    assert.equal(await readFile(join(dir,"data","signal-history.json"),"utf-8"),"{broken");
  } finally {await rm(dir,{recursive:true});}
});
test("history retains last 500 without resetting", async () => {
  const dir=await mkdtemp(join(tmpdir(),"edgescope-test-"));
  try {await saveHistory(dir,Array.from({length:500},(_,i)=>({...entry,symbol:String(i)})));await appendSignalHistory(dir,[row]);const h=await readHistory(dir);assert.equal(h.length,500);assert.equal(h[0].symbol,"1");assert.equal(h[499].symbol,row.symbol);} finally {await rm(dir,{recursive:true});}
});
test("renderer escapes external strings and excludes invalid rows from strongest panel", () => {
  const html = renderReport([{...row,symbol:'<img src=x onerror=alert(1)>',thinking:'</div><script>alert(2)</script>',receiptUrl:'javascript:alert(3)'},{...row,llmStatus:"failed",divergence:1}],[],row.observedAt!);
  assert.ok(!html.includes('<img src=x')); assert.ok(!html.includes('<script>alert(2)'));assert.ok(!html.includes('href="javascript:'));
  assert.ok(html.includes('37.50'));assert.ok(html.includes('data-signal="strong"'));
  const invalidHistory = renderReport([row],[{...entry,invalidated:true,excludedReason:"bad <receipt>"}],row.observedAt!);
  assert.ok(invalidHistory.includes('>Excluded<')); assert.ok(invalidHistory.includes('bad &lt;receipt&gt;'));
  for (const v of [NaN, Infinity, null, undefined, -1, 2]) assert.equal(formatProbability(v),"n/a");
});
test("oracle explorer link renders only for a valid decimal question id", () => {
  const withId = renderReport([{...row, oracleQuestionId: "9182734"}],[],row.observedAt!);
  assert.ok(withId.includes('https://prd.oracle.somnia.host/questions/9182734?view=graph'));
  assert.ok(withId.includes("Audit the resolution on the Oracle Explorer"));
  for (const bad of [null, undefined, "", "0x1a", "12; DROP TABLE", "12abc", "-5"]) {
    const html = renderReport([{...row, oracleQuestionId: bad as any}],[],row.observedAt!);
    assert.ok(!html.includes("prd.oracle.somnia.host"));
  }
});
test("liquidity classification: tight two-sided ok, wide-spread and one-sided both rejected as a probability source", () => {
  const tight = classifyLiquidity(.3, .35);
  assert.equal(tight.state, "ok"); assert.ok(Math.abs(tight.spread! - .05) < 1e-9);
  const under = classifyLiquidity(.46, .53); assert.equal(under.state, "ok");
  const over = classifyLiquidity(.45, .54); assert.equal(over.state, "wide-spread");
  const wide = classifyLiquidity(.2, .8);
  assert.equal(wide.state, "wide-spread"); assert.ok(Math.abs(wide.spread! - .6) < 1e-9);
  assert.deepEqual(classifyLiquidity(undefined, .95), { state: "one-sided", spread: null });
  assert.deepEqual(classifyLiquidity(.2, undefined), { state: "one-sided", spread: null });
  assert.deepEqual(classifyLiquidity(undefined, undefined), { state: "no-book", spread: null });
});
test("unique-market Brier equal-weights markets, not observations", () => {
  const marketA = "0x" + "a".repeat(64), marketB = "0x" + "b".repeat(64);
  const history: HistoryEntry[] = [
    {...entry, marketId: marketA, resolved: true, dreamdexBrier: .01},
    {...entry, marketId: marketA, resolved: true, dreamdexBrier: .01},
    {...entry, marketId: marketA, resolved: true, dreamdexBrier: .01},
    {...entry, marketId: marketB, resolved: true, dreamdexBrier: .81},
  ];
  const summary = computeUniqueMarketBrier(history, "dreamdexBrier");
  assert.equal(summary!.n, 4); assert.equal(summary!.uniqueMarkets, 2);
  assert.ok(Math.abs(summary!.avgPerMarket - .41) < 1e-9);
  const excluded: HistoryEntry[] = [
    {...entry, marketId: marketA, resolved: true, invalidated: true, dreamdexBrier: .01},
    {...entry, marketId: marketA, resolved: undefined, dreamdexBrier: .01},
    {...entry, marketId: undefined, resolved: true, dreamdexBrier: .01},
  ];
  assert.equal(computeUniqueMarketBrier(excluded, "dreamdexBrier"), null);
});
test("insufficient liquidity renders a distinct explanation and never leaks a fabricated probability", () => {
  const noBook = {...row, dreamdexUp: null, liquidityState: "no-book" as const, spread: null, bestBid: null, bestAsk: null};
  const html1 = renderReport([noBook], [], row.observedAt!);
  assert.ok(html1.includes("Insufficient market liquidity"));
  assert.ok(html1.includes("no bid or ask is posted"));
  assert.ok(html1.includes('data-signal="none"'));
  assert.ok(!html1.includes('data-signal="strong"') && !html1.includes('data-signal="weak"'));
  const oneSided = {...row, dreamdexUp: null, liquidityState: "one-sided" as const, spread: null, bestBid: null, bestAsk: .95};
  const html2 = renderReport([oneSided], [], row.observedAt!);
  assert.ok(html2.includes("only one side of the book is posted"));
  assert.ok(html2.includes("ask 95.00%"));
  assert.ok(!html2.includes("95.00% (two-sided"));
  const wide = {...row, dreamdexUp: null, liquidityState: "wide-spread" as const, spread: .6, bestBid: .2, bestAsk: .8};
  const html3 = renderReport([wide], [], row.observedAt!);
  assert.ok(html3.includes("60.0 pts"));
});
test("simulated edge section renders resolved trades and an explicit empty state otherwise", () => {
  const resolvedEntry = {...entry, resolved: true as const, actualOutcome: "YES" as const};
  const withData = renderReport([row], [resolvedEntry], row.observedAt!);
  assert.ok(withData.includes("Simulated edge"));
  assert.ok(withData.includes("Strong signals"));
  assert.ok(!withData.includes("No resolved signals yet to simulate"));
  const withoutData = renderReport([row], [entry], row.observedAt!);
  assert.ok(withoutData.includes("No resolved signals yet to simulate"));
});
test("rendering leaves all analytical values and ordering untouched", () => {
  const rows=[{...row,agreement:"none" as const},{...row}];const before=structuredClone(rows);renderReport(rows,[entry],row.observedAt!);assert.deepEqual(rows,before);
});
test("medianOf: odd count returns the middle value, even count averages the two middle values, order and duplicates don't matter", () => {
  assert.equal(medianOf([5]), 5);
  assert.equal(medianOf([3, 1, 2]), 2);
  assert.equal(medianOf([1, 2]), 1.5);
  assert.equal(medianOf([4, 1, 3, 2]), 2.5);
  assert.equal(medianOf([10, 10, 10]), 10);
  assert.equal(medianOf([100000.5, 100000.7, 900000]), 100000.7); // one wildly-off source doesn't move a 3-source median
  assert.throws(() => medianOf([]));
});
test("multi-source price row renders the source count and names in the verification snapshot", () => {
  const html = renderReport([{ ...row, priceSources: ["CoinGecko", "Binance"] }], [entry], row.observedAt!);
  assert.ok(html.includes("median of 2"));
  assert.ok(html.includes("CoinGecko, Binance"));
  const singleSource = renderReport([{ ...row, priceSources: ["CoinGecko"] }], [entry], row.observedAt!);
  assert.ok(singleSource.includes("median of 1"));
  const noSourceInfo = renderReport([{ ...row, priceSources: undefined }], [entry], row.observedAt!);
  assert.ok(!noSourceInfo.includes("median of"));
});
test("empty report, missing reasoning and invalid numbers render safely", async () => {
  const html=renderReport([],[],row.observedAt!);assert.ok(html.includes("No active signal data"));assert.ok(html.includes("No verified settlement"));
  const failed=renderReport([{...row,llmStatus:"failed",llmEst:NaN,ensembleEst:Infinity,thinking:null,divergence:null}],[],row.observedAt!);
  assert.ok(!failed.includes('>NaN<'));assert.ok(!failed.includes('>Infinity<'));
  await mkdir(new URL("./output/",import.meta.url),{recursive:true});
  await writeFile(new URL("./output/test-states.html",import.meta.url),renderReport([row,{...row,symbol:"WEAK",agreement:"weak"},{...row,symbol:"NONE",agreement:"none"},{...row,symbol:"FAILED",llmStatus:"failed",llmEst:null,ensembleEst:null,divergence:null},{...row,symbol:"SKIPPED",llmStatus:"skipped"},{...row,symbol:"EXPIRED",llmStatus:"expired"}], [entry],row.observedAt!));
  await writeFile(new URL("./output/test-empty.html",import.meta.url),html);
});
