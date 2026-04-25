import type { FactRow } from "../api";

interface Props {
  facts: FactRow[];
  onSourceClick: (id: string, highlight?: [number, number]) => void;
}

/** Attribute names whose latest value summarizes the entity's current state. */
const STATE_ATTRIBUTES = [
  "status",
  "state",
  "current_state",
  "current_status",
];

/** Attribute names that reveal who's currently responsible. */
const OWNER_ATTRIBUTES = ["owner", "current_owner", "assigned_to"];

/** Attribute names with a hard deadline. */
const DUE_ATTRIBUTES = ["due_date", "deadline", "due"];

/**
 * Render a compact "current state" card if we can derive one from the
 * facts. Picks the latest fact (by source_date) for each known role.
 */
export function CurrentState({ facts, onSourceClick }: Props) {
  if (facts.length === 0) return null;

  const latestStatus = pickLatest(facts, STATE_ATTRIBUTES);
  const latestOwner = pickLatest(facts, OWNER_ATTRIBUTES);
  const latestDue = pickLatest(facts, DUE_ATTRIBUTES);
  const latestAction = pickLatestByCategory(facts, "action");
  const latestBlocker = pickLatest(facts, ["blocker", "blocked_by"]);

  const anything =
    latestStatus || latestOwner || latestDue || latestAction || latestBlocker;
  if (!anything) return null;

  const overallLatest = newestFactDate(facts);

  return (
    <div className="rounded-lg border-2 border-slate-300 bg-gradient-to-br from-slate-50 to-white p-5 shadow-sm">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-700">
          Current state
        </h2>
        {overallLatest && (
          <span className="text-xs text-slate-500">
            latest activity {overallLatest}
          </span>
        )}
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {latestStatus && (
          <StateField
            label="Status"
            value={latestStatus.value}
            date={latestStatus.source_date}
            sourceId={latestStatus.source_id}
            onSourceClick={onSourceClick}
          />
        )}
        {latestOwner && (
          <StateField
            label="Owner"
            value={latestOwner.value}
            date={latestOwner.source_date}
            sourceId={latestOwner.source_id}
            onSourceClick={onSourceClick}
          />
        )}
        {latestDue && (
          <StateField
            label="Due"
            value={latestDue.value}
            date={latestDue.source_date}
            sourceId={latestDue.source_id}
            onSourceClick={onSourceClick}
          />
        )}
        {latestBlocker && (
          <StateField
            label="Blocker"
            value={latestBlocker.value}
            date={latestBlocker.source_date}
            sourceId={latestBlocker.source_id}
            onSourceClick={onSourceClick}
          />
        )}
        {latestAction && (
          <div className="md:col-span-2">
            <StateField
              label="Latest action"
              value={latestAction.value}
              date={latestAction.source_date}
              sourceId={latestAction.source_id}
              onSourceClick={onSourceClick}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function StateField({
  label,
  value,
  date,
  sourceId,
  onSourceClick,
}: {
  label: string;
  value: string;
  date: string;
  sourceId: string;
  onSourceClick: (id: string, highlight?: [number, number]) => void;
}) {
  return (
    <div className="flex flex-col">
      <div className="text-xs font-medium uppercase tracking-wider text-slate-500">
        {label}
      </div>
      <div className="mt-0.5 text-sm font-medium text-slate-900">
        {value}
      </div>
      <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-500">
        <span>{formatDate(date)}</span>
        <span>·</span>
        <button
          onClick={() => onSourceClick(sourceId)}
          className="text-slate-500 transition-colors hover:text-slate-900 hover:underline"
        >
          source
        </button>
      </div>
    </div>
  );
}

function pickLatest(facts: FactRow[], attrs: string[]): FactRow | null {
  const matches = facts.filter((f) =>
    attrs.includes(f.attribute.toLowerCase()),
  );
  if (matches.length === 0) return null;
  return matches.sort((a, b) =>
    (b.source_date ?? "").localeCompare(a.source_date ?? ""),
  )[0];
}

/**
 * Pick the latest fact whose attribute *contains* (or starts with) the
 * category. e.g. "action", "action_required", "action_target" all qualify
 * for category "action".
 */
function pickLatestByCategory(
  facts: FactRow[],
  category: string,
): FactRow | null {
  const matches = facts.filter((f) =>
    f.attribute.toLowerCase().includes(category),
  );
  if (matches.length === 0) return null;
  return matches.sort((a, b) =>
    (b.source_date ?? "").localeCompare(a.source_date ?? ""),
  )[0];
}

function newestFactDate(facts: FactRow[]): string | null {
  let latest = "";
  for (const f of facts) {
    if ((f.source_date ?? "") > latest) latest = f.source_date ?? "";
  }
  return latest ? formatDate(latest) : null;
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
