import { useEffect, useState } from "react";
import { search, type SearchResult, type SourceLite } from "../api";
import { FactRow } from "./FactRow";

interface Props {
  query: string;
  roles: string[];
  onEntityClick: (name: string) => void;
  onSourceClick: (id: string, highlight?: [number, number]) => void;
}

export function SearchResults({
  query,
  roles,
  onEntityClick,
  onSourceClick,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SearchResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    search(query, roles)
      .then((r) => {
        if (cancelled) return;
        setResult(r);
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

  if (loading) return <div className="text-sm text-slate-500">Searching…</div>;
  if (error) return <div className="text-sm text-red-600">Error: {error}</div>;
  if (!result) return null;

  if (result.kind === "entity_hit") {
    return (
      <div className="space-y-6">
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
          Resolved <strong>"{query}"</strong> to entity{" "}
          <button
            onClick={() => onEntityClick(result.entity.id)}
            className="mono font-semibold underline-offset-2 hover:underline"
          >
            {result.entity.id}
          </button>{" "}
          ({result.entity.type}).
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-500">
            Top facts ({result.facts.length})
            {result.redacted_facts > 0 && (
              <span className="ml-2 text-amber-700">
                ({result.redacted_facts} hidden by ACL)
              </span>
            )}
          </h2>
          {result.facts.slice(0, 10).map((f) => (
            <FactRow key={f.id} fact={f} onSourceClick={onSourceClick} />
          ))}
          {result.facts.length > 10 && (
            <button
              onClick={() => onEntityClick(result.entity.id)}
              className="mt-3 text-sm text-blue-700 hover:underline"
            >
              View entity page → {result.facts.length} facts
            </button>
          )}
        </div>

        <SourceList
          sources={result.sources}
          redacted={result.redacted_sources}
          onClick={onSourceClick}
          label={`Sources mentioning ${result.entity.name}`}
        />
      </div>
    );
  }

  // source_hits
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
        No entity matched <strong>"{query}"</strong>. Showing sources that
        mention it.
      </div>
      <SourceList
        sources={result.sources}
        redacted={result.redacted_sources}
        onClick={onSourceClick}
        label="Source matches"
      />
    </div>
  );
}

function SourceList({
  sources,
  redacted,
  onClick,
  label,
}: {
  sources: SourceLite[];
  redacted: number;
  onClick: (id: string) => void;
  label: string;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-500">
        {label} ({sources.length})
        {redacted > 0 && (
          <span className="ml-2 text-amber-700">({redacted} hidden by ACL)</span>
        )}
      </h2>
      {sources.length === 0 ? (
        <div className="text-sm text-slate-500">
          No sources visible. {redacted > 0 ? "Try a higher-privilege role." : ""}
        </div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {sources.map((s) => (
            <li
              key={s.id}
              onClick={() => onClick(s.id)}
              className="cursor-pointer py-2.5 hover:bg-slate-50"
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
  );
}
