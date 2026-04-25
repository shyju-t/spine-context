import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { SourceAdapter, SourceRecord } from "@spine/schema";

/**
 * KB adapter — EnterpriseBench Inazuma_Overflow/overflow.json.
 *
 * Inazuma's internal Stack-Overflow-style Q&A. Each post is either:
 *   - a question (PostTypeId=1, has Title, no ParentId)
 *   - an answer   (PostTypeId=2, has ParentId pointing to the question)
 *
 * Author identity is in employee_id / employee_Name. Tags exist on
 * questions but are sometimes null. The LLM extractor downstream will
 * derive expertise/skill facts about authors from post bodies.
 *
 * Format-specific: Notion, Confluence, GitHub Discussions etc. each
 * need their own adapter producing the same SourceRecord shape.
 */

const RawOverflowPostSchema = z
  .object({
    Id: z.number(),
    PostTypeId: z.number(), // 1 = question, 2 = answer
    ParentId: z.number().nullable().optional(),
    AcceptedAnswerId: z.number().nullable().optional(),
    Score: z.number().nullable().optional(),
    ViewCount: z.number().nullable().optional(),
    Title: z.string().nullable().optional(),
    Body: z.string(),
    // Questions: array of tag strings. Answers: null. Older exports: string.
    Tags: z.union([z.array(z.string()), z.string(), z.null()]).optional(),
    CreationDate: z.string().nullable().optional(),
    employee_id: z.string().nullable().optional(),
    employee_Name: z.string().nullable().optional(),
  })
  .passthrough();
export type RawOverflowPost = z.infer<typeof RawOverflowPostSchema>;

export const inazumaOverflowAdapter: SourceAdapter<RawOverflowPost> = {
  type: "kb",

  async *discover(location: string): AsyncIterable<RawOverflowPost> {
    const text = await readFile(location, "utf8");
    const data = JSON.parse(text);
    if (!Array.isArray(data)) {
      throw new Error(`[kb] expected JSON array in ${location}`);
    }
    let skipped = 0;
    let firstSkipReported = false;
    for (const raw of data) {
      const parsed = RawOverflowPostSchema.safeParse(raw);
      if (!parsed.success) {
        skipped += 1;
        // Surface the first failure immediately so we don't silently drop
        // records when the pipeline breaks early (e.g. via --limit).
        if (!firstSkipReported) {
          console.warn(
            `[kb] first skip — id=${(raw as { Id?: unknown }).Id}, error: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`,
          );
          firstSkipReported = true;
        }
        continue;
      }
      yield parsed.data;
    }
    if (skipped > 0) {
      console.warn(`[kb] skipped ${skipped} malformed records total`);
    }
  },

  normalize(raw: RawOverflowPost): SourceRecord {
    const date = raw.CreationDate ? new Date(raw.CreationDate) : new Date();
    const isQuestion = raw.PostTypeId === 1;
    const subject = isQuestion
      ? (raw.Title ?? `Question #${raw.Id}`)
      : `Answer to #${raw.ParentId ?? "?"}`;

    // Tags can be string[], string, or null. Normalize for display + metadata.
    const tagArray: string[] = Array.isArray(raw.Tags)
      ? raw.Tags
      : typeof raw.Tags === "string"
        ? raw.Tags.split(/[,\s|]+/).filter(Boolean)
        : [];
    const tagDisplay = tagArray.length ? tagArray.join(", ") : "";

    return {
      id: `kb/${raw.Id}`,
      type: "kb",
      external_id: String(raw.Id),
      subject,
      content: [
        isQuestion
          ? `Question: ${raw.Title ?? "(no title)"}`
          : `Answer to question #${raw.ParentId}`,
        raw.employee_Name
          ? `Author: ${raw.employee_Name} (${raw.employee_id ?? "?"})`
          : "",
        tagDisplay ? `Tags: ${tagDisplay}` : "",
        raw.Score !== null && raw.Score !== undefined
          ? `Score: ${raw.Score}`
          : "",
        ``,
        raw.Body,
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: {
        post_type: isQuestion ? "question" : "answer",
        parent_id: raw.ParentId ?? null,
        accepted_answer_id: raw.AcceptedAnswerId ?? null,
        score: raw.Score ?? null,
        view_count: raw.ViewCount ?? null,
        tags: tagArray,
        author_emp_id: raw.employee_id ?? null,
        author_name: raw.employee_Name ?? null,
        creation_date: raw.CreationDate ?? null,
      },
      ingested_at: isNaN(date.getTime()) ? new Date() : date,
      // Internal Q&A: visible to all employees by default — it's the
      // company's shared technical knowledge layer.
      default_acl: ["employee:all"],
    };
  },
};
