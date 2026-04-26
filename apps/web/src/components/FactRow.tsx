import type { FactRow as FactRowType } from "../api";

interface Props {
  fact: FactRowType;
  onSourceClick: (source_id: string, highlight?: [number, number]) => void;
}

/**
 * Source types whose subject carries a prose preview worth surfacing
 * inline (review/sales summary lines, email subject, chat first line,
 * KB question title, ticket issue snippet, post title). For these, a
 * link-style row with the subject is far more useful than 'reviewed_by =
 * customer/X' alone — the user actually wants to see *what* the review
 * said. 'hr' is excluded — it has no narrative subject.
 */
const SUBJECT_PREVIEW_TYPES = new Set([
  "review",
  "support_chat",
  "post",
  "ticket",
  "email",
  "chat",
  "kb",
  "sales",
]);

export function FactRow({ fact, onSourceClick }: Props) {
  const aclTags = parseAcl(fact.acl);
  const isLLM = fact.author.startsWith("extractor:");
  const showPreview =
    !!fact.source_subject &&
    fact.source_subject.trim().length > 0 &&
    SUBJECT_PREVIEW_TYPES.has(fact.source_type);
  return (
    <div className="group flex items-start gap-3 border-b border-slate-100 py-2.5">
      <div className="w-44 shrink-0 text-sm font-medium text-slate-700">
        {fact.attribute}
      </div>
      <div className="flex-1 text-sm text-slate-900">
        <span className="break-words">{fact.value || <em className="text-slate-400">(empty)</em>}</span>
        {showPreview && (
          <button
            type="button"
            onClick={() =>
              onSourceClick(
                fact.source_id,
                fact.source_span_start >= 0 && fact.source_span_end >= 0
                  ? [fact.source_span_start, fact.source_span_end]
                  : undefined,
              )
            }
            className="mt-1 block w-full text-left text-xs italic leading-snug text-slate-600 hover:text-slate-900"
            title="Open source"
          >
            “
            {fact.source_subject.length > 220
              ? fact.source_subject.slice(0, 220).trimEnd() + "…"
              : fact.source_subject}
            ”
          </button>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
          {fact.source_date && (
            <>
              <span className="font-medium text-slate-700">{formatDate(fact.source_date)}</span>
              <span>·</span>
            </>
          )}
          <span className="font-mono">{fact.type}</span>
          <span>·</span>
          <span>conf {fact.confidence.toFixed(2)}</span>
          <span>·</span>
          <button
            onClick={() =>
              onSourceClick(
                fact.source_id,
                fact.source_span_start >= 0 && fact.source_span_end >= 0
                  ? [fact.source_span_start, fact.source_span_end]
                  : undefined,
              )
            }
            className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-700 transition-colors hover:bg-slate-200"
            title={`Open ${fact.source_type}: ${fact.source_subject?.slice(0, 60) ?? ""}`}
          >
            {fact.source_type ? `${fact.source_type}/` : ""}
            {fact.source_id.replace(/^[^/]+\//, "")}
          </button>
          <span>·</span>
          <span className={isLLM ? "text-blue-600" : "text-emerald-700"}>
            {isLLM ? "LLM" : "structured"}
          </span>
          {aclTags.length > 0 && (
            <>
              <span>·</span>
              <div className="flex flex-wrap gap-1">
                {aclTags.map((t) => (
                  <span
                    key={t}
                    className="rounded border border-slate-200 bg-white px-1 py-0.5 text-[10px] font-mono text-slate-500"
                  >
                    {t}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function parseAcl(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function formatDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 10);
  // Compact: "Mar 24, 2020"
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
