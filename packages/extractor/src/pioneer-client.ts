/**
 * Pioneer GLiNER2 extraction backend.
 *
 * GLiNER2 is purpose-built for schema-driven entity/relation extraction —
 * the schema language matches Spine's data model 1:1, so we can run
 * extraction without prompts at all. We send the schema once with each
 * request, the model returns typed spans + relations, and we map them
 * back into the same `ExtractorOutput` shape Gemini emits.
 *
 * Routing decision lives in extractor.ts (`pioneer/...` model id triggers
 * this path; `gemini-*` keeps the existing prompt-based path).
 *
 * v1 scope: entities + relations. Classifications and structures are
 * deferred — their fit to the Fact schema needs more thought (see
 * pioneer-schema.ts for the closed-schema exploration).
 */

import type { LocalResolver } from "@spine/resolver";
import type { SourceRecord } from "@spine/schema";
import { SPINE_SCHEMA } from "./pioneer-schema.js";
import type {
  ExtractedFact,
  ExtractorOutput,
  NewEntity,
} from "./types.js";

// ──────────────────────── Wire types ────────────────────────

/**
 * GLiNER2 entity span as returned by Pioneer.
 *
 * `text` is the surface form; `span` is the [start, end) char offset into
 * the input text when `include_spans=true`. `confidence` is 0..1 when
 * `include_confidence=true`.
 */
interface GLiNER2Entity {
  type: string;
  text: string;
  span?: [number, number];
  confidence?: number;
}

interface GLiNER2RelationParticipant {
  type: string;
  text: string;
  span?: [number, number];
}

interface GLiNER2Relation {
  type: string;
  subject: GLiNER2RelationParticipant;
  object: GLiNER2RelationParticipant;
  span?: [number, number];
  confidence?: number;
}

interface GLiNER2Output {
  entities?: GLiNER2Entity[];
  relations?: GLiNER2Relation[];
}

interface ChatCompletionsResponse {
  choices: Array<{
    message: { content: string | GLiNER2Output };
  }>;
}

// ──────────────────────── Schema ────────────────────────

/**
 * Relations we ask GLiNER2 to extract. Each maps to a Fact attribute on
 * the subject entity. Keep this list short — every relation costs
 * inference work and noisy relations pollute the conflict queue.
 */
const RUNTIME_RELATIONS = [
  "manages",
  "reports_to",
  "owns",
  "assigned_to",
  "blocks",
  "blocked_by",
  "decided_by",
  "due_on",
  "discussed_with",
] as const;

type RuntimeRelation = (typeof RUNTIME_RELATIONS)[number];

/**
 * The GLiNER2 schema we send with every extraction request. Built from
 * SPINE_SCHEMA (single source of truth for entity types) plus the
 * runtime relation list.
 */
function buildPioneerSchema(): {
  entities: string[];
  relations: string[];
} {
  return {
    entities: SPINE_SCHEMA.entities.map((e) => e.type),
    relations: [...RUNTIME_RELATIONS],
  };
}

// ──────────────────────── Mapping ────────────────────────

const NEW_ENTITY_TYPES = new Set([
  "topic",
  "project",
  "decision",
  "commitment",
]);
const REGISTRY_ENTITY_TYPES = new Set([
  "person",
  "customer",
  "client",
  "vendor",
  "product",
]);

/**
 * Map a relation type to the Fact attribute name we store on the subject.
 * Most are 1:1; `discussed_with` becomes `mentions` because that's how
 * the rest of the pipeline (Mentions edges) names it.
 */
const RELATION_TO_ATTRIBUTE: Record<RuntimeRelation, string> = {
  manages: "manages",
  reports_to: "reports_to",
  owns: "owner",
  assigned_to: "assigned_to",
  blocks: "blocks",
  blocked_by: "blocker",
  decided_by: "decided_by",
  due_on: "due_date",
  discussed_with: "discussed_with",
};

/**
 * Trajectory relations describe time-varying state (ownership, assignment,
 * blockers can shift). Identity-style relations (manages, reports_to) are
 * static. Everything else defaults to trajectory — closer to "what's
 * happening now" than "this is forever true".
 */
const STATIC_RELATIONS = new Set<RuntimeRelation>(["manages", "reports_to"]);

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

/**
 * Given resolver output for the source content, build a quick lookup from
 * lowercased surface text to (canonical_id, canonical_entity_type). We
 * use this to bind GLiNER2's text spans back to canonical IDs.
 */
function buildSurfaceIndex(
  resolver: LocalResolver,
  content: string,
): Map<string, { id: string; type: string }> {
  const idx = new Map<string, { id: string; type: string }>();
  const mentions = resolver.resolve(content, {});
  // Sort by confidence desc so the highest-confidence mapping wins on
  // surface collisions (common first names, ambiguous initials, etc.)
  const sorted = [...mentions].sort((a, b) => b.confidence - a.confidence);
  for (const m of sorted) {
    const key = m.surface.toLowerCase();
    if (!idx.has(key)) {
      idx.set(key, { id: m.entity_id, type: m.entity_type.toLowerCase() });
    }
  }
  return idx;
}

/**
 * Convert GLiNER2's response into Spine's `ExtractorOutput`.
 *
 * - Detected `topic/project/decision/commitment` spans become `new_entities`
 *   (one per distinct surface text), with proposed_id `<type>/<slug>`.
 * - Detected `person/customer/client/vendor/product` spans get resolved
 *   against the LocalResolver. If they don't resolve, they're dropped —
 *   we don't invent registry entries from text alone.
 * - Each relation becomes one Fact on the subject entity.
 *
 * Entities the extractor sees but doesn't issue a fact for are still
 * useful (they get reflected as Mentions edges by the ingest pipeline,
 * which uses our resolver pre-pass independently).
 */
export function pioneerToExtractorOutput(
  raw: GLiNER2Output,
  source: SourceRecord,
  resolver: LocalResolver,
): ExtractorOutput {
  const detectedEntities = raw.entities ?? [];
  const detectedRelations = raw.relations ?? [];

  const surfaceIndex = buildSurfaceIndex(resolver, source.content);

  // Pass 1 — register proposed_ids for new-style entities. Keyed by the
  // exact surface text so the relation pass can rebind to the same ID
  // (we don't slugify twice).
  const new_entities: NewEntity[] = [];
  const proposedByText = new Map<string, string>();
  const seenProposed = new Set<string>();
  for (const ent of detectedEntities) {
    const t = ent.type.toLowerCase();
    if (!NEW_ENTITY_TYPES.has(t)) continue;
    const slug = slugify(ent.text);
    if (!slug) continue;
    const proposedId = `${t}/${slug}`;
    if (seenProposed.has(proposedId)) continue;
    seenProposed.add(proposedId);
    proposedByText.set(ent.text, proposedId);
    new_entities.push({
      type: capitalize(t) as NewEntity["type"],
      proposed_id: proposedId,
      name: ent.text.slice(0, 120),
      aliases: [],
    });
  }

  // Resolve any entity span (registry or new) to a canonical or proposed ID.
  const resolveEntity = (
    text: string,
    type: string,
  ): { id: string; type: string } | null => {
    const t = type.toLowerCase();
    if (NEW_ENTITY_TYPES.has(t)) {
      const id = proposedByText.get(text);
      if (id) return { id, type: t };
      // Span seen as a relation participant but not in the entities list?
      // Slugify on the fly and add it (defensive — happens with messy outputs).
      const slug = slugify(text);
      if (!slug) return null;
      const proposedId = `${t}/${slug}`;
      if (!seenProposed.has(proposedId)) {
        seenProposed.add(proposedId);
        proposedByText.set(text, proposedId);
        new_entities.push({
          type: capitalize(t) as NewEntity["type"],
          proposed_id: proposedId,
          name: text.slice(0, 120),
          aliases: [],
        });
      }
      return { id: proposedId, type: t };
    }
    if (REGISTRY_ENTITY_TYPES.has(t)) {
      const hit = surfaceIndex.get(text.toLowerCase());
      if (!hit) return null;
      // Sanity: only accept the resolver mapping when the type lines up.
      // Otherwise GLiNER2 mis-typed the span (e.g. customer name flagged
      // as person), and we'd write a fact about the wrong entity_id.
      if (hit.type !== t) return null;
      return hit;
    }
    return null;
  };

  // Pass 2 — relations become facts.
  const facts: ExtractedFact[] = [];
  for (const rel of detectedRelations) {
    const relType = rel.type.toLowerCase() as RuntimeRelation;
    if (!RELATION_TO_ATTRIBUTE[relType]) continue;
    const subj = resolveEntity(rel.subject.text, rel.subject.type);
    const obj = resolveEntity(rel.object.text, rel.object.type);
    if (!subj || !obj) continue;

    const span = rel.span ?? null;
    facts.push({
      entity_id: subj.id,
      attribute: RELATION_TO_ATTRIBUTE[relType],
      value: obj.id,
      fact_type: STATIC_RELATIONS.has(relType) ? "static" : "trajectory",
      confidence: rel.confidence ?? 0.7,
      source_span_start: span ? span[0] : null,
      source_span_end: span ? span[1] : null,
    });
  }

  return { new_entities, facts };
}

// ──────────────────────── HTTP call ────────────────────────

export interface PioneerCallOptions {
  apiKey: string;
  /** Full Pioneer model id, e.g. "fastino/gliner2-multi-large-v1". */
  model: string;
  source: SourceRecord;
  resolver: LocalResolver;
  /** Override base URL for tests/mocks. Default: https://api.pioneer.ai/v1 */
  baseUrl?: string;
  /** Request timeout in ms. Default: 30s. */
  timeoutMs?: number;
}

export interface PioneerCallResult {
  output: ExtractorOutput;
  raw: GLiNER2Output;
}

/**
 * Call Pioneer's chat-completions endpoint with the GLiNER2 schema and
 * map the result into Spine's `ExtractorOutput`.
 *
 * Errors out on non-2xx with the raw body — let the caller decide whether
 * to retry, fall back, or skip.
 */
export async function callPioneer(
  opts: PioneerCallOptions,
): Promise<PioneerCallResult> {
  const baseUrl = opts.baseUrl ?? "https://api.pioneer.ai/v1";
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const body = {
    model: opts.model,
    messages: [{ role: "user", content: opts.source.content }],
    schema: buildPioneerSchema(),
    include_confidence: true,
    include_spans: true,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "<no body>");
    throw new Error(
      `Pioneer ${res.status} ${res.statusText}: ${text.slice(0, 500)}`,
    );
  }

  const json = (await res.json()) as ChatCompletionsResponse;
  const messageContent = json.choices?.[0]?.message?.content;
  if (messageContent === undefined) {
    throw new Error(
      `Pioneer response missing choices[0].message.content: ${JSON.stringify(json).slice(0, 500)}`,
    );
  }

  // Pioneer may return the structured object inline OR as a JSON string.
  // Handle both transparently.
  const raw: GLiNER2Output =
    typeof messageContent === "string"
      ? (JSON.parse(messageContent) as GLiNER2Output)
      : messageContent;

  const output = pioneerToExtractorOutput(raw, opts.source, opts.resolver);
  return { output, raw };
}

/** Exposed for tests / debug tooling. */
export const __internals = { buildPioneerSchema, slugify };
