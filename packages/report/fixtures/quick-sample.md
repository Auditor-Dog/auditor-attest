# Quick scan — `vault` at `ca89527f0e2b4b6c9d1a3e5f7a9b1c3d5e7f9a1b`

## Summary

| | |
|---|---|
| **Verdict** | fail at threshold 7 |
| **Highest severity** | 9 — CRITICAL |
| **Findings** | 1 × 9, 1 × 5, 2 × 3, 1 × 2 |
| **Reviewed** | the whole repository, the sections and rows `audit_1/scope.md` lists |
| **Analyzers** | ran: grep-scanners · not run: semgrep (not installed) |
| **Mode** | preflight: mode: strict (AUDITOR_STRICT=1) |

Withdraw trusts an unchecked owner account. This is a Quick review, not a complete audit.

## Provenance

- **Command:** `/auditor:quick-scan --strict`
- **Pinned:** HEAD `ca89527f0e2b4b6c9d1a3e5f7a9b1c3d5e7f9a1b`, from `git-ro.sh rev-parse`.
- **Run directory:** `audit_1/`

## Findings

#### [F-001] Anyone can withdraw from any vault

| Field | Value |
|---|---|
| **Severity** | 9 — 🔴 CRITICAL |
| **Checklist Item** | 02-004 |
| **File** | programs/vault/src/lib.rs:44 |
| **Status** | Open |

**Description:** `withdraw` takes `owner` as an UncheckedAccount with no signer or has_one check.

#### [F-002] Deposit accepts any account as the vault

| Field | Value |
|---|---|
| **Severity** | 5 — 🟡 MEDIUM |
| **File** | programs/vault/src/lib.rs:72 |
| **Status** | Open |

## Verdicts

- 01-001 [PASS] …

## Coverage & Limitations

- semgrep was not installed.
