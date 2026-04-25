import { z } from "zod";
import type { SourceAdapter, SourceRecord } from "@spine/schema";
import { safeReadFile } from "./safe-fs.js";

/**
 * Email adapter — EnterpriseBench Enterprise_mail_system/emails.json.
 *
 * This adapter is **format-specific**: it expects EnterpriseBench's exact
 * JSON shape (sender_emp_id, category="INTERNAL", etc.). A real Gmail or
 * MBOX or Outlook export needs its own adapter that produces the same
 * SourceRecord shape — the pipeline doesn't change, only the parser does.
 *
 * Unstructured-only: bodies go through the LLM extractor downstream.
 * No extractStructuredFacts here — sender/recipient identity is captured
 * by the HR adapter; this just hands the LLM a clean SourceRecord.
 */

const EnterpriseBenchRawEmailSchema = z.object({
  email_id: z.string(),
  thread_id: z.string().nullable().optional(),
  date: z.string(),
  sender_email: z.string(),
  sender_name: z.string(),
  sender_emp_id: z.string().nullable().optional(),
  recipient_email: z.string(),
  recipient_name: z.string(),
  recipient_emp_id: z.string().nullable().optional(),
  subject: z.string(),
  body: z.string(),
  importance: z.string().nullable().optional(),
  signature: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
});
export type EnterpriseBenchRawEmail = z.infer<typeof EnterpriseBenchRawEmailSchema>;

export const enterpriseBenchEmailAdapter: SourceAdapter<EnterpriseBenchRawEmail> = {
  type: "email",

  async *discover(location: string): AsyncIterable<EnterpriseBenchRawEmail> {
    const text = await safeReadFile(location);
    const data = JSON.parse(text);
    if (!Array.isArray(data)) {
      throw new Error(
        `[email] expected JSON array in ${location}, got ${typeof data}`,
      );
    }
    let skipped = 0;
    let firstSkipReported = false;
    for (const raw of data) {
      const parsed = EnterpriseBenchRawEmailSchema.safeParse(raw);
      if (!parsed.success) {
        skipped += 1;
        if (!firstSkipReported) {
          console.warn(
            `[email] first skip — error: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`,
          );
          firstSkipReported = true;
        }
        continue;
      }
      yield parsed.data;
    }
    if (skipped > 0) {
      console.warn(`[email] skipped ${skipped} malformed records total`);
    }
  },

  normalize(raw: EnterpriseBenchRawEmail): SourceRecord {
    const date = new Date(raw.date);
    return {
      id: `email/${raw.email_id}`,
      type: "email",
      external_id: raw.email_id,
      subject: raw.subject,
      content: [
        `From: ${raw.sender_name} <${raw.sender_email}>`,
        `To: ${raw.recipient_name} <${raw.recipient_email}>`,
        `Date: ${raw.date}`,
        `Subject: ${raw.subject}`,
        ``,
        raw.body,
      ].join("\n"),
      metadata: {
        thread_id: raw.thread_id ?? null,
        sender_emp_id: raw.sender_emp_id ?? null,
        recipient_emp_id: raw.recipient_emp_id ?? null,
        sender_email: raw.sender_email,
        recipient_email: raw.recipient_email,
        importance: raw.importance ?? null,
        category: raw.category ?? null,
      },
      ingested_at: isNaN(date.getTime()) ? new Date() : date,
      // Default ACL by category. Internal emails visible to all employees;
      // anything else (or missing category) restricted until policy engine
      // narrows further.
      default_acl:
        raw.category === "INTERNAL"
          ? ["employee:all"]
          : ["role:exec", "role:hr"],
    };
  },
};
