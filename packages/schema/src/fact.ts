import { z } from "zod";

export const FactTypeSchema = z.enum(["static", "procedural", "trajectory"]);
export type FactType = z.infer<typeof FactTypeSchema>;

export const FactValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);
export type FactValue = z.infer<typeof FactValueSchema>;

export const FactSchema = z.object({
  id: z.string(),
  entity_id: z.string(),
  attribute: z.string(),
  value: FactValueSchema,
  type: FactTypeSchema,
  valid_from: z.date().nullable(),
  valid_to: z.date().nullable(),
  tx_from: z.date(),
  tx_to: z.date().nullable(),
  source_id: z.string(),
  source_span: z.tuple([z.number(), z.number()]).nullable(),
  confidence: z.number().min(0).max(1),
  author: z.string(),
  acl: z.array(z.string()),
  override_by: z.string().nullable(),
  override_reason: z.string().nullable(),
});
export type Fact = z.infer<typeof FactSchema>;

export interface MakeFactInput {
  entity_id: string;
  attribute: string;
  value: FactValue;
  type: FactType;
  source_id: string;
  source_span?: [number, number] | null;
  confidence?: number;
  author?: string;
  valid_from?: Date | null;
  acl?: string[];
}

export function makeFact(input: MakeFactInput): Fact {
  const now = new Date();
  return {
    id: crypto.randomUUID(),
    entity_id: input.entity_id,
    attribute: input.attribute,
    value: input.value,
    type: input.type,
    valid_from: input.valid_from ?? null,
    valid_to: null,
    tx_from: now,
    tx_to: null,
    source_id: input.source_id,
    source_span: input.source_span ?? null,
    confidence: input.confidence ?? 1.0,
    author: input.author ?? "system",
    acl: input.acl ?? ["employee:all"],
    override_by: null,
    override_reason: null,
  };
}
