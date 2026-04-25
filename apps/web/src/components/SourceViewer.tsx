import { useEffect, useState } from "react";
import { getSource, type SourceFull } from "../api";

interface Props {
  source_id: string;
  roles: string[];
  highlightSpans?: Array<[number, number]>;
  onClose: () => void;
}

export function SourceViewer({
  source_id,
  roles,
  highlightSpans,
  onClose,
}: Props) {
  const [loading, setLoading] = useState(true);
  const [source, setSource] = useState<SourceFull | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getSource(source_id, roles)
      .then((res) => {
        if (cancelled) return;
        if (res.source) {
          setSource(res.source);
        } else {
          setError(
            res.message ??
              (res.redacted ? "Source not visible to your role(s)." : "Source not found."),
          );
        }
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
  }, [source_id, roles.join(",")]);

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded bg-slate-900 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-white">
              {source?.type ?? "source"}
            </span>
            <span className="mono text-xs text-slate-500">{source_id}</span>
          </div>
          <h2 className="mt-2 text-lg font-semibold text-slate-900">
            {source?.subject ?? (loading ? "Loading…" : "")}
          </h2>
        </div>
        <button
          onClick={onClose}
          className="text-sm text-slate-500 transition-colors hover:text-slate-900"
        >
          Close
        </button>
      </div>
      {error && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          {error}
        </div>
      )}
      {source && (
        <div className="space-y-3">
          <pre className="whitespace-pre-wrap rounded bg-slate-50 p-4 mono text-xs leading-5 text-slate-800">
            {renderHighlighted(source.content, highlightSpans ?? [])}
          </pre>
          <details className="text-xs text-slate-500">
            <summary className="cursor-pointer">Metadata</summary>
            <pre className="mt-1 whitespace-pre-wrap rounded bg-slate-50 p-3 mono">
              {prettyJson(source.metadata)}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}

function renderHighlighted(text: string, spans: Array<[number, number]>) {
  if (spans.length === 0) return text;
  // Sort + merge overlapping spans, then walk text once.
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [s, e] of sorted) {
    if (merged.length === 0 || s > merged[merged.length - 1][1]) {
      merged.push([s, e]);
    } else {
      merged[merged.length - 1][1] = Math.max(
        merged[merged.length - 1][1],
        e,
      );
    }
  }
  const parts: Array<string | React.ReactElement> = [];
  let cursor = 0;
  merged.forEach(([s, e], i) => {
    if (s < 0 || e <= s) return;
    if (cursor < s) parts.push(text.slice(cursor, s));
    parts.push(
      <mark key={i} className="rounded bg-yellow-200 px-0.5">
        {text.slice(s, e)}
      </mark>,
    );
    cursor = e;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}
