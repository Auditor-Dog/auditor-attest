import Link from "next/link";
import { effectiveVisibility } from "@auditor/report";
import { enabledModels, loadModels } from "@auditor/pricing";
import { SeverityBadges } from "@/components/SeverityBadges";
import { prisma } from "@/lib/db";
import { shortSha, when } from "@/lib/format";

export const dynamic = "force-dynamic";

type Search = { q?: string; min?: string; model?: string; sort?: string; page?: string };
const PAGE = 24;

export default async function ExplorePage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const min = Number(sp.min ?? 0) || 0;
  const model = sp.model ?? "";
  const sort = sp.sort === "severity" ? "severity" : "newest";
  const page = Math.max(1, Number(sp.page ?? 1) || 1);

  const where = {
    visibility: "public" as const,
    ...(q ? { OR: [{ owner: { contains: q, mode: "insensitive" as const } }, { repo: { contains: q, mode: "insensitive" as const } }] } : {}),
    ...(min ? { highestSeverity: { gte: min } } : {}),
    ...(model ? { model } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.report.findMany({
      where,
      orderBy: sort === "severity" ? [{ highestSeverity: "desc" }, { createdAt: "desc" }] : [{ createdAt: "desc" }],
      include: { attestation: true },
      take: PAGE + 1,
      skip: (page - 1) * PAGE,
    }),
    prisma.report.count({ where }),
  ]);
  const visible = rows.filter((r) => effectiveVisibility({ visibility: r.visibility, submitterVerified: r.submitterVerified, redactUntil: r.redactUntil, maintainerAckAt: r.maintainerAckAt }) !== "private");
  const hasNext = visible.length > PAGE;
  const list = visible.slice(0, PAGE);
  const models = enabledModels(loadModels());

  const qs = (over: Partial<Search>) => {
    const p = new URLSearchParams({ q, min: String(min), model, sort, page: String(page), ...Object.fromEntries(Object.entries(over).map(([k, v]) => [k, String(v)])) });
    for (const [k, v] of [...p.entries()]) if (!v || v === "0" || (k === "page" && v === "1")) p.delete(k);
    return `/explore?${p.toString()}`;
  };

  return (
    <div className="container-x space-y-5 pt-8 pb-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h-section text-3xl">Reports</h1>
          <p className="mt-3 max-w-2xl text-[var(--muted)]">
            Every public report, newest first, with full finding text. Private reports are never listed. Severity counts match the on-chain attestation.
          </p>
        </div>
        <div className="text-sm text-[var(--muted)]">{total} public report{total === 1 ? "" : "s"}</div>
      </div>

      <form className="card flex flex-wrap items-end gap-3 p-4 text-sm" method="get">
        <label className="flex min-w-48 flex-1 flex-col gap-1">
          <span className="text-xs text-[var(--muted)]">Repository</span>
          <input name="q" defaultValue={q} placeholder="owner or repo" className="input input-sq py-2" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-[var(--muted)]">Min. severity</span>
          <select name="min" defaultValue={String(min)} className="input input-sq py-2 pr-8">
            <option value="0">any</option>
            <option value="9">Critical</option>
            <option value="7">High or worse</option>
            <option value="5">Medium or worse</option>
            <option value="3">Low or worse</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-[var(--muted)]">Model</span>
          <select name="model" defaultValue={model} className="input input-sq mono py-2 pr-8 text-xs">
            <option value="">any</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-[var(--muted)]">Sort</span>
          <select name="sort" defaultValue={sort} className="input input-sq py-2 pr-8">
            <option value="newest">newest</option>
            <option value="severity">highest severity</option>
          </select>
        </label>
        <button type="submit" className="btn btn-primary btn-sm">Filter</button>
        {(q || min || model || sort !== "newest") && <Link href="/explore" className="btn btn-outline btn-sm">Reset</Link>}
      </form>

      {list.length === 0 && <div className="card p-10 text-center text-[var(--muted)]">No public reports match.</div>}
      <ul className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {list.map((r) => {
          const vis = effectiveVisibility({ visibility: r.visibility, submitterVerified: r.submitterVerified, redactUntil: r.redactUntil, maintainerAckAt: r.maintainerAckAt });
          return (
            <li key={r.id}>
              <Link href={`/r/${r.owner}/${r.repo}/${r.commit}`} className="card block h-full p-5">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-semibold">{r.owner}/{r.repo}</span>
                  <span className="mono text-xs text-[var(--dim)]">{shortSha(r.commit)}</span>
                </div>
                <div className="mt-3">
                  <SeverityBadges size="sm" counts={{ critical: r.critical, high: r.high, medium: r.medium, low: r.low, info: r.info }} />
                </div>
                <div className="mt-3 flex flex-wrap gap-x-3 text-xs text-[var(--dim)]">
                  {r.depth === "quick" && <span className="text-white">Quick scan</span>}
                  <span className="mono">{r.model}</span>
                  <span>{when(r.finishedAt ?? r.createdAt)}</span>
                  {vis === "public_redacted" && <span>redacted</span>}
                  {r.attestation && <span className="text-[var(--green)]">attested ✓</span>}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="flex gap-3 text-sm">
        {page > 1 && <Link href={qs({ page: String(page - 1) })} className="btn btn-outline btn-sm">← Previous</Link>}
        {hasNext && <Link href={qs({ page: String(page + 1) })} className="btn btn-outline btn-sm">Next</Link>}
      </div>
    </div>
  );
}
