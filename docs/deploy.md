# Deploying the site (no server)

Three free services, one public repository.

```
                    paste link + key            workflow_dispatch
  browser  ───────▶  Vercel (apps/web)  ───────▶  GitHub Actions (.github/workflows/audit.yml)
                        │   ▲                              │
                        ▼   │ reads index + status         │ runs scripts/ci-audit.ts
                       Neon Postgres  ◀────────────────────┤ writes Report/Attestation/JobEvent
                                                           ├─ attests on Solana devnet
                                                           └─ commits reports/<…> to this repo
  report page reads reports/<…>/report.md from disk, else raw.githubusercontent.com
```

## 1. GitHub repository (public)

1. Create the repo (public), push this tree with the submodule.
2. **Settings → Secrets and variables → Actions → Secrets**
   - `DATABASE_URL` — the Neon connection string
   - `BYOK_KEK` — `openssl rand -hex 32` (same value as on Vercel)
   - `ATTESTER_KEYPAIR_JSON` — the content of the attester keypair file (the JSON array)
3. **Variables** (same page, Variables tab)
   - `SITE_URL` — `https://<your-vercel-domain>`
   - `AUDIT_ATTEST_PROGRAM_ID` — optional, defaults to the devnet deployment
   - `RPC_URL` — optional, defaults to `https://api.devnet.solana.com`
4. **Settings → Actions → General**: "Allow all actions", and under Workflow permissions
   "Read and write permissions" (the runner pushes reports).
5. A fine-grained personal access token for the web tier: Settings → Developer settings →
   Personal access tokens → Fine-grained → only this repository → **Actions: Read and
   write**, **Contents: Read and write**. This is `GITHUB_DISPATCH_TOKEN` on Vercel.

## 2. Neon (Postgres)

1. New project, copy the connection string (`postgresql://…`).
2. Apply the schema from your laptop:
   ```bash
   PROD_DATABASE_URL='postgresql://…' pnpm db:deploy:prod
   ```
3. Load the example reports (optional, ~1 minute, 39 devnet transactions):
   ```bash
   DATABASE_URL="$PROD_DATABASE_URL" pnpm ingest:examples -- --attest
   ```

## 3. Vercel

1. Import the repository. **Root Directory**: `apps/web`. Framework: Next.js.
2. **Build Command** (override): `cd ../.. && pnpm run build:web`
3. Environment variables:

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | Neon connection string |
   | `BYOK_KEK` | same as the Actions secret |
   | `GITHUB_DISPATCH_TOKEN` | the fine-grained PAT |
   | `SITE_REPO` | `owner/repo` of this repository |
   | `SITE_BRANCH` | `main` |
   | `NEXT_PUBLIC_SITE_URL` | `https://<your-vercel-domain>` |
   | `CLUSTER` | `devnet` |
   | `AUDIT_ATTEST_PROGRAM_ID` | `sXtvdoheTtFBukx8vCppJHhiiJHW2xa3xc5KaPAhzkC` |
   | `CORPUS_VERSION` | `7.7.5@8ecccb4` |

4. Deploy. Every push to `main` (including the runner's report commits) redeploys.

## 4. Solana devnet

Already done for the reference deployment; to run your own:

```bash
solana airdrop 2 <deploy wallet> --url devnet                      # repeat as needed (~2 SOL for the program)
solana program deploy target/deploy/audit_attest.so \
  --program-id target/deploy/audit_attest-keypair.json --url devnet --keypair <deploy wallet>
pnpm exec tsx scripts/attest-init.ts init --authority <deploy wallet>   # sets the attester
solana transfer <attester pubkey> 1 --allow-unfunded-recipient --url devnet --keypair <deploy wallet>
```

Each attestation costs ~0.0023 SOL of rent plus fees; 1 SOL covers hundreds.

## Smoke test after deploying

1. Open the site, paste a small public Solana repo, check the estimate appears.
2. Paste a throwaway key with a spend limit, start. The job page should show
   "queued on GitHub Actions" and the Actions tab a running `audit` workflow.
3. 15–25 minutes later: the job page says done, the report page renders, the attestation
   links to explorer.solana.com with `?cluster=devnet`, and `reports/` has a new commit.
4. Delete the key.

## What runs where

| Concern | Where | Secret needed |
|---|---|---|
| Sizing a repository | Vercel function (GitHub tree API) | `GITHUB_DISPATCH_TOKEN` (read) |
| Validating the user's key | Vercel function (`GET /v1/models`) | the user's key, in memory |
| Holding the key until the run starts | Neon, AES-256-GCM | `BYOK_KEK` |
| The audit itself | GitHub Actions runner | the user's key, in the CLI's env only |
| Attestation | GitHub Actions runner | `ATTESTER_KEYPAIR_JSON` (a separate step env) |
| Report storage | git (`reports/`) | the workflow's `GITHUB_TOKEN` |
| Report rendering | Vercel (disk, else raw.githubusercontent.com) | none |

The user's key is never in a workflow input, never in a log (every line goes through
`scrub()`), and the stored ciphertext is wiped the moment the runner claims the job.
