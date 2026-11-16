export type SeverityTier = "critical" | "high" | "medium" | "low" | "info";

export const TIERS: readonly SeverityTier[] = ["critical", "high", "medium", "low", "info"];

export interface SeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
}

export interface Finding {
  /** "AUD-01", "F-001", "SF-01", "KL-01" … whatever id scheme the report uses. */
  id: string;
  title: string;
  /** Null when the block carries no recognisable severity (redacted conservatively). */
  tier: SeverityTier | null;
  /** Internal 1-10 score when the report states one on that scale. */
  score: number | null;
  status: string | null;
  location: string | null;
  category: string | null;
  /** 0-based line range [start, end) of the finding block in the source markdown. */
  startLine: number;
  endLine: number;
}

/** "client" = templates/audit-report.md, "internal" = templates/report-template.md, "legacy" = free-form pre-7.x reports with a Severity Distribution table. */
export type ReportFormat = "client" | "internal" | "legacy" | "unknown" | "quick";

export interface ParsedReport {
  format: ReportFormat;
  /**
   * Severity counts. The report's own summary table when it has one (the auditor's
   * asserted totals), otherwise derived from the parsed finding blocks.
   */
  counts: SeverityCounts;
  /** Where `counts` came from. */
  countsSource: "declared" | "findings" | "none";
  /** Counts the report declares in its summary table, if present. */
  declaredCounts: SeverityCounts | null;
  /** Counts derived from parsed finding blocks (null tiers excluded). */
  findingCounts: SeverityCounts;
  findings: Finding[];
  /** Highest internal severity (1-10). Null when there are no findings. */
  highestSeverity: number | null;
  /** "Repository Risk Score" when present. */
  riskScore: number | null;
  meta: {
    repository: string | null;
    commit: string | null;
    date: string | null;
    scope: string | null;
    auditor: string | null;
  };
  metrics: {
    totalItems: number | null;
    pass: number | null;
    fail: number | null;
    partial: number | null;
    na: number | null;
    completionPct: number | null;
  };
  warnings: string[];
}

/** Severity tier for an internal 1-10 score (OUTPUT-RULES.md Rule 1). */
export function tierForScore(n: number): SeverityTier {
  if (n >= 9) return "critical";
  if (n >= 7) return "high";
  if (n >= 5) return "medium";
  if (n >= 3) return "low";
  return "info";
}

/** Representative score for a tier when the report only gives the label. */
export function scoreForTier(t: SeverityTier): number {
  switch (t) {
    case "critical":
      return 9;
    case "high":
      return 7;
    case "medium":
      return 5;
    case "low":
      return 3;
    default:
      return 1;
  }
}

export function tierLabel(t: SeverityTier | null): string {
  switch (t) {
    case "critical":
      return "Critical";
    case "high":
      return "High";
    case "medium":
      return "Medium";
    case "low":
      return "Low";
    case "info":
      return "Informational";
    default:
      return "Unclassified";
  }
}

export function emptyCounts(): SeverityCounts {
  return { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
}
