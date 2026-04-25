/**
 * Closed-schema mapping for fine-tuning GLiNER2 via Pioneer.
 *
 * Why this file exists:
 *   The Gemini extractor (prompt.ts) uses an open attribute vocabulary —
 *   1,088 unique attribute names across 9,996 cached facts (median 1, with
 *   729 attributes used exactly once). That long tail IS the silver-label
 *   noise. GLiNER2 is closed-vocabulary by design, so we collapse the zoo
 *   into a small, enforceable schema before exporting training data.
 *
 *   This module is the single source of truth for that mapping. The export
 *   script imports it, and PIONEER_SCHEMA.md / PIONEER_PROMPT.md are
 *   rendered from it.
 *
 * v1 scope: entities + classifications. Structures are deferred — they
 *   need per-source aggregation logic and the JSONL output format isn't
 *   well-documented in the GLiNER2 README, so we revisit after seeing
 *   what Pioneer's Agent does with v1.
 */

// ─────────────────────────── Types ───────────────────────────

export interface GLiNER2EntitySpec {
  /** GLiNER2 entity-type key (lowercase, snake_case) */
  type: string;
  /** Description shown to GLiNER2 at schema-declaration time */
  description: string;
}

export interface GLiNER2ClassificationSpec {
  /** Task name */
  name: string;
  labels: string[];
  description: string;
}

export interface SpineSchema {
  entities: GLiNER2EntitySpec[];
  classifications: GLiNER2ClassificationSpec[];
}

// ─────────────── Closed schema (v1) ───────────────

export const SPINE_SCHEMA: SpineSchema = {
  entities: [
    {
      type: "person",
      description:
        "An employee, identified by full name (e.g. 'Raj Patel') or emp_id (e.g. 'emp_1031').",
    },
    {
      type: "customer",
      description: "An end-user customer, by name or customer_id.",
    },
    {
      type: "client",
      description:
        "An enterprise client account, by name or client_id (e.g. 'CLNT-0001').",
    },
    {
      type: "vendor",
      description: "A third-party supplier, by name or vendor_id.",
    },
    {
      type: "product",
      description: "A product or service offered by the company.",
    },
    {
      type: "project",
      description:
        "A named multi-step initiative (e.g. 'Phoenix migration', 'Q3 launch').",
    },
    {
      type: "topic",
      description:
        "A recurring discussion theme (e.g. 'Q2 budget review', 'employee retention').",
    },
    {
      type: "decision",
      description:
        "A concrete decision made by an individual or group (e.g. 'approved vendor X for AI labeling').",
    },
    {
      type: "commitment",
      description:
        "A promise to deliver something with a deliverable or deadline (e.g. 'draft contract by Friday').",
    },
  ],
  classifications: [
    {
      name: "sentiment",
      labels: ["positive", "neutral", "negative", "escalating"],
      description:
        "Overall sentiment expressed in the source. 'escalating' = a customer or stakeholder is increasing pressure.",
    },
    {
      name: "fact_type",
      labels: ["static", "procedural", "trajectory"],
      description:
        "Dominant fact type in this source. static = identity/baseline. procedural = how-it-works/policies. trajectory = time-varying state.",
    },
  ],
};

// ───────── Entity-id prefix → GLiNER2 entity type ─────────
//
// spine stores facts with `entity_id` like "person/emp_1031" or
// "customer/arout". For training, we need to know which GLiNER2 entity
// type the entity_id maps to so we can convert (entity_id, span) into
// a labeled surface form.

export const ENTITY_PREFIX_TO_TYPE: Record<string, string> = {
  "person/": "person",
  "customer/": "customer",
  "client/": "client",
  "vendor/": "vendor",
  "product/": "product",
  "project/": "project",
  "topic/": "topic",
  "decision/": "decision",
  "commitment/": "commitment",
};

export function entityTypeFromId(entity_id: string): string | null {
  for (const [prefix, type] of Object.entries(ENTITY_PREFIX_TO_TYPE)) {
    if (entity_id.startsWith(prefix)) return type;
  }
  return null;
}

// ───────── Attribute → classification bucket ─────────
//
// Of the 30 most-common attributes Gemini emitted, only a few are good
// per-source classifications. Most are structured fields (deferred to v2)
// or already covered by entity extraction.

const SENTIMENT_ATTRIBUTES = new Set([
  "sentiment",
  "tone",
  "mood",
  "feeling",
]);

/**
 * Sentiment values Gemini wrote that we map to closed labels.
 * Anything else → drop (don't train on noise).
 */
const SENTIMENT_VALUE_MAP: Record<string, string> = {
  positive: "positive",
  neutral: "neutral",
  negative: "negative",
  escalating: "escalating",
  frustrated: "negative",
  angry: "negative",
  upset: "negative",
  happy: "positive",
  satisfied: "positive",
  pleased: "positive",
  concerned: "negative",
  urgent: "escalating",
};

export function classifySentimentValue(raw: string): string | null {
  const norm = raw.toLowerCase().trim();
  return SENTIMENT_VALUE_MAP[norm] ?? null;
}

export function isSentimentAttribute(attribute: string): boolean {
  return SENTIMENT_ATTRIBUTES.has(attribute.toLowerCase().trim());
}

// ───────── Stats helper ─────────

export interface SchemaStats {
  total_outputs: number;

  // Mention-based entity-surface pipeline (the v1.1 primary source)
  total_mentions: number;
  mentions_kept: number;
  mentions_dropped_unknown_type: number;
  mentions_dropped_outside_schema: number;
  mentions_dropped_empty_surface: number;
  mentions_dropped_surface_not_in_content: number;

  // Fact-based pipeline (only used for sentiment + fact_type votes)
  total_facts: number;
  facts_kept_as_sentiment: number;
  facts_dropped_sentiment_unmapped: number;

  // LLM-proposed entity names (secondary-source surface recovery)
  llm_proposed_names_added: number;
  llm_proposed_names_not_in_content: number;

  outputs_with_at_least_one_label: number;
}

export function emptyStats(): SchemaStats {
  return {
    total_outputs: 0,
    total_mentions: 0,
    mentions_kept: 0,
    mentions_dropped_unknown_type: 0,
    mentions_dropped_outside_schema: 0,
    mentions_dropped_empty_surface: 0,
    mentions_dropped_surface_not_in_content: 0,
    total_facts: 0,
    facts_kept_as_sentiment: 0,
    facts_dropped_sentiment_unmapped: 0,
    llm_proposed_names_added: 0,
    llm_proposed_names_not_in_content: 0,
    outputs_with_at_least_one_label: 0,
  };
}

/** Set of entity types declared in the schema — used for fast membership checks. */
export const SCHEMA_ENTITY_TYPES: Set<string> = new Set(
  SPINE_SCHEMA.entities.map((e) => e.type),
);

// ───────── Markdown rendering ─────────
//
// Used to emit PIONEER_SCHEMA.md so the schema is readable in the repo
// and pasteable into the Pioneer chat prompt.

export function renderSchemaMarkdown(): string {
  const lines: string[] = [];
  lines.push("# GLiNER2 schema for spine fine-tuning");
  lines.push("");
  lines.push(
    "Closed-vocabulary mapping derived from `packages/extractor/src/pioneer-schema.ts`. " +
      "v1 covers entities + classifications. Structures (commitment_detail, project_state, etc.) " +
      "are deferred to v2 after seeing Pioneer's first-run quality.",
  );
  lines.push("");
  lines.push("## Entities");
  lines.push("");
  for (const e of SPINE_SCHEMA.entities) {
    lines.push(`- **${e.type}** — ${e.description}`);
  }
  lines.push("");
  lines.push("## Classifications");
  lines.push("");
  for (const c of SPINE_SCHEMA.classifications) {
    lines.push(`- **${c.name}** \`${c.labels.join(" | ")}\` — ${c.description}`);
  }
  lines.push("");
  lines.push("## GLiNER2 builder form (for Pioneer chat prompt)");
  lines.push("");
  lines.push("```python");
  lines.push("schema = (extractor.create_schema()");
  lines.push("    .entities({");
  for (const e of SPINE_SCHEMA.entities) {
    lines.push(
      `        "${e.type}": ${JSON.stringify(e.description)},`,
    );
  }
  lines.push("    })");
  for (const c of SPINE_SCHEMA.classifications) {
    lines.push(
      `    .classification(${JSON.stringify(c.name)}, ${JSON.stringify(c.labels)})`,
    );
  }
  lines.push(")");
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}
