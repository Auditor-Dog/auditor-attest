#!/usr/bin/env tsx
/**
 * Runner self-check: proves the GitHub Actions environment can attest and reach the
 * database, without running an audit or spending anything. Prints only public facts.
 *   workflow_dispatch with selfcheck=true → this script
 */
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { deriveConfigPda } from "@auditor/attest";
import { prisma } from "@auditor/db";

const ok = (label: string, v: unknown) => console.log(`ok    ${label}: ${v}`);
const bad = (label: string, v: unknown) => { console.log(`FAIL  ${label}: ${v}`); process.exitCode = 1; };

async function main() {
  const has = (k: string) => (process.env[k] ?? "").length > 0;
  for (const k of ["DATABASE_URL", "BYOK_KEK", "ATTESTER_KEYPAIR_JSON"]) has(k) ? ok(`secret ${k}`, "present") : bad(`secret ${k}`, "missing");
  if (has("BYOK_KEK") && !/^[0-9a-f]{64}$/i.test(process.env.BYOK_KEK!)) bad("BYOK_KEK", "not 64 hex chars");

  const rpc = process.env.RPC_URL ?? "https://api.devnet.solana.com";
  const pid = process.env.AUDIT_ATTEST_PROGRAM_ID ?? "";
  ok("cluster", process.env.CLUSTER ?? "(unset)");
  ok("rpc", rpc);
  ok("program id", pid || "(unset)");
  ok("site url", process.env.SITE_URL ?? "(unset)");
  ok("spend cap var MAX_BUDGET_USD", process.env.MAX_BUDGET_USD || "(unset, good for real audits)");

  let attester: Keypair | null = null;
  try {
    attester = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.ATTESTER_KEYPAIR_JSON ?? "[]") as number[]));
    ok("attester pubkey", attester.publicKey.toBase58());
  } catch (e) {
    bad("attester keypair", `cannot parse: ${(e as Error).message}`);
  }

  const conn = new Connection(rpc, "confirmed");
  if (attester) {
    const bal = await conn.getBalance(attester.publicKey);
    (bal > 0.05 * LAMPORTS_PER_SOL ? ok : bad)("attester balance", `${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  }
  if (pid) {
    const programId = new PublicKey(pid);
    const prog = await conn.getAccountInfo(programId);
    prog ? ok("program account", `${prog.data.length} bytes, executable=${prog.executable}`) : bad("program account", "not found on this cluster");
    const [config] = deriveConfigPda(programId);
    const info = await conn.getAccountInfo(config);
    if (!info) bad("config pda", "not initialised");
    else {
      const configured = new PublicKey(info.data.subarray(40, 72)).toBase58();
      const match = attester && configured === attester.publicKey.toBase58();
      (match ? ok : bad)("config attester", `${configured}${match ? " (matches secret)" : " (does NOT match the ATTESTER_KEYPAIR_JSON secret)"}`);
    }
  }

  try {
    const [reports, attestations, queued] = await Promise.all([prisma.report.count(), prisma.attestation.count(), prisma.job.count({ where: { status: "queued" } })]);
    ok("database", `${reports} reports, ${attestations} attestations, ${queued} queued jobs`);
  } catch (e) {
    bad("database", (e as Error).message.split("\n")[0]);
  } finally {
    await prisma.$disconnect();
  }
  console.log(process.exitCode ? "\nSELF-CHECK FAILED" : "\nSELF-CHECK PASSED");
}
main().catch((e) => { console.error(e); process.exit(1); });
