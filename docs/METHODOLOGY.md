# Methodology

## Market probability

EdgeScope reads the best bid and ask from DreamDEX immediately before estimation. A midpoint is used only when both sides exist and the spread is at most `0.08`. Otherwise the market is marked as insufficient liquidity and no mispricing signal is issued.

## Deterministic baseline

For the current asset price move `m`, remaining time `t`, and assumed annual volatility `sigma`:

```text
sigma_window = sigma * sqrt(t / minutes_per_year)
z            = (m / 100) / sigma_window
p_baseline   = Phi(z)
```

The result is clipped to `[0.02, 0.98]`. BTC currently uses 0.55 annual volatility and ETH 0.70. These are disclosed assumptions, not fitted estimates.

## Agent estimate

A Somnia LLM Inference Agent receives the opening price, current price, percentage move, and time remaining. EdgeScope validates that the numeric final answer is well formed, in range, and exactly matches the ABI-decoded result before accepting it.

## Signal classification

For each accepted estimate:

```text
baseline_divergence = baseline_probability - dreamdex_probability
llm_divergence      = llm_probability - dreamdex_probability
```

- `strong`: both absolute divergences are at least 0.15 and point in the same direction.
- `weak`: at least one clears 0.15, but the pair does not satisfy the strong condition.
- `none`: neither clears the threshold.

The ensemble probability is the simple average of the deterministic baseline and accepted LLM estimate. This is not presented as a calibrated financial model.

## Outcome scoring

After a market resolves, EdgeScope reads the on-chain winning outcome and computes Brier scores for DreamDEX and the ensemble. The report shows both per-observation scoring and equal-weighted per-unique-market scoring so repeated observations of one market do not silently dominate the headline metric.

## Interpretation limits

- CoinGecko is an independent external reference, not DreamDEX's settlement oracle.
- The deterministic and LLM estimates share the same underlying observed price move and are not fully independent evidence.
- Simulated edge statistics are hypothetical flat-stake calculations over the small resolved sample and are not a profitability claim.
