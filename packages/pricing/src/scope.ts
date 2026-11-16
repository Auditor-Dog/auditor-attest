/**
 * Scope detection: which checklists and known-vector groups the corpus would load for
 * a repo, from the language mix + repo markers. Mirrors SKILL.md "SCOPE-GATED LOADING"
 * Step 2 and known-vectors/INDEX.md section groupings. Used for the free `quick` tier
 * and to size the corpus share of the quote.
 */

export interface Checklist {
  id: string;
  name: string;
  items: number;
}

/** Item counts from SKILL.md "Checklists Reference" (7.7.5). */
export const CHECKLISTS: readonly Checklist[] = [
  { id: "01", name: "Account Validation", items: 90 },
  { id: "02", name: "Access Control", items: 55 },
  { id: "03", name: "Arithmetic Safety", items: 63 },
  { id: "04", name: "CPI & PDA Safety", items: 70 },
  { id: "05", name: "State Machine & Lifecycle", items: 74 },
  { id: "06", name: "Economic & Logic Attacks", items: 92 },
  { id: "07", name: "OpSec & Governance", items: 87 },
  { id: "08", name: "TypeScript Safety", items: 64 },
  { id: "09", name: "Backend Security", items: 133 },
  { id: "10", name: "Frontend Security", items: 84 },
  { id: "11", name: "Supply Chain & Dependencies", items: 65 },
  { id: "12", name: "Secrets & Key Management", items: 53 },
  { id: "13", name: "Deployment & Infrastructure", items: 102 },
  { id: "14", name: "Python Safety", items: 82 },
  { id: "15", name: "General Language Safety", items: 88 },
  { id: "16", name: "Formal Verification & Testing", items: 73 },
  { id: "17", name: "Logging, Monitoring & IR", items: 68 },
  { id: "18", name: "Privacy, Compliance & Change Mgmt", items: 60 },
  { id: "19", name: "AI Agent Security", items: 39 },
  { id: "20", name: "Rust Off-Chain Services", items: 23 },
];

export interface VectorGroup {
  id: string;
  name: string;
  range: string;
  count: number;
}

/** Section groupings from known-vectors/INDEX.md (7.7.5). */
export const VECTOR_GROUPS: readonly VectorGroup[] = [
  { id: "crypto", name: "Crypto / On-Chain", range: "1-30", count: 30 },
  { id: "backend", name: "Backend / API", range: "31-55", count: 25 },
  { id: "frontend", name: "Frontend / Client-Side", range: "56-75", count: 20 },
  { id: "devops", name: "DevOps / Supply Chain", range: "76-100", count: 25 },
  { id: "modern-onchain", name: "On-Chain — Modern Surface", range: "101-109", count: 9 },
  { id: "ai-offchain-rust", name: "Solana × AI + Off-Chain Rust", range: "110-117", count: 8 },
  { id: "governance-randomness", name: "On-Chain — Governance & Randomness", range: "118-120", count: 3 },
  { id: "custody-consumers", name: "Modern On-Chain, Custody & Off-Chain Consumers", range: "121-126", count: 6 },
  { id: "dos-float-keeper-clmm", name: "DoS, Float Math, Keeper Lifecycle & CLMM Math", range: "127-131", count: 5 },
  { id: "token-registry", name: "Token Registries, Risk Signals & Permissioned Tokens", range: "132-134", count: 3 },
  { id: "tx-format", name: "Transaction Format & Runtime-Upgrade Readiness", range: "135-136", count: 2 },
  { id: "vendored-programs", name: "Vendored Programs & White-Label Fleets", range: "137", count: 1 },
  { id: "runtime-timing", name: "Runtime Timing: 200 ms Slots & the Alpenglow Clock", range: "138", count: 1 },
  { id: "ci-trigger", name: "CI/CD Trigger Trust — GitHub Actions", range: "139-140", count: 2 },
  { id: "host-kernel", name: "Host Kernel & Network Attack Surface", range: "141", count: 1 },
];

/** Repo markers the corpus greps for (SKILL.md Step 1 + discovery). */
export interface RepoMarkers {
  anchorToml: boolean;
  cargoToml: boolean;
  /** .rs files outside programs/ (checklist 20). */
  rustOffchain: boolean;
  packageJson: boolean;
  /** next/react/vite etc. in package.json, or .tsx/.jsx present. */
  web: boolean;
  /** express/fastify/nest/hono/prisma or an apps/backend|server|api dir. */
  backend: boolean;
  python: boolean;
  otherLanguages: string[]; // Go, Java, Ruby, PHP, ...
  /** .mcp.json, agent SDK deps, "agent" dirs. */
  aiAgent: boolean;
}

export interface LanguageLines {
  code: number;
  comments: number;
  blanks: number;
  files: number;
}

export type LanguageMix = Record<string, LanguageLines>;

export interface Scope {
  checklists: string[];
  vectorGroups: string[];
  itemCount: number;
  vectorCount: number;
  /** Fraction of the checklist corpus (by item count) that is in scope. */
  checklistFraction: number;
  /** Fraction of the known-vector corpus (by vector count) that is in scope. */
  vectorFraction: number;
  reasons: string[];
}

const ALWAYS_CHECKLISTS = ["11", "12", "13", "16", "17", "18"];
const ALWAYS_VECTORS = ["devops", "tx-format", "ci-trigger", "host-kernel"];

const OTHER_LANGS = new Set(["Go", "Java", "Ruby", "PHP", "Kotlin", "Scala", "C", "C++", "C#", "Swift", "Elixir", "Solidity", "Move"]);

export function detectScope(languages: LanguageMix, markers: Partial<RepoMarkers> = {}): Scope {
  const cl = new Set<string>(ALWAYS_CHECKLISTS);
  const vg = new Set<string>(ALWAYS_VECTORS);
  const reasons: string[] = ["11-13, 16-18 always apply (any repo)"];

  const has = (lang: string) => (languages[lang]?.code ?? 0) > 0;
  const rust = has("Rust") || markers.anchorToml || markers.cargoToml;
  if (rust) {
    ["01", "02", "03", "04", "05", "06", "07"].forEach((c) => cl.add(c));
    ["crypto", "modern-onchain", "governance-randomness", "custody-consumers", "dos-float-keeper-clmm", "vendored-programs", "runtime-timing"].forEach((g) => vg.add(g));
    reasons.push(markers.anchorToml ? "Anchor.toml / .rs → 01-07 + on-chain vectors" : ".rs / Cargo.toml → 01-07 + on-chain vectors");
    if (markers.rustOffchain) {
      cl.add("20");
      vg.add("ai-offchain-rust");
      reasons.push(".rs outside programs/ → 20 + off-chain Rust vectors");
    }
  }
  const ts = has("TypeScript") || has("TSX") || has("JavaScript") || has("JSX") || markers.packageJson;
  if (ts) {
    cl.add("08");
    reasons.push(".ts/.js → 08");
    const web = markers.web ?? (has("TSX") || has("JSX"));
    const backend = markers.backend ?? (has("TypeScript") || has("JavaScript"));
    if (backend) {
      cl.add("09");
      vg.add("backend");
      vg.add("token-registry");
      reasons.push("backend markers → 09 + backend vectors");
    }
    if (web) {
      cl.add("10");
      vg.add("frontend");
      reasons.push("web markers (.tsx / framework) → 10 + frontend vectors");
    }
  }
  if (has("Python") || markers.python) {
    cl.add("14");
    vg.add("backend");
    reasons.push(".py → 14 + backend vectors");
  }
  const others = Object.keys(languages).filter((l) => OTHER_LANGS.has(l) && has(l));
  for (const l of markers.otherLanguages ?? []) if (!others.includes(l)) others.push(l);
  if (others.length > 0) {
    cl.add("15");
    vg.add("backend");
    reasons.push(`${others.join("/")} → 15 + backend vectors`);
  }
  if (markers.aiAgent) {
    cl.add("19");
    vg.add("ai-offchain-rust");
    reasons.push("AI/agent components → 19 + AI vectors");
  }

  const checklists = [...cl].sort();
  const vectorGroups = VECTOR_GROUPS.map((g) => g.id).filter((g) => vg.has(g));
  const itemCount = CHECKLISTS.filter((c) => cl.has(c.id)).reduce((n, c) => n + c.items, 0);
  const vectorCount = VECTOR_GROUPS.filter((g) => vg.has(g.id)).reduce((n, g) => n + g.count, 0);
  const totalItems = CHECKLISTS.reduce((n, c) => n + c.items, 0);
  const totalVectors = VECTOR_GROUPS.reduce((n, g) => n + g.count, 0);
  return {
    checklists,
    vectorGroups,
    itemCount,
    vectorCount,
    checklistFraction: itemCount / totalItems,
    vectorFraction: vectorCount / totalVectors,
    reasons,
  };
}
