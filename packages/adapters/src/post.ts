import { createHash } from "node:crypto";
import { z } from "zod";
import {
  type Fact,
  type SourceAdapter,
  type SourceRecord,
  makeFact,
} from "@spine/schema";
import { safeReadFile } from "./safe-fs.js";

/**
 * Enterprise social-platform post adapter — EnterpriseBench
 *   Enterprise Social Platform/posts.json
 *
 * Internal company-wide posts (think Workplace by Meta, Yammer, internal
 * Discourse). Each row has Title + Post + emp_id + author. Posts.json
 * doesn't carry a stable record id, so we synthesize one from a SHA-256
 * of (emp_id, title, body-prefix) — stable across re-runs, no
 * collisions in this dataset.
 *
 * ACL: posts are visible to all employees by default (it's the company
 * bulletin board). LLM extraction picks up topics, sentiments, and any
 * decisions/commitments announced in the post body.
 */

const RawPostSchema = z
  .object({
    Title: z.string().optional(),
    Post: z.string(),
    emp_id: z.string().optional(),
    author: z.string().optional(),
  })
  .passthrough();
export type RawPost = z.infer<typeof RawPostSchema>;

function postId(raw: RawPost): string {
  const h = createHash("sha256");
  h.update(raw.emp_id ?? "");
  h.update("|");
  h.update(raw.Title ?? "");
  h.update("|");
  h.update((raw.Post ?? "").slice(0, 200));
  return h.digest("hex").slice(0, 16);
}

export const postAdapter: SourceAdapter<RawPost> = {
  type: "post",

  async *discover(location: string): AsyncIterable<RawPost> {
    const text = await safeReadFile(location);
    const data = JSON.parse(text);
    if (!Array.isArray(data)) {
      throw new Error(`[post] expected JSON array in ${location}`);
    }
    let skipped = 0;
    let firstReported = false;
    for (const raw of data) {
      const parsed = RawPostSchema.safeParse(raw);
      if (!parsed.success) {
        skipped += 1;
        if (!firstReported) {
          console.warn(
            `[post] first skip — ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`,
          );
          firstReported = true;
        }
        continue;
      }
      yield parsed.data;
    }
    if (skipped > 0) console.warn(`[post] skipped ${skipped} malformed rows`);
  },

  normalize(raw: RawPost): SourceRecord {
    const id = postId(raw);
    const subject =
      raw.Title?.slice(0, 80) ?? `Post by ${raw.author ?? raw.emp_id ?? "unknown"}`;
    return {
      id: `post/${id}`,
      type: "post",
      external_id: id,
      subject,
      content: [
        raw.Title ? `# ${raw.Title}` : "",
        raw.author ? `Author: ${raw.author}` : "",
        raw.emp_id ? `Author emp_id: ${raw.emp_id}` : "",
        ``,
        raw.Post,
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: {
        post_id: id,
        title: raw.Title ?? null,
        author: raw.author ?? null,
        emp_id: raw.emp_id ?? null,
      },
      ingested_at: new Date(),
      // Internal company-wide bulletin: visible to all employees.
      default_acl: ["employee:all"],
    };
  },

  extractStructuredFacts(record: SourceRecord, raw: RawPost): Fact[] {
    if (!raw.emp_id) return [];
    return [
      makeFact({
        entity_id: `person/${raw.emp_id}`,
        attribute: "authored_post",
        value: record.id,
        type: "trajectory",
        source_id: record.id,
        author: "post-adapter",
        acl: ["employee:all"],
      }),
    ];
  },
};
