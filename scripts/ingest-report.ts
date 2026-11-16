#!/usr/bin/env tsx
/**
 * Ingest a report produced outside the platform (e.g. run by hand on a big protocol)
 * into the storage contract + database, optionally attesting it on-chain.
 *
 *   pnpm ingest <report.md> --repo <url> --commit <sha> --model <id> [--attest]
 *        [--visibility public|private] [--verified] [--corpus 7.7.5@8ecccb4]
 *        [--input-tokens N --output-tokens N --cache-read N --cache-write N --cost-usd X]
 *        [--run-json run.json]  (usage is read from it when given)
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { parseGitHubUrl, isFullSha } from "@auditor/report";
import { loadModels, getModel, findRepoRoot } from "@auditor/pricing";
import { prisma } from "@auditor/db";
import { loadEnv } from "../apps/worker/src/env.js";
import { ingestReport, usageFromRunJson, type RunUsage } from "../apps/worker/src/ingest.js";

loadDotenv({ path: resolve(findRepoRoot(process.cwd()), ".env"), quiet: true });

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const file = process.argv[2];
  if (!file || file.startsWith("--")) throw new Error("usage: ingest-report.ts <report.md> --repo <url> --commit <sha> --model <id> [--attest]");
  const gh = parseGitHubUrl(arg("repo") ?? "");
  if (!gh) throw new Error("--repo must be a GitHub url");
  const commit = (arg("commit") ?? "").toLowerCase();
  if (!isFullSha(commit)) throw new Error("--commit must be the full 40-char sha");
  const model = arg("model") ?? "";
  getModel(model, loadModels()); // throws for unknown ids
  const visibility = (arg("visibility") ?? "private") as "public" | "private";
  if (!["public", "private"].includes(visibility)) throw new Error("--visibility must be public|private");

  const env = loadEnv();
  const corpusVersion = arg("corpus") ?? env.corpusVersion;
  const reportMd = readFileSync(resolve(file));
  let usage: RunUsage;
  let runJson: unknown;
  const runPath = arg("run-json");
  if (runPath && existsSync(runPath)) {
    runJson = JSON.parse(readFileSync(runPath, "utf8"));
    usage = usageFromRunJson(runJson, model);
  } else {
    const n = (k: string) => Number(arg(k) ?? 0);
    usage = { input_tokens: n("input-tokens"), output_tokens: n("output-tokens"), cache_read_tokens: n("cache-read"), cache_write_tokens: n("cache-write"), cost_usd: n("cost-usd") };
  }

  const out = await ingestReport(env, {
    reportMd,
    repoUrl: gh.url,
    owner: gh.owner,
    repo: gh.repo,
    commit,
    model,
    corpusVersion,
    visibility,
    submitterVerified: flag("verified"),
    jobId: null,
    tier: "manual",
    startedAt: null,
    finishedAt: new Date(),
    usage,
    runJson,
    attest: flag("attest"),
  });
  console.log(JSON.stringify({ reportId: out.reportId, storagePath: out.storagePath, counts: out.parsed.counts, highest: out.parsed.highestSeverity, format: out.parsed.format, warnings: out.parsed.warnings, attested: out.attested, attestation: out.meta.attestation }, null, 2));
  const row = await prisma.report.findUnique({ where: { id: out.reportId } });
  console.log(`page: /r/${gh.owner}/${gh.repo}/${commit}${row?.visibility === "private" ? `?t=${row.accessToken}` : ""}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await prisma.$disconnect();
    process.exit(1);
  });
