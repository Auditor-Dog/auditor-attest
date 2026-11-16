import { corpusVersion, githubToken } from "@/lib/env";

export const CORPUS_REPO = "solanabr/auditor-skill";
export const CORPUS_URL = `https://github.com/${CORPUS_REPO}`;

interface RepoInfo {
  description: string | null;
  stargazers_count: number;
  forks_count: number;
  license: { spdx_id: string } | null;
  topics?: string[];
}

async function corpusInfo(): Promise<RepoInfo | null> {
  try {
    const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "auditor-dog" };
    const t = githubToken();
    if (t) headers.authorization = `Bearer ${t}`;
    const res = await fetch(`https://api.github.com/repos/${CORPUS_REPO}`, { headers, next: { revalidate: 3600 } });
    if (!res.ok) return null;
    return (await res.json()) as RepoInfo;
  } catch {
    return null;
  }
}

/** The corpus this site runs: the repository you clone to use it yourself. */
export async function CorpusCard() {
  const info = await corpusInfo();
  const topics = (info?.topics ?? []).slice(0, 8);
  return (
    <aside className="card p-5">
      <div className="text-xs uppercase tracking-wide text-[var(--muted)]">The corpus this site runs</div>
      <a href={CORPUS_URL} target="_blank" rel="noreferrer" className="mono mt-1 block text-base font-semibold hover:underline">
        {CORPUS_REPO}
      </a>
      <p className="mt-2 text-sm text-[var(--muted)]">
        {info?.description ?? "Claude Code / agentic security skill for Solana programs and software. Full audit-firm lifecycle, executable PoC + fix-patch delivery, a Rust pre-scanner + cross-audit memory, 1,346 checks across 20 checklists, and 131 real-world attack vectors."}
      </p>
      <dl className="mono mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-[var(--muted)]">
        {info && (
          <>
            <div><dt className="inline">stars </dt><dd className="inline text-white">{info.stargazers_count}</dd></div>
            <div><dt className="inline">forks </dt><dd className="inline text-white">{info.forks_count}</dd></div>
          </>
        )}
        <div><dt className="inline">license </dt><dd className="inline text-white">{info?.license?.spdx_id ?? "MIT"}</dd></div>
        <div><dt className="inline">pinned here </dt><dd className="inline text-white">{corpusVersion()}</dd></div>
      </dl>
      {topics.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-1.5">
          {topics.map((t) => (
            <li key={t} className="rounded-sm border border-[var(--border)] px-1.5 py-0.5 text-[11px] text-[var(--muted)]">{t}</li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <a href={CORPUS_URL} target="_blank" rel="noreferrer" className="btn btn-outline btn-sm">Clone it to run it yourself</a>
      </div>
    </aside>
  );
}
