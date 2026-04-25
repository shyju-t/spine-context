import type { FactRow as FactRowType } from "../api";
import { FactRow } from "./FactRow";

interface Props {
  facts: FactRowType[];
  onSourceClick: (id: string, highlight?: [number, number]) => void;
}

/**
 * Timeline view — facts ordered by source date (descending = newest first).
 * Groups facts into date buckets so the visual rhythm is per-day, not
 * per-fact. Within a date, facts are also stable-sorted by confidence.
 */
export function Timeline({ facts, onSourceClick }: Props) {
  if (facts.length === 0) {
    return (
      <div className="text-sm text-slate-500">No facts visible to your role.</div>
    );
  }

  // Sort: newest first, then by confidence desc.
  const sorted = [...facts].sort((a, b) => {
    const dateCmp = (b.source_date ?? "").localeCompare(a.source_date ?? "");
    if (dateCmp !== 0) return dateCmp;
    return (b.confidence ?? 0) - (a.confidence ?? 0);
  });

  // Bucket by YYYY-MM-DD
  const buckets = new Map<string, FactRowType[]>();
  for (const f of sorted) {
    const key = (f.source_date ?? "").slice(0, 10) || "unknown";
    const arr = buckets.get(key) ?? [];
    arr.push(f);
    buckets.set(key, arr);
  }

  return (
    <div>
      {[...buckets.entries()].map(([day, rows]) => (
        <div key={day} className="relative mb-5 last:mb-0">
          <div className="sticky top-[88px] z-[1] -mx-2 mb-2 flex items-center gap-3 bg-white/95 px-2 py-1 backdrop-blur">
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-700">
              {formatDayHeader(day)}
            </div>
            <div className="text-xs text-slate-400">
              {rows.length} fact{rows.length === 1 ? "" : "s"}
            </div>
            <div className="h-px flex-1 bg-slate-200" />
          </div>
          <div className="border-l-2 border-slate-100 pl-4">
            {rows.map((f) => (
              <FactRow key={f.id} fact={f} onSourceClick={onSourceClick} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function formatDayHeader(day: string): string {
  if (day === "unknown") return "Date unknown";
  const d = new Date(day);
  if (isNaN(d.getTime())) return day;
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
