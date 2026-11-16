import { describe, expect, it } from "vitest";
import { LIMIT_HEADROOM, SAFETY_FACTOR, budgetFor, ceilCents, estimate, estimateTokens } from "./estimate.js";
import { detectScope } from "./scope.js";
import { TOTAL_CHECKLIST_ITEMS, TOTAL_KNOWN_VECTORS } from "./costs.js";
import { summarizeTokei } from "./tokei.js";
import { CHECKLISTS, VECTOR_GROUPS } from "./scope.js";
import type { ModelsConfig } from "./models.js";

const models: ModelsConfig = {
  default: "test-opus",
  models: [
    { id: "test-opus", label: "Opus", tier: "depth", enabled: true, input_per_mtok: 5, output_per_mtok: 25, cache_read_per_mtok: 0.5, cache_write_per_mtok: 6.25 },
    { id: "test-sonnet", label: "Sonnet", tier: "value", enabled: true, input_per_mtok: 2, output_per_mtok: 10, cache_read_per_mtok: 0.2, cache_write_per_mtok: 2.5 },
  ],
};

/** The eight Claude Opus 5 program-scope runs the profile was fitted on (docs/calibration.md). */
const CALIBRATION_RUNS: [name: string, rustLoc: number, actualUsd: number][] = [
  ["ISC/isc_bridge", 356, 16.01],
  ["Serum/swap", 485, 16.39],
  ["Meteora/dynamic-fee-sharing", 1072, 22.54],
  ["Kamino/kfarms", 4134, 22.1],
  ["Kamino/kvault", 8595, 23.28],
  ["Kamino/scope", 9541, 32.22],
  ["Meteora/dynamic-bonding-curve", 12906, 31.2],
  ["Meteora/damm-v2", 13344, 27.82],
];

describe("corpus constants", () => {
  it("checklist and vector totals match the corpus", () => {
    expect(CHECKLISTS.reduce((n, c) => n + c.items, 0)).toBe(TOTAL_CHECKLIST_ITEMS);
    expect(VECTOR_GROUPS.reduce((n, g) => n + g.count, 0)).toBe(TOTAL_KNOWN_VECTORS);
  });
});

describe("scope detection", () => {
  it("rust-only repo loads 01-07 + always-on, never 14", () => {
    const s = detectScope({ Rust: { code: 1000, comments: 0, blanks: 0, files: 3 } }, { anchorToml: true });
    expect(s.checklists).toEqual(["01", "02", "03", "04", "05", "06", "07", "11", "12", "13", "16", "17", "18"]);
    expect(s.checklists).not.toContain("14");
    expect(s.vectorGroups).toContain("crypto");
    expect(s.vectorGroups).not.toContain("frontend");
    expect(s.itemCount).toBe(531 + 421);
  });
  it("empty repo still has the always-on set", () => {
    const s = detectScope({});
    expect(s.checklists).toEqual(["11", "12", "13", "16", "17", "18"]);
  });
});

describe("single-agent token profile", () => {
  it("is dominated by cache reads and grows gently with LOC", () => {
    const a = estimateTokens(1000);
    const b = estimateTokens(2000);
    expect(a.cacheRead).toBeGreaterThan(a.output * 10);
    expect(b.cacheRead - a.cacheRead).toBe(1_600_000);
    expect(b.output - a.output).toBe(5_000);
    expect(a.inputTotal).toBe(a.input + a.cacheRead + a.cacheWrite);
  });
  it("covers every calibration run at Opus 5 list prices (upper bound, within 1.5× of actual)", () => {
    for (const [name, loc, actual] of CALIBRATION_RUNS) {
      const e = estimate({ loc, languages: { Rust: { code: loc, comments: 0, blanks: 0, files: 5 } }, markers: { anchorToml: true }, scope: "program", model: "test-opus", models });
      expect(e.estCostUsd, name).toBeGreaterThanOrEqual(actual);
      expect(e.estCostUsd, name).toBeLessThan(actual * 1.5);
    }
  });
  it("uses SAFETY_FACTOR by default and LIMIT_HEADROOM for the suggested spend limit", () => {
    const e = estimate({ loc: 2000, languages: { Rust: { code: 2000, comments: 0, blanks: 0, files: 5 } }, model: "test-opus", models });
    expect(e.calibration).toBe(SAFETY_FACTOR);
    expect(e.estCostUsd).toBe(ceilCents(e.rawCostUsd * SAFETY_FACTOR));
    expect(e.suggestedLimitUsd).toBe(Math.ceil(e.estCostUsd * LIMIT_HEADROOM));
    expect(budgetFor(e, 1.5)).toBeCloseTo(ceilCents(e.estCostUsd * 1.5), 8);
  });
  it("prices the same tokens at the model's own rates", () => {
    const base = { loc: 5000, languages: { Rust: { code: 5000, comments: 0, blanks: 0, files: 5 } }, calibration: 1, models };
    const opus = estimate({ ...base, model: "test-opus" });
    const sonnet = estimate({ ...base, model: "test-sonnet" });
    expect(opus.tokens).toEqual(sonnet.tokens);
    expect(sonnet.rawCostUsd).toBeLessThan(opus.rawCostUsd / 2);
  });
  it("ceilCents rounds up", () => {
    expect(ceilCents(1.001)).toBe(1.01);
    expect(ceilCents(1.0)).toBe(1.0);
    expect(ceilCents(0.1 + 0.2)).toBe(0.3);
  });
});

describe("depths at corpus 7.7.5 (docs/costs.md, Claude Opus 5.5)", () => {
  const opus55: ModelsConfig = { default: "o", models: [{ id: "o", label: "Opus 5.5", tier: "depth", enabled: true, input_per_mtok: 4, output_per_mtok: 20, cache_read_per_mtok: 0.2, cache_write_per_mtok: 5 }] };
  const run = (loc: number, depth: "quick" | "standard") => estimate({ loc, languages: { Rust: { code: loc, comments: 0, blanks: 0, files: 5 } }, scope: "program", model: "o", models: opus55, depth });
  it("Standard covers the measured runs: 3K $13.07, 7K $14.70, 12K $18.83", () => {
    for (const [loc, actual] of [[3000, 13.07], [7000, 14.7], [12000, 18.83]] as const) {
      expect(run(loc, "standard").estCostUsd).toBeGreaterThanOrEqual(actual);
      expect(run(loc, "standard").estCostUsd).toBeLessThan(actual * 1.5);
    }
  });
  it("Quick covers the measured runs: 3K $6.98, 12K $2.84, and stays well under Standard", () => {
    expect(run(3000, "quick").estCostUsd).toBeGreaterThanOrEqual(6.98);
    expect(run(12000, "quick").estCostUsd).toBeGreaterThanOrEqual(2.84);
    expect(run(3000, "quick").estCostUsd).toBeLessThan(run(3000, "standard").estCostUsd / 1.5);
    expect(run(3000, "quick").depth).toBe("quick");
  });
});

describe("scope narrowing", () => {
  it("program scope keeps only Rust and drops off-chain checklists", () => {
    const languages = { Rust: { code: 1000, comments: 0, blanks: 0, files: 3 }, TypeScript: { code: 5000, comments: 0, blanks: 0, files: 20 }, JSON: { code: 9000, comments: 0, blanks: 0, files: 4 } };
    const markers = { anchorToml: true, packageJson: true, web: true, backend: true, rustOffchain: true };
    const full = estimate({ loc: 15000, languages, markers, model: "test-opus", models, scope: "full" });
    const prog = estimate({ loc: 15000, languages, markers, model: "test-opus", models, scope: "program" });
    expect(prog.tokens.loc).toBe(1000);
    expect(full.tokens.loc).toBe(15000);
    expect(prog.scope.checklists).not.toContain("08");
    expect(prog.scope.checklists).not.toContain("20");
    expect(full.scope.checklists).toContain("10");
    expect(prog.estCostUsd).toBeLessThan(full.estCostUsd);
  });
});

describe("tokei summarizer", () => {
  it("drops docs, lockfiles and vendored dirs", () => {
    const raw = {
      Rust: { blanks: 10, code: 100, comments: 5, reports: [{ name: "./programs/x/src/lib.rs", stats: { blanks: 10, code: 100, comments: 5 } }] },
      JSON: {
        blanks: 0,
        code: 5000,
        comments: 0,
        reports: [
          { name: "./package-lock.json", stats: { blanks: 0, code: 4990, comments: 0 } },
          { name: "./idl.json", stats: { blanks: 0, code: 10, comments: 0 } },
        ],
      },
      TypeScript: { blanks: 0, code: 999, comments: 0, reports: [{ name: "./node_modules/x/index.ts", stats: { blanks: 0, code: 999, comments: 0 } }] },
      Markdown: { blanks: 0, code: 300, comments: 0, reports: [{ name: "./README.md", stats: { blanks: 0, code: 300, comments: 0 } }] },
      Total: { blanks: 0, code: 0, comments: 0, reports: [] },
    };
    const s = summarizeTokei(raw as never);
    expect(s.loc).toBe(110);
    expect(s.files).toBe(2);
    expect(Object.keys(s.languages).sort()).toEqual(["JSON", "Rust"]);
    expect(s.excluded.map((e) => e.language).sort()).toEqual(["JSON", "Markdown", "TypeScript"]);
  });
});
