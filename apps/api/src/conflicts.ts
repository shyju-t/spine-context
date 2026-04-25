import { randomUUID } from "node:crypto";
import type { Graph } from "@spine/graph";
import type { Fact } from "@spine/schema";
import { type FactRow, type RoleContext } from "./query.js";

/**
 * Conflict engine.
 *
 * A "conflict" is two or more facts about the same (entity_id, attribute)
 * with different values, where the caller can see at least two of those
 * values. We don't materialize Conflict nodes — conflicts are *derived*
 * from the Fact table at query time. Resolution writes an additional
 * Fact stamped with override_by + override_reason; the original facts
 * stay (history preserved).
 *
 * Attribute scope: we only consider attributes where having multiple
 * distinct values is genuinely a conflict (status, owner, due_date,
 * blocker, sentiment, etc.). Free-form attributes like "notes" or
 * "action" are skipped — multiple actions about the same entity are a
 * narrative, not a contradiction.
 */

/**
 * Conflict semantics depend on entity type. Same (entity, attribute) with
 * different values is only a *conflict* when having multiple distinct
 * values is logically incoherent.
 *
 * Counter-example surfaced in the demo: a Person had 4 different
 * `due_date` values across 4 emails. That's not a conflict — that's 4
 * different commitments that the LLM (wrongly) hung off the Person
 * instead of materializing as Commitment entities. Each is valid in
 * isolation.
 *
 * Real conflicts:
 *   - Person: ONE current_role, ONE level, ONE manager, ONE salary at a time.
 *   - Topic / Project / Commitment / Decision: ONE current status, owner,
 *     due_date, blocker per entity.
 *   - Customer / Vendor / Client: ONE industry, current_status, sentiment.
 *
 * Anything outside these (entity_type, attribute) pairs gets skipped at
 * the conflict detection layer. The facts still exist on the entity
 * page; they just don't deserve queue space.
 */
const CONFLICT_RULES: Record<string, Set<string>> = {
  // `role` deliberately excluded — the LLM extraction frequently
  // mis-attributes roles mentioned in email body text to the sender,
  // producing garbage conflicts (a single person with 10+ "roles").
  // Tracked in DEFERRED.md as an extraction-prompt fix.
  Person: new Set([
    "level",
    "department",
    "category",
    "manager",
    "reports_to",
    "salary",
    "performance_rating",
    "date_of_leaving",
  ]),
  Topic: new Set([
    "status",
    "state",
    "current_state",
    "owner",
    "current_owner",
    "due_date",
    "deadline",
    "blocker",
    "blocked_by",
  ]),
  Project: new Set([
    "status",
    "state",
    "current_state",
    "owner",
    "current_owner",
    "due_date",
    "deadline",
    "blocker",
    "blocked_by",
  ]),
  Commitment: new Set([
    "status",
    "owner",
    "due_date",
    "deadline",
    "blocker",
  ]),
  Decision: new Set(["decided_by", "decided_on", "status", "approved_by"]),
  Customer: new Set([
    "industry",
    "current_status",
    "sentiment",
    "current_poc_product",
  ]),
  Vendor: new Set([
    "industry",
    "current_status",
  ]),
  Client: new Set([
    "industry",
    "current_status",
    "poc_status",
    "contact_person_name",
  ]),
};

/** Returns the EntityType-prefix of an entity_id, e.g. "person/emp_X" → "Person". */
function entityTypeFromId(id: string): string | null {
  const prefix = id.split("/")[0]?.toLowerCase();
  switch (prefix) {
    case "person":
      return "Person";
    case "topic":
      return "Topic";
    case "project":
      return "Project";
    case "commitment":
      return "Commitment";
    case "decision":
      return "Decision";
    case "customer":
      return "Customer";
    case "vendor":
      return "Vendor";
    case "client":
      return "Client";
    case "product":
      return "Product";
    default:
      return null;
  }
}

/**
 * Build the flat attribute set for the WHERE clause — union of every
 * attribute we'd ever consider a conflict, across all entity types. We
 * filter by (entity_type, attribute) pair after the query in code.
 */
const CONFLICT_ATTRIBUTES = new Set<string>(
  Object.values(CONFLICT_RULES).flatMap((s) => [...s]),
);

export interface ConflictingFact {
  id: string;
  value: string;
  type: string;
  source_id: string;
  source_date: string;
  source_type: string;
  source_subject: string;
  confidence: number;
  author: string;
  acl: string;
  override_by: string | null;
  override_reason: string | null;
}

export interface Conflict {
  /** Stable identifier derived from entity+attribute — usable as a key. */
  id: string;
  entity_id: string;
  attribute: string;
  /** Number of distinct values — > 1 by definition. */
  distinct_values: number;
  facts: ConflictingFact[];
  /** True if any of the facts has been resolved via override. */
  has_resolution: boolean;
  /** The winning fact id (if resolved). */
  resolved_fact_id: string | null;
  resolved_by: string | null;
  resolved_reason: string | null;
}

interface FactWithSource extends FactRow {
  override_by: string | null;
  override_reason: string | null;
}

/**
 * Find conflicts visible to the caller. Pulls facts on the
 * conflict-prone attribute set, groups by (entity, attribute), and
 * keeps groups with >1 distinct value AND >=2 visible facts.
 */
export async function findConflicts(
  graph: Graph,
  ctx: RoleContext,
  limit = 50,
): Promise<Conflict[]> {
  // Pull all facts whose attribute is in the conflict-prone set, joined
  // to source for date context. Single query, group in code.
  const attrList = [...CONFLICT_ATTRIBUTES]
    .map((a) => `'${a}'`)
    .join(", ");

  const rows = await graph.query<FactWithSource>(
    `MATCH (f:Fact), (s:Source)
     WHERE f.attribute IN [${attrList}]
       AND f.source_id = s.id
     RETURN f.id AS id, f.entity_id AS entity_id, f.attribute AS attribute,
            f.value AS value, f.type AS type, f.source_id AS source_id,
            f.source_span_start AS source_span_start, f.source_span_end AS source_span_end,
            f.confidence AS confidence, f.author AS author, f.acl AS acl,
            f.override_by AS override_by, f.override_reason AS override_reason,
            s.ingested_at AS source_date, s.type AS source_type, s.subject AS source_subject`,
  );

  // Filter by ACL — we only show conflicts where the caller can see ≥2 facts
  const visible = rows.filter((f) => factVisibleTo(f.acl, ctx));

  // Group by (entity_id, attribute)
  const groups = new Map<string, FactWithSource[]>();
  for (const f of visible) {
    const key = `${f.entity_id}::${f.attribute}`;
    const arr = groups.get(key) ?? [];
    arr.push(f);
    groups.set(key, arr);
  }

  const conflicts: Conflict[] = [];
  for (const [key, facts] of groups) {
    if (facts.length < 2) continue;

    // Prose-shape filter: real status/role/blocker values are short
    // labels. If any value in this group is sentence-shaped (long, lots
    // of words), the LLM probably hallucinated a description as a fact.
    // Skip the whole group — the conflict isn't real.
    if (facts.some((f) => looksLikeProse(f.value))) continue;

    // Cluster values by substring containment (case + whitespace
    // normalized). Same role at different specificity ("Software Engineer"
    // vs "Software Engineer, EN10") collapses into one cluster — not a
    // conflict. Distinct unrelated values ("shipped" vs "blocked") stay
    // separate. Real cluster count, not raw distinct count, decides.
    const rawValues = [...new Set(facts.map((f) => f.value))];
    const clusters = clusterByContainment(rawValues);
    if (clusters.length < 2) continue;

    // Entity-type-aware filter: same (entity, attribute) with multiple
    // values is a *conflict* only when the attribute is conflict-worthy
    // for that entity's type. Filters out e.g. multiple due_dates on a
    // Person (which is just multiple commitments, not a contradiction).
    const sample = facts[0];
    const entityType = entityTypeFromId(sample.entity_id);
    if (entityType) {
      const attrSet = CONFLICT_RULES[entityType];
      if (!attrSet || !attrSet.has(sample.attribute.toLowerCase())) continue;
    }
    // For unknown entity-id prefixes (e.g. "new_entity/...") the LLM
    // violated naming; we still want those surfaced because they're often
    // real Topic-class conflicts under a wrong prefix. Fall through.

    // Sort: latest source_date first, then highest confidence.
    facts.sort((a, b) => {
      const cmp = (b.source_date ?? "").localeCompare(a.source_date ?? "");
      if (cmp !== 0) return cmp;
      return (b.confidence ?? 0) - (a.confidence ?? 0);
    });

    const overrideFact = facts.find((f) => f.override_by);

    const [entity_id, attribute] = key.split("::");
    conflicts.push({
      id: stableId(entity_id, attribute),
      entity_id,
      attribute,
      distinct_values: clusters.length,
      facts: facts.map((f) => ({
        id: f.id,
        value: f.value,
        type: f.type,
        source_id: f.source_id,
        source_date: f.source_date,
        source_type: f.source_type,
        source_subject: f.source_subject,
        confidence: f.confidence,
        author: f.author,
        acl: f.acl,
        override_by: f.override_by,
        override_reason: f.override_reason,
      })),
      has_resolution: Boolean(overrideFact),
      resolved_fact_id: overrideFact?.id ?? null,
      resolved_by: overrideFact?.override_by ?? null,
      resolved_reason: overrideFact?.override_reason ?? null,
    });
  }

  // Sort: unresolved first; within each, by recency of latest fact.
  conflicts.sort((a, b) => {
    if (a.has_resolution !== b.has_resolution) {
      return a.has_resolution ? 1 : -1;
    }
    const aLatest = a.facts[0]?.source_date ?? "";
    const bLatest = b.facts[0]?.source_date ?? "";
    return bLatest.localeCompare(aLatest);
  });

  return conflicts.slice(0, limit);
}

/**
 * Resolve a conflict by stamping a winning fact with override metadata.
 * Implementation: write a NEW Fact identical to the chosen one but with
 * override_by, override_reason, author=human, confidence=1.0. The
 * original facts stay; queries will see the override-stamped one as
 * authoritative.
 */
export interface ResolveInput {
  winning_fact_id: string;
  resolved_by_user: string;     // e.g. "user:emp_0431" or "user:demo-reviewer"
  reason: string;
}

export async function resolveConflict(
  graph: Graph,
  input: ResolveInput,
): Promise<{ override_fact_id: string }> {
  // 1. Load the winning fact.
  const rows = await graph.query<FactRow & { override_by: string; override_reason: string }>(
    `MATCH (f:Fact {id: $fid}) RETURN f.id AS id, f.entity_id AS entity_id,
            f.attribute AS attribute, f.value AS value, f.type AS type,
            f.source_id AS source_id, f.source_span_start AS source_span_start,
            f.source_span_end AS source_span_end, f.confidence AS confidence,
            f.author AS author, f.acl AS acl`,
    { fid: input.winning_fact_id },
  );
  if (rows.length === 0) {
    throw new Error(`No fact found with id=${input.winning_fact_id}`);
  }
  const winner = rows[0];

  // 2. Write a new Fact with override metadata. Same value as the winner;
  //    the override stamp marks it as the human-blessed authoritative one.
  const overrideId = randomUUID();
  const aclArr = parseAcl(winner.acl);
  const overrideFact: Fact = {
    id: overrideId,
    entity_id: winner.entity_id,
    attribute: winner.attribute,
    value: winner.value,
    type: winner.type as Fact["type"],
    valid_from: null,
    valid_to: null,
    tx_from: new Date(),
    tx_to: null,
    source_id: winner.source_id,
    source_span:
      winner.source_span_start >= 0 && winner.source_span_end >= 0
        ? [winner.source_span_start, winner.source_span_end]
        : null,
    confidence: 1.0,
    author: `human:${input.resolved_by_user}`,
    acl: aclArr,
    override_by: input.resolved_by_user,
    override_reason: input.reason,
  };
  await graph.insertFact(overrideFact);

  return { override_fact_id: overrideId };
}

// ───── helpers ─────

function factVisibleTo(aclJson: string, ctx: RoleContext): boolean {
  if (!aclJson) return true;
  try {
    const acl = JSON.parse(aclJson) as string[];
    if (!Array.isArray(acl) || acl.length === 0) return true;
    return acl.some((tag) => ctx.roles.includes(tag));
  } catch {
    return true;
  }
}

function stableId(entity_id: string, attribute: string): string {
  // Slug-friendly stable ID for a conflict group.
  return `conflict/${entity_id.replace(/[^A-Za-z0-9_-]/g, "_")}::${attribute}`;
}

/**
 * Cluster values by substring containment under normalization. Two
 * values belong to the same cluster if (case + whitespace normalized)
 * one is contained in the other — i.e., they're the same fact at
 * different specificity. Returns one canonical (longest) value per
 * cluster.
 *
 * Examples:
 *   ["Software Engineer", "Software Engineer, EN10"]   → 1 cluster
 *   ["shipped", "blocked"]                              → 2 clusters
 *   ["Q3", "Thursday"]                                  → 2 clusters
 *   ["approved by CEO", "approved by CEO on Jan 10"]    → 1 cluster
 */
function clusterByContainment(values: string[]): string[] {
  if (values.length <= 1) return values;
  // Sort longest first so the canonical winner is the most specific value.
  const sorted = [...values].sort(
    (a, b) => normalize(b).length - normalize(a).length,
  );
  const clusters: string[] = [];
  for (const v of sorted) {
    const nv = normalize(v);
    if (nv.length === 0) continue;
    const merged = clusters.some((c) => {
      const nc = normalize(c);
      return nc.includes(nv) || nv.includes(nc);
    });
    if (!merged) clusters.push(v);
  }
  return clusters;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Heuristic: a real categorical value (a role, a status, a blocker tag,
 * a date) is short. If a fact's value looks like a sentence, it's
 * almost certainly the LLM mistaking descriptive prose for a label,
 * not a real conflict candidate.
 *
 * Thresholds: > 60 chars OR > 7 words OR ends with sentence punctuation.
 */
function looksLikeProse(v: string | null | undefined): boolean {
  if (!v) return false;
  const s = v.trim();
  if (s.length > 60) return true;
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length > 7) return true;
  if (/[.!?]$/.test(s) && words.length > 3) return true;
  return false;
}

function parseAcl(json: string | null | undefined): string[] {
  if (!json) return ["employee:all"];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as string[]) : ["employee:all"];
  } catch {
    return ["employee:all"];
  }
}
