import type { EffectiveVisibility } from "./visibility.js";
import type { ReportFormat, SeverityCounts } from "./types.js";

/** reports/<owner>/<repo>/<commit>/meta.json — the storage contract. */
export interface ReportMeta {
  repo: string; // full url
  owner: string;
  name: string; // repo name
  commit: string; // 40-char sha
  corpus_version: string; // e.g. "7.3.0@6bb2cbf"
  model: string;
  started_at: string | null; // ISO
  finished_at: string | null; // ISO
  report_sha256: string;
  counts: SeverityCounts;
  highest_severity: number | null;
  visibility: EffectiveVisibility;
  submitter_verified: boolean;
  attestation: { tx: string; pda: string; program_id?: string } | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
    cost_usd: number;
  };
  parser?: {
    format: ReportFormat;
    declared_counts: SeverityCounts | null;
    risk_score: number | null;
    warnings: string[];
  };
  job_id?: string | null;
  tier?: "quick" | "standard" | "byok" | "manual";
  depth?: "quick" | "standard";
}

/** Filesystem-safe slug for a corpus version or model id ("7.3.0@6bb2cbf" → "7.3.0-6bb2cbf"). */
export function pathSlug(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

/**
 * reports/<owner>/<repo>/<commit>/<corpus>__<model>/ — one directory per audit of a commit,
 * so a re-run with a newer corpus or another model never overwrites an earlier report.
 */
export function storagePathFor(owner: string, repo: string, commit: string, corpusVersion: string, model: string): string {
  return `${owner}/${repo}/${commit}/${pathSlug(corpusVersion)}__${pathSlug(model)}`;
}
