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
//
// Pioneer's GLiNER2 wraps the structured payload as a JSON string inside
// the OpenAI chat-completions envelope (choices[0].message.content). The
// structured payload itself uses object-keyed-by-type for entities and
// relations rather than a flat tagged array — flattening happens in the
// mapper below so the rest of the pipeline doesn't have to know.
//
// Example shape (abridged):
//   {
//     "entities": {
//       "person":  [{"text": "Alice", "start": 3, "end": 8, "confidence": 0.99}],
//       "project": [{"text": "Phoenix", "start": 30, "end": 55, "confidence": 0.97}]
//     },
//     "relation_extraction": {
//       "owns":   [{"head": {"text": "Bob", "start": ...}, "tail": {"text": "schema", "start": ...}}],
//       "due_on": [...]
//     }
//   }

interface GLiNER2Span {
  text: string;
  start?: number;
  end?: number;
  confidence?: number;
}

interface GLiNER2Relation {
  head: GLiNER2Span;
  tail: GLiNER2Span;
  confidence?: number;
}

interface GLiNER2Output {
  entities?: Record<string, GLiNER2Span[]>;
  relation_extraction?: Record<string, GLiNER2Relation[]>;
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

/**
 * Relations whose tail is a literal string (typically a date), not an
 * entity reference. We store the tail.text verbatim as the fact value
 * instead of trying to resolve it to an entity_id.
 *
 * GLiNER2 doesn't have a built-in "date" entity type in our schema, so
 * the tail text stays as-is — downstream conflict detection and timeline
 * code already handles raw date strings (DOJ, deadline, etc).
 */
const LITERAL_TAIL_RELATIONS = new Set<RuntimeRelation>(["due_on"]);

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
 * Confidence threshold for accepting an entity-type assignment when the
 * same span is tagged with multiple types (a common GLiNER2 quirk —
 * "Acme Corp" comes back as both customer:0.94 and client:0.54). We
 * keep the highest-confidence one and drop the others.
 */
const MIN_TYPE_CONFIDENCE = 0.55;

/**
 * Convert GLiNER2's response into Spine's `ExtractorOutput`.
 *
 * Pipeline:
 *  1. Flatten the type-keyed `entities` object into a single span list
 *     where each span has its strongest type (resolves overlap noise).
 *  2. New-style entities (topic/project/decision/commitment) become
 *     `new_entities` with `proposed_id = <type>/<slug>`.
 *  3. Registry-style entities (person/customer/...) get resolved against
 *     the LocalResolver to canonical IDs. Unresolved registry spans
 *     are dropped — we don't invent registry entries from text alone.
 *  4. Each `relation_extraction[<rel>]` triple → one Fact on the head
 *     entity. Both head and tail have their entity types looked up by
 *     text against the flattened entity map; relations whose head or
 *     tail can't be typed/resolved are dropped.
 */
export function pioneerToExtractorOutput(
  raw: GLiNER2Output,
  source: SourceRecord,
  resolver: LocalResolver,
): ExtractorOutput {
  const entitiesByType = raw.entities ?? {};
  const relationsByType = raw.relation_extraction ?? {};

  // Pass 0 — flatten entity object-of-arrays into "for each text, pick
  // the highest-confidence type assignment". GLiNER2 sometimes assigns
  // the same span to several types (customer + client for "Acme Corp");
  // we keep one winner per text, breaking ties by confidence.
  type Tagged = { type: string; conf: number; start?: number; end?: number };
  const bestTypeByText = new Map<string, Tagged>();
  for (const [type, spans] of Object.entries(entitiesByType)) {
    const t = type.toLowerCase();
    if (!NEW_ENTITY_TYPES.has(t) && !REGISTRY_ENTITY_TYPES.has(t)) continue;
    for (const sp of spans ?? []) {
      const conf = sp.confidence ?? 0;
      if (conf < MIN_TYPE_CONFIDENCE) continue;
      const prev = bestTypeByText.get(sp.text);
      if (!prev || prev.conf < conf) {
        bestTypeByText.set(sp.text, {
          type: t,
          conf,
          start: sp.start,
          end: sp.end,
        });
      }
    }
  }

  const surfaceIndex = buildSurfaceIndex(resolver, source.content);

  // Pass 1 — register proposed_ids for new-style entities.
  const new_entities: NewEntity[] = [];
  const proposedByText = new Map<string, string>();
  const seenProposed = new Set<string>();
  for (const [text, tagged] of bestTypeByText) {
    if (!NEW_ENTITY_TYPES.has(tagged.type)) continue;
    const slug = slugify(text);
    if (!slug) continue;
    const proposedId = `${tagged.type}/${slug}`;
    if (seenProposed.has(proposedId)) continue;
    seenProposed.add(proposedId);
    proposedByText.set(text, proposedId);
    new_entities.push({
      type: capitalize(tagged.type) as NewEntity["type"],
      proposed_id: proposedId,
      name: text.slice(0, 120),
      aliases: [],
    });
  }

  /**
   * Resolve a relation participant (which only carries `text`) to a
   * canonical or proposed entity_id. We:
   *  1. Look up the text's strongest type from bestTypeByText.
   *  2. For new-style types, return the proposed_id (registering it if
   *     somehow we missed it in pass 1).
   *  3. For registry types, pass through the LocalResolver and verify
   *     the canonical-entity type matches what GLiNER2 said.
   */
  const resolveParticipant = (
    text: string,
  ): { id: string; type: string } | null => {
    const tagged = bestTypeByText.get(text);
    if (!tagged) return null;
    const t = tagged.type;

    if (NEW_ENTITY_TYPES.has(t)) {
      let id = proposedByText.get(text);
      if (!id) {
        const slug = slugify(text);
        if (!slug) return null;
        id = `${t}/${slug}`;
        if (!seenProposed.has(id)) {
          seenProposed.add(id);
          proposedByText.set(text, id);
          new_entities.push({
            type: capitalize(t) as NewEntity["type"],
            proposed_id: id,
            name: text.slice(0, 120),
            aliases: [],
          });
        }
      }
      return { id, type: t };
    }

    if (REGISTRY_ENTITY_TYPES.has(t)) {
      const hit = surfaceIndex.get(text.toLowerCase());
      if (!hit) return null;
      if (hit.type !== t) return null;
      return hit;
    }

    return null;
  };

  // Pass 2 — relations become facts.
  const facts: ExtractedFact[] = [];
  const seenFactKey = new Set<string>();
  for (const [relType, triples] of Object.entries(relationsByType)) {
    const rt = relType.toLowerCase() as RuntimeRelation;
    if (!RELATION_TO_ATTRIBUTE[rt]) continue;
    const isLiteralTail = LITERAL_TAIL_RELATIONS.has(rt);
    for (const triple of triples ?? []) {
      const headText = triple.head?.text;
      const tailText = triple.tail?.text;
      if (!headText || !tailText) continue;

      const subj = resolveParticipant(headText);
      if (!subj) continue;

      let value: string;
      if (isLiteralTail) {
        // due_on: the tail is a date/time literal ("Friday", "by Q3"),
        // not an entity. Store the tail text verbatim as the fact value.
        value = tailText.slice(0, 200);
      } else {
        const obj = resolveParticipant(tailText);
        if (!obj) continue;
        value = obj.id;
      }

      // Drop self-relations (subject === object). GLiNER2 occasionally
      // emits these — e.g. (Bob, assigned_to, Bob) — and they're always
      // noise: there's no fact value being added by saying X relates to X.
      // (Literal-tail relations are exempt; "X due_on Y" can never have
      //  X==Y since the tail is a date string, not an entity_id.)
      if (!isLiteralTail && subj.id === value) continue;

      // Dedup the same (entity, attribute, value) emitted multiple times
      // (GLiNER2 sometimes outputs symmetric pairs like blocks + blocked_by
      // for the same edge — we want one fact each, not duplicates).
      const attribute = RELATION_TO_ATTRIBUTE[rt];
      const key = `${subj.id}::${attribute}::${value}`;
      if (seenFactKey.has(key)) continue;
      seenFactKey.add(key);

      // Use the head-span's offsets as fact provenance — it's the closest
      // anchor we have to "where in the source did this fact come from".
      const headStart = triple.head.start ?? null;
      const headEnd = triple.head.end ?? null;

      facts.push({
        entity_id: subj.id,
        attribute,
        value,
        fact_type: STATIC_RELATIONS.has(rt) ? "static" : "trajectory",
        confidence: triple.confidence ?? 0.7,
        source_span_start: headStart,
        source_span_end: headEnd,
      });
    }
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
