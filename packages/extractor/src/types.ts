import { z } from "zod";

/**
 * Output schema for the LLM extractor.
 *
 * Two outputs:
 *  1. `new_entities` — Topics/Projects/Decisions/Commitments the LLM
 *     proposes that don't yet exist in the graph. We materialize these as
 *     nodes before writing facts that reference them.
 *  2. `facts` — assertions about entities (existing or proposed-new).
 */

export const NewEntitySchema = z.object({
  type: z.enum(["Topic", "Project", "Decision", "Commitment"]),
  proposed_id: z
    .string()
    .regex(
      /^(topic|project|commitment|decision)\/[a-z0-9_-]+$/,
      "proposed_id must be exactly '<type>/<slug>' where type is topic|project|commitment|decision and slug is lowercase letters, digits, underscores, or hyphens",
    )
    .describe(
      "Slug-style ID like 'topic/acme_renewal' or 'commitment/draft_contract_friday'. MUST start with 'topic/', 'project/', 'commitment/', or 'decision/'. Lowercase, no spaces.",
    ),
  name: z
    .string()
    .min(1)
    .max(120)
    .describe("Human-readable name. Short — under 120 chars."),
  aliases: z
    .array(z.string())
    .default([])
    .describe("Other strings the entity may be referred to as."),
});
export type NewEntity = z.infer<typeof NewEntitySchema>;

export const ExtractedFactSchema = z.object({
  entity_id: z
    .string()
    .describe(
      "ID of the entity this fact is about. May be an existing canonical ID (e.g. 'person/emp_0431', 'customer/arout', 'client/CLNT-0001') or a proposed_id from the new_entities list.",
    ),
  attribute: z
    .string()
    .describe(
      "Attribute name. Conventional names: status, owner, due_date, approved_by, decided_by, blocker, sentiment, expert_in, promised_to, action, notes.",
    ),
  value: z
    .string()
    .describe(
      "Value as a string. Numbers/booleans/dates are stringified — the storage layer coerces them.",
    ),
  fact_type: z
    .enum(["static", "procedural", "trajectory"])
    .describe(
      "static: identity/baseline (role, expertise). procedural: how-it-works (policies, SOPs). trajectory: time-varying state (status, ownership-this-week).",
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("How confident you are in this extraction, 0..1."),
  source_span_start: z
    .number()
    .int()
    .nullable()
    .describe(
      "Start char offset in the source text where this fact is supported. Use null if you can't pinpoint.",
    ),
  source_span_end: z
    .number()
    .int()
    .nullable()
    .describe("End char offset in the source text. Use null if unknown."),
  reasoning: z
    .string()
    .optional()
    .describe("Brief one-line note explaining why you extracted this fact."),
});
export type ExtractedFact = z.infer<typeof ExtractedFactSchema>;

export const ExtractorOutputSchema = z.object({
  new_entities: z.array(NewEntitySchema).default([]),
  facts: z.array(ExtractedFactSchema).default([]),
});
export type ExtractorOutput = z.infer<typeof ExtractorOutputSchema>;

// ───── Mention used by the extractor's input/output ─────

export interface PreResolvedMention {
  span: [number, number];
  surface: string;
  entity_id: string;
  entity_type: string;
  confidence: number;
  method: string;
}
