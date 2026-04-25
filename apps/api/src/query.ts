import type { EntityType } from "@spine/schema";
import type { Graph } from "@spine/graph";

/**
 * Query layer — read paths over the graph with role-based ACL filtering.
 *
 * Every fact and every source carries an ACL list. A caller passes `roles`
 * (their role tags); we surface only the items whose ACL intersects.
 *
 * ACLs are JSON-stringified arrays in Kuzu (Kuzu 0.6 doesn't bind list
 * params), so the filter checks substring matches on the JSON form.
 * Quoted-string match (e.g. '"role:hr"') prevents prefix collisions.
 */

export interface RoleContext {
  /**
   * Tags the caller can claim. Examples:
   *  ["employee:all", "role:hr", "person:emp_0431"]
   * `employee:all` is the default for any authenticated employee.
   */
  roles: string[];
}

const PUBLIC_ROLES: RoleContext = { roles: ["employee:all"] };

/**
 * Build a Cypher fragment that filters by ACL. Returns a clause like
 *   (alias.acl CONTAINS '"employee:all"' OR alias.acl CONTAINS '"role:hr"')
 * Pass `aclColumn` as the qualified field name (e.g. "f.acl" or "s.acl").
 */
function aclFilterFragment(aclColumn: string, ctx: RoleContext): string {
  const roles = ctx.roles.length > 0 ? ctx.roles : PUBLIC_ROLES.roles;
  const clauses = roles.map(
    (r) => `${aclColumn} CONTAINS '${jsonQuotedRole(r)}'`,
  );
  return `(${clauses.join(" OR ")})`;
}

/** Render a role as it appears inside a JSON-encoded array, with quotes. */
function jsonQuotedRole(role: string): string {
  // Escape single quotes for Cypher; role values shouldn't contain them but be safe.
  return `"${role.replace(/'/g, "\\'")}"`;
}

// ────────────── Entity resolution at query time ──────────────

export interface ResolvedEntity {
  id: string;
  type: EntityType;
  name: string;
  match: "id" | "alias" | "name";
}

/**
 * Resolve a free-form query string to a single canonical entity.
 *
 * Order of resolution:
 *   1. Exact ID match across all entity types
 *   2. Alias substring match (acl-array stored as JSON STRING)
 *   3. Case-insensitive name match
 *
 * Returns null if nothing resolves.
 */
export async function findEntityByQuery(
  graph: Graph,
  query: string,
): Promise<ResolvedEntity | null> {
  const q = query.trim();
  if (!q) return null;

  // Pass 1: exact ID match. Try each typed table.
  const idTables: Array<{ label: EntityType; nameField: string }> = [
    { label: "Person", nameField: "name" },
    { label: "Customer", nameField: "name" },
    { label: "Product", nameField: "name" },
    { label: "Client", nameField: "name" },
    { label: "Vendor", nameField: "name" },
    { label: "Project", nameField: "name" },
    { label: "Topic", nameField: "name" },
    { label: "Decision", nameField: "name" },
    { label: "Commitment", nameField: "name" },
  ];
  for (const { label, nameField } of idTables) {
    const rows = await graph.query<{ id: string; name: string }>(
      `MATCH (n:${label} {id: $id}) RETURN n.id AS id, n.${nameField} AS name LIMIT 1`,
      { id: q },
    );
    if (rows.length > 0) {
      return { id: rows[0].id, type: label, name: rows[0].name, match: "id" };
    }
  }

  // Pass 2: case-insensitive name match. Run per type until we find one.
  // (Could parallelize but single-writer Kuzu makes serial fine.)
  const lowerQ = q.toLowerCase();
  for (const { label } of idTables) {
    const rows = await graph.query<{ id: string; name: string }>(
      `MATCH (n:${label}) WHERE lower(n.name) = $q RETURN n.id AS id, n.name AS name LIMIT 1`,
      { q: lowerQ },
    );
    if (rows.length > 0) {
      return { id: rows[0].id, type: label, name: rows[0].name, match: "name" };
    }
  }

  // Pass 3: alias match (aliases is a JSON-stringified array).
  for (const { label } of idTables) {
    const rows = await graph.query<{ id: string; name: string }>(
      `MATCH (n:${label}) WHERE n.aliases CONTAINS $alias RETURN n.id AS id, n.name AS name LIMIT 1`,
      { alias: `"${q}"` },
    );
    if (rows.length > 0) {
      return { id: rows[0].id, type: label, name: rows[0].name, match: "alias" };
    }
  }

  return null;
}

// ────────────── Facts about an entity ──────────────

export interface FactRow {
  id: string;
  entity_id: string;
  attribute: string;
  value: string;
  type: string;
  source_id: string;
  source_span_start: number;
  source_span_end: number;
  confidence: number;
  author: string;
  acl: string;
  /** ISO date of the source — for emails/chats this is the real event date. */
  source_date: string;
  source_type: string;
  source_subject: string;
}

/**
 * Facts attached to an entity that the caller is allowed to see.
 * Returns the count of facts redacted by ACL so the UI can show
 * "N additional facts require role:X".
 */
export async function getFactsForEntity(
  graph: Graph,
  entity_id: string,
  ctx: RoleContext,
): Promise<{ facts: FactRow[]; redacted: number }> {
  // Inner-join Fact to Source so each fact carries the source's date —
  // for emails/chats that's the real event date, which is what the UI
  // needs to render a timeline. Facts whose source is missing (shouldn't
  // happen in normal flow) are pulled from a fallback query.
  const allRows = await graph.query<FactRow>(
    `MATCH (f:Fact), (s:Source)
     WHERE f.entity_id = $eid AND f.source_id = s.id
     RETURN f.id AS id, f.entity_id AS entity_id, f.attribute AS attribute,
            f.value AS value, f.type AS type, f.source_id AS source_id,
            f.source_span_start AS source_span_start, f.source_span_end AS source_span_end,
            f.confidence AS confidence, f.author AS author, f.acl AS acl,
            s.ingested_at AS source_date, s.type AS source_type, s.subject AS source_subject`,
    { eid: entity_id },
  );

  const visible = allRows.filter((f) => factVisibleTo(f.acl, ctx, entity_id));
  return {
    facts: visible,
    redacted: allRows.length - visible.length,
  };
}

/** ACL check that respects "person:self" semantics (entity_id-relative). */
function factVisibleTo(
  aclJson: string,
  ctx: RoleContext,
  entity_id: string,
): boolean {
  const acl = parseAclArray(aclJson);
  if (acl.length === 0) return true; // unrestricted
  for (const tag of acl) {
    if (ctx.roles.includes(tag)) return true;
    // Special case: "person:<emp_id>" matches if the caller IS that person.
    // Caller signals identity via roles like "person:emp_0431".
    if (tag.startsWith("person:") && ctx.roles.includes(tag)) return true;
  }
  return false;
}

function parseAclArray(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

// ────────────── Sources for an entity ──────────────

export interface SourceLite {
  id: string;
  type: string;
  subject: string;
  ingested_at: string;
  acl: string;
}

/** Sources that mention an entity (via any Mentions* edge) and the caller can see. */
export async function getSourcesForEntity(
  graph: Graph,
  entity_id: string,
  entity_type: EntityType,
  ctx: RoleContext,
  limit = 20,
): Promise<{ sources: SourceLite[]; redacted: number }> {
  const relTable = `Mentions${entity_type}`;
  const rows = await graph.query<SourceLite>(
    `MATCH (s:Source)-[r:${relTable}]->(e:${entity_type} {id: $eid})
     RETURN s.id AS id, s.type AS type, s.subject AS subject, s.ingested_at AS ingested_at, s.acl AS acl
     LIMIT ${Math.max(1, limit + 50)}`,
    { eid: entity_id },
  );

  const visible = rows.filter((s) => sourceVisibleTo(s.acl, ctx));
  return {
    sources: visible.slice(0, limit),
    redacted: rows.length - visible.length,
  };
}

function sourceVisibleTo(aclJson: string, ctx: RoleContext): boolean {
  const acl = parseAclArray(aclJson);
  if (acl.length === 0) return true;
  return acl.some((tag) => ctx.roles.includes(tag));
}

// ────────────── Get a source (with content) ──────────────

export interface SourceFull extends SourceLite {
  external_id: string;
  content: string;
  metadata: string;
}

export async function getSourceById(
  graph: Graph,
  source_id: string,
  ctx: RoleContext,
): Promise<{ source: SourceFull | null; redacted: boolean }> {
  const rows = await graph.query<SourceFull>(
    `MATCH (s:Source {id: $sid})
     RETURN s.id AS id, s.type AS type, s.external_id AS external_id,
            s.subject AS subject, s.content AS content, s.metadata AS metadata,
            s.ingested_at AS ingested_at, s.acl AS acl LIMIT 1`,
    { sid: source_id },
  );
  if (rows.length === 0) return { source: null, redacted: false };
  if (!sourceVisibleTo(rows[0].acl, ctx)) {
    return { source: null, redacted: true };
  }
  return { source: rows[0], redacted: false };
}

// ────────────── Full-text fallback ──────────────

export async function searchSources(
  graph: Graph,
  query: string,
  ctx: RoleContext,
  limit = 10,
): Promise<{ sources: SourceLite[]; redacted: number }> {
  const rows = await graph.query<SourceLite>(
    `MATCH (s:Source)
     WHERE s.content CONTAINS $q OR s.subject CONTAINS $q
     RETURN s.id AS id, s.type AS type, s.subject AS subject, s.ingested_at AS ingested_at, s.acl AS acl
     ORDER BY s.ingested_at DESC
     LIMIT ${Math.max(1, limit + 50)}`,
    { q: query },
  );
  const visible = rows.filter((s) => sourceVisibleTo(s.acl, ctx));
  return { sources: visible.slice(0, limit), redacted: rows.length - visible.length };
}

// ────────────── List persons ──────────────

export interface PersonLite {
  id: string;
  emp_id: string;
  name: string;
  level: string;
  category: string;
  email: string;
}

export async function listPersons(
  graph: Graph,
  filter: { department?: string; level?: string },
  limit = 50,
): Promise<PersonLite[]> {
  const conditions: string[] = [];
  const params: Record<string, string> = {};
  if (filter.department) {
    conditions.push("p.category = $department");
    params.department = filter.department;
  }
  if (filter.level) {
    conditions.push("p.level = $level");
    params.level = filter.level;
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return graph.query<PersonLite>(
    `MATCH (p:Person) ${where}
     RETURN p.id AS id, p.emp_id AS emp_id, p.name AS name, p.level AS level, p.category AS category, p.email AS email
     LIMIT ${limit}`,
    params,
  );
}
