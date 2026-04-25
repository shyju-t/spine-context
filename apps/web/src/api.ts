// Thin fetch wrappers around the spine HTTP API.

const API = "/api";

export interface ResolvedEntity {
  id: string;
  type: string;
  name: string;
  match: string;
}

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
  source_date: string;
  source_type: string;
  source_subject: string;
}

export interface SourceLite {
  id: string;
  type: string;
  subject: string;
  ingested_at: string;
  acl: string;
}

export interface SourceFull extends SourceLite {
  external_id: string;
  content: string;
  metadata: string;
}

export interface GraphStats {
  sources: number;
  persons: number;
  customers: number;
  vendors: number;
  clients: number;
  products: number;
  topics: number;
  projects: number;
  facts: number;
  entities: number;
}

export async function getStats(): Promise<GraphStats> {
  const r = await fetch(`${API}/stats`);
  if (!r.ok) throw new Error(`getStats failed: ${r.status}`);
  return r.json();
}

export interface PersonLite {
  id: string;
  emp_id: string;
  name: string;
  level: string;
  category: string;
  email: string;
}

export interface SearchResultEntity {
  kind: "entity_hit";
  entity: ResolvedEntity;
  facts: FactRow[];
  sources: SourceLite[];
  redacted_facts: number;
  redacted_sources: number;
}

export interface SearchResultSources {
  kind: "source_hits";
  sources: SourceLite[];
  redacted_sources: number;
}

export type SearchResult = SearchResultEntity | SearchResultSources;

function asRoleQuery(roles: string[]): string {
  return `as_role=${encodeURIComponent(roles.join(","))}`;
}

export async function search(
  query: string,
  roles: string[],
): Promise<SearchResult> {
  const r = await fetch(
    `${API}/search?q=${encodeURIComponent(query)}&${asRoleQuery(roles)}`,
  );
  if (!r.ok) throw new Error(`search failed: ${r.status}`);
  return r.json();
}

export async function getEntity(query: string, roles: string[]) {
  const r = await fetch(
    `${API}/entity?q=${encodeURIComponent(query)}&${asRoleQuery(roles)}`,
  );
  if (!r.ok) throw new Error(`getEntity failed: ${r.status}`);
  return r.json() as Promise<{
    entity: ResolvedEntity | null;
    facts: FactRow[];
    sources: SourceLite[];
    redacted_facts: number;
    redacted_sources: number;
  }>;
}

export async function getSource(
  source_id: string,
  roles: string[],
): Promise<{ source: SourceFull | null; redacted?: boolean; message?: string }> {
  const r = await fetch(
    `${API}/source/${encodeURI(source_id)}?${asRoleQuery(roles)}`,
  );
  return r.json();
}

export async function listPersons(
  filter: { department?: string; level?: string },
  limit = 50,
): Promise<{ persons: PersonLite[] }> {
  const params = new URLSearchParams();
  if (filter.department) params.set("department", filter.department);
  if (filter.level) params.set("level", filter.level);
  params.set("limit", String(limit));
  const r = await fetch(`${API}/persons?${params.toString()}`);
  if (!r.ok) throw new Error(`listPersons failed: ${r.status}`);
  return r.json();
}

// ───────── Conflicts ─────────

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
  id: string;
  entity_id: string;
  attribute: string;
  distinct_values: number;
  facts: ConflictingFact[];
  has_resolution: boolean;
  resolved_fact_id: string | null;
  resolved_by: string | null;
  resolved_reason: string | null;
}

export async function listConflicts(
  roles: string[],
  limit = 50,
): Promise<{ conflicts: Conflict[] }> {
  const r = await fetch(
    `${API}/conflicts?${asRoleQuery(roles)}&limit=${limit}`,
  );
  if (!r.ok) throw new Error(`listConflicts failed: ${r.status}`);
  return r.json();
}

export async function resolveConflict(input: {
  winning_fact_id: string;
  resolved_by_user: string;
  reason: string;
}): Promise<{ override_fact_id: string }> {
  const r = await fetch(`${API}/conflicts/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!r.ok) throw new Error(`resolveConflict failed: ${r.status}`);
  return r.json();
}
