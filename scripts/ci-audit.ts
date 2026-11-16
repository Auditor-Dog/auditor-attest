#!/usr/bin/env tsx
/**
 * The audit runner for the site, executed by .github/workflows/audit.yml on a disposable
 * GitHub Actions machine. One job per run:
 *
 *   1. claim the job (queued → running) and wipe the stored key ciphertext at once
 *   2. decrypt the user's Anthropic key in memory; it goes only into the CLI's environment
 *   3. shallow-clone the audited commit (hooks off, no submodules, nothing executed)
 *   4. run the corpus command (Standard: /auditor:audit, Quick: /auditor:quick-scan) in the
 *      corpus's strict mode: no repository or machine settings, no MCP, nothing built
 *   5. parse + store the report under reports/, attest on-chain, update the database
 *   6. commit reports/<...> back to this repository
 *
 * Environment (secrets come from the workflow): JOB_ID, DATABASE_URL, BYOK_KEK,
 * ATTESTER_KEYPAIR_JSON, AUDIT_ATTEST_PROGRAM_ID, RPC_URL, CLUSTER, SITE_URL, RUN_URL.
 * Every log line and job event passes through scrub(), so a key can never leak into
 * the public Actions log or the database.
 */
import { spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config as loadDotenv } from "dotenv";
import { prisma } from "@auditor/db";
import { budgetFor, findRepoRoot } from "@auditor/pricing";

const execFileP = promisify(execFile);
const ROOT = findRepoRoot(process.cwd());
loadDotenv({ path: resolve(ROOT, ".env"), quiet: true });

const CORPUS_SHA = "8ecccb4a4013d296c1798ba279c1af605f47d317";

function scrub(s: string): string {
  return s.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "sk-ant-***");
}

async function main() {
  const jobId = process.env.JOB_ID;
  if (!jobId) throw new Error("JOB_ID is required");
  const runUrl = process.env.RUN_URL ?? null;
  const siteUrl = process.env.SITE_URL ?? "https://auditor-attest.vercel.app";

  // Attester key: the secret holds the JSON array; the attest client reads a file path.
  let attesterPath: string | null = null;
  if (process.env.ATTESTER_KEYPAIR_JSON) {
    attesterPath = join(tmpdir(), `attester-${process.pid}.json`);
    writeFileSync(attesterPath, process.env.ATTESTER_KEYPAIR_JSON, { mode: 0o600 });
    process.env.ATTESTER_KEYPAIR_PATH = attesterPath;
  }
  process.env.CLUSTER ??= "devnet";
  process.env.REPORTS_DIR ??= "reports";
  process.env.CORPUS_DIR ??= "vendor/auditor-skill";

  const { loadEnv } = await import("../apps/worker/src/env.js");
  const { decryptSecret } = await import("../apps/worker/src/byok.js");
  const { shallowClone } = await import("../apps/worker/src/git.js");
  const { ingestReport, usageFromRunJson } = await import("../apps/worker/src/ingest.js");
  const { jobEvent } = await import("../apps/worker/src/log.js");
  const env = loadEnv();

  const corpus = env.corpusDir;
  const corpusHead = (await execFileP("git", ["-C", corpus, "rev-parse", "HEAD"])).stdout.trim();
  if (corpusHead !== CORPUS_SHA) throw new Error(`corpus submodule is at ${corpusHead}, expected ${CORPUS_SHA}`);

  // 1. claim
  const claimed = await prisma.job.updateMany({ where: { id: jobId, status: "queued" }, data: { status: "running", startedAt: new Date(), containerId: runUrl } });
  if (claimed.count !== 1) {
    const j = await prisma.job.findUnique({ where: { id: jobId } });
    throw new Error(`job ${jobId} is ${j?.status ?? "missing"}, not queued; nothing to do`);
  }
  const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId }, include: { quote: true } });
  const ciphertext = job.byokCiphertext;
  await prisma.job.update({ where: { id: jobId }, data: { byokCiphertext: null } });
  await jobEvent(jobId, `runner started on GitHub Actions${runUrl ? ` (${runUrl})` : ""}`);

  const startedAt = new Date();
  const workDir = join(tmpdir(), `auditor-${jobId}`);
  const repoDir = join(workDir, "repo");
  let apiKey = "";
  try {
    if (!job.commitSha) throw new Error("job has no commit");
    if (!job.quote) throw new Error("job has no quote");
    if (job.tier !== "byok") throw new Error(`tier ${job.tier} is not supported by this runner`);
    if (!ciphertext) throw new Error("the job has no API key (already consumed?)");
    if (!env.byokKek) throw new Error("BYOK_KEK not configured");
    apiKey = decryptSecret(ciphertext, env.byokKek);

    const scope = job.scope === "program" ? "program" : "full";
    let budget = job.budgetUsd ? Number(job.budgetUsd) : budgetFor({ estCostUsd: Number(job.quote.estCostUsd) });
    // Operator cap (repository variable MAX_BUDGET_USD): used for smoke tests of the pipeline.
    const cap = Number(process.env.MAX_BUDGET_USD || "");
    if (Number.isFinite(cap) && cap > 0 && cap < budget) {
      budget = cap;
      await jobEvent(jobId, `operator cap: spend limited to $${cap} for this run (pipeline test)`, undefined, "warn");
    }

    // 3. clone, then strip the repository's own Claude Code config (corpus docs/ci.md does the same)
    await jobEvent(jobId, "cloning the audited commit", { commit: job.commitSha });
    await shallowClone(job.repoUrl, job.commitSha, repoDir, { maxBytes: 2 * 1024 * 1024 * 1024 });
    const stripped = stripAgentConfig(repoDir);
    if (stripped.length) await jobEvent(jobId, `removed the repository's own agent config before the run: ${stripped.slice(0, 10).join(", ")}${stripped.length > 10 ? ` and ${stripped.length - 10} more` : ""}`);

    // 4. run the corpus command in strict mode (corpus docs/permissions-and-isolation.md,
    //    "Non-interactive runs"): no settings file of the repository or of the machine,
    //    no MCP server, the corpus's strict template with builds switched off entirely.
    const depth = job.depth === "quick" ? "quick" : "standard";
    const command = depth === "quick" ? "/auditor:quick-scan . --strict" : `/auditor:audit . --scope ${scope} --strict`;
    const settingsPath = join(workDir, "strict-settings.json");
    const template = JSON.parse(readFileSync(join(corpus, "templates", "strict-settings.json"), "utf8")) as { env?: Record<string, string> };
    template.env = { ...(template.env ?? {}), AUDITOR_STRICT: "1", AUDITOR_EXEC_MODE: "none" };
    writeFileSync(settingsPath, JSON.stringify(template, null, 2));
    const args = [
      "-p", command,
      "--model", job.model,
      "--setting-sources", "",
      "--strict-mcp-config",
      "--plugin-dir", corpus,
      "--settings", settingsPath,
      "--no-session-persistence",
      "--max-budget-usd", String(budget),
      "--output-format", "json",
    ];
    if (process.env.SANDBOX_EFFORT) args.push("--effort", process.env.SANDBOX_EFFORT);

    const cliEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (/^(CLAUDE|ANTHROPIC_|AUDITOR_|DATABASE_URL|BYOK_KEK|ATTESTER_|GITHUB_TOKEN|GH_TOKEN|RPC_URL|PROD_)/.test(k)) continue;
      cliEnv[k] = v;
    }
    cliEnv.ANTHROPIC_API_KEY = apiKey;
    cliEnv.AUDITOR_STRICT = "1";
    cliEnv.AUDITOR_EXEC_MODE = "none";
    cliEnv.GIT_TERMINAL_PROMPT = "0";

    await jobEvent(jobId, "audit started", { depth, command, model: job.model, budgetUsd: budget, corpus: env.corpusVersion });
    const maxMinutes = Number(process.env.MAX_JOB_MINUTES ?? 120);
    const runPath = join(workDir, "run.json");
    const errPath = join(workDir, "stderr.log");
    const exit = await new Promise<{ code: number | null; signal: string | null; killed: boolean }>((res, rej) => {
      const child = spawn("claude", args, { cwd: repoDir, env: cliEnv, stdio: ["ignore", "pipe", "pipe"] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on("data", (d: Buffer) => out.push(d));
      child.stderr.on("data", (d: Buffer) => err.push(d));
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 30_000).unref();
      }, maxMinutes * 60_000);
      const ticker = setInterval(() => {
        const min = Math.round((Date.now() - startedAt.getTime()) / 60_000);
        void jobEvent(jobId, `still auditing… ${min} min elapsed`);
      }, 5 * 60_000);
      child.on("error", (e) => {
        clearTimeout(timer);
        clearInterval(ticker);
        rej(e);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        clearInterval(ticker);
        writeFileSync(runPath, Buffer.concat(out));
        writeFileSync(errPath, scrub(Buffer.concat(err).toString("utf8")));
        res({ code, signal, killed });
      });
    });
    apiKey = "";
    for (const k of Object.keys(cliEnv)) delete cliEnv[k];
    await jobEvent(jobId, "audit process exited", { code: exit.code, signal: exit.signal, killed: exit.killed });

    // The command makes its own run directory (audit_<n>) with the corpus's rundir.sh.
    const reportName = depth === "quick" ? "QUICK-SCAN.md" : "REPORT.md";
    const runDirs = readdirSync(repoDir).filter((d) => /^audit_\d+$/.test(d)).sort((a, b) => Number(b.slice(6)) - Number(a.slice(6)));
    const reportPath = runDirs.map((d) => join(repoDir, d, reportName)).find((f) => existsSync(f)) ?? join(repoDir, "audit_1", reportName);
    let runJson: Record<string, unknown> | null = null;
    try {
      runJson = JSON.parse(readFileSync(runPath, "utf8")) as Record<string, unknown>;
    } catch {
      runJson = null;
    }
    // The model that did the work = the modelUsage entry with the most output tokens.
    const mu = (runJson?.modelUsage ?? {}) as Record<string, { outputTokens?: number }>;
    const modelUsed = Object.entries(mu).sort((a, b) => (b[1].outputTokens ?? 0) - (a[1].outputTokens ?? 0))[0]?.[0]?.replace(/-\d{8}$/, "") ?? job.model;
    const usage = usageFromRunJson(runJson, modelUsed);
    await jobEvent(jobId, "usage", { ...usage, model: modelUsed });

    if (!existsSync(reportPath)) {
      const tail = existsSync(errPath) ? readFileSync(errPath, "utf8").slice(-400) : "";
      const resultText = typeof runJson?.result === "string" ? scrub(String(runJson.result)).slice(0, 300) : "";
      const budgetHit = /budget/i.test(resultText) || /budget/i.test(tail);
      const status = exit.killed ? "failed" : budgetHit ? "failed_budget" : "failed";
      const why = exit.killed ? `stopped after ${maxMinutes} minutes without a report` : budgetHit ? `the spend cap of $${budget} was reached before the report was written` : `no report was produced (exit ${exit.code}). ${resultText || tail}`.trim();
      await prisma.job.update({ where: { id: jobId }, data: { status, finishedAt: new Date(), error: scrub(why).slice(0, 1000) } });
      await jobEvent(jobId, `job ${status}: ${why}`, { cost_usd: usage.cost_usd }, "error");
      return;
    }

    // 5. store + attest + database
    await prisma.job.update({ where: { id: jobId }, data: { status: "ingesting" } });
    const finishedAt = new Date();
    const out = await ingestReport(env, {
      reportMd: readFileSync(reportPath),
      repoUrl: job.repoUrl,
      owner: job.owner,
      repo: job.repo,
      commit: job.commitSha,
      model: modelUsed,
      corpusVersion: env.corpusVersion,
      visibility: job.visibility,
      submitterVerified: job.submitterVerified,
      jobId,
      tier: "byok",
      depth,
      startedAt,
      finishedAt,
      usage,
      runJson: undefined,
      artifactsDir: null,
      attest: true,
    });
    await jobEvent(jobId, out.attested ? "attested on-chain" : "attestation skipped (not configured)", { storagePath: out.storagePath, counts: out.parsed.counts });

    // 6. commit the report to this repository
    const rel = `reports/${out.storagePath}`;
    try {
      await git(["config", "user.name", "auditor-attest runner"]);
      await git(["config", "user.email", "runner@auditor-attest.invalid"]);
      await git(["add", "-f", rel]);
      await git(["commit", "-q", "-m", `audit: ${job.owner}/${job.repo}@${job.commitSha.slice(0, 7)} (${modelUsed}, job ${jobId})`]);
      let pushed = false;
      for (let i = 0; i < 5 && !pushed; i++) {
        try {
          await git(["pull", "-q", "--rebase", "--autostash", "origin", "HEAD"]);
          await git(["push", "-q", "origin", "HEAD"]);
          pushed = true;
        } catch (e) {
          await jobEvent(jobId, `push attempt ${i + 1} failed: ${scrub((e as Error).message).slice(0, 200)}`, undefined, "warn");
          await new Promise((r) => setTimeout(r, 5_000 * (i + 1)));
        }
      }
      if (!pushed) throw new Error("could not push the report after 5 attempts");
      await jobEvent(jobId, "report committed to the public repository", { path: rel });
    } catch (e) {
      // The report is in the database and on-chain; a missing commit is recoverable by the operator.
      await jobEvent(jobId, `report commit failed: ${scrub((e as Error).message).slice(0, 300)}`, undefined, "warn");
    }

    await prisma.job.update({ where: { id: jobId }, data: { status: "done", finishedAt, error: null } });
    const link = `${siteUrl}/r/${job.owner}/${job.repo}/${job.commitSha}${job.visibility === "private" ? "?t=<your token>" : ""}`;
    await jobEvent(jobId, `done: ${out.parsed.counts.critical}C ${out.parsed.counts.high}H ${out.parsed.counts.medium}M ${out.parsed.counts.low}L ${out.parsed.counts.info}I · ${link}`, { cost_usd: usage.cost_usd, attested: out.attested });
  } catch (err) {
    apiKey = "";
    const message = scrub((err as Error).message ?? String(err));
    await prisma.job.update({ where: { id: jobId }, data: { status: "failed", finishedAt: new Date(), error: message.slice(0, 1000), byokCiphertext: null } });
    await jobEvent(jobId, `job failed: ${message}`, undefined, "error");
    process.exitCode = 1;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    if (attesterPath) rmSync(attesterPath, { force: true });
    await prisma.$disconnect();
  }
}

/** Every .claude/, .mcp.json, .claude.json, CLAUDE.md and CLAUDE.local.md in the checkout (corpus docs/ci.md). */
function stripAgentConfig(root: string): string[] {
  const removed: string[] = [];
  const NAMES = new Set([".claude", ".mcp.json", ".claude.json", "CLAUDE.md", "CLAUDE.local.md"]);
  const walk = (rel: string) => {
    let entries: string[];
    try {
      entries = readdirSync(join(root, rel));
    } catch {
      return;
    }
    for (const e of entries) {
      if (e === ".git") continue;
      const r = rel ? `${rel}/${e}` : e;
      const st = lstatSync(join(root, r));
      if (NAMES.has(e)) {
        rmSync(join(root, r), { recursive: true, force: true });
        removed.push(r);
      } else if (st.isDirectory() && !st.isSymbolicLink()) walk(r);
    }
  };
  walk("");
  return removed;
}

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, { cwd: ROOT, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

main().catch((err) => {
  console.error(scrub(err instanceof Error ? err.stack ?? err.message : String(err)));
  process.exit(1);
});
