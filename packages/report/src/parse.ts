/**
 * Parser for auditor-skill reports. Handles three layouts:
 *  - client   (templates/audit-report.md, 7.x audit-cycle): "#### AUD-01 — Title",
 *             "| **Severity** | 🔴 Critical (internal: 10) |", "Findings Summary by Severity".
 *  - internal (templates/report-template.md, 7.x /audit): "#### [F-001] Title",
 *             "| **Severity** | 8 — 🟠 HIGH |", "Severity Distribution" with Score|Label|Count.
 *  - legacy   (pre-7 free-form): "### SF-01 — Title" / "### [HIGH] F-1 — Title",
 *             "- **Severity:** 10/10 — Critical" or "| **Severity** | Medium (4 / 10) |",
 *             "Severity Distribution" with "| Critical (9-10) | 0 |" rows.
 *
 * Counts: the report's own severity table is the source of truth when present (it is the
 * auditor's asserted total); finding blocks are parsed for redaction and cross-checked.
 */
import {
  emptyCounts,
  scoreForTier,
  tierForScore,
  type Finding,
  type ParsedReport,
  type ReportFormat,
  type SeverityCounts,
  type SeverityTier,
} from "./types.js";

const FINDING_HEADING_RE = /^(#{2,5})\s+(?:\[(CRITICAL|HIGH|MEDIUM|LOW|INFO\w*)\]\s+)?\[?([A-Z]{1,6}-\d{1,4})\]?\s*(?:[—–:\-]+\s*)?(.*?)\s*$/;
const ANY_HEADING_RE = /^#{1,6}\s/;
const FIELD_ROW_RE = /^\|\s*\*{0,2}([A-Za-z /]+?)\*{0,2}\s*\|\s*(.*?)\s*\|\s*$/;
const FIELD_BULLET_RE = /^\s*(?:[-*]\s*)?\*\*([A-Za-z /]+?):?\*\*:?\s*(.+?)\s*$/;
const TIER_WORD_RE = /\b(critical|high|medium|low|informational|info)\b/i;
/** Sections whose id-headed blocks are not confirmed findings. */
const NON_FINDING_SECTION_RE = /unconfirmed|not confirmed|candidates|investigated but|notes? (?:&|and) nitpicks|nitpicks|known vector|detailed item|coverage|methodology|appendix|disclaimer/i;

function tierFromWord(w: string): SeverityTier {
  const s = w.toLowerCase();
  if (s.startsWith("crit")) return "critical";
  if (s.startsWith("high")) return "high";
  if (s.startsWith("med")) return "medium";
  if (s.startsWith("low")) return "low";
  return "info";
}

function stripMd(s: string): string {
  return s.replace(/[*`_]/g, "").trim();
}

/**
 * Severity from a cell/line such as "🔴 Critical (internal: 10)", "8 — 🟠 HIGH",
 * "10/10 — Critical", "Medium (4 / 10)", "4 (High)", "N / N — INFO/LOW".
 * The tier word wins over the number (legacy reports used other scales); the number is
 * kept as the 1-10 score only when it is on a /10 scale or no other scale is stated.
 */
export function parseSeverityCell(cell: string): { tier: SeverityTier; score: number | null } | null {
  const word = cell.match(TIER_WORD_RE)?.[1];
  const scaleMatch = cell.match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
  let score: number | null = null;
  if (scaleMatch) {
    const n = Number(scaleMatch[1]);
    const d = Number(scaleMatch[2]);
    score = d === 10 && n >= 1 && n <= 10 ? n : null;
  } else {
    const m = cell.match(/(?<![\d.])(10|[1-9])(?![\d.%])/);
    if (m) score = Number(m[1]);
  }
  if (word) {
    const tier = tierFromWord(word);
    // An explicit "/10" number is the 1-10 score even if the report's tier ranges differ
    // from 7.3's. A bare number that contradicts the word is from another scale: drop it.
    if (score !== null && !scaleMatch && tierForScore(score) !== tier) score = null;
    return { tier, score };
  }
  if (score !== null) return { tier: tierForScore(score), score };
  return null;
}

function detectFormat(text: string): ReportFormat {
  // 7.7 Quick depth (quick-scan / diff-audit / deep-review), templates/pr-report.md
  if (/^#\s+Quick (?:scan|review)\b/m.test(text) && /^\|\s*\*\*Findings\*\*\s*\|/m.test(text)) return "quick";
  if (/^#{2,5}\s+AUD-\d+/m.test(text) || /Findings Summary by Severity/.test(text)) return "client";
  if (/^#{2,5}\s+\[F-\d+\]/m.test(text) && /^\|\s*(10|[1-9])\s*\|\s*[^|]*(CRITICAL|HIGH|MEDIUM|LOW|INFO)/im.test(text)) return "internal";
  if (/Severity Distribution/i.test(text) || /^#{2,5}\s+(?:\[[A-Z]+\]\s+)?\[?[A-Z]{1,6}-\d{1,4}\]?/m.test(text)) return "legacy";
  return "unknown";
}

function parseFindingBlocks(lines: string[], warnings: string[]): Finding[] {
  const findings: Finding[] = [];
  let section = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^##?\s/.test(line)) section = line.replace(/^#+\s*/, "");
    const m = line.match(FINDING_HEADING_RE);
    if (!m) continue;
    if (NON_FINDING_SECTION_RE.test(section) && !/finding/i.test(section)) continue;
    const level = m[1]!.length;
    const tag = m[2] ?? null;
    const id = m[3]!;
    const title = stripMd(m[4] ?? "");
    if (/X{2,}|\{|\}/.test(id + title)) continue; // template placeholder
    let end = i + 1;
    while (end < lines.length) {
      const l = lines[end]!;
      if (ANY_HEADING_RE.test(l) && l.match(/^(#+)/)![1]!.length <= level) break;
      end++;
    }
    let tier: SeverityTier | null = null;
    let score: number | null = null;
    let status: string | null = null;
    let location: string | null = null;
    let category: string | null = null;
    for (let j = i + 1; j < end; j++) {
      const row = lines[j]!.match(FIELD_ROW_RE) ?? lines[j]!.match(FIELD_BULLET_RE);
      if (!row) continue;
      const key = row[1]!.trim().toLowerCase();
      const val = row[2]!.trim();
      if (key === "severity" && tier === null) {
        const sev = parseSeverityCell(val);
        if (sev) {
          tier = sev.tier;
          score = sev.score;
        }
      } else if (key === "status") status = stripMd(val);
      else if (key === "location" || key === "file") location = val;
      else if (key === "category") category = stripMd(val);
    }
    if (tier === null && tag) tier = tierFromWord(tag);
    if (tier === null) warnings.push(`finding ${id} has no recognisable severity; treated as unclassified`);
    if (findings.some((f) => f.id === id)) {
      warnings.push(`duplicate finding id ${id}; later block ignored`);
      continue;
    }
    findings.push({ id, title, tier, score, status, location, category, startLine: i, endLine: end });
    i = end - 1;
  }
  return findings;
}

/** Severity summary table: Score|Label|Count rows (internal) or Label|Count rows (client, legacy). */
function parseDeclaredCounts(lines: string[]): SeverityCounts | null {
  const counts = emptyCounts();
  const seen = new Set<SeverityTier>();
  let found = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith("|")) continue;
    const cells = line
      .slice(1, line.endsWith("|") ? -1 : undefined)
      .split("|")
      .map((c) => stripMd(c));
    if (cells.length < 2) continue;
    const c0 = cells[0]!;
    const c1 = cells[1]!;
    // Internal: | 10 | 🔴 CRITICAL | 0 |
    if (/^(10|[1-9])$/.test(c0) && cells.length >= 3 && TIER_WORD_RE.test(cells[1]!)) {
      const n = Number(cells[2]!.replace(/[^\d]/g, ""));
      if (Number.isFinite(n)) {
        counts[tierForScore(Number(c0))] += n;
        found = true;
      }
      continue;
    }
    // Client / legacy: | 🔴 Critical | 2 | … |   or   | Critical (9-10) | 2 |
    const w = c0.match(TIER_WORD_RE)?.[1];
    if (w && /^\d+$/.test(c1)) {
      const t = tierFromWord(w);
      // Only the first table counts (the lifecycle table repeats the labels with other columns).
      if (!seen.has(t)) {
        seen.add(t);
        counts[t] = Number(c1);
        found = true;
      }
    }
  }
  return found ? counts : null;
}

/**
 * Quick reports (templates/pr-report.md) declare counts in one Summary row:
 *   | **Findings** | 1 × 8, 2 × 5 |   or   | **Findings** | none |
 * Severities 1-3 get no finding block there, so this row is the only full count.
 */
function parseQuickCounts(lines: string[]): SeverityCounts | null {
  const row = firstMatch(lines, /^\|\s*\*\*Findings\*\*\s*\|\s*([^|]*)\|/);
  if (row === null) return null;
  const counts = emptyCounts();
  if (/^\s*(none|0|no findings)/i.test(stripMd(row))) return counts;
  let found = false;
  for (const m of row.matchAll(/(\d+)\s*[×x*]\s*(10|[1-9])\b/g)) {
    counts[tierForScore(Number(m[2]))] += Number(m[1]);
    found = true;
  }
  return found ? counts : null;
}

function firstMatch(lines: string[], re: RegExp): string | null {
  for (const l of lines) {
    const m = l.match(re);
    if (m) return (m[1] ?? "").trim();
  }
  return null;
}

function numberOrNull(s: string | null): number | null {
  if (s === null) return null;
  const m = s.replace(/[*`]/g, "").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

export function parseReport(markdown: string): ParsedReport {
  const lines = markdown.split(/\r?\n/);
  const warnings: string[] = [];
  const format = detectFormat(markdown);
  const findings = parseFindingBlocks(lines, warnings);

  const findingCounts = emptyCounts();
  for (const f of findings) if (f.tier) findingCounts[f.tier] += 1;

  const declaredCounts = format === "quick" ? parseQuickCounts(lines) : parseDeclaredCounts(lines);
  let counts: SeverityCounts;
  let countsSource: ParsedReport["countsSource"];
  if (declaredCounts) {
    counts = declaredCounts;
    countsSource = "declared";
    for (const t of Object.keys(counts) as SeverityTier[]) {
      // Quick reports give severities 1-3 no block, so low/info are compared only for the others.
      if (format === "quick" && (t === "low" || t === "info")) continue;
      if (declaredCounts[t] !== findingCounts[t]) warnings.push(`declared ${t} count ${declaredCounts[t]} ≠ parsed finding blocks ${findingCounts[t]}`);
    }
  } else if (findings.length) {
    counts = findingCounts;
    countsSource = "findings";
    warnings.push("no severity summary table; counts derived from finding blocks");
  } else {
    counts = emptyCounts();
    countsSource = "none";
    warnings.push("no severity table and no finding blocks recognised");
  }

  const metricsHighest =
    numberOrNull(firstMatch(lines, /^\|\s*Highest severity found\s*\|\s*([^|]*)\|/i)) ??
    numberOrNull(firstMatch(lines, /^\|\s*\*\*Highest severity\*\*\s*\|\s*([^|]*)\|/i));
  const scored = findings.filter((f) => f.tier !== null);
  const findingsHighest = scored.length ? Math.max(...scored.map((f) => f.score ?? scoreForTier(f.tier!))) : null;
  const tiers: SeverityTier[] = ["critical", "high", "medium", "low", "info"];
  const topDeclared = tiers.find((t) => counts[t] > 0) ?? null;
  let highestSeverity: number | null = null;
  if (topDeclared) {
    // Never report lower than the declared top tier; use a finding's exact score when it agrees.
    const floor = scoreForTier(topDeclared);
    highestSeverity = findingsHighest !== null && tierForScore(findingsHighest) === topDeclared ? Math.max(findingsHighest, floor) : floor;
  } else if (findingsHighest !== null) highestSeverity = findingsHighest;
  else if (metricsHighest !== null) highestSeverity = metricsHighest;

  const riskScore =
    numberOrNull(firstMatch(lines, /\*\*Repository Risk Score:\*\*\s*([^—\n]*)/)) ??
    numberOrNull(firstMatch(lines, /Repository Risk Score:?\s*\**\s*(\d{1,2})\s*\/\s*10/i)) ??
    numberOrNull(firstMatch(lines, /^\|\s*Repository Risk Score\s*\|\s*([^|]*)\|/i));

  const meta = {
    repository:
      firstMatch(lines, /^\*\*Repository:\*\*\s*(.+)$/) ??
      firstMatch(lines, /^\|\s*\*\*Repository\*\*\s*\|\s*([^|]+)\|/),
    commit:
      firstMatch(lines, /^\*\*Commit:\*\*\s*`?([0-9a-fA-F]{7,40})`?/) ??
      firstMatch(lines, /^\|\s*\*\*(?:Audited Commit|Review Start Commit|Commit)\*\*\s*\|\s*`?([0-9a-fA-F]{7,40})`?/) ??
      firstMatch(lines, /^\s*-\s*\*\*Pinned:\*\*\s*HEAD\s*`([0-9a-fA-F]{7,40})`/),
    date:
      firstMatch(lines, /^\*\*Date:\*\*\s*(\d{4}-\d{2}-\d{2})/) ??
      firstMatch(lines, /^\|\s*\*\*(?:Report Published|Date)\*\*\s*\|\s*(\d{4}-\d{2}-\d{2})/),
    scope: firstMatch(lines, /^\*\*Scope:\*\*\s*(.+)$/) ?? firstMatch(lines, /^\|\s*\*\*Scope\*\*\s*\|\s*([^|]+)\|/),
    auditor:
      firstMatch(lines, /^\*\*Auditor:\*\*\s*(.+)$/) ?? firstMatch(lines, /^\|\s*\*\*Auditor\*\*\s*\|\s*([^|]+)\|/),
  };
  for (const k of Object.keys(meta) as (keyof typeof meta)[]) {
    if (meta[k]) meta[k] = stripMd(meta[k]!) || null;
  }

  const metricRow = (label: string) => numberOrNull(firstMatch(lines, new RegExp(`^\\|\\s*${label}\\s*\\|\\s*([^|]*)\\|`, "i")));
  const metrics = {
    totalItems: metricRow("Total (?:checklist )?items(?: evaluated)?"),
    pass: metricRow("PASS"),
    fail: metricRow("FAIL"),
    partial: metricRow("PARTIAL"),
    na: metricRow("N/A"),
    completionPct: metricRow("Completion(?: \\(in-scope\\))?"),
  };

  if (format === "unknown") warnings.push("report format not recognised");

  return { format, counts, countsSource, declaredCounts, findingCounts, findings, highestSeverity, riskScore, meta, metrics, warnings };
}
