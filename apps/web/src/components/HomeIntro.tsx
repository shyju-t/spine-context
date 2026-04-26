import { useEffect, useState } from "react";
import { getStats, type GraphStats } from "../api";
import StatsStrip from "./StatsStrip";

/**
 * Per-source-type breakdown shown under the StatsStrip.
 * Renders one chip per source type with its count, sorted by the
 * server's response order (count descending). Friendly labels map the
 * internal type ('support_chat') to a more readable form ('Support Chats').
 */
const SOURCE_TYPE_LABELS: Record<string, string> = {
  email: "Emails",
  chat: "Internal Chats",
  kb: "KB / Q&A",
  hr: "HR Records",
  sales: "Sales",
  review: "Reviews",
  support_chat: "Support Chats",
  ticket: "IT Tickets",
  post: "Social Posts",
};

function formatCount(n: number): string {
  if (n >= 10000) {
    const k = n / 1000;
    return `${k.toFixed(1).replace(/\.0$/, "")}k`;
  }
  return n.toLocaleString("en-US");
}

function SourceBreakdown({
  breakdown,
}: {
  breakdown?: Record<string, number>;
}) {
  if (!breakdown) return null;
  const entries = Object.entries(breakdown).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/50 px-4 py-3">
      <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.16em] text-slate-500">
        Sources processed by type
      </div>
      <div className="flex flex-wrap gap-1.5">
        {entries.map(([type, count]) => (
          <span
            key={type}
            className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs"
            title={`${count.toLocaleString("en-US")} ${type} sources`}
          >
            <span className="font-medium text-slate-700">
              {SOURCE_TYPE_LABELS[type] ?? type}
            </span>
            <span className="font-mono text-slate-500 tabular-nums">
              {formatCount(count)}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

interface Props {
  onSearch: (q: string) => void;
}

const SUGGESTIONS: Array<{
  query: string;
  desc: string;
  tag: "person" | "topic" | "vendor" | "search";
}> = [
  {
    query: "Ravi Kumar",
    desc: "HR Manager. Switch role between Employee, HR, and Exec to watch ACLs gate his salary and performance facts.",
    tag: "person",
  },
  {
    query: "Vendor Management Challenges",
    desc: "A Topic the LLM extracted from internal chats. See its timeline of status changes across multiple sources.",
    tag: "topic",
  },
  {
    query: "Castillo Inc",
    desc: "A vendor mentioned across emails and chats — every fact is traced back to its source span.",
    tag: "vendor",
  },
  {
    query: "quarterly reviews",
    desc: "Free-form search. Tries entity match first, falls back to full-text over Source content.",
    tag: "search",
  },
];

const TAG_BADGE: Record<string, string> = {
  person: "bg-blue-50 text-blue-700 ring-blue-200",
  topic: "bg-purple-50 text-purple-700 ring-purple-200",
  vendor: "bg-amber-50 text-amber-700 ring-amber-200",
  search: "bg-slate-100 text-slate-700 ring-slate-300",
};

export function HomeIntro({ onSearch }: Props) {
  const [stats, setStats] = useState<GraphStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    getStats()
      .then((s) => {
        if (!cancelled) setStats(s);
      })
      .catch(() => {
        // stats are decorative; if the API hiccups, render the page without them
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mx-auto max-w-3xl space-y-12">
      {/* ─── Hero ─── */}
      <div>
        <div className="text-[11px] font-medium uppercase tracking-[0.22em] text-slate-500">
          Inazuma.co · Inspector
        </div>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-900 md:text-5xl">
          The compiled state
          <br />
          of your company.
        </h1>
        <p className="mt-4 max-w-xl text-base leading-relaxed text-slate-600">
          Search a person, customer, or topic. Every fact links back to the
          source it came from. Switch roles to see how ACLs change what you
          can see.
        </p>
      </div>

      {/* ─── Stats strip (Lovable-generated component) ─── */}
      <div className="space-y-3">
        <StatsStrip
          stats={{
            sources: stats?.sources ?? 0,
            entities: stats?.entities ?? 0,
            facts: stats?.facts ?? 0,
            topics: stats?.topics ?? 0,
          }}
        />
        <SourceBreakdown breakdown={stats?.sources_by_type} />
      </div>


      {/* ─── Suggestion tiles ─── */}
      <div>
        <div className="mb-3 text-xs font-medium uppercase tracking-wider text-slate-500">
          Try
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s.query}
              onClick={() => onSearch(s.query)}
              className="group relative flex flex-col items-start gap-2.5 rounded-lg border border-slate-200 bg-white p-4 text-left transition-all hover:-translate-y-0.5 hover:border-slate-400 hover:shadow-md"
            >
              <div className="absolute right-4 top-4 text-slate-300 transition-colors group-hover:text-slate-700">
                ↗
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ring-1 ${TAG_BADGE[s.tag]}`}
                >
                  {s.tag}
                </span>
              </div>
              <div className="rounded bg-slate-100 px-2.5 py-1 mono text-xs font-semibold text-slate-900">
                "{s.query}"
              </div>
              <div className="text-sm leading-relaxed text-slate-600">
                {s.desc}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* ─── How it works (compact) ─── */}
      <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-5">
        <div className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500">
          How it works
        </div>
        <p className="text-sm leading-relaxed text-slate-700">
          Spine compiles unstructured enterprise data — emails, chats,
          policy docs, knowledge-base posts — into typed{" "}
          <span className="rounded bg-white px-1.5 py-0.5 mono text-xs ring-1 ring-slate-200">
            (entity, attribute, value, source)
          </span>{" "}
          facts. Each fact carries provenance, ACL, and a link back to the
          exact span it came from. AI agents query through the same MCP
          server the Inspector uses; nobody re-RAGs raw sources.
        </p>
      </div>
    </div>
  );
}

