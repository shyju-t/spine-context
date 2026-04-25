/**
 * Demo-entity ranker — picks the strongest hero for the Loom.
 *
 * Scores every Project / Topic / Commitment by:
 *   - factCount         (more facts = richer page)
 *   - sourceTypeCount   (multiple silos contributing = "compiled across sources")
 *   - sourceCount       (raw distinct source ids)
 *   - hasConflict       (do any of its facts collide on a conflict-prone attr?)
 *   - hasRestrictedAcl  (any fact with non-public ACL? proves role-switching)
 *   - hasTimeline       (>= 3 distinct timestamps among facts)
 *   - hasStatus / hasOwner / hasDueDate / hasBlocker (the current-state card)
 *
 * Run: npx tsx apps/api/src/rank-demo-entities.ts [--top N] [--db PATH]
 */

import { Graph } from "@spine/graph";

const CONFLICT_ATTRS: Record<string, Set<string>> = {
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
};

const STATUS_ATTRS = new Set([
  "status",
  "state",
  "current_state",
  "current_status",
]);
const OWNER_ATTRS = new Set(["owner", "current_owner", "assigned_to"]);
const DUE_ATTRS = new Set(["due_date", "deadline"]);
const BLOCKER_ATTRS = new Set(["blocker", "blocked_by"]);

interface FactRow {
  id: string;
  entity_id: string;
  attribute: string;
  value: string;
  acl: string;
  source_id: string;
  valid_from: string | null;
}

interface Scored {
  entityId: string;
  entityType: string;
  factCount: number;
  sourceCount: number;
  sourceTypes: Set<string>;
  conflictAttrs: string[];
  restrictedAcl: boolean;
  hasStatus: boolean;
  hasOwner: boolean;
  hasDueDate: boolean;
  hasBlocker: boolean;
  timelineSpread: number;
  score: number;
  why: string[];
}

function entityTypeFromId(id: string): string | null {
  const prefix = id.split("/")[0]?.toLowerCase();
  if (prefix === "topic") return "Topic";
  if (prefix === "project") return "Project";
  if (prefix === "commitment") return "Commitment";
  return null;
}

function looksLikeProse(value: string): boolean {
  return value.length > 60 || value.split(/\s+/).length > 7;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const topIdx = args.indexOf("--top");
  const top = topIdx >= 0 ? Number(args[topIdx + 1]) : 8;
  const dbIdx = args.indexOf("--db");
  const dbPath = dbIdx >= 0 ? args[dbIdx + 1]! : "data/spine.db";

  const graph = new Graph(dbPath);

  // Pull every fact whose entity is a Project/Topic/Commitment.
  const rows = await graph.query<FactRow>(`
    MATCH (f:Fact)
    WHERE f.entity_id STARTS WITH 'topic/'
       OR f.entity_id STARTS WITH 'project/'
       OR f.entity_id STARTS WITH 'commitment/'
    RETURN f.id AS id,
           f.entity_id AS entity_id,
           f.attribute AS attribute,
           f.value AS value,
           f.acl AS acl,
           f.source_id AS source_id,
           f.valid_from AS valid_from
  `);

  // Pull source-id -> source-type map so we can count silo diversity.
  const srcRows = await graph.query<{ id: string; type: string }>(`
    MATCH (s:Source)
    RETURN s.id AS id, s.type AS type
  `);
  const sourceTypeOf = new Map(srcRows.map((r) => [r.id, r.type]));

  // Group by entity_id.
  type Bucket = {
    facts: FactRow[];
    byAttr: Map<string, Set<string>>;
  };
  const groups = new Map<string, Bucket>();
  for (const r of rows) {
    let g = groups.get(r.entity_id);
    if (!g) {
      g = { facts: [], byAttr: new Map() };
      groups.set(r.entity_id, g);
    }
    g.facts.push(r);
    const lower = r.attribute.toLowerCase();
    let set = g.byAttr.get(lower);
    if (!set) {
      set = new Set();
      g.byAttr.set(lower, set);
    }
    set.add(r.value);
  }

  const scored: Scored[] = [];
  for (const [entityId, bucket] of groups) {
    const entityType = entityTypeFromId(entityId);
    if (!entityType) continue;

    const factCount = bucket.facts.length;
    if (factCount < 3) continue; // skip thin entities

    const sourceIds = new Set(bucket.facts.map((f) => f.source_id));
    const sourceTypes = new Set<string>();
    for (const sid of sourceIds) {
      const t = sourceTypeOf.get(sid);
      if (t) sourceTypes.add(t);
    }

    const conflictRules = CONFLICT_ATTRS[entityType] ?? new Set();
    const conflictAttrs: string[] = [];
    for (const [attr, vals] of bucket.byAttr) {
      if (!conflictRules.has(attr)) continue;
      // multiple distinct, non-prose values → conflict candidate
      const cleanVals = [...vals].filter((v) => !looksLikeProse(v));
      if (cleanVals.length >= 2) conflictAttrs.push(attr);
    }

    const restrictedAcl = bucket.facts.some(
      (f) => f.acl && !f.acl.includes("employee:all"),
    );

    const attrLowerSet = new Set([...bucket.byAttr.keys()]);
    const hasStatus = [...attrLowerSet].some((a) => STATUS_ATTRS.has(a));
    const hasOwner = [...attrLowerSet].some((a) => OWNER_ATTRS.has(a));
    const hasDueDate = [...attrLowerSet].some((a) => DUE_ATTRS.has(a));
    const hasBlocker = [...attrLowerSet].some((a) => BLOCKER_ATTRS.has(a));

    const validFroms = new Set(
      bucket.facts.map((f) => f.valid_from).filter(Boolean),
    );
    const timelineSpread = validFroms.size;

    // Demo-worthiness score. Weights tuned to favour entities that let
    // the Loom hit every Spine differentiator: provenance (sources),
    // ACL switch (restricted), conflicts (queue), timeline, current state.
    let score = 0;
    score += Math.min(factCount, 30); // saturate at 30
    score += sourceTypes.size * 8; // each silo adds a lot
    score += Math.min(sourceIds.size, 10) * 2;
    score += conflictAttrs.length * 12; // conflicts are gold
    score += restrictedAcl ? 8 : 0;
    score += hasStatus ? 5 : 0;
    score += hasOwner ? 5 : 0;
    score += hasDueDate ? 4 : 0;
    score += hasBlocker ? 4 : 0;
    score += Math.min(timelineSpread, 8) * 2;

    const why: string[] = [];
    why.push(`${factCount} facts`);
    why.push(`${sourceTypes.size} silo(s): ${[...sourceTypes].join("/")}`);
    if (conflictAttrs.length)
      why.push(`conflict on: ${conflictAttrs.join(",")}`);
    if (restrictedAcl) why.push(`has restricted ACL`);
    const cardBits: string[] = [];
    if (hasStatus) cardBits.push("status");
    if (hasOwner) cardBits.push("owner");
    if (hasDueDate) cardBits.push("due");
    if (hasBlocker) cardBits.push("blocker");
    if (cardBits.length) why.push(`current-state: ${cardBits.join("+")}`);
    if (timelineSpread >= 3) why.push(`${timelineSpread} timeline points`);

    scored.push({
      entityId,
      entityType,
      factCount,
      sourceCount: sourceIds.size,
      sourceTypes,
      conflictAttrs,
      restrictedAcl,
      hasStatus,
      hasOwner,
      hasDueDate,
      hasBlocker,
      timelineSpread,
      score,
      why,
    });
  }

  scored.sort((a, b) => b.score - a.score);

  console.log(`\nRanked top ${top} demo candidates (out of ${scored.length}):\n`);
  for (const s of scored.slice(0, top)) {
    console.log(`  [${s.score}] ${s.entityId}  (${s.entityType})`);
    console.log(`        ${s.why.join("  •  ")}`);
    console.log();
  }

  // Tier breakdown
  const projects = scored.filter((s) => s.entityType === "Project");
  const topics = scored.filter((s) => s.entityType === "Topic");
  const commits = scored.filter((s) => s.entityType === "Commitment");

  console.log(`Tier counts: Project=${projects.length}, Topic=${topics.length}, Commitment=${commits.length}`);
  console.log();
  console.log(`Top Project:    ${projects[0]?.entityId ?? "(none)"} [${projects[0]?.score ?? 0}]`);
  console.log(`Top Topic:      ${topics[0]?.entityId ?? "(none)"} [${topics[0]?.score ?? 0}]`);
  console.log(`Top Commitment: ${commits[0]?.entityId ?? "(none)"} [${commits[0]?.score ?? 0}]`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
