# Cost calibration

The estimate shown on the site is fitted on real runs of the production flow: the
auditor-skill corpus `7.3.0@6bb2cbf`, single agent (corpus Mode 1, `Task`/`Agent`
disallowed), `--scope program`, Bash limited to read-only inspection, driven by Claude Code
`-p` exactly as `scripts/audit-local.sh` and `scripts/ci-audit.ts` do.

## The runs (2026-09-11/12, list prices, SDK-reported cost)

| Repository | Rust LOC | Turns | Minutes | Output tokens | Cache reads | Cache writes | Actual cost | Estimate shown |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| ISC/isc_bridge | 356 | 85 | 15 | 216,505 | 12,565,913 | 430,910 | $16.01 | $21.9 |
| project-serum/swap | 485 | 81 | 18 | 266,175 | 11,871,520 | 379,627 | $16.39 | $22.0 |
| Meteora/dynamic-fee-sharing | 1,072 | 128 | 21 | 306,064 | 19,946,208 | 491,658 | $22.54 | $22.8 |
| Kamino/kfarms | 4,134 | 125 | 18 | 237,770 | 22,815,592 | 475,024 | $22.10 | $27.3 |
| Kamino/kvault | 8,595 | 147 | 22 | 311,921 | 19,989,206 | 548,568 | $23.28 | $33.7 |
| Kamino/scope | 9,541 | 173 | 22 | 284,881 | 37,725,228 | 623,063 | $32.22 | $35.2 |
| Meteora/dynamic-bonding-curve | 12,906 | 211 | 21 | 266,496 | 35,956,203 | 655,521 | $31.20 | $40.1 |
| Meteora/damm-v2 | 13,344 | 150 | 21 | 298,811 | 28,933,725 | 588,268 | $27.82 | $40.7 |

All eight on `claude-opus-5` ($5 / $25 per MTok, cache read $0.50, cache write $6.25).
Two further runs on `claude-fable-5-1` (OpenEden, Streamflow: $17.85 and $16.59) are not
in the fit; Fable reads far less from the cache, so the profile over-estimates it by
~40%, which is the safe direction.

Rust LOC is `tokei` code lines of the clone at the audited commit. The site sizes
repositories from the GitHub tree API instead (bytes ÷ 42 per line for Rust; measured
32–56 across these clones). Because the cost is nearly flat in LOC, a 25% LOC error moves
the estimate by about 3%.

## What the numbers say

- **Cache reads dominate.** Each turn re-reads the corpus and the code already in
  context. 55–65% of the bill is cache reads, 20–30% output, the rest cache writes.
  Uncached input is negligible (106–216 tokens per run).
- **A large fixed part.** A 356-line program costs $16; a 13,000-line one $28–32. The
  corpus walk (checklists, known vectors, report template) is the floor.
- **Noise is in the small repos.** Cache reads at ~1K LOC range from 12M to 20M
  depending on how many turns the model takes.

## The profile (packages/pricing/src/estimate.ts)

```
output       = 230,000 +  5 × LOC
cache reads  = 14,000,000 + 1,600 × LOC
cache writes = 380,000 + 20 × LOC
uncached in  = 1,000
cost         = Σ tokens × model list price
estimate     = cost × SAFETY_FACTOR (1.4)
spend limit  = ceil(estimate × LIMIT_HEADROOM (1.2))
```

`SAFETY_FACTOR` is the smallest multiplier that puts every run above under its estimate
(Meteora/dynamic-fee-sharing is the tightest). The test suite checks both bounds:
estimate ≥ actual and estimate < 1.5 × actual for all eight.

The spend limit the user is told to set adds 20% on top, so a run that is 20% worse than
our worst observed case still finishes. The CLI also gets `--max-budget-usd` at the same
figure, so a runaway run stops at the limit instead of at the workspace ceiling.

## Re-fitting

1. Run audits with `pnpm audit:local -- Org/repo` (writes `audit_N/run.json`).
2. `modelUsage` in each `run.json` has the four token counts; `total_cost_usd` the cost.
3. Update `SINGLE_AGENT_PROFILE` and the table above; keep the two test bounds green.

Full-scope runs (`--scope full`) have not been calibrated. The site defaults to program
scope and says so next to the estimate.

## Corpus 7.7.5 (2026-11-16)

The site now runs the corpus's own commands in its strict mode instead of walking
`FULL-AUDIT.md` by hand: Standard is `/auditor:audit . --scope program --strict` and Quick
is `/auditor:quick-scan . --strict`. No run of ours has been measured on 7.7.5 yet; the
figures come from the corpus's `docs/costs.md` (Claude Opus 5.5, Claude Code 2.1.304):

| Depth | 3K-line program | 7K-line program | 12K-line program |
|---|---:|---:|---:|
| Quick (`quick-scan`) | $6.98 · 22.6 min | $7.14 · 11.9 min (draft) | $2.84 · 5.5 min (draft) |
| Standard (`audit --scope program`) | $13.07 · 36 min | $14.70 · 36 min | $18.83 · 56 min |

- **Standard** keeps `SINGLE_AGENT_PROFILE`. Priced at Opus 5.5's rates it gives $15.2,
  $18.1 and $21.7 for those three sizes, above each measured run and within 1.5× of it.
- **Quick** uses `QUICK_PROFILE` (a smaller fixed part: one session over the selected
  subset). It gives $7.4 at 3K lines and $10.2 at 12K on Opus 5.5.
- The test suite checks both depths against these runs.

Re-fit both profiles once we have our own 7.7.5 runs.
