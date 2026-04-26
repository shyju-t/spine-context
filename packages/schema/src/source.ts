import { z } from "zod";
import type { Fact } from "./fact.js";

export const SourceTypeSchema = z.enum([
  "email",
  "hr",
  "resume",
  "crm",
  "doc",
  "chat",
  "kb",
  "ticket",
  "client",
  // Wider EnterpriseBench coverage:
  "sales", // structured purchase rows; no LLM
  "support_chat", // CS agent ↔ customer transcripts; LLM
  "review", // product sentiment reviews; LLM
  "post", // internal enterprise social posts; LLM
]);
export type SourceType = z.infer<typeof SourceTypeSchema>;

export const SourceRecordSchema = z.object({
  id: z.string(),
  type: SourceTypeSchema,
  external_id: z.string(),
  subject: z.string().optional(),
  content: z.string(),
  metadata: z.record(z.unknown()),
  ingested_at: z.date(),
  default_acl: z.array(z.string()).optional(),
});
export type SourceRecord = z.infer<typeof SourceRecordSchema>;

/**
 * A SourceAdapter knows how to read a particular kind of source
 * (email file, CRM JSON, Slack export, etc.) and produce normalized
 * SourceRecords for the rest of the pipeline.
 *
 * Optionally, an adapter can also extract structured facts directly
 * from known schema fields without an LLM call. This is the cheap
 * 70% of fact extraction.
 */
export interface SourceAdapter<Raw = unknown> {
  readonly type: SourceType;

  /** Walk a location (file/dir/API) and yield raw records. */
  discover(location: string): AsyncIterable<Raw>;

  /** Convert a raw record into a normalized SourceRecord. */
  normalize(raw: Raw): SourceRecord;

  /** Optional: extract facts directly from structured fields (no LLM). */
  extractStructuredFacts?(record: SourceRecord, raw: Raw): Fact[];

  /** Optional: suggest a default ACL based on source location/metadata. */
  defaultAcl?(record: SourceRecord): string[];
}
