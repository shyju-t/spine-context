import { z } from "zod";
import type { SourceAdapter, SourceRecord } from "@spine/schema";
import { safeReadFile } from "./safe-fs.js";

/**
 * Chat adapter — EnterpriseBench Collaboration_tools/conversations.json.
 *
 * Each conversation is a single multi-turn dialogue between two employees
 * stored as one text blob with "Name: message" lines. The full text goes
 * into SourceRecord.content; the LLM extractor downstream derives facts
 * (decisions, blockers, disagreements) from it.
 *
 * Format-specific: a Slack export, Teams export, or Discord export would
 * need its own adapter producing the same SourceRecord shape.
 */

const RawConversationSchema = z.object({
  conversation_id: z.string(),
  sender_emp_id: z.string(),
  recipient_emp_id: z.string(),
  date: z.string(),
  text: z.string(),
});
export type RawConversation = z.infer<typeof RawConversationSchema>;

export const enterpriseBenchChatAdapter: SourceAdapter<RawConversation> = {
  type: "chat",

  async *discover(location: string): AsyncIterable<RawConversation> {
    const text = await safeReadFile(location);
    const data = JSON.parse(text);
    if (!Array.isArray(data)) {
      throw new Error(`[chat] expected JSON array in ${location}`);
    }
    let skipped = 0;
    let firstSkipReported = false;
    for (const raw of data) {
      const parsed = RawConversationSchema.safeParse(raw);
      if (!parsed.success) {
        skipped += 1;
        if (!firstSkipReported) {
          console.warn(
            `[chat] first skip — error: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`,
          );
          firstSkipReported = true;
        }
        continue;
      }
      yield parsed.data;
    }
    if (skipped > 0) {
      console.warn(`[chat] skipped ${skipped} malformed records total`);
    }
  },

  normalize(raw: RawConversation): SourceRecord {
    const date = new Date(raw.date);
    const firstLine =
      raw.text.split("\n").find((l) => l.trim().length > 0) ?? "";
    const subject =
      firstLine.length > 80 ? firstLine.slice(0, 77) + "..." : firstLine;
    return {
      id: `chat/${raw.conversation_id}`,
      type: "chat",
      external_id: raw.conversation_id,
      subject,
      content: [
        `Conversation between ${raw.sender_emp_id} and ${raw.recipient_emp_id}`,
        `Date: ${raw.date}`,
        ``,
        raw.text,
      ].join("\n"),
      metadata: {
        sender_emp_id: raw.sender_emp_id,
        recipient_emp_id: raw.recipient_emp_id,
        date: raw.date,
      },
      ingested_at: isNaN(date.getTime()) ? new Date() : date,
      // Internal team chat: visible to participants + execs by default.
      // Engineering ICs not in the chat won't see it; HR + the policy
      // engine may widen for specific topics later.
      default_acl: [
        "role:exec",
        `person:${raw.sender_emp_id}`,
        `person:${raw.recipient_emp_id}`,
      ],
    };
  },
};
