import { useEffect, useState } from "react";
import {
  listConflicts,
  resolveConflict,
  type Conflict,
  type ConflictingFact,
} from "../api";

interface Props {
  roles: string[];
  /** A user-identity string used as the resolver, e.g. "demo-reviewer" or "emp_0431". */
  resolverIdentity: string;
  onSourceClick: (id: string, highlight?: [number, number]) => void;
  onEntityClick: (id: string) => void;
}

export function ConflictQueue({
  roles,
  resolverIdentity,
  onSourceClick,
  onEntityClick,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [resolving, setResolving] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listConflicts(roles, 50)
      .then((r) => {
        if (cancelled) return;
        setConflicts(r.conflicts);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [roles.join(","), reload]);

  async function pick(conflict: Conflict, fact: ConflictingFact) {
    setResolving(fact.id);
    try {
      await resolveConflict({
        winning_fact_id: fact.id,
        resolved_by_user: resolverIdentity,
        reason: `Resolved via Inspector by ${resolverIdentity}`,
      });
      setReload((n) => n + 1);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setResolving(null);
    }
  }

  if (loading) return <div className="text-sm text-slate-500">Loading conflicts…</div>;
  if (error) return <div className="text-sm text-red-600">Error: {error}</div>;

  const open = conflicts.filter((c) => !c.has_resolution);
  const resolved = conflicts.filter((c) => c.has_resolution);

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold text-slate-900">Conflict Queue</h1>
        <p className="mt-1 text-sm text-slate-600">
          Two or more sources said different things about the same{" "}
          <span className="mono">(entity, attribute)</span>. Pick the version
          you trust — your decision becomes the authoritative fact going forward
          (the others stay in history).
        </p>
        <div className="mt-3 flex gap-4 text-sm">
          <span className="rounded bg-amber-100 px-2 py-0.5 font-medium text-amber-900">
            {open.length} open
          </span>
          <span className="rounded bg-emerald-100 px-2 py-0.5 font-medium text-emerald-900">
            {resolved.length} resolved
          </span>
        </div>
      </div>

      {open.length === 0 && resolved.length === 0 && (
        <div className="rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-500">
          No conflicts visible to your role.
        </div>
      )}

      {open.map((c) => (
        <ConflictCard
          key={c.id}
          conflict={c}
          resolving={resolving}
          onPick={pick}
          onSourceClick={onSourceClick}
          onEntityClick={onEntityClick}
        />
      ))}

      {resolved.length > 0 && (
        <div>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-500">
            Resolved ({resolved.length})
          </h2>
          {resolved.map((c) => (
            <ConflictCard
              key={c.id}
              conflict={c}
              resolving={resolving}
              onPick={pick}
              onSourceClick={onSourceClick}
              onEntityClick={onEntityClick}
              compact
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ConflictCard({
  conflict,
  resolving,
  onPick,
  onSourceClick,
  onEntityClick,
  compact,
}: {
  conflict: Conflict;
  resolving: string | null;
  onPick: (c: Conflict, f: ConflictingFact) => void;
  onSourceClick: (id: string, highlight?: [number, number]) => void;
  onEntityClick: (id: string) => void;
  compact?: boolean;
}) {
  const isResolved = conflict.has_resolution;
  return (
    <div
      className={`rounded-lg border ${
        isResolved
          ? "border-emerald-200 bg-emerald-50/40"
          : "border-amber-200 bg-amber-50/40"
      } p-5 shadow-sm ${compact ? "mb-3" : "mb-4"}`}
    >
      <div className="mb-3 flex items-baseline gap-3">
        <button
          onClick={() => onEntityClick(conflict.entity_id)}
          className="mono text-sm font-semibold text-slate-900 hover:underline"
        >
          {conflict.entity_id}
        </button>
        <span className="text-slate-400">·</span>
        <span className="text-sm font-medium text-slate-700">
          {conflict.attribute}
        </span>
        <span className="text-slate-400">·</span>
        <span className="text-xs text-slate-500">
          {conflict.distinct_values} distinct values, {conflict.facts.length} fact
          {conflict.facts.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {conflict.facts.map((f) => {
          const isWinner = conflict.resolved_fact_id === f.id;
          const isOverrideStamp = !!f.override_by;
          return (
            <div
              key={f.id}
              className={`rounded-md border p-3 ${
                isWinner
                  ? "border-emerald-300 bg-white"
                  : "border-slate-200 bg-white"
              }`}
            >
              <div className="text-sm font-medium text-slate-900">
                {f.value || <em className="text-slate-400">(empty)</em>}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <span className="font-medium text-slate-700">
                  {formatDate(f.source_date)}
                </span>
                <span>·</span>
                <span>conf {f.confidence.toFixed(2)}</span>
                <span>·</span>
                <button
                  onClick={() => onSourceClick(f.source_id)}
                  className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-slate-200"
                >
                  {f.source_type}/{f.source_id.replace(/^[^/]+\//, "")}
                </button>
                <span>·</span>
                <span
                  className={
                    f.author.startsWith("human:")
                      ? "text-emerald-700"
                      : f.author.startsWith("extractor:")
                        ? "text-blue-600"
                        : "text-slate-700"
                  }
                >
                  {f.author.startsWith("human:")
                    ? "human override"
                    : f.author.startsWith("extractor:")
                      ? "LLM"
                      : "structured"}
                </span>
              </div>
              {isOverrideStamp && (
                <div className="mt-2 rounded bg-emerald-100 px-2 py-1 text-xs text-emerald-900">
                  ✓ resolved by {f.override_by} — {f.override_reason}
                </div>
              )}
              {!isResolved && !isOverrideStamp && (
                <button
                  onClick={() => onPick(conflict, f)}
                  disabled={resolving !== null}
                  className="mt-3 w-full rounded bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-800 disabled:opacity-50"
                >
                  {resolving === f.id ? "Resolving…" : "This one is correct"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
