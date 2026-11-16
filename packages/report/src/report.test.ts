import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseReport, parseSeverityCell } from "./parse.js";
import { redactReport, redactionTargets } from "./redact.js";
import { effectiveVisibility, redactUntilFor } from "./visibility.js";
import { parseGitHubUrl } from "./github.js";
import { sha256Hex } from "./hash.js";

const fixtures = resolve(import.meta.dirname, "../fixtures");
const client = readFileSync(resolve(fixtures, "client-sample.md"), "utf8");
const internal = readFileSync(resolve(fixtures, "internal-sample.md"), "utf8");
const legacy = readFileSync(resolve(fixtures, "legacy-sample.md"), "utf8");

describe("parse: client report (audit-cycle template)", () => {
  const p = parseReport(client);
  it("detects format and counts findings by tier", () => {
    expect(p.format).toBe("client");
    expect(p.counts).toEqual({ critical: 1, high: 1, medium: 1, low: 1, info: 1 });
    expect(p.countsSource).toBe("declared");
    expect(p.findingCounts).toEqual(p.counts);
    expect(p.warnings.filter((w) => w.includes("≠"))).toEqual([]);
  });
  it("extracts finding fields", () => {
    const f = p.findings.find((x) => x.id === "AUD-01")!;
    expect(f.title).toBe("Missing owner check allows draining any vault");
    expect(f.tier).toBe("critical");
    expect(f.score).toBe(10);
    expect(f.status).toBe("Open");
    expect(f.category).toContain("Access Control");
    expect(f.location).toContain("withdraw.rs");
    expect(p.findings.map((x) => x.id)).toEqual(["AUD-01", "AUD-02", "AUD-03", "AUD-04", "AUD-05"]);
  });
  it("computes highest severity and metadata", () => {
    expect(p.highestSeverity).toBe(10);
    expect(p.riskScore).toBeNull();
    expect(p.meta.commit).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(p.meta.date).toBe("2026-09-02");
  });
});

describe("parse: internal report (report-template)", () => {
  const p = parseReport(internal);
  it("detects format, counts and metrics", () => {
    expect(p.format).toBe("internal");
    expect(p.counts).toEqual({ critical: 0, high: 1, medium: 1, low: 0, info: 0 });
    expect(p.declaredCounts).toEqual(p.counts);
    expect(p.highestSeverity).toBe(8);
    expect(p.riskScore).toBe(8);
    expect(p.metrics.totalItems).toBe(910);
    expect(p.metrics.pass).toBe(880);
    expect(p.meta.repository).toBe("example-org/example-vault");
    expect(p.meta.scope).toBe("PROGRAM");
  });
  it("parses [F-NNN] headings and numeric severity cells", () => {
    expect(p.findings.map((f) => [f.id, f.score])).toEqual([
      ["F-001", 8],
      ["F-002", 5],
    ]);
    expect(p.findings[0]!.location).toBe("programs/vault/src/state.rs:88");
  });
});

describe("parse: legacy free-form report (pre-7 corpus)", () => {
  const p = parseReport(legacy);
  it("takes counts from the declared table and ignores unconfirmed candidates", () => {
    expect(p.format).toBe("legacy");
    expect(p.counts).toEqual({ critical: 1, high: 1, medium: 1, low: 1, info: 0 });
    expect(p.countsSource).toBe("declared");
    expect(p.findings.map((f) => f.id)).toEqual(["EX-01", "EX-02", "EX-03", "EX-04"]);
    expect(p.findings.map((f) => f.tier)).toEqual(["critical", "high", "medium", "low"]);
    expect(p.warnings.filter((w) => w.includes("≠"))).toEqual([]);
  });
  it("reads bullet severities, heading tags and other scales", () => {
    const byId = Object.fromEntries(p.findings.map((f) => [f.id, f]));
    expect(byId["EX-01"]!.score).toBe(10);
    expect(byId["EX-02"]!.score).toBeNull(); // "4 (High)" is not on the 1-10 scale
    expect(byId["EX-03"]!.score).toBe(4); // "Medium (4 / 10)": explicit /10 keeps the number
    expect(byId["EX-04"]!.score).toBe(2);
    expect(byId["EX-01"]!.location).toBe("`src/withdraw.rs:98`");
  });
  it("gets risk score, commit and highest severity", () => {
    expect(p.riskScore).toBe(10);
    expect(p.highestSeverity).toBe(10);
    expect(p.meta.commit).toBe("abcdef0123456789abcdef0123456789abcdef01");
    expect(p.meta.date).toBe("2026-06-20");
  });
  it("floors highest severity at the declared top tier when blocks are unparseable", () => {
    const only = legacy.replace("- **Severity:** 10/10 — Critical", "- **Severity:** see below");
    const q = parseReport(only);
    expect(q.findings.find((f) => f.id === "EX-01")!.tier).toBeNull();
    expect(q.highestSeverity).toBe(9);
    expect(redactionTargets(q).map((f) => f.id)).toEqual(["EX-02", "EX-01"]); // unclassified withheld too
  });
});

describe("severity cell parsing", () => {
  it("handles every notation seen in the wild", () => {
    expect(parseSeverityCell("🔴 Critical (internal: 10)")).toEqual({ tier: "critical", score: 10 });
    expect(parseSeverityCell("8 — 🟠 HIGH")).toEqual({ tier: "high", score: 8 });
    expect(parseSeverityCell("🟡 Medium")).toEqual({ tier: "medium", score: null });
    expect(parseSeverityCell("⚪ Informational (internal: 1)")).toEqual({ tier: "info", score: 1 });
    expect(parseSeverityCell("10/10 — Critical")).toEqual({ tier: "critical", score: 10 });
    expect(parseSeverityCell("4 (High)")).toEqual({ tier: "high", score: null });
    expect(parseSeverityCell("Medium (4 / 10)")).toEqual({ tier: "medium", score: 4 });
    expect(parseSeverityCell("4 / 6 — High")).toEqual({ tier: "high", score: null });
    expect(parseSeverityCell("6 / 10 — Medium")).toEqual({ tier: "medium", score: 6 });
    expect(parseSeverityCell("2 / 10 — INFO/LOW")).toEqual({ tier: "info", score: 2 });
    expect(parseSeverityCell("n/a")).toBeNull();
  });
});

describe("redaction", () => {
  const p = parseReport(client);
  const r = redactReport(client, p, { redactUntil: new Date("2026-12-01T00:00:00Z") });
  it("removes Critical/High titles, descriptions and locations everywhere", () => {
    expect(r).not.toContain("Missing owner check allows draining any vault");
    expect(r).not.toContain("Unchecked arithmetic in fee accrual");
    expect(r).not.toContain("withdraw.rs#L42");
    expect(r).not.toContain("state.rs:88");
    expect(r).not.toContain("permissionless vault drain"); // key takeaway bullet
    expect(r).not.toContain("never constrains the destination");
  });
  it("keeps ids, severities, counts and lower-severity findings", () => {
    expect(r).toContain("AUD-01");
    expect(r).toContain("AUD-02");
    expect(r).toContain("| 🔴 Critical         | 1 ");
    expect(r).toContain("Pause flag not enforced on withdraw");
    expect(r).toContain("Redundant rent check");
    expect(r).toContain("2026-12-01");
    expect(r).toContain("Details withheld");
  });
  it("redacted output still parses with the same counts", () => {
    const p2 = parseReport(r);
    expect(p2.counts).toEqual(p.counts);
    expect(p2.findings.find((f) => f.id === "AUD-01")!.title).toBe("[redacted]");
  });
  it("redacts legacy reports too", () => {
    const pl = parseReport(legacy);
    const rl = redactReport(legacy, pl);
    expect(rl).not.toContain("Withdraw accounting mismatch");
    expect(rl).not.toContain("Missing signer check on admin path");
    expect(rl).toContain("Rounding favours the caller");
    expect(rl).toContain("| Critical (9-10) | 1 |");
  });
  it("is a no-op when nothing is Critical/High", () => {
    const only = internal.replace("8 — 🟠 HIGH", "5 — 🟡 MEDIUM").replace("| 8 | 🟠 HIGH | 1 |", "| 8 | 🟠 HIGH | 0 |").replace("| 5 | 🟡 MEDIUM | 1 |", "| 5 | 🟡 MEDIUM | 2 |");
    const pp = parseReport(only);
    expect(redactReport(only, pp)).toBe(only);
  });
});

describe("effective visibility", () => {
  const now = new Date("2026-09-10T00:00:00Z");
  it("private is always private", () => {
    expect(effectiveVisibility({ visibility: "private", submitterVerified: true }, now)).toBe("private");
  });
  it("verified maintainer publishes everything", () => {
    expect(effectiveVisibility({ visibility: "public", submitterVerified: true }, now)).toBe("public");
  });
  it("unverified public is redacted until ack or 90 days", () => {
    const created = new Date("2026-09-01T00:00:00Z");
    const until = redactUntilFor(created);
    expect(until.toISOString()).toBe("2026-11-30T00:00:00.000Z");
    expect(effectiveVisibility({ visibility: "public", submitterVerified: false, redactUntil: until }, now)).toBe("public");
    process.env.REDACT_PUBLIC = "1";
    expect(effectiveVisibility({ visibility: "public", submitterVerified: false, redactUntil: until }, now)).toBe("public_redacted");
    expect(effectiveVisibility({ visibility: "public", submitterVerified: false, redactUntil: until }, new Date("2026-11-30T00:00:01Z"))).toBe("public");
    expect(effectiveVisibility({ visibility: "public", submitterVerified: false, redactUntil: until, maintainerAckAt: new Date("2026-09-05") }, now)).toBe("public");
    delete process.env.REDACT_PUBLIC;
  });
});

describe("github url parsing", () => {
  it("accepts the common forms", () => {
    expect(parseGitHubUrl("https://github.com/solanabr/auditor-skill")).toEqual({ owner: "solanabr", repo: "auditor-skill", ref: null, url: "https://github.com/solanabr/auditor-skill" });
    expect(parseGitHubUrl("github.com/a/b.git")?.repo).toBe("b");
    expect(parseGitHubUrl("https://github.com/a/b/tree/feat/x")?.ref).toBe("feat/x");
    expect(parseGitHubUrl("git@github.com:a/b.git")?.owner).toBe("a");
  });
  it("rejects non-github and malformed input", () => {
    expect(parseGitHubUrl("https://gitlab.com/a/b")).toBeNull();
    expect(parseGitHubUrl("https://github.com/a")).toBeNull();
    expect(parseGitHubUrl("https://github.com/a/b/tree/-rf")).toBeNull();
    expect(parseGitHubUrl("")).toBeNull();
  });
});

describe("hash", () => {
  it("is byte-exact sha256", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("quick report (corpus 7.7 pr-report)", () => {
  const md = readFileSync(resolve(fixtures, "quick-sample.md"), "utf8");
  const p = parseReport(md);
  it("is recognised and counted from the Summary row, lows included", () => {
    expect(p.format).toBe("quick");
    expect(p.counts).toEqual({ critical: 1, high: 0, medium: 1, low: 2, info: 1 });
    expect(p.countsSource).toBe("declared");
    expect(p.highestSeverity).toBe(9);
    expect(p.meta.commit).toBe("ca89527f0e2b4b6c9d1a3e5f7a9b1c3d5e7f9a1b");
    expect(p.findings.map((f) => f.id)).toEqual(["F-001", "F-002"]);
    expect(p.warnings.filter((w) => w.startsWith("declared"))).toEqual([]);
  });
  it("reads 'none' as zero findings", () => {
    const none = parseReport(md.replace("1 × 9, 1 × 5, 2 × 3, 1 × 2", "none").replace(/## Findings[\s\S]*## Verdicts/, "## Findings\n\nNo findings on the reviewed surface.\n\n## Verdicts"));
    expect(none.counts).toEqual({ critical: 0, high: 0, medium: 0, low: 0, info: 0 });
  });
});
