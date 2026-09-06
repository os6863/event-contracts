import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReportRow, HistoryEntry, SignalAgreement } from "./types.js";
import { validMarketId, computeSimulatedEdge, type SimulatedEdgeBucket } from "./analysis.js";
import { css, responsiveCss } from "./styles.js";

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const prob = (v: unknown): v is number => finite(v) && v >= 0 && v <= 1;
export const formatProbability = (v: unknown) => prob(v) ? `${(v * 100).toFixed(2)}%` : "n/a";
export const formatDivergence = (v: unknown) => finite(v) ? `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)} pts` : "n/a";
const usd = (v: unknown) => finite(v) ? `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "n/a";
const move = (v: unknown) => finite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}%` : "n/a";
const time = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "n/a";
const signal = (v: unknown): SignalAgreement => v === "strong" || v === "weak" ? v : "none";
const label = (v: unknown) => ({ strong: "Strong signal", weak: "Weak signal", none: "No signal" })[signal(v)];
const badge = (v: unknown) => `<span class="badge ${signal(v)}">${label(v)}</span>`;
const external = (url: string, text: string) => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)} <span aria-hidden="true">↗</span></a>`;
function safeReceipt(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try { const u = new URL(url); return u.protocol === "https:" && !u.username && !u.password ? u.href : null; } catch { return null; }
}
/**
 * oracleQuestionId is a uint256 as a decimal string (docs: Market Structure
 * & Lifecycle). Validate the shape before building a URL from it — same
 * discipline as safeReceipt above, applied to a field sourced from the
 * indexer rather than user input, but external data either way.
 */
function oracleExplorerUrl(id: unknown): string | null {
  return typeof id === "string" && /^[0-9]+$/.test(id)
    ? `https://prd.oracle.somnia.host/questions/${id}?view=graph`
    : null;
}
const eligible = (r: ReportRow) => r.llmStatus === "ok" && prob(r.dreamdexUp) && prob(r.naiveEst) && prob(r.llmEst) && prob(r.ensembleEst) && finite(r.divergence);
function explanation(r: ReportRow): string {
  if (r.llmStatus === "expired") return "This market expired during report generation. It is excluded from signal counts and scoring history.";
  if (r.llmStatus === "failed") return "The agent estimate was unavailable or failed response validation. No ensemble signal is issued.";
  if (r.llmStatus === "skipped") return "Incomplete or stale inputs prevented estimation. No signal is issued.";
  if (!eligible(r)) return "No usable DreamDEX quote is available for an independent comparison.";
  if (r.agreement === "strong") return "Both estimates differ from DreamDEX by at least 15 percentage points in the same direction. This is agreement on divergence, not proof of accuracy.";
  if (r.agreement === "weak") return "At least one estimate differs by 15 points, but the two do not both clear the threshold in the same direction.";
  return "Neither estimate differs from DreamDEX by the 15-point threshold.";
}
function bar(name: string, value: unknown, cls: string) {
  return `<div class="bar-row"><span>${name}</span><div class="bar-track" aria-hidden="true"><i class="${cls}" style="width:${prob(value) ? value * 100 : 0}%"></i></div><b>${formatProbability(value)}</b></div>`;
}
function renderCard(r: ReportRow, index: number): string {
  const state = eligible(r) ? signal(r.agreement) : "none";
  const url = safeReceipt(r.receiptUrl);
  const oracleUrl = oracleExplorerUrl(r.oracleQuestionId);
  return `<article class="signal-card" data-signal="${state}">
    <div class="card-top"><div class="identity"><span class="asset-icon ${r.asset === "ETH" ? "eth" : "btc"}" aria-hidden="true">${r.asset === "ETH" ? "Ξ" : r.asset === "BTC" ? "₿" : "·"}</span><div><span class="eyebrow">${escapeHtml(r.asset)} / EVENT CONTRACT</span><h3>${escapeHtml(r.question)}</h3></div></div>${badge(state)}</div>
    <p class="symbol">${escapeHtml(r.symbol)}</p>
    <div class="market-metrics"><div><span>DreamDEX</span><strong>${formatProbability(r.dreamdexUp)}</strong></div><div><span>Independent ensemble</span><strong class="blue">${formatProbability(r.ensembleEst)}</strong></div><div><span>Ensemble divergence</span><strong class="${finite(r.divergence) && r.divergence < 0 ? "negative" : "positive"}">${formatDivergence(r.divergence)}</strong></div></div>
    <div class="comparison">${bar("Market", r.dreamdexUp, "market-bar")}${bar("Ensemble", r.ensembleEst, "ensemble-bar")}</div>
    <p class="assessment">${explanation(r)}</p>
    <details class="evidence"><summary>Verification snapshot <span aria-hidden="true">＋</span></summary><div class="evidence-body"><dl class="verification-grid">
    ${[["Opening price", usd(r.openingPrice)], ["Agent price", usd(r.currentPrice)], ["Price move", move(r.movePct)], ["Naive baseline", formatProbability(r.naiveEst)], ["LLM estimate", formatProbability(r.llmEst)], ["Time left at observation", finite(r.minutesLeft) ? `${r.minutesLeft.toFixed(1)} min` : "n/a"]].map(([k,v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>
    <p>Input snapshot: ${time(r.observedAt)}<br>Price received: ${time(r.priceObservedAt)}<br>Market expiry: ${time(r.expiresAt)}</p>
    <p class="agent-status">${r.llmStatus === "ok" ? "Successful agent receipt · final answer checked" : r.llmStatus === "expired" ? "Receipt checked · market expired" : r.llmStatus === "failed" ? "LLM estimate unavailable" : "Estimate skipped — incomplete source data"}</p>
    ${r.retried ? '<p class="notice">A malformed initial response was rejected. The displayed result comes from one retry without extended reasoning.</p>' : ""}
    ${r.issue ? `<p class="notice">${escapeHtml(r.issue)}</p>` : ""}
    ${url ? external(url, `View receipt${r.requestId ? ` · ${r.requestId}` : ""}`) : ""}
    ${oracleUrl ? external(oracleUrl, "Audit the resolution on the Oracle Explorer") : ""}</div></details>
    <details class="reasoning"><summary>View analysis &amp; AI reasoning <span aria-hidden="true">＋</span></summary><div class="evidence-body">
      <div class="analysis-summary"><span class="eyebrow">INPUT SUMMARY · GENERATED FROM REPORT DATA</span><p><b>Move:</b> ${escapeHtml(r.asset)} moved ${move(r.movePct)} from its opening price.</p><p><b>Time:</b> ${finite(r.minutesLeft) ? `${r.minutesLeft.toFixed(1)} minutes remained when these inputs were observed.` : "Timing data is unavailable."}</p><p><b>Comparison:</b> The baseline is ${formatProbability(r.naiveEst)} and the LLM estimate is ${formatProbability(r.llmEst)}. ${explanation(r)}</p></div>
      ${r.thinking ? `<details class="raw"><summary>Original agent reasoning</summary><div class="raw-text" tabindex="0" role="region" aria-label="Original reasoning for market ${index + 1}">${escapeHtml(r.thinking)}</div></details>` : `<p class="muted">${r.reasoningTruncated ? "Reasoning was generated but could not be fully retrieved for this report." : r.retried ? "The accepted retry requested a numeric answer without extended reasoning." : "No original reasoning was returned for this estimate."}</p>`}
    </div></details>
  </article>`;
}
function renderHistory(history: HistoryEntry[]) {
  return `<section id="history"><div class="section-heading"><div><span class="eyebrow">OBSERVATIONS OVER TIME</span><h2>Recent signal history</h2></div><span class="subtle-tag">Latest ${Math.min(history.length, 15)} of ${history.length} records</span></div>
  <p class="section-intro">Real testnet runs, preserved over time. Signal history alone does not measure resolved-market accuracy.</p>
  ${history.length ? `<div class="history-shell"><table><thead><tr><th>Market / observed at</th><th>DreamDEX</th><th>Ensemble</th><th>Signal</th><th>Settlement</th></tr></thead><tbody>${history.slice(-15).reverse().map(h => `<tr><td data-label="Market"><b>${escapeHtml(h.symbol)}</b><small>${time(h.timestamp)} · ${h.version ? escapeHtml(h.version) : "legacy model"}</small></td><td data-label="DreamDEX">${formatProbability(h.dreamdexUp)}</td><td data-label="Ensemble">${formatProbability(h.ensembleEst)}</td><td data-label="Signal">${h.invalidated ? `<span class="badge">Excluded</span>` : badge(h.agreement)}</td><td data-label="Settlement">${h.invalidated ? escapeHtml(h.excludedReason ?? "Invalidated legacy response") : h.resolved === "voided" ? "Voided · not scored" : h.resolved === true && (h.actualOutcome === "YES" || h.actualOutcome === "NO") ? `Resolved ${h.actualOutcome}` : !validMarketId(h.marketId) ? "Legacy · no market ID" : "Pending verification"}</td></tr>`).join("")}</tbody></table></div>` : '<div class="empty">No signal history yet. Successful observations will appear after a report run.</div>'}</section>`;
}
function renderTrackRecord(history: HistoryEntry[]) {
  const resolved = history.filter(h => !h.invalidated && h.resolved === true && prob(h.dreamdexBrier) && prob(h.ensembleBrier));
  const unique = new Set(resolved.map(h => h.marketId).filter(Boolean)).size;
  const score = (key: "dreamdexBrier" | "ensembleBrier") => (resolved.reduce((sum, h) => sum + h[key]!, 0) / resolved.length).toFixed(4);
  return `<section id="track-record" class="track-record"><div><span class="eyebrow">ACCOUNTABILITY, AFTER SETTLEMENT</span><h2>Track record</h2><p class="section-intro">Only on-chain resolved outcomes are scored. Lower Brier is better; voided markets are excluded.</p></div>${resolved.length ? `<div class="score-grid"><div><span>DreamDEX · avg. Brier</span><strong>${score("dreamdexBrier")}</strong></div><div><span>Ensemble · avg. Brier</span><strong class="blue">${score("ensembleBrier")}</strong></div></div><p class="muted">${resolved.length} prediction records across ${unique} unique markets. Repeated observations are scored separately; model versions may differ. This small testnet sample is not a profitability claim.</p>` : '<div class="empty">No verified settlement scores yet. Results appear after logged markets settle and outcomes are checked.</div>'}</section>`;
}
const pct = (v: unknown) => finite(v) ? `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%` : "n/a";
const units = (v: unknown) => finite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}u` : "n/a";
function edgeBucketBlock(title: string, note: string, b: SimulatedEdgeBucket | null) {
  if (!b) return `<div><span>${title}</span><p class="muted">No resolved signals in this class yet.</p></div>`;
  const items: [string, string, string?][] = [
    ["Sample", String(b.n)],
    ["Win rate", `${(b.winRate * 100).toFixed(0)}% (${b.wins}/${b.n})`],
    ["Avg. return / signal", pct(b.avgReturnPct), b.avgReturnPct >= 0 ? "positive" : "negative"],
    ["Net payoff, 1u staked / signal", units(b.totalPayoff), b.totalPayoff >= 0 ? "positive" : "negative"],
  ];
  return `<div><span>${title} <small>(${note})</small></span><div class="edge-data">${items.map(([k, v, cls]) => `<div><span>${k}</span><b${cls ? ` class="${cls}"` : ""}>${v}</b></div>`).join("")}</div></div>`;
}
function renderSimulatedEdge(history: HistoryEntry[]) {
  const edge = computeSimulatedEdge(history);
  const hasAny = edge.strong || edge.weak;
  return `<section id="simulated-edge" class="track-record"><div><span class="eyebrow">WOULD THE SIGNAL HAVE PAID?</span><h2>Simulated edge</h2><p class="section-intro">Hypothetical only — not a real trade, not a backtest of executed orders, and not investment advice. For every resolved signal, this assumes staking exactly 1 unit on the side the ensemble diverged toward, at DreamDEX's own quoted price for that side at observation time, with no fees or slippage modeled.</p></div>${hasAny ? `<div class="score-grid">${edgeBucketBlock("Strong signals", "both estimators agreed", edge.strong)}${edgeBucketBlock("Weak signals", "one estimator agreed", edge.weak)}</div><p class="muted">${edge.combined ? `${edge.combined.n} simulated signal(s) total. ` : ""}Small-sample results swing heavily on a single outcome — this is a transparency check on the method, not a return you should expect.</p>` : '<div class="empty">No resolved signals yet to simulate. Results appear once flagged markets settle and outcomes are checked.</div>'}</section>`;
}
export function renderReport(rows: ReportRow[], history: HistoryEntry[], generatedAt: string): string {
  const valid = rows.filter(eligible);
  const rank = { strong: 0, weak: 1, none: 2 };
  const sorted = [...rows].sort((a,b) => rank[eligible(a) ? signal(a.agreement) : "none"] - rank[eligible(b) ? signal(b.agreement) : "none"] || Math.abs(finite(b.divergence) ? b.divergence : 0) - Math.abs(finite(a.divergence) ? a.divergence : 0));
  const strongest = [...valid].sort((a,b) => Math.abs(b.divergence!) - Math.abs(a.divergence!))[0];
  const strong = valid.filter(r => r.agreement === "strong").length;
  const weak = valid.filter(r => r.agreement === "weak").length;
  const logo = `<span class="brand-mark" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M3 17L8 12L12 15L20 6M14 6H20V12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span><strong>EdgeScope</strong><small>DreamDEX Signal Intelligence</small></span>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="EdgeScope compares DreamDEX event-contract probabilities with independent Somnia Agent estimates. A verifiable testnet analytics snapshot."><meta name="color-scheme" content="dark"><title>EdgeScope — DreamDEX Signal Intelligence</title><style>${css}${responsiveCss}</style></head><body><a class="skip" href="#signals">Skip to signals</a>
<header><div class="wrap header-inner"><a class="brand" href="#top" aria-label="EdgeScope home">${logo}</a><nav class="nav" aria-label="Main navigation"><span class="network"><i class="dot"></i>Somnia Shannon Testnet</span><span class="github-link">${external("https://github.com/os6863/event-contracts/", "GitHub")}</span><a class="btn primary" href="#signals">View signals <span aria-hidden="true">↗</span></a></nav></div></header>
<main id="top" class="wrap"><div class="hero"><div class="hero-copy"><span class="eyebrow">VERIFIABLE ON-CHAIN MARKET INTELLIGENCE</span><h1>See the market.<br><em>Find the disagreement.</em></h1><p>DreamDEX sets the probability. Independent price data and on-chain AI offer a second view. EdgeScope shows where they diverge — and the evidence behind every signal.</p><div class="actions"><a class="btn primary" href="#signals">Explore signals <span aria-hidden="true">↗</span></a><a class="btn" href="#methodology">How it works <span aria-hidden="true">↓</span></a></div><p class="hero-note"><i class="dot"></i>Testnet analytics · No order placement</p></div>
<aside class="edge-panel" aria-label="Largest observed divergence"><div class="edge-head"><span class="eyebrow">LARGEST OBSERVED DIVERGENCE</span>${strongest ? badge(strongest.agreement) : '<span class="badge">Awaiting data</span>'}</div>${strongest ? `<div class="edge-number">${(Math.abs(strongest.divergence!) * 100).toFixed(2)} <small>pts</small></div><p class="edge-subtitle">${escapeHtml(strongest.asset)} · ${strongest.divergence! < 0 ? "Ensemble below market" : "Ensemble above market"}</p><div class="edge-data"><div><span>DreamDEX</span><b>${formatProbability(strongest.dreamdexUp)}</b></div><div><span>Independent ensemble</span><b class="blue">${formatProbability(strongest.ensembleEst)}</b></div></div><div class="edge-foot">${strongest.agreement === "strong" ? "2/2 estimators clear the threshold in the same direction" : "Does not pass the two-estimator Strong gate"}</div>` : '<div class="empty">No active signal data available</div>'}</aside></div>
<div class="snapshot-bar"><span>SNAPSHOT REPORT · v0.0.0.10</span><span>Generated <time datetime="${escapeHtml(generatedAt)}">${time(generatedAt)}</time></span></div><p class="muted" style="margin-top:-10px;margin-bottom:22px">These are recorded observations, not streaming quotes. Market prices and trading status may have changed since this report was generated.</p>
<div class="kpis"><div class="kpi"><span>Markets in this run</span><strong>${rows.length.toString().padStart(2,"0")}</strong><small>${valid.length} usable comparisons</small></div><div class="kpi"><span>Strong signals</span><strong class="green">${String(strong).padStart(2,"0")}</strong><small>Both estimators clear the gate</small></div><div class="kpi"><span>Weak signals</span><strong class="yellow">${String(weak).padStart(2,"0")}</strong><small>Incomplete estimator agreement</small></div><div class="kpi"><span>Trading mode</span><strong style="font-size:25px">Read-only</strong><small>No orders · agent computation uses testnet transactions</small></div></div>
<section id="signals"><div class="section-heading"><div><span class="eyebrow">THE INDEPENDENT VIEW</span><h2>Opportunity board</h2></div><div class="filters" role="group" aria-label="Filter signals">${[["all","All"],["strong","Strong"],["weak","Weak"],["none","No signal"]].map(([v,l])=>`<button type="button" data-filter="${v}" aria-pressed="${v === "all"}">${l}</button>`).join("")}</div></div><p class="section-intro">Ranked by signal class, then divergence. Strong requires both estimators to differ from DreamDEX by at least 15 points in the same direction.</p><div class="board">${sorted.map(renderCard).join("")}</div>${!rows.length ? '<div class="empty">No active markets with sufficient time remaining were found in this run.</div>' : ""}<div id="filter-empty" class="empty" hidden>No markets match this filter.</div><p id="board-count" class="board-count" aria-live="polite">Showing ${rows.length} of ${rows.length} markets</p><noscript><p class="muted">All markets are shown. Enable JavaScript to filter them.</p></noscript></section>
<section id="methodology"><div class="section-heading"><div><span class="eyebrow">FROM SOURCE TO SIGNAL</span><h2>Evidence at every step.</h2></div><span class="subtle-tag">Somnia × DreamDEX</span></div><p class="section-intro">Two on-chain agents. One independent baseline. A transparent comparison you can inspect.</p><div class="flow">${[["01","DreamDEX market","Read the opening price, order-book probability and on-chain trading status."],["02","Somnia price agent","Fetch BTC / ETH spot data through consensus-validated agent execution."],["03","LLM estimator","Estimate YES probability from the timestamped inputs. Check the final response against its receipt."],["04","Ensemble gate","Average the two estimates. Strong requires both to cross the 15-point threshold in the same direction."]].map(([n,t,d])=>`<div><div class="step"><span>${n}</span><span aria-hidden="true">↗</span></div><h3>${t}</h3><p>${d}</p></div>`).join("")}</div><p class="muted">The baseline uses a normal CDF with √time scaling and assumed annual volatility: BTC 55%, ETH 70%. These experimental models are not calibrated financial forecasts.</p></section>
<section><span class="eyebrow">BUILT THROUGH REAL TESTNET RUNS</span><h2>Reliability comes from iteration.</h2><p class="section-intro">Each release records the problems found in live testing and the fixes that followed.</p><div class="timeline"><div><b>v0.0.0.3</b><h3>The correct price foundation</h3><p>Replaced the unusable strike field with DreamDEX's actual opening-price source.</p></div><div><b>v0.0.0.7–9</b><h3>A second model checks the signal</h3><p>Added ensemble agreement, real settlement scoring and a time-aware probability baseline.</p></div><div><b>v0.0.0.10</b><h3>Check the response, expose the evidence</h3><p>Validate final answers, retain receipt references and distinguish expired or unavailable estimates.</p></div></div></section>
${renderTrackRecord(history)}${renderSimulatedEdge(history)}${renderHistory(history)}</main><footer><div class="wrap"><div class="footer-top"><a class="brand" href="#top">${logo}</a><div class="footer-links">${external("https://github.com/os6863/event-contracts/", "GitHub")}${external("https://docs.dreamdex.io/developers/event-contracts", "DreamDEX")}${external("https://agents.testnet.somnia.network", "Somnia Agents")}</div></div><p>EdgeScope is an analytics and research tool built for the Somnia × DreamDEX Event Contracts Hackathon. It does not place trades. These experimental testnet estimates are not financial advice, audited forecasts or a promise of returns.</p></div></footer>
<script>(()=>{const cards=[...document.querySelectorAll('[data-signal]')];const buttons=[...document.querySelectorAll('[data-filter]')];for(const button of buttons){button.addEventListener('click',()=>{const value=button.dataset.filter;let count=0;for(const card of cards){card.hidden=value!=='all'&&card.dataset.signal!==value;if(!card.hidden)count++;}for(const other of buttons)other.setAttribute('aria-pressed',String(other===button));document.getElementById('filter-empty').hidden=count!==0||cards.length===0;document.getElementById('board-count').textContent='Showing '+count+' of '+cards.length+' markets';});}})();</script></body></html>`;
}
export async function writeReport(rows: ReportRow[], history: HistoryEntry[], generatedAt: string): Promise<string> {
  const dir = dirname(fileURLToPath(import.meta.url));
  const html = renderReport(rows, history, generatedAt).replace(/[ \\t]+$/gm, "");
  await mkdir(join(dir, "output"), { recursive: true });
  await mkdir(join(dir, "..", "docs"), { recursive: true });
  await writeFile(join(dir, "output", "report.html"), html, "utf-8");
  await writeFile(join(dir, "..", "docs", "index.html"), html, "utf-8");
  return join(dir, "output", "report.html");
}
