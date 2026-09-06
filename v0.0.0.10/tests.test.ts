import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import vm from "node:vm";
import { normalCDF, naiveProbability, computeAgreement, validateLlmResult, remainingMinutes } from "./analysis.js";
import { renderReport, formatProbability } from "./report-ui.js";
import { readHistory, saveHistory, appendSignalHistory, uncheckedIds, settleEntries } from "./history.js";
import type { ReportRow, HistoryEntry } from "./types.js";
const id = `0x${"a".repeat(64)}`;
const row: ReportRow = { symbol: "BTC-TEST", marketId: id, question: "BTC closes above opening", asset: "BTC", openingPrice: 100, currentPrice: 101, movePct: 1, dreamdexUp: .3, naiveEst: .7, llmEst: .65, ensembleEst: .675, llmStatus: "ok", divergence: .375, flagged: true, agreement: "strong", thinking: "Original model explanation", reasoningTruncated: false, observedAt: "2026-09-06T20:00:00Z" };
const entry: HistoryEntry = { timestamp: row.observedAt!, symbol: row.symbol, marketId: id, asset: "BTC", dreamdexUp: .3, naiveEst: .7, llmEst: .65, ensembleEst: .675, divergence: .375, agreement: "strong" };

test("v9 baseline and agreement remain identical across a grid of inputs", async () => {
  const source = await readFile(new URL("../v0.0.0.9/mispricing-report.ts", import.meta.url), "utf-8");
  const extracted = 'const MISPRICING_ALERT_THRESHOLD=0.15;\n' + source.slice(source.indexOf("const ASSET_ANNUAL_VOLATILITY"), source.indexOf("function escapeHtml"));
  const context = vm.createContext({});
  vm.runInContext(ts.transpileModule(extracted, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  for (const asset of ["BTC", "ETH", "OTHER"]) for (const minutes of [0, 1, 15, 60, 240, 1440]) for (const move of [-2, -.5, 0, .5, 2]) {
    assert.equal(naiveProbability(move, minutes, asset), context.naiveProbability(move, minutes, asset));
  }
  for (const naive of [.1,.3,.5,.7,.9]) for (const llm of [.1,.3,.5,.7,.9]) for (const market of [.1,.3,.5,.7,.9]) assert.equal(computeAgreement(naive,llm,market), context.computeAgreement(naive,llm,market));
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
  // Zero remains a legitimate answer when explicitly present and matched; no arbitrary clamping.
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
test("rendering leaves all analytical values and ordering untouched", () => {
  const rows=[{...row,agreement:"none" as const},{...row}];const before=structuredClone(rows);renderReport(rows,[entry],row.observedAt!);assert.deepEqual(rows,before);
});
test("empty report, missing reasoning and invalid numbers render safely", async () => {
  const html=renderReport([],[],row.observedAt!);assert.ok(html.includes("No active signal data"));assert.ok(html.includes("No verified settlement"));
  const failed=renderReport([{...row,llmStatus:"failed",llmEst:NaN,ensembleEst:Infinity,thinking:null,divergence:null}],[],row.observedAt!);
  assert.ok(!failed.includes('>NaN<'));assert.ok(!failed.includes('>Infinity<'));
  // Fixtures never overwrite the public report or real history.
  await mkdir(new URL("./output/",import.meta.url),{recursive:true});
  await writeFile(new URL("./output/test-states.html",import.meta.url),renderReport([row,{...row,symbol:"WEAK",agreement:"weak"},{...row,symbol:"NONE",agreement:"none"},{...row,symbol:"FAILED",llmStatus:"failed",llmEst:null,ensembleEst:null,divergence:null},{...row,symbol:"SKIPPED",llmStatus:"skipped"},{...row,symbol:"EXPIRED",llmStatus:"expired"}], [entry],row.observedAt!));
  await writeFile(new URL("./output/test-empty.html",import.meta.url),html);
});
