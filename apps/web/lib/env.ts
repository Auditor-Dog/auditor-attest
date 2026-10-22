import { resolve } from "node:path";
import { findRepoRoot } from "@auditor/pricing";

export function repoRoot(): string {
  return findRepoRoot(process.cwd());
}

export function reportsDir(): string {
  const v = process.env.REPORTS_DIR;
  return resolve(repoRoot(), v && v.length ? v : "reports");
}

export function corpusVersion(): string {
  return process.env.CORPUS_VERSION ?? "7.3.0@6bb2cbf";
}

export function siteUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
}

export function byokKek(): Buffer | null {
  const k = process.env.BYOK_KEK;
  return k && /^[0-9a-f]{64}$/i.test(k) ? Buffer.from(k, "hex") : null;
}

/** "owner/name" of this site's own public GitHub repository (reports live in it, audits run in its Actions). */
export function siteRepo(): string {
  return process.env.SITE_REPO ?? "Auditor-Dog/auditor-attest";
}

export function siteRepoUrl(): string {
  return `https://github.com/${siteRepo()}`;
}

/** Branch the Actions runner commits reports to and the site reads them from. */
export function siteBranch(): string {
  return process.env.SITE_BRANCH ?? "main";
}

/** Fine-grained PAT: reads public repos for quotes, dispatches the audit workflow. */
export function githubToken(): string | null {
  const t = process.env.GITHUB_DISPATCH_TOKEN;
  return t && t.length ? t : null;
}

export function cluster(): "devnet" | "mainnet-beta" {
  return process.env.CLUSTER === "mainnet-beta" ? "mainnet-beta" : "devnet";
}

export function clusterLabel(): string {
  return cluster() === "devnet" ? "Solana devnet" : "Solana mainnet";
}

export function explorerUrl(kind: "tx" | "address", id: string): string {
  const q = cluster() === "devnet" ? "?cluster=devnet" : "";
  return `https://explorer.solana.com/${kind}/${id}${q}`;
}

export function attestProgramId(): string | null {
  const p = process.env.AUDIT_ATTEST_PROGRAM_ID;
  return p && p.length ? p : null;
}
