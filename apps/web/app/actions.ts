"use server";

import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AUDIT_DEPTHS, AUDIT_SCOPES, budgetFor, type AuditDepth, defaultModelId, enabledModels, envNumber, estimate, loadModels, type AuditScope, type LanguageMix, type RepoMarkers } from "@auditor/pricing";
import { parseGitHubUrl } from "@auditor/report";
import type { Prisma } from "@auditor/db";
import { checkApiKey, modelAvailable } from "@/lib/anthropic";
import { prisma } from "@/lib/db";
import { dispatchAudit } from "@/lib/dispatch";
import { byokKek } from "@/lib/env";
import { quoteFromGitHub } from "@/lib/quote";
import { encryptSecret } from "@/lib/secret";

function fail(msg: string): never {
  throw new Error(msg);
}

/** Per-IP and global throttles on job creation (each job costs a few GitHub API calls). */
const PER_IP_PER_HOUR = 10;
const GLOBAL_PER_10_MIN = 60;

async function clientIpHash(): Promise<string> {
  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? h.get("x-real-ip") ?? "local").split(",")[0]!.trim();
  return createHash("sha256").update(ip).digest("hex").slice(0, 32);
}

async function throttle(ipHash: string): Promise<void> {
  const hourAgo = new Date(Date.now() - 3600_000);
  const tenMinAgo = new Date(Date.now() - 600_000);
  const [perIp, global] = await Promise.all([
    prisma.jobEvent.count({ where: { message: "job created", at: { gte: hourAgo }, data: { path: ["ipHash"], equals: ipHash } } }),
    prisma.job.count({ where: { createdAt: { gte: tenMinAgo } } }),
  ]);
  if (perIp >= PER_IP_PER_HOUR) fail("Too many audits started from this address in the last hour. Try again later.");
  if (global >= GLOBAL_PER_10_MIN) fail("The site is busy right now. Try again in a few minutes.");
}

/** `/` form: paste a URL → quote the repository from the GitHub API → job in `quoted`. */
export async function createJob(formData: FormData): Promise<void> {
  const url = String(formData.get("url") ?? "");
  const gh = parseGitHubUrl(url);
  if (!gh) fail("Enter a public GitHub repository URL (https://github.com/owner/repo).");
  const ipHash = await clientIpHash();
  await throttle(ipHash);

  const cfg = loadModels();
  const models = enabledModels(cfg);
  const chosen = defaultModelId(cfg);
  const scopeName: AuditScope = "program";
  const ttlMin = envNumber("QUOTE_TTL_MINUTES", 60);

  let q;
  try {
    q = await quoteFromGitHub(gh.owner, gh.repo, gh.ref);
  } catch (e) {
    fail(`Could not quote ${gh.owner}/${gh.repo}: ${(e as Error).message}`);
  }
  if (q.truncated) fail("This repository has too many files for the GitHub tree API (100k+). Clone the site and run the audit locally instead.");

  const perDepth = Object.fromEntries(
    AUDIT_DEPTHS.map((depth) => [
      depth,
      Object.fromEntries(
        models.map((m) => {
          const e = estimate({ loc: q.loc, languages: q.languages, markers: q.markers, scope: scopeName, model: m.id, models: cfg, depth });
          return [m.id, { estCostUsd: e.estCostUsd, rawCostUsd: e.rawCostUsd, suggestedLimitUsd: e.suggestedLimitUsd, tokens: e.tokens, typicalMinutes: e.typicalMinutes }];
        }),
      ),
    ]),
  );
  const perModel = Object.fromEntries(
    models.map((m) => {
      const e = estimate({ loc: q.loc, languages: q.languages, markers: q.markers, scope: scopeName, model: m.id, models: cfg });
      return [m.id, { estCostUsd: e.estCostUsd, rawCostUsd: e.rawCostUsd, suggestedLimitUsd: e.suggestedLimitUsd, tokens: e.tokens, typicalMinutes: e.typicalMinutes }];
    }),
  );
  const est = estimate({ loc: q.loc, languages: q.languages, markers: q.markers, scope: scopeName, model: chosen, models: cfg });

  const job = await prisma.job.create({
    data: {
      repoUrl: gh.url,
      owner: gh.owner,
      repo: gh.repo,
      ref: gh.ref,
      commitSha: q.sha,
      model: chosen,
      tier: "byok",
      visibility: "public",
      scope: scopeName,
      status: "quoted",
      quote: {
        create: {
          model: chosen,
          loc: q.loc,
          totalLoc: q.totalLoc,
          files: q.files,
          languages: q.languages as unknown as Prisma.InputJsonValue,
          markers: q.markers as unknown as Prisma.InputJsonValue,
          scope: est.scope as unknown as Prisma.InputJsonValue,
          estInputTokens: est.tokens.inputTotal,
          estOutputTokens: est.tokens.output,
          estCostUsd: est.estCostUsd,
          margin: 1,
          calibration: est.calibration,
          priceUsdc: 0,
          attestFeeUsdc: 0,
          breakdown: { chosen: est.tokens, perModel, perDepth, excluded: q.excluded, reasons: est.scope.reasons, auditScope: scopeName, source: "github-api", description: q.description, archived: q.archived, defaultBranch: q.defaultBranch } as unknown as Prisma.InputJsonValue,
          expiresAt: new Date(Date.now() + ttlMin * 60_000),
        },
      },
      events: {
        create: [
          { message: "job created", data: { url: gh.url, ref: gh.ref, ipHash } },
          { message: "quote ready", data: { commit: q.sha, loc: q.loc, files: q.files, model: chosen, estCostUsd: est.estCostUsd } },
        ],
      },
    },
  });
  redirect(`/q/${job.id}`);
}

/** Quote page: the user chose model / scope / disclosure and pasted their key → queue on GitHub Actions. */
export async function startAudit(formData: FormData): Promise<void> {
  const jobId = String(formData.get("jobId") ?? "");
  const model = String(formData.get("model") ?? "");
  const visibility = String(formData.get("visibility") ?? "public");
  const scope = String(formData.get("scope") ?? "program") as AuditScope;
  const byokKey = String(formData.get("byokKey") ?? "").trim();
  const depth = String(formData.get("depth") ?? "standard") as AuditDepth;
  const confirmed = formData.get("confirm") === "on";

  if (!["public", "private"].includes(visibility)) fail("invalid visibility");
  if (!AUDIT_SCOPES.includes(scope)) fail("invalid scope");
  if (!AUDIT_DEPTHS.includes(depth)) fail("invalid depth");
  const cfg = loadModels();
  if (!enabledModels(cfg).some((m) => m.id === model)) fail("invalid model");
  if (!confirmed) fail("Please confirm you created a dedicated key with a spend limit and will delete it afterwards.");

  const job = await prisma.job.findUnique({ where: { id: jobId }, include: { quote: true } });
  if (!job || !job.quote) fail("job not found or not quoted");
  if (job.status !== "quoted") fail(`this job is already ${job.status}`);
  if (job.quote.expiresAt.getTime() < Date.now()) fail("the quote expired; submit the repository again");
  if (!job.commitSha) fail("job has no commit");

  const kek = byokKek();
  if (!kek) fail("BYOK is not enabled on this deployment (BYOK_KEK missing)");
  const check = await checkApiKey(byokKey);
  if (!check.ok) fail(`API key check failed: ${check.reason}`);
  if (!modelAvailable(check.models, model)) fail(`This key's organization cannot use ${model}. Pick another model or check the key's workspace.`);

  const est = estimate({
    loc: job.quote.loc,
    languages: job.quote.languages as unknown as LanguageMix,
    markers: job.quote.markers as unknown as Partial<RepoMarkers>,
    scope,
    model,
    models: cfg,
    depth,
  });
  const byokCiphertext = encryptSecret(byokKey, kek);

  await prisma.$transaction([
    prisma.job.update({
      where: { id: jobId },
      data: { tier: "byok", model, visibility: visibility as "public" | "private", scope, depth, status: "queued", budgetUsd: budgetFor(est), byokCiphertext, error: null },
    }),
    prisma.quote.update({ where: { jobId }, data: { model, scope: est.scope as unknown as Prisma.InputJsonValue, estCostUsd: est.estCostUsd, estInputTokens: est.tokens.inputTotal, estOutputTokens: est.tokens.output } }),
    prisma.jobEvent.create({ data: { jobId, message: `configured: ${depth === "quick" ? "Quick scan" : "Standard audit"} / ${model} / ${scope} scope / ${visibility}`, data: { estCostUsd: est.estCostUsd, suggestedLimitUsd: est.suggestedLimitUsd } } }),
  ]);

  try {
    await dispatchAudit(jobId);
    await prisma.jobEvent.create({ data: { jobId, message: "queued on GitHub Actions; a runner picks it up within a minute" } });
  } catch (e) {
    const message = (e as Error).message;
    await prisma.$transaction([
      prisma.job.update({ where: { id: jobId }, data: { status: "failed", error: message.slice(0, 1000), byokCiphertext: null } }),
      prisma.jobEvent.create({ data: { jobId, message: `could not start the runner: ${message}`, level: "error" } }),
    ]);
  }
  redirect(`/q/${jobId}`);
}
