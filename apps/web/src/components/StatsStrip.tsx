// Generated via Lovable (lovable.dev) — Pro Plan 1 redemption.
// Prompt: "Generate a single React + TypeScript component called StatsStrip
// that displays 4 metrics: sources, entities, facts, topics. Each metric
// should show a large monospace number with thousands separator and a small
// uppercase label below. Use Tailwind, slate palette, with subtle dividers
// between metrics. The component takes a prop `stats: { sources, entities,
// facts, topics }`. Format numbers >10k as 'Nk'. Add a subtle fade-in
// animation when stats load."
import { useEffect, useState } from "react";

interface StatsStripProps {
  stats: {
    sources: number;
    entities: number;
    facts: number;
    topics: number;
  };
}

function formatNumber(value: number): string {
  if (value > 10000) {
    const k = value / 1000;
    // One decimal, trim trailing .0
    const formatted = k.toFixed(1).replace(/\.0$/, "");
    return `${formatted}k`;
  }
  return value.toLocaleString("en-US");
}

const METRICS: Array<{ key: keyof StatsStripProps["stats"]; label: string }> = [
  { key: "sources", label: "Sources" },
  { key: "entities", label: "Entities" },
  { key: "facts", label: "Facts" },
  { key: "topics", label: "Topics" },
];

export default function StatsStrip({ stats }: StatsStripProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Trigger fade-in on mount / stats change
    setVisible(false);
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, [stats]);

  return (
    <div
      className={`grid grid-cols-2 sm:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-slate-200 rounded-lg border border-slate-200 bg-white transition-all duration-700 ease-out ${
        visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"
      }`}
    >
      {METRICS.map(({ key, label }) => (
        <div
          key={key}
          className="flex flex-col items-center justify-center gap-2 px-6 py-6"
        >
          <span className="font-mono text-3xl sm:text-4xl font-semibold tracking-tight text-slate-900 tabular-nums">
            {formatNumber(stats[key])}
          </span>
          <span className="text-xs font-medium uppercase tracking-widest text-slate-500">
            {label}
          </span>
        </div>
      ))}
    </div>
  );
}
