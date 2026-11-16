import { resolve } from "node:path";
import { findRepoRoot } from "@auditor/pricing";

export interface WorkerEnv {
  repoRoot: string;
  reportsDir: string;
  corpusDir: string;
  corpusVersion: string;
  jobsDir: string;
  sandboxImage: string;
  egressProxyImage: string;
  egressAllowedHosts: string;
  egressNetwork: string;
  egressProxyName: string;
  maxJobMinutes: number;
  sandboxMemory: string;
  sandboxCpus: string;
  pollMs: number;
  serviceApiKey: string | null;
  byokKek: Buffer | null;
  attestProgramId: string | null;
  attesterKeypairPath: string | null;
  rpcUrl: string | null;
  cluster: string;
  treasuryPubkey: string | null;
  usdcMint: string;
  paymentPollMs: number;
  visibilitySyncMs: number;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be numeric`);
  return n;
}

export function loadEnv(): WorkerEnv {
  const repoRoot = findRepoRoot(process.cwd());
  const rel = (p: string | undefined, d: string) => resolve(repoRoot, p && p.length ? p : d);
  const cluster = process.env.CLUSTER ?? "devnet";
  if (cluster !== "devnet" && cluster !== "mainnet-beta") throw new Error(`CLUSTER must be devnet or mainnet-beta (got ${cluster})`);
  const kek = process.env.BYOK_KEK;
  if (kek && !/^[0-9a-f]{64}$/i.test(kek)) throw new Error("BYOK_KEK must be 64 hex chars (32 bytes)");
  return {
    repoRoot,
    reportsDir: rel(process.env.REPORTS_DIR, "reports"),
    corpusDir: rel(process.env.CORPUS_DIR, "vendor/auditor-skill"),
    corpusVersion: process.env.CORPUS_VERSION ?? "7.7.5@8ecccb4",
    jobsDir: process.env.JOBS_DIR && process.env.JOBS_DIR.length ? process.env.JOBS_DIR : "/tmp/auditor-jobs",
    sandboxImage: process.env.SANDBOX_IMAGE ?? "auditor-sandbox:latest",
    egressProxyImage: process.env.EGRESS_PROXY_IMAGE ?? "auditor-egress-proxy:latest",
    egressAllowedHosts: process.env.EGRESS_ALLOWED_HOSTS ?? "api.anthropic.com",
    egressNetwork: process.env.EGRESS_NETWORK ?? "auditor-egress",
    egressProxyName: process.env.EGRESS_PROXY_NAME ?? "auditor-egress-proxy",
    maxJobMinutes: num("MAX_JOB_MINUTES", 180),
    sandboxMemory: process.env.SANDBOX_MEMORY ?? "4g",
    sandboxCpus: process.env.SANDBOX_CPUS ?? "2",
    pollMs: num("WORKER_POLL_MS", 2000),
    serviceApiKey: process.env.ANTHROPIC_API_KEY?.length ? process.env.ANTHROPIC_API_KEY : null,
    byokKek: kek ? Buffer.from(kek, "hex") : null,
    attestProgramId: process.env.AUDIT_ATTEST_PROGRAM_ID?.length ? process.env.AUDIT_ATTEST_PROGRAM_ID : null,
    attesterKeypairPath: process.env.ATTESTER_KEYPAIR_PATH?.length ? process.env.ATTESTER_KEYPAIR_PATH : null,
    rpcUrl: process.env.RPC_URL?.length ? process.env.RPC_URL : null,
    cluster,
    treasuryPubkey: process.env.TREASURY_PUBKEY?.length ? process.env.TREASURY_PUBKEY : null,
    usdcMint: process.env.USDC_MINT?.length ? process.env.USDC_MINT : "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    paymentPollMs: num("PAYMENT_POLL_MS", 15000),
    visibilitySyncMs: num("VISIBILITY_SYNC_MS", 10 * 60 * 1000),
  };
}
