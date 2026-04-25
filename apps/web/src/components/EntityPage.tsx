import { useEffect, useState } from "react";
import {
  getEntity,
  type FactRow as FactRowType,
  type ResolvedEntity,
  type SourceLite,
} from "../api";
import { CurrentState } from "./CurrentState";
import { FactRow } from "./FactRow";
import { Timeline } from "./Timeline";

type FactView = "timeline" | "by_type";

/** Default view: timeline for event-shaped entities, by_type for identity-shaped ones. */
function defaultView(entityType: string): FactView {
  switch (entityType) {
    case "Topic":
    case "Project":
    case "Decision":
    case "Commitment":
      return "timeline";
    default:
      return "by_type";
  }
}

interface Props {
  query: string;
  roles: string[];
  onSourceClick: (id: string, highlight?: [number, number]) => void;
}

export function EntityPage({ query, roles, onSourceClick }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entity, setEntity] = useState<ResolvedEntity | null>(null);
  const [facts, setFacts] = useState<FactRowType[]>([]);
  const [sources, setSources] = useState<SourceLite[]>([]);
  const [redactedFacts, setRedactedFacts] = useState(0);
  const [redactedSources, setRedactedSources] = useState(0);
  const [view, setView] = useState<FactView>("timeline");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getEntity(query, roles)
      .then((res) => {
        if (cancelled) return;
        setEntity(res.entity);
        setFacts(res.facts ?? []);
        setSources(res.sources ?? []);
        setRedactedFacts(res.redacted_facts ?? 0);
        setRedactedSources(res.redacted_sources ?? 0);
        if (res.entity) setView(defaultView(res.entity.type));
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
  }, [query, roles.join(",")]);

  if (loading) {
    return <div className="text-sm text-slate-500">Loading…</div>;
  }
  if (error) {
    return <div className="text-sm text-red-600">Error: {error}</div>;
  }
  if (!entity) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-500">
        No entity found for "{query}". Try a different name or use the search
        bar.
      </div>
    );
  }

  const factsByType = groupBy(facts, (f) => f.type);

  return (
    <div className="space-y-6">
      {/* Entity header */}
      <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center gap-2">
          <span className="rounded bg-slate-900 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-white">
            {entity.type}
          </span>
          <span className="text-xs text-slate-500">matched via {entity.match}</span>
        </div>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">{entity.name}</h1>
        <div className="mt-1 mono text-xs text-slate-500">{entity.id}</div>
      </div>

      {/* Redaction notice */}
      {(redactedFacts > 0 || redactedSources > 0) && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
          <span className="font-medium">{redactedFacts}</span> fact(s) and{" "}
          <span className="font-medium">{redactedSources}</span> source(s)
          hidden — your role(s) don't satisfy their ACL.
        </div>
      )}

      {/* Current state synthesis (only renders if there's enough signal) */}
      <CurrentState facts={facts} onSourceClick={onSourceClick} />

      {/* Facts: timeline or by-type view */}
      <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">
            Facts ({facts.length})
          </h2>
          <div className="flex rounded-md border border-slate-200 p-0.5 text-xs font-medium">
            <button
              onClick={() => setView("timeline")}
              className={`rounded px-2.5 py-1 transition-colors ${
                view === "timeline"
                  ? "bg-slate-900 text-white"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              Timeline
            </button>
            <button
              onClick={() => setView("by_type")}
              className={`rounded px-2.5 py-1 transition-colors ${
                view === "by_type"
                  ? "bg-slate-900 text-white"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              By type
            </button>
          </div>
        </div>
        {facts.length === 0 ? (
          <div className="text-sm text-slate-500">
            No facts visible to your role.
          </div>
        ) : view === "timeline" ? (
          <Timeline facts={facts} onSourceClick={onSourceClick} />
        ) : (
          <>
            {(["static", "trajectory", "procedural"] as const).map((t) => {
              const list = factsByType.get(t) ?? [];
              if (list.length === 0) return null;
              return (
                <div key={t} className="mb-5 last:mb-0">
                  <div className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-400">
                    {t}
                  </div>
                  <div>
                    {list.map((f) => (
                      <FactRow
                        key={f.id}
                        fact={f}
                        onSourceClick={onSourceClick}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>

      {/* Sources */}
      <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-500">
          Sources mentioning this entity ({sources.length})
        </h2>
        {sources.length === 0 ? (
          <div className="text-sm text-slate-500">
            No sources visible. There may be more — see redaction note above.
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {sources.map((s) => (
              <li
                key={s.id}
                className="cursor-pointer py-2.5 hover:bg-slate-50"
                onClick={() => onSourceClick(s.id)}
              >
                <div className="flex items-center gap-2 text-sm">
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-slate-600">
                    {s.type}
                  </span>
                  <span className="font-medium text-slate-900">{s.subject}</span>
                </div>
                <div className="mono text-xs text-slate-400">{s.id}</div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function groupBy<T, K>(list: T[], keyFn: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of list) {
    const k = keyFn(x);
    const arr = m.get(k) ?? [];
    arr.push(x);
    m.set(k, arr);
  }
  return m;
}
