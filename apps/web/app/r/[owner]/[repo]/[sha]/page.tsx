import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Markdown } from "@/components/Markdown";
import { SeverityTiles } from "@/components/SeverityBadges";
import { clusterLabel, corpusVersion, explorerUrl, siteBranch, siteRepo, siteRepoUrl, siteUrl } from "@/lib/env";
import { int, shortSha, usd, when } from "@/lib/format";
import { findReport, loadReport } from "@/lib/reports";

export const dynamic = "force-dynamic";

type Params = { owner: string; repo: string; sha: string };

async function load(params: Params, token: string | undefined, version: string | undefined) {
  const found = await findReport(params.owner, params.repo, params.sha, version);
  if (!found) return null;
  const loaded = await loadReport(found.row, found.siblings);
  if (!loaded) return null;
  if (loaded.visibility === "private" && token !== found.row.accessToken) return "private" as const;
  return loaded;
}

export async function generateMetadata({ params, searchParams }: { params: Promise<Params>; searchParams: Promise<{ t?: string; v?: string }> }): Promise<Metadata> {
  const p = await params;
  const { t, v } = await searchParams;
  const r = await load(p, t, v);
  if (!r || r === "private") return { title: "Report", robots: { index: false } };
  const c = r.parsed.counts;
  return {
    title: `${p.owner}/${p.repo}@${shortSha(r.row.commit)}`,
    description: `Security audit: ${c.critical} critical, ${c.high} high, ${c.medium} medium, ${c.low} low, ${c.info} info. Corpus ${r.row.corpusVersion}, model ${r.row.model}.`,
    robots: { index: r.visibility !== "private" },
  };
}

export default async function ReportPage({ params, searchParams }: { params: Promise<Params>; searchParams: Promise<{ t?: string; v?: string }> }) {
  const p = await params;
  const { t, v } = await searchParams;
  const r = await load(p, t, v);
  if (!r || r === "private") notFound();
  const { row, siblings, parsed, markdown, redacted, visibility } = r;
  const others = siblings.filter((s) => s.id !== row.id && s.visibility !== "private");
  const att = row.attestation;
  const readmeBadge = `[![audit](${siteUrl()}/badge/${row.owner}/${row.repo}.svg)](${siteUrl()}/r/${row.owner}/${row.repo})`;
  const sourceUrl = `${siteRepoUrl()}/blob/${siteBranch()}/reports/${row.storagePath}/report.md`;

  return (
    <div className="container-x space-y-4 pt-8 pb-6">
      {/* Header */}
      <section className="card card-gradient p-6 sm:p-8">
        <div className="text-xs uppercase tracking-wide text-[var(--muted)]">{row.depth === "quick" ? "Quick scan report" : "Security audit report"}</div>
        <h1 className="h-section mt-1 text-2xl sm:text-3xl">
          <a href={`https://github.com/${row.owner}/${row.repo}`} target="_blank" rel="noreferrer">{row.owner}/{row.repo}</a>
        </h1>
        <p className="mono mt-2 text-sm text-[var(--muted)]">
          commit <a href={`https://github.com/${row.owner}/${row.repo}/commit/${row.commit}`} target="_blank" rel="noreferrer" className="text-white">{shortSha(row.commit)}</a> · {row.model} · corpus {row.corpusVersion || corpusVersion()} · {when(row.finishedAt ?? row.createdAt)}
        </p>
        <div className="mt-4">
          <SeverityTiles counts={parsed.counts} />
        </div>
        {others.length > 0 && (
          <div className="mt-5 text-sm">
            <span className="text-[var(--muted)]">Other audits of this commit: </span>
            {others.map((s) => (
              <a key={s.id} href={`?v=${s.id}`} className="mono mr-3 text-[var(--green)]">
                {s.depth === "quick" ? "Quick · " : ""}{s.corpusVersion} · {s.model} · {when(s.finishedAt ?? s.createdAt)}
              </a>
            ))}
          </div>
        )}
      </section>

      {row.depth === "quick" && (
        <div className="card p-4 text-sm text-[var(--muted)]">
          This is a Quick scan: the corpus selected the checklist sections and known-vector files that apply to this code and the model read each of them. It does not give every checklist item a verdict and runs no validation gate. A Standard audit covers the rest.
        </div>
      )}

      {redacted && (
        <div className="rounded-md border border-[var(--high)] bg-[#2a1f12] p-4 text-sm">
          <b>Critical and High findings are withheld</b> until {row.redactUntil ? row.redactUntil.toISOString().slice(0, 10) : "the disclosure date"}. The counts above are exact and match the on-chain attestation.
        </div>
      )}

      {/* Meta + attestation */}
      <section className="grid gap-4 md:grid-cols-2">
        <div className="card p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--muted)]">Provenance</h2>
          <dl className="mono mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
            <dt className="text-[var(--muted)]">Visibility</dt>
            <dd>{visibility}{row.submitterVerified ? " · maintainer verified" : ""}</dd>
            <dt className="text-[var(--muted)]">Highest severity</dt>
            <dd>{parsed.highestSeverity ?? "none"} / 10</dd>
            <dt className="text-[var(--muted)]">Report sha256</dt>
            <dd className="break-all">{row.reportSha256}</dd>
            <dt className="text-[var(--muted)]">Usage</dt>
            <dd>{int(row.inputTokens)} in · {int(row.outputTokens)} out · {int(row.cacheReadTokens)} cached · {usd(Number(row.costUsd), 2)}</dd>
            {visibility !== "private" && (
              <>
                <dt className="text-[var(--muted)]">Source file</dt>
                <dd className="break-all"><a href={sourceUrl} target="_blank" rel="noreferrer" className="text-[var(--green)]">{siteRepo()}/reports/…</a></dd>
              </>
            )}
          </dl>
          {visibility !== "private" && (
            <details className="mt-4 text-xs text-[var(--muted)]">
              <summary className="cursor-pointer">README badge</summary>
              <pre className="mono mt-2 overflow-x-auto rounded-md border border-[var(--border)] bg-black/40 p-3">{readmeBadge}</pre>
            </details>
          )}
        </div>
        <div className="card p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--muted)]">On-chain attestation · {clusterLabel()}</h2>
          {att ? (
            <dl className="mono mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
              <dt className="text-[var(--muted)]">Transaction</dt>
              <dd className="break-all"><a href={explorerUrl("tx", att.txSig)} target="_blank" rel="noreferrer" className="text-[var(--green)]">{att.txSig}</a></dd>
              <dt className="text-[var(--muted)]">Account</dt>
              <dd className="break-all"><a href={explorerUrl("address", att.pda)} target="_blank" rel="noreferrer" className="text-[var(--green)]">{att.pda}</a></dd>
              <dt className="text-[var(--muted)]">Attester</dt>
              <dd className="break-all">{att.attester}</dd>
              <dt className="text-[var(--muted)]">Program</dt>
              <dd className="break-all"><a href={explorerUrl("address", att.programId)} target="_blank" rel="noreferrer" className="text-[var(--green)]">{att.programId}</a></dd>
            </dl>
          ) : (
            <p className="mt-3 text-sm text-[var(--muted)]">Not attested yet. The attestation binds this report&apos;s hash, commit, corpus version, model and the counts above into one account on {clusterLabel()}.</p>
          )}
          <p className="mt-3 text-xs text-[var(--dim)]">Verify without us: the account address is the PDA of sha256(lowercased repo url) + the commit bytes under the program; its data holds the report sha256 above.</p>
          {parsed.warnings.length > 0 && (
            <details className="mt-4 text-xs text-[var(--muted)]">
              <summary className="cursor-pointer">Parser notes ({parsed.warnings.length})</summary>
              <ul className="mt-1 list-disc pl-5">
                {parsed.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </section>

      {/* Body */}
      <section className="card p-5 sm:p-8">
        <Markdown source={markdown} />
      </section>
    </div>
  );
}
