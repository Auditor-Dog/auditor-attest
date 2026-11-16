/**
 * Constants transcribed from vendor/auditor-skill/COSTS.md (corpus 7.3.0@6bb2cbf).
 * Nothing here is invented: each value cites the COSTS.md line it comes from.
 * If the corpus is bumped, re-read COSTS.md and update this file.
 */

/** "Fixed total ~14–15K — same regardless of repo size" (COSTS.md § Fixed Cost). */
export const FIXED_FLOOR_INPUT_TOKENS = 15_000;

/** "Code reading: ~10 tokens per line of code" (COSTS.md § Code + scanning). */
export const INPUT_TOKENS_PER_LOC = 10;

/**
 * "Variable multiplier ~1.6× code tokens" = code reading 1.0 + checklist cross-ref 0.3
 * + grep/terminal 0.2 + checkpoint saves 0.1 (COSTS.md § Code + scanning).
 */
export const VARIABLE_MULTIPLIER = 1.6;

/** Corpus upper bounds when the whole thing is loaded (COSTS.md § Variable Cost table). */
export const CORPUS_FULL_TOKENS = {
  /** "Checklists (20 files, 1,413 items) ~50K" */
  checklists: 50_000,
  /** "Known vectors (136 procedures) ~90K" */
  knownVectors: 90_000,
  /** "References (framework idioms, methodologies, orchestration, report-format) ~100K" */
  references: 100_000,
  /** "Templates + discovery files ~32K" */
  templatesAndDiscovery: 32_000,
} as const;

/**
 * The corpus version this code is written against (vendor/auditor-skill submodule).
 * Bump together with the submodule pointer. The web reads this, not an env var, so a
 * stale deployment variable cannot show the wrong version.
 */
export const CORPUS_VERSION = "7.7.5@8ecccb4";

/** Item and vector totals the corpus ships with (SKILL.md, known-vectors/INDEX.md), 7.7.5. */
export const TOTAL_CHECKLIST_ITEMS = 1_465;
export const TOTAL_KNOWN_VECTORS = 141;

/**
 * Output-token estimate by repo size, COSTS.md § "Cost by Repo Size" (Anthropic table).
 * Piecewise-linear interpolation on code LOC; clamped at both ends.
 * These are the corpus's own empirical figures ("scales with findings").
 */
export const OUTPUT_TOKENS_BY_LOC: ReadonlyArray<readonly [loc: number, outputTokens: number]> = [
  [2_000, 80_000],
  [5_000, 100_000],
  [20_000, 150_000],
  [50_000, 240_000],
  [100_000, 350_000],
  [500_000, 800_000],
];

/**
 * Input-token reference points from the same table. Not used for the quote itself
 * (the quote uses the component formula above) but exposed so the UI can show the
 * corpus's own ballpark next to ours.
 */
export const INPUT_TOKENS_BY_LOC: ReadonlyArray<readonly [loc: number, inputTokens: number]> = [
  [2_000, 150_000],
  [5_000, 200_000],
  [20_000, 430_000],
  [50_000, 910_000],
  [100_000, 1_700_000],
  [500_000, 8_200_000],
];

/**
 * Corpus tokens the corpus itself measured for its reference monorepo (a Solana/Anchor
 * program + TypeScript backend + Next.js frontend, per the COSTS.md preamble), derived
 * from the size table: mean over the 2K..100K rows of
 *   input − FIXED_FLOOR − LOC × INPUT_TOKENS_PER_LOC × VARIABLE_MULTIPLIER.
 * The 500K row is excluded because its figures are rounded to the nearest 100K.
 * This replaces the raw "full corpus" upper bounds (~272K) with what a real run loaded.
 */
export const REFERENCE_MONOREPO_CORPUS_TOKENS = Math.round(
  INPUT_TOKENS_BY_LOC.slice(0, 5)
    .map(([loc, input]) => input - FIXED_FLOOR_INPUT_TOKENS - loc * INPUT_TOKENS_PER_LOC * VARIABLE_MULTIPLIER)
    .reduce((a, b) => a + b, 0) / 5,
);

export function interpolate(
  table: ReadonlyArray<readonly [number, number]>,
  x: number,
): number {
  const first = table[0]!;
  const last = table[table.length - 1]!;
  if (x <= first[0]) return first[1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < table.length; i++) {
    const [x1, y1] = table[i]!;
    const [x0, y0] = table[i - 1]!;
    if (x <= x1) {
      const t = (x - x0) / (x1 - x0);
      return Math.round(y0 + t * (y1 - y0));
    }
  }
  return last[1];
}
