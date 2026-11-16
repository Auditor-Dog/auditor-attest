/**
 * Ingest a report into the storage contract + database (+ on-chain attestation when
 * the program is deployed). Shared by the worker (after a sandbox run) and by
 * scripts/ingest-report.ts (manual reports).
 */
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prisma, type Prisma } from "@auditor/db";
import { costOf, getModel, loadModels } from "@auditor/pricing";
import {
  effectiveVisibility,
  parseReport,
  redactUntilFor,
  sha256Hex,
  storagePathFor,
  type ParsedReport,
  type ReportMeta,
  type RequestedVisibility,
} from "@auditor/report";
import type { WorkerEnv } from "./env.js";
import { log } from "./log.js";

export interface RunUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  /** Our cost at config/models.json rates. */
  cost_usd: number;
  /** The SDK's own estimate, when available. */
  sdk_cost_usd?: number | null;
}

export interface IngestInput {
  reportMd: Buffer;
  repoUrl: string;
  owner: string;
  repo: string;
  commit: string;
  model: string;
  corpusVersion: string;
  visibility: RequestedVisibility;
  submitterVerified: boolean;
  jobId?: string | null;
  tier: "quick" | "standard" | "byok" | "manual";
  /** Corpus depth that produced the report. Default standard. */
  depth?: "quick" | "standard";
  startedAt?: Date | null;
  finishedAt?: Date | null;
  usage: RunUsage;
  /** run.json from the sandbox, stored next to the report. */
  runJson?: unknown;
  /** Directory of intermediate artifacts to copy alongside (worksheets, intake...). */
  artifactsDir?: string | null;
  attest: boolean;
}

export interface IngestOutput {
  reportId: string;
  storagePath: string;
  absDir: string;
  meta: ReportMeta;
  parsed: ParsedReport;
  attested: boolean;
}

/** Sum the SDK's per-model usage map into one usage record priced at our rates. */
export function usageFromRunJson(run: unknown, fallbackModel: string): RunUsage {
  // Accepts the sandbox runner's run.json (model_usage) and the CLI's --output-format json (modelUsage).
  const r = (run ?? {}) as { model_usage?: Record<string, Record<string, number>>; modelUsage?: Record<string, Record<string, number>>; total_cost_usd?: number | null };
  const cfg = loadModels();
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
  for (const [modelKey, u] of Object.entries(r.model_usage ?? r.modelUsage ?? {})) {
    const i = u.inputTokens ?? u.input_tokens ?? 0;
    const o = u.outputTokens ?? u.output_tokens ?? 0;
    const cr = u.cacheReadInputTokens ?? u.cache_read_input_tokens ?? 0;
    const cw = u.cacheCreationInputTokens ?? u.cache_creation_input_tokens ?? 0;
    input += i;
    output += o;
    cacheRead += cr;
    cacheWrite += cw;
    let m;
    try {
      m = getModel(modelKey, cfg);
    } catch {
      m = getModel(fallbackModel, cfg);
    }
    cost += costOf({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw }, m);
  }
  return { input_tokens: input, output_tokens: output, cache_read_tokens: cacheRead, cache_write_tokens: cacheWrite, cost_usd: Number(cost.toFixed(6)), sdk_cost_usd: r.total_cost_usd ?? null };
}

export async function ingestReport(env: WorkerEnv, input: IngestInput): Promise<IngestOutput> {
  const parsed = parseReport(input.reportMd.toString("utf8"));
  const reportSha256 = sha256Hex(input.reportMd);
  const depth = input.depth ?? "standard";
  // Standard keeps the historical path; a Quick report of the same commit/corpus/model sits beside it.
  const storagePath = storagePathFor(input.owner, input.repo, input.commit, input.corpusVersion, input.model) + (depth === "quick" ? "__quick" : "");
  const absDir = join(env.reportsDir, storagePath);
  mkdirSync(absDir, { recursive: true });

  // 1. report.md byte-for-byte
  writeFileSync(join(absDir, "report.md"), input.reportMd);
  if (input.runJson !== undefined) writeFileSync(join(absDir, "run.json"), JSON.stringify(input.runJson, null, 2));
  if (input.artifactsDir && existsSync(input.artifactsDir)) {
    try {
      cpSync(input.artifactsDir, join(absDir, "artifacts"), { recursive: true });
    } catch (e) {
      log("warn", `artifacts copy failed: ${(e as Error).message}`);
    }
  }

  // 2. database row (unique per owner/repo/commit; re-ingest replaces)
  const createdAt = new Date();
  const redactUntil = input.visibility === "public" && !input.submitterVerified ? redactUntilFor(createdAt) : null;
  const data: Prisma.ReportUncheckedCreateInput = {
    jobId: input.jobId ?? null,
    owner: input.owner,
    repo: input.repo,
    commit: input.commit,
    corpusVersion: input.corpusVersion,
    model: input.model,
    depth,
    reportSha256,
    storagePath,
    critical: parsed.counts.critical,
    high: parsed.counts.high,
    medium: parsed.counts.medium,
    low: parsed.counts.low,
    info: parsed.counts.info,
    highestSeverity: parsed.highestSeverity,
    riskScore: parsed.riskScore,
    visibility: input.visibility,
    submitterVerified: input.submitterVerified,
    redactUntil,
    startedAt: input.startedAt ?? null,
    finishedAt: input.finishedAt ?? null,
    inputTokens: BigInt(input.usage.input_tokens),
    outputTokens: BigInt(input.usage.output_tokens),
    cacheReadTokens: BigInt(input.usage.cache_read_tokens),
    cacheWriteTokens: BigInt(input.usage.cache_write_tokens),
    costUsd: input.usage.cost_usd,
  };
  const existing = await prisma.report.findUnique({
    where: { owner_repo_commit_corpusVersion_model_depth: { owner: input.owner, repo: input.repo, commit: input.commit, corpusVersion: input.corpusVersion, model: input.model, depth } },
  });
  const row = existing
    ? await prisma.report.update({ where: { id: existing.id }, data: { ...data, maintainerAckAt: existing.maintainerAckAt, redactUntil: existing.redactUntil ?? redactUntil } })
    : await prisma.report.create({ data });

  const visibility = effectiveVisibility({ visibility: row.visibility, submitterVerified: row.submitterVerified, redactUntil: row.redactUntil, maintainerAckAt: row.maintainerAckAt });

  // 3. meta.json
  const meta: ReportMeta = {
    repo: input.repoUrl,
    owner: input.owner,
    name: input.repo,
    commit: input.commit,
    corpus_version: input.corpusVersion,
    model: input.model,
    started_at: input.startedAt?.toISOString() ?? null,
    finished_at: input.finishedAt?.toISOString() ?? null,
    report_sha256: reportSha256,
    counts: parsed.counts,
    highest_severity: parsed.highestSeverity,
    visibility,
    submitter_verified: input.submitterVerified,
    attestation: null,
    usage: {
      input_tokens: input.usage.input_tokens,
      output_tokens: input.usage.output_tokens,
      cache_read_tokens: input.usage.cache_read_tokens,
      cache_write_tokens: input.usage.cache_write_tokens,
      cost_usd: input.usage.cost_usd,
    },
    parser: { format: parsed.format, declared_counts: parsed.declaredCounts, risk_score: parsed.riskScore, warnings: parsed.warnings },
    job_id: input.jobId ?? null,
    tier: input.tier,
    depth,
  };
  writeFileSync(join(absDir, "meta.json"), JSON.stringify(meta, null, 2));

  // 4. attestation (Phase 2). Only hashes + counts ever leave this process.
  let attested = false;
  if (input.attest) {
    if (!env.attestProgramId || !env.attesterKeypairPath || !env.rpcUrl) {
      log("warn", `attestation skipped for ${storagePath}: AUDIT_ATTEST_PROGRAM_ID / ATTESTER_KEYPAIR_PATH / RPC_URL not set`);
    } else {
      const { attestOnChain } = await import("./attest.js");
      const res = await attestOnChain(env, {
        repoUrl: input.repoUrl,
        commitSha: input.commit,
        corpusVersion: input.corpusVersion,
        modelId: input.model,
        reportSha256,
        counts: parsed.counts,
        visibility: visibility === "private" ? 0 : visibility === "public" ? 1 : 2,
      });
      const onChainVisibility = visibility === "private" ? 0 : visibility === "public" ? 1 : 2;
      // The on-chain account is per (repo, commit) and now holds THIS report's hash
      // (reattest), so the attestation row moves to this report even if a sibling
      // report of the same commit owned it before.
      const attData = { reportId: row.id, pda: res.pda, txSig: res.txSig, attester: res.attester, slot: res.slot !== null ? BigInt(res.slot) : null, programId: res.programId, onChainVisibility };
      await prisma.$transaction([
        prisma.attestation.deleteMany({ where: { OR: [{ pda: res.pda }, { reportId: row.id }] } }),
        prisma.attestation.create({ data: attData }),
      ]);
      meta.attestation = { tx: res.txSig, pda: res.pda, program_id: res.programId };
      writeFileSync(join(absDir, "meta.json"), JSON.stringify(meta, null, 2));
      attested = true;
    }
  }

  if (parsed.warnings.length) log("warn", `parser warnings for ${storagePath}: ${parsed.warnings.join("; ")}`);
  return { reportId: row.id, storagePath, absDir, meta, parsed, attested };
}
