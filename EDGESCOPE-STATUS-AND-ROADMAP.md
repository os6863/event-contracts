# EdgeScope: Current Status and Product Roadmap

**Current release:** `v0.0.0.10`  
**Next target:** `v0.0.0.11`  
**Project:** EdgeScope  
**Repository:** <https://github.com/os6863/event-contracts>  
**Live report:** <https://os6863.github.io/event-contracts/>  
**Assessment date:** September 6, 2026

## 1. Executive summary

EdgeScope is a read-only analytics and verification layer for DreamDEX Event Contracts on Somnia. It discovers active binary markets, reads live order-book prices, obtains independent probability estimates through Somnia Agents, measures disagreement between the estimate and the market, and preserves evidence that allows users to inspect how each signal was produced.

Version `v0.0.0.10` is a working and technically credible prototype. Its core DreamDEX integration follows the current SDK model, its public report is deployed, and its existing automated checks pass. The project already has a clear differentiator: it combines independent probability estimation, market comparison, verifiable Agent receipts, and post-settlement calibration in one evidence-first report.

The next release should focus on stronger protocol provenance, complete submission materials, longer-term performance evidence, and clearer product positioning. Trading execution is not required to make EdgeScope competitive. Its strongest direction is to become the trusted intelligence and audit layer around Event Contracts.

## 2. Product purpose

EdgeScope should help a user answer six questions:

1. What probability is the DreamDEX market currently pricing?
2. What probability does an independent Agent estimate?
3. How large is the disagreement between them?
4. How confident and fresh is the estimate?
5. Has the method been accurate after previous markets settled?
6. Can the analysis and the final settlement be independently verified?

The product is intentionally read-only. It does not place trades, request wallet approval, manage user funds, or claim guaranteed profitability.

## 3. Current implementation

### 3.1 Market discovery

The current release:

- Uses `@somnia-chain/markets-sdk` version `^0.29.0`.
- Loads current DreamDEX markets through the SDK.
- Narrows records to binary Event Contracts.
- Filters markets to the intended venue.
- Reads live on-chain market state.
- Excludes markets that are not in the trading state.
- Applies expiry headroom before requesting expensive analysis.
- Uses market identifiers and symbols rather than treating pool addresses as permanent identities.

### 3.2 Market-implied probability

For each eligible market, EdgeScope:

- Reads the outcome order book.
- Extracts the best bid and best ask.
- Calculates the midpoint when both sides are available.
- Treats that midpoint as the market-implied probability.
- Preserves book and market context in the generated report.

### 3.3 Independent estimation

The analysis pipeline:

- Retrieves spot-price context through a Somnia Agent.
- Requests a structured probability estimate from a second Agent.
- Validates and normalizes returned values.
- Produces an ensemble probability.
- Measures the edge between the ensemble and the DreamDEX midpoint.
- Assigns confidence and diagnostic states.
- Preserves Agent transaction and receipt evidence where available.

### 3.4 Historical accountability

The current history system:

- Persists generated signals by market identity.
- Revisits markets after settlement.
- Distinguishes pending, resolved, and voided outcomes.
- Maps outcome index `0` to YES/UP and `1` to NO/DOWN.
- Records final outcomes.
- Calculates Brier scores for resolved predictions.
- Displays the initial basis for a measurable forecasting track record.

### 3.5 Public report

The GitHub Pages report provides:

- A responsive evidence-first interface.
- Summary metrics and signal cards.
- Market, probability, confidence, and edge information.
- Receipt and diagnostic details.
- Historical outcome and calibration information.
- A static artifact that can be reviewed without connecting a wallet.

## 4. Current technical assessment

### 4.1 Confirmed strengths

| Area | Status | Assessment |
|---|---|---|
| DreamDEX SDK integration | Confirmed | Uses the supported TypeScript SDK and a current package version. |
| Binary-market discovery | Confirmed | Uses binary-market narrowing and venue scoping. |
| On-chain status validation | Confirmed | Market status is checked against live contract state. |
| Order-book pricing | Confirmed | Best bid, best ask, and midpoint are used correctly for read-only analysis. |
| Independent estimation | Confirmed | Agent-derived estimates are separate from the DreamDEX price. |
| Evidence preservation | Confirmed | Agent requests and receipts are surfaced for verification. |
| Settlement tracking | Confirmed | Resolved and voided states are handled. |
| Outcome mapping | Confirmed | YES/UP and NO/DOWN outcome indices are mapped correctly. |
| Forecast scoring | Confirmed | Resolved predictions feed a Brier-score history. |
| Security boundary | Confirmed | No DreamDEX trade execution or user-fund access is present. |
| Automated validation | Confirmed | Existing tests and TypeScript checks passed during the v0.0.0.10 review. |
| Deployment | Confirmed | The generated report is published through GitHub Pages. |

### 4.2 Remaining technical gaps

#### A. Use on-chain expiry as the authoritative expiry

The validated on-chain market snapshot should be the final source of expiry:

```ts
const secondsLeft = Number(onchain.expiry) - now;
```

Indexer metadata is useful for discovery but may lag. The on-chain value should control admission to the analysis pipeline. The market should also be revalidated before an Agent request if enough time has passed since discovery.

#### B. Add DreamDEX settlement-oracle provenance

Agent receipts prove how an estimate was requested or produced. They do not prove how DreamDEX settled the market. EdgeScope should capture `oracleQuestionId` when it is available and expose the corresponding oracle explorer link:

```text
https://prd.oracle.somnia.host/questions/{oracleQuestionId}?view=graph
```

The interface must label these evidence types separately:

- **Analysis evidence:** Somnia Agent request and receipt.
- **Settlement evidence:** DreamDEX oracle question and final market state.

Missing oracle metadata must be shown as unavailable rather than represented by an invented link or empty identifier.

#### C. Strengthen finalized-market discovery

Finalized Event Contracts leave the active list returned by `loadMarkets()`. Outcome reconciliation should use the finalized binary-market source, scoped to the correct venue, and must handle pagination when necessary. Persisted market IDs should remain a direct fallback so a tracked signal cannot silently disappear from outcome checking.

#### D. Correct outdated public copy

Any statement claiming that DreamDEX has no public Event Contracts interface must be removed or updated. The current public interface is:

<https://app.dreamdex.io/event-contracts>

All external product and protocol claims should be checked against the current official documentation before release.

#### E. Expand unknown-state handling

Missing bid, ask, spot, receipt, oracle, block, or settlement data must remain `null` or explicitly unknown. It must never be silently converted to zero. The UI should distinguish unavailable data from a real numeric value and explain which conclusion cannot be made.

## 5. Competitive position

EdgeScope competes most effectively as an independent intelligence and verification product. Several Event Contracts projects emphasize order execution, automated trading, market making, portfolio hedging, or agent-controlled strategies. EdgeScope's distinct value is the ability to compare a market with an independently generated probability and then hold that estimate accountable after settlement.

### 5.1 Competitive strengths

- Clear read-only safety boundary.
- Real DreamDEX market and order-book integration.
- Independent Agent probability rather than a reformatted market price.
- Verifiable analysis receipts.
- Historical outcome reconciliation.
- Brier scoring for long-term model accountability.
- Public, wallet-free evidence report.
- Clean repository and deployment workflow.

### 5.2 Competitive weaknesses

- The resolved sample is still too small to establish forecasting quality.
- The product has no recurring user workflow, alerting loop, or integration surface yet.
- Settlement-oracle provenance is not fully exposed.
- Business and ecosystem impact are less concrete than projects that execute or protect positions.
- The public repository does not yet contain a complete SDK feedback report and polished two-to-three-minute demo package.
- A static report is useful for judging, but a continuously refreshed intelligence product would demonstrate stronger adoption potential.

### 5.3 Current estimated hackathon score

| Criterion | Weight | Current score | Main reason |
|---|---:|---:|---|
| Innovation and originality | 20 | 17 | Independent verifiable probability comparison is differentiated. |
| Technical implementation | 25 | 22 | Strong SDK, Agent, evidence, and history integration; provenance can improve. |
| User experience and design | 20 | 17 | Clear responsive report; some evidence states can be easier to understand. |
| Business and ecosystem impact | 20 | 11 | Useful analytics concept, but adoption and integration paths need definition. |
| Presentation and demo | 15 | 12 | Strong README and live report; formal demo and SDK feedback assets remain. |
| **Total** | **100** | **79** | Strong prototype with identifiable submission and product gaps. |

The score is an internal product assessment, not an official judging result. Completing the priority roadmap should raise the project into an estimated `85–87` range without changing its read-only identity.

## 6. Target state for v0.0.0.11

Version `v0.0.0.11` should be a submission-ready evidence release with these outcomes:

1. On-chain expiry controls candidate selection.
2. Every market is revalidated before costly analysis.
3. DreamDEX settlement-oracle provenance is preserved when available.
4. Finalized-market reconciliation cannot silently lose tracked signals.
5. Unknown data remains explicit throughout JSON, scoring, and HTML.
6. Public documentation contains only current and verifiable claims.
7. The project includes a concise SDK and documentation feedback report.
8. The project includes a reproducible two-to-three-minute demo script and shot list.
9. The public report explains the distinction between analysis evidence and settlement evidence.
10. The report and repository pass privacy, identity, secret, build, and visual checks.

## 7. Prioritized roadmap

### Priority 0: release blockers

#### 7.1 On-chain expiry precedence

- Replace indexer expiry as the final filtering authority.
- Calculate remaining time from `onchain.expiry`.
- Preserve a configurable expiry safety threshold.
- Recheck status and expiry before Agent analysis.
- Add tests proving that stale indexer expiry cannot admit an expired market.

**Acceptance criteria**

- A market with a future indexer expiry and an expired on-chain value is rejected.
- A market outside the safety window never reaches either Agent.
- Generated records use the authoritative expiry value.

#### 7.2 Settlement-oracle evidence

- Inspect installed SDK types and real market records for `oracleQuestionId`.
- Extend normalized market and history types without breaking existing records.
- Generate an oracle explorer URL only for a valid identifier.
- Add a dedicated settlement evidence control to the report.
- Escape all external identifiers and URLs before HTML output.

**Acceptance criteria**

- Valid oracle IDs create correct clickable links.
- Missing IDs show an explicit unavailable state.
- Agent receipts and settlement evidence are never presented as the same proof.
- Historical data created before this field existed still renders correctly.

#### 7.3 Finalized-market reconciliation

- Query finalized binary markets with the correct venue scope.
- Page through finalized results when supported or required.
- Continue direct reconciliation of known market IDs.
- Treat temporary indexer absence as unknown, not as a lost or failed signal.
- Preserve correct behavior for resolved, voided, and pending states.

**Acceptance criteria**

- A tracked market outside the first finalized page can still be reconciled.
- A voided market is recorded with a `0.5` outcome basis for both sides.
- Outcome index `0` and `1` mappings are covered by tests.
- Repeated checks are idempotent and do not duplicate history entries.

#### 7.4 Public documentation accuracy

- Update obsolete DreamDEX interface statements.
- Link current official developer and Event Contracts pages.
- Confirm that all metrics and security claims match implemented behavior.
- Avoid profitability, guaranteed accuracy, or production-trading claims.

**Acceptance criteria**

- No known outdated protocol claim remains.
- Every important external claim has an authoritative source or is clearly labeled as project behavior.

### Priority 1: judging and trust improvements

#### 7.5 SDK and documentation feedback report

Add `DREAMDEX-SDK-FEEDBACK.md` containing:

- SDK version and environment tested.
- Successful integration areas.
- Friction encountered during discovery and lifecycle tracking.
- Indexer versus on-chain consistency observations.
- Finalized-market discovery behavior.
- Expiry and pool-recycling considerations.
- Oracle and receipt discoverability feedback.
- Specific documentation improvement suggestions.

The report should be concise, factual, constructive, and useful to the DreamDEX team.

#### 7.6 Demo package

Add:

- `DEMO_SCRIPT.md`
- `DEMO_SHOTLIST.md`

The final video should take two to three minutes and demonstrate:

1. Live report and current data timestamp.
2. DreamDEX market identity and order-book midpoint.
3. Independent Agent probability.
4. Edge and confidence classification.
5. Agent receipt verification.
6. Resolved history and Brier score.
7. DreamDEX settlement-oracle evidence.
8. Read-only security boundary.

**Acceptance criteria**

- Spoken script fits within three minutes at a natural pace.
- Every statement shown in the video is supported by the live app or repository.
- No fixture is presented as a live transaction or live market result.

#### 7.7 Evidence clarity in the UI

- Add plain-language descriptions for each evidence type.
- Make pending, resolved, voided, unavailable, and failed states visually distinct.
- Ensure confidence and edge are not communicated by color alone.
- Handle long questions, symbols, hashes, and links without layout overflow.
- Preserve keyboard focus visibility and adequate contrast.

### Priority 2: product growth

#### 7.8 Build a meaningful track record

- Run the report on a consistent schedule.
- Accumulate enough resolved markets for useful calibration analysis.
- Report sample size beside every accuracy metric.
- Add calibration buckets when the resolved sample becomes large enough.
- Show results by asset, interval, confidence band, and signal direction.
- Avoid performance claims when the sample is statistically weak.

#### 7.9 Distribution and integration

Evaluate read-only product extensions such as:

- Machine-readable JSON signal feed.
- Shareable market-specific report links.
- Threshold-based alerts.
- Historical CSV or JSON export.
- Embeddable signal cards.
- A documented read-only API for ecosystem integrations.

Each extension should preserve evidence links and include freshness metadata.

#### 7.10 Business and ecosystem impact

Frame EdgeScope for realistic users:

- Traders researching market disagreement.
- Analysts monitoring short-duration Event Contracts.
- Risk teams reviewing Agent-generated signals.
- Builders consuming a verifiable probability feed.
- Researchers evaluating forecasting calibration.
- Protocol teams studying liquidity and market efficiency.

The initial business case should emphasize trusted analytics and integration value. Monetization should be proposed only after the project demonstrates recurring use and a credible resolved-market history.

## 8. Data and evidence contract

Every generated signal should preserve, when available:

| Category | Fields |
|---|---|
| Network | Chain ID, venue ID, network name |
| Market identity | Market ID, symbol, question, asset, interval |
| Lifecycle | On-chain status, on-chain expiry, observation time, observed block |
| Order book | Best bid, best ask, midpoint, depth metadata if used |
| Spot context | Spot value, source, timestamp, receipt |
| Estimate | Agent probability, ensemble probability, confidence, edge, rationale summary |
| Agent provenance | Agent identifier, request transaction, receipt transaction, verification state |
| Settlement provenance | Oracle question ID, oracle explorer URL, final on-chain outcome |
| Evaluation | Prediction value, outcome value, Brier score, scoring timestamp |

Rules:

- Missing values remain `null` or unknown.
- Zero is used only when the observed value is actually zero.
- External strings are treated as untrusted input.
- Generated HTML escapes market questions, symbols, hashes, diagnostics, and URLs.
- Historical schema changes remain backward compatible where practical.
- A signal is never presented as independently verifiable unless its required evidence is available.

## 9. Security and privacy requirements

The public repository and generated artifacts must contain no:

- Private keys, API keys, access tokens, or wallet secrets.
- Local usernames or private filesystem paths.
- Personal email addresses or identity metadata.
- Geographic or national identity references unrelated to the product.
- Non-English private planning notes.
- Private reference documents or copied internal instructions.
- Fabricated transaction hashes, oracle IDs, receipts, or market outcomes.

The release process must scan tracked files and generated artifacts case-insensitively. Git history should not be rewritten without explicit authorization.

## 10. Validation plan

### 10.1 Automated checks

- Run the complete existing test suite.
- Run TypeScript type checking.
- Add focused tests for all new lifecycle and evidence logic.
- Generate the production report.
- Run the outcome checker where network access is available.
- Validate all internal and external URLs generated by the application.
- Scan source and artifacts for secrets, identity strings, and local paths.

### 10.2 Required new tests

- On-chain expiry takes precedence over indexer expiry.
- Expiry safety filtering blocks near-expiry markets.
- Revalidation blocks a market that changes status before analysis.
- Valid oracle question IDs generate correct URLs.
- Missing or malformed oracle IDs generate no link.
- Outcome `0` maps to YES/UP.
- Outcome `1` maps to NO/DOWN.
- Voided markets use the correct scoring basis.
- Finalized-market pagination does not omit tracked markets.
- Unknown numeric values remain unknown rather than becoming zero.
- Untrusted market and evidence strings are escaped in generated HTML.
- Legacy history records still load and render.

### 10.3 Visual checks

Inspect the generated report at minimum at:

- Desktop width.
- Tablet width.
- `390px` mobile width.

Verify:

- No horizontal overflow.
- Readable long market questions.
- Wrapped or abbreviated hashes with access to the full value.
- Clear keyboard focus states.
- Sufficient contrast.
- Non-color indicators for signal and lifecycle states.
- Understandable empty, loading, unavailable, and failure states.

## 11. Release acceptance checklist

### Engineering

- [ ] `onchain.expiry` controls expiry filtering.
- [ ] Market status and expiry are revalidated before Agent analysis.
- [ ] Venue scoping is preserved everywhere.
- [ ] Persistent records remain keyed by stable market identity.
- [ ] Finalized-market queries handle all required pages or tracked IDs.
- [ ] Resolved and voided outcomes reconcile correctly.
- [ ] Oracle provenance is included when available.
- [ ] Unknown values are never silently converted to zero.
- [ ] External data is escaped before HTML generation.
- [ ] Existing history data remains readable.

### Product and UI

- [ ] Analysis and settlement evidence are clearly separated.
- [ ] Pending, resolved, voided, failed, and unavailable states are clear.
- [ ] Desktop and mobile layouts pass visual review.
- [ ] Public copy matches current DreamDEX behavior.
- [ ] The read-only boundary is clearly communicated.
- [ ] No profitability or guaranteed-accuracy claim is present.

### Submission

- [ ] Live prototype is available.
- [ ] Public source repository is current.
- [ ] Two-to-three-minute demo video is complete.
- [ ] Demo script and shot list are included.
- [ ] SDK and documentation feedback report is included.
- [ ] README provides a short judge path.
- [ ] Important evidence links work without private access.

### Quality and privacy

- [ ] Tests pass.
- [ ] Type checking passes.
- [ ] Production report generation passes.
- [ ] Outcome checking completes or reports a documented network limitation.
- [ ] Secret scan passes.
- [ ] Identity and local-path scan passes.
- [ ] Private planning material is absent from tracked files and artifacts.
- [ ] `git status` contains only intentional release changes.

## 12. Recommended v0.0.0.11 deliverables

- `v0.0.0.11/` implementation and tests.
- `v0.0.0.11/CHANGES.md`.
- Updated `README.md`.
- Updated generated GitHub Pages report.
- Updated report and history JSON artifacts.
- `DREAMDEX-SDK-FEEDBACK.md`.
- `DEMO_SCRIPT.md`.
- `DEMO_SHOTLIST.md`.
- A concise validation record containing test, typecheck, build, live-network, privacy, and visual-review results.

## 13. Definition of done

Version `v0.0.0.11` is complete when:

1. The implementation satisfies every Priority 0 acceptance criterion.
2. All required submission assets are public and accurate.
3. Automated tests, type checking, report generation, and privacy scans pass.
4. Live-network limitations are documented without replacing live production data with fixtures.
5. The public report is visually verified on desktop and mobile.
6. No private planning material or identity information is present in source, documentation, or generated artifacts.
7. A reviewer can trace a signal from market discovery through Agent evidence and, when settled, to DreamDEX settlement evidence and forecast scoring.

At that point, EdgeScope will present a coherent product rather than only a working analysis script: an independent, verifiable intelligence layer with measurable accountability for DreamDEX Event Contracts.
