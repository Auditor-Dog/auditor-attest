# Auditor Attest

**Open-source security audits for Solana programs, run on your own model key, recorded on-chain. No fees.**

Paste a public GitHub link, get a cost estimate, paste a throwaway Anthropic API key, and
an AI auditor runs the open-source [auditor-skill](https://github.com/solanabr/auditor-skill)
corpus (20 checklists, 1,413 items, 136 known attack vectors) against the code. The report
is committed to this repository byte-for-byte and its hash, commit, corpus version, model
and severity counts are written to an account on Solana devnet that anyone can verify.

We charge nothing and hold no keys. The only cost is your own model usage, billed by
Anthropic to your account, and we tell you the ceiling before you start.

A rigorous first pass, not a substitute for a human audit, and never a "safe to deploy"
stamp.

## Three ways to use it

| | How | What you need |
|---|---|---|
| **1. The site** | paste a link, create a key with a spend limit, wait 15–25 min | an Anthropic account |
| **2. Inside Claude Code** | load the corpus as a plugin in your own repo and run `/auditor:audit` | Claude Code |
| **3. Clone this repo** | `pnpm dev` brings up the whole thing locally; `pnpm audit:local` runs an audit with your own login | node, pnpm, Docker |

### 2. Inside Claude Code

```bash
git clone https://github.com/solanabr/auditor-skill
cd your-solana-repo
claude --plugin-dir ../auditor-skill
> /auditor:audit --scope program
```

The corpus is a Claude Code plugin; nothing of ours is involved. This repository pins it
as a submodule at `vendor/auditor-skill` (`7.3.0@6bb2cbf`) and never edits it.

### 3. Clone and run locally

```bash
git clone --recurse-submodules https://github.com/Auditor-Dog/auditor-attest
cd auditor-attest
pnpm dev                       # → http://localhost:3000 (installs, Postgres, migrations, worker, web)
pnpm audit:local -- Org/repo   # audit a clone under "examples i runned local/" with your Claude Code login
```

`pnpm dev` does everything: dependencies, corpus submodule, `.env` with generated secrets,
Postgres in Docker, Prisma, shared packages, sandbox images, then the worker and the web
app. Every step is a no-op when nothing changed. Requirements: Linux (WSL2 is fine), node
≥ 20, pnpm 10, git, `tokei`, Docker with the compose plugin.

## How the site runs an audit

```
browser ─ paste link ─▶ Vercel (apps/web)
                          │ sizes the repo via the GitHub tree API, estimates the cost per model
                          │ checks your key with one free call, encrypts it (AES-256-GCM), queues the job
                          └─ workflow_dispatch ─▶ GitHub Actions (.github/workflows/audit.yml)
                                                   │ scripts/ci-audit.ts on a disposable machine:
                                                   │ claims the job, wipes the stored key, clones the commit
                                                   │ runs the corpus with Claude Code, single agent, read-only tools
                                                   │ parses the report, attests on devnet, writes the database
                                                   └─ commits reports/<owner>/<repo>/<sha>/… back here
```

- **Estimate.** Fitted on our own runs: a large fixed part (the corpus walk) plus a gentle
  slope per line, times a 1.4 safety factor. Every calibration run lands under it. See
  [docs/calibration.md](docs/calibration.md).
- **Your key.** Spend limits in the Anthropic Console are per workspace, so the site walks
  you through: new workspace → monthly limit = estimate + 20% → one key in it → paste →
  delete the key when the report is ready. The key is encrypted at rest, decrypted in
  memory by the runner, wiped from the database before the model starts, never logged.
- **The runner.** A fresh GitHub Actions VM. The audited repository is never built or
  executed; Bash is limited to read-only inspection; `Task`/`Agent`/web tools are
  disallowed. The corpus's own prompt treats the repository as untrusted input.
- **Attestation.** `programs/audit_attest` on Solana devnet, program id
  `sXtvdoheTtFBukx8vCppJHhiiJHW2xa3xc5KaPAhzkC`. One account per (repository, commit),
  address derived from `sha256(lowercased url)` and the commit bytes, written only by the
  attester key. You need no wallet and no SOL.
- **Disclosure.** Public reports list under Audits; Critical/High details are redacted for
  90 days unless a maintainer asks for earlier disclosure (open an issue here). Private
  reports are reachable only with the token in the link. Counts are always visible.
  Enforced in `packages/report/src/visibility.ts`.

Deployment (Vercel + Neon + GitHub Actions, all free tiers, no server):
[docs/deploy.md](docs/deploy.md).

## Layout

```
apps/web                Next.js site (App Router, server components, Tailwind)
apps/worker             local job runner (Docker sandbox) used by pnpm dev; the site uses Actions instead
programs/audit_attest   Anchor program (attest / reattest / set_visibility)
packages/db             Prisma schema + client
packages/pricing        estimate engine (calibrated single-agent profile, config/models.json)
packages/report         report parser → counts/findings, redaction, disclosure rules
packages/attest         client for the program + arg encoding
sandbox/                container image, in-container runner and egress proxy (local worker only)
vendor/auditor-skill    git submodule, pinned, read-only
reports/                every report the site shows, committed (see reports/README.md)
config/models.json      model ids + prices (hand-maintained)
scripts/                ci-audit.ts (Actions runner), audit-local.sh, ingest, unpublish, freshness…
.github/workflows       audit.yml
docs/                   deploy, calibration, design review, phase notes (history), roadmap
```

## Operator commands

```bash
pnpm audit:local -- Kamino/klend [--scope program|full] [--model opus] [--ingest]   # one local audit
pnpm audit:all                                   # every clone not yet audited with the current corpus
pnpm ingest:examples -- [--attest] [--dry-run]   # publish the hand-run audits (local DB, or DATABASE_URL=<neon>)
pnpm unpublish owner/repo --reason "…"           # take a repository off the site (on-chain stays)
pnpm check:freshness                             # archived? last push? how far behind HEAD is what we audited?
pnpm db:deploy:prod                              # apply migrations to PROD_DATABASE_URL
pnpm check:secrets                               # the pre-commit scan, on the whole tree
```

`pnpm hooks:install` enables the pre-commit hook (secret scan + submodule guard).

## Security notes

- Secrets never enter git: `.env` is ignored, keypairs live outside the repo, the
  pre-commit hook scans staged content, every runner log line is scrubbed of key shapes.
- The audited repository is untrusted input for the model too. The prompt says so and the
  tool allowlist makes it structurally true: nothing from it is executed.
- The site runs on devnet. The program and the client are cluster-agnostic; a mainnet
  deployment is a config change plus a funded deploy wallet.
- `docs/phase-*.md` describe the original build (USDC payments, Docker worker, GitHub
  OAuth) and are kept as history; the pivot to BYOK + GitHub Actions is dated 2026-10-09.
