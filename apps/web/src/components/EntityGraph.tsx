import { useMemo } from "react";
import type { FactRow as FactRowType, ResolvedEntity } from "../api";

/**
 * Local 1-hop graph view of the current entity.
 *
 * Pulls neighbors directly from the fact list (no extra API call) by
 * scanning each fact's `value` field for canonical entity ids of the
 * shape '<type>/<slug>'. Each (attribute, neighbor) pair becomes an
 * edge from the centre to the neighbor.
 *
 * Layout is radial — centre node in the middle, neighbors evenly
 * spaced on a circle. We cap the visible neighbor count so dense
 * entities (a Customer with 50 purchases) don't render unreadable
 * spaghetti; the rest can be reached via the regular fact list.
 */
interface Props {
  entity: ResolvedEntity;
  facts: FactRowType[];
  onNavigate: (entityId: string) => void;
}

interface Neighbor {
  id: string;
  type: string;
  label: string;
  attributes: string[];
}

const ENTITY_ID_RE = /^([a-z]+)\/[A-Za-z0-9_.-]+$/;

const TYPE_COLOR: Record<string, string> = {
  person: "#10b981", // emerald
  customer: "#3b82f6", // blue
  product: "#8b5cf6", // violet
  client: "#0ea5e9", // sky
  vendor: "#f97316", // orange
  project: "#ec4899", // pink
  topic: "#eab308", // yellow
  decision: "#ef4444", // red
  commitment: "#14b8a6", // teal
  ticket: "#6366f1", // indigo
};

const MAX_NEIGHBORS = 14;
const RADIUS_X = 240;
const RADIUS_Y = 160;
const CENTER_X = 320;
const CENTER_Y = 220;
const SVG_W = 640;
const SVG_H = 440;
const NODE_R = 22;

function entityTypePrefix(id: string): string {
  const m = id.match(ENTITY_ID_RE);
  return m ? m[1] : "";
}

function shortLabel(s: string, max = 18): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function EntityGraph({ entity, facts, onNavigate }: Props) {
  const neighbors = useMemo<Neighbor[]>(() => {
    const map = new Map<string, Neighbor>();
    for (const f of facts) {
      // value must look like '<type>/<id>' — trajectory-style facts pointing
      // at another entity. Skip literal-value facts (status="at-risk", date strings).
      const m = ENTITY_ID_RE.exec(f.value);
      if (!m) continue;
      if (f.value === entity.id) continue;
      const t = m[1];
      const existing = map.get(f.value);
      if (existing) {
        if (!existing.attributes.includes(f.attribute)) {
          existing.attributes.push(f.attribute);
        }
      } else {
        // Strip the type prefix for the visible label; use the slug as
        // the fallback name. We don't have the neighbor's display name
        // without an extra lookup, so the slug is the best we can do
        // until/unless the API joins through.
        const slug = f.value.slice(t.length + 1);
        map.set(f.value, {
          id: f.value,
          type: t,
          label: slug,
          attributes: [f.attribute],
        });
      }
    }
    // Rank by edge count (most-connected first), then alphabetically
    // for stability.
    return [...map.values()]
      .sort((a, b) => b.attributes.length - a.attributes.length || a.id.localeCompare(b.id))
      .slice(0, MAX_NEIGHBORS);
  }, [facts, entity.id]);

  if (neighbors.length === 0) return null;

  const centerType = entity.type.toLowerCase();
  const centerColor = TYPE_COLOR[centerType] ?? "#475569"; // slate-600

  // Distribute neighbors around an ellipse so the layout uses horizontal space.
  const angleStep = (2 * Math.PI) / neighbors.length;
  const positioned = neighbors.map((n, i) => {
    const angle = -Math.PI / 2 + i * angleStep; // start at top
    const x = CENTER_X + RADIUS_X * Math.cos(angle);
    const y = CENTER_Y + RADIUS_Y * Math.sin(angle);
    return { ...n, x, y };
  });

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">
          1-hop graph
        </h2>
        <span className="text-xs text-slate-400">
          {neighbors.length} neighbor{neighbors.length === 1 ? "" : "s"} shown
        </span>
      </div>
      <svg
        viewBox={`0 0 ${SVG_W} ${SVG_H}`}
        className="h-[440px] w-full"
        role="img"
        aria-label={`Local graph for ${entity.name}`}
      >
        {/* Edges first, so nodes paint over them */}
        {positioned.map((n) => {
          const midX = (CENTER_X + n.x) / 2;
          const midY = (CENTER_Y + n.y) / 2;
          const labelText = shortLabel(n.attributes.join(", "), 28);
          return (
            <g key={`edge-${n.id}`}>
              <line
                x1={CENTER_X}
                y1={CENTER_Y}
                x2={n.x}
                y2={n.y}
                stroke="#cbd5e1"
                strokeWidth={1.25}
              />
              <text
                x={midX}
                y={midY - 4}
                textAnchor="middle"
                className="select-none fill-slate-500"
                fontSize={10}
              >
                {labelText}
              </text>
            </g>
          );
        })}
        {/* Neighbor nodes */}
        {positioned.map((n) => {
          const fill = TYPE_COLOR[n.type] ?? "#94a3b8";
          return (
            <g
              key={`node-${n.id}`}
              className="cursor-pointer"
              onClick={() => onNavigate(n.id)}
            >
              <circle
                cx={n.x}
                cy={n.y}
                r={NODE_R}
                fill={fill}
                fillOpacity={0.18}
                stroke={fill}
                strokeWidth={1.5}
              />
              <text
                x={n.x}
                y={n.y - NODE_R - 6}
                textAnchor="middle"
                className="select-none fill-slate-700"
                fontSize={11}
                fontWeight={600}
              >
                {shortLabel(n.label, 18)}
              </text>
              <text
                x={n.x}
                y={n.y + 4}
                textAnchor="middle"
                className="select-none fill-slate-700"
                fontSize={9}
                fontWeight={500}
              >
                {n.type}
              </text>
            </g>
          );
        })}
        {/* Center node — drawn last so it sits on top */}
        <g>
          <circle
            cx={CENTER_X}
            cy={CENTER_Y}
            r={NODE_R + 6}
            fill={centerColor}
            fillOpacity={0.22}
            stroke={centerColor}
            strokeWidth={2}
          />
          <text
            x={CENTER_X}
            y={CENTER_Y + 5}
            textAnchor="middle"
            className="select-none fill-slate-900"
            fontSize={11}
            fontWeight={700}
          >
            {shortLabel(entity.name, 16)}
          </text>
        </g>
      </svg>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-slate-500">
        {Object.entries(TYPE_COLOR)
          .filter(([t]) =>
            positioned.some((n) => n.type === t) || centerType === t,
          )
          .map(([t, c]) => (
            <span key={t} className="inline-flex items-center gap-1">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: c }}
              />
              {t}
            </span>
          ))}
      </div>
    </div>
  );
}
