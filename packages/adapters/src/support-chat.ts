import { z } from "zod";
import {
  type Fact,
  type SourceAdapter,
  type SourceRecord,
  makeFact,
} from "@spine/schema";
import { safeReadFile } from "./safe-fs.js";

/**
 * Customer-support adapter — EnterpriseBench
 *   Customer_Relation_Management/Customer Support/customer_support_chats.json
 *
 * Each row is one CS interaction: one customer ↔ one agent ↔ one product
 * conversation, the transcript is in `text`. The structured ids let us
 * write Customer/Product/Agent links without LLM; the prose body goes
 * through the downstream extractor for sentiment, complaints, action
 * items, resolution status, etc.
 *
 * ACL: support transcripts are visible to CS + exec by default, plus
 * the agent who handled it. Not on the all-employee bulletin board.
 */

const RawSupportChatSchema = z
  .object({
    chat_id: z.union([z.string(), z.number()]).transform(String),
    customer_id: z.string(),
    customer_name: z.string().optional(),
    product_id: z.string(),
    product_name: z.string().optional(),
    emp_id: z.string(),
    text: z.string(),
    interaction_date: z.string().optional(),
  })
  .passthrough();
export type RawSupportChat = z.infer<typeof RawSupportChatSchema>;

function parseDate(s: string | undefined): Date {
  if (!s) return new Date();
  const d = new Date(s);
  return isNaN(d.getTime()) ? new Date() : d;
}

export const supportChatAdapter: SourceAdapter<RawSupportChat> = {
  type: "support_chat",

  async *discover(location: string): AsyncIterable<RawSupportChat> {
    const text = await safeReadFile(location);
    const data = JSON.parse(text);
    if (!Array.isArray(data)) {
      throw new Error(`[support_chat] expected JSON array in ${location}`);
    }
    let skipped = 0;
    let firstReported = false;
    for (const raw of data) {
      const parsed = RawSupportChatSchema.safeParse(raw);
      if (!parsed.success) {
        skipped += 1;
        if (!firstReported) {
          console.warn(
            `[support_chat] first skip — ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`,
          );
          firstReported = true;
        }
        continue;
      }
      yield parsed.data;
    }
    if (skipped > 0)
      console.warn(`[support_chat] skipped ${skipped} malformed rows`);
  },

  normalize(raw: RawSupportChat): SourceRecord {
    const date = parseDate(raw.interaction_date);
    const subject =
      raw.customer_name && raw.product_name
        ? `Support: ${raw.customer_name} re ${raw.product_name}`
        : `Support chat ${raw.chat_id}`;
    return {
      id: `support_chat/${raw.chat_id}`,
      type: "support_chat",
      external_id: raw.chat_id,
      subject,
      content: [
        `Customer: ${raw.customer_name ?? raw.customer_id} (${raw.customer_id})`,
        `Product: ${raw.product_name ?? raw.product_id} (${raw.product_id})`,
        `Agent: ${raw.emp_id}`,
        raw.interaction_date ? `Date: ${raw.interaction_date}` : "",
        ``,
        raw.text,
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: {
        chat_id: raw.chat_id,
        customer_id: raw.customer_id,
        customer_name: raw.customer_name ?? null,
        product_id: raw.product_id,
        product_name: raw.product_name ?? null,
        emp_id: raw.emp_id,
        interaction_date: raw.interaction_date ?? null,
      },
      ingested_at: date,
      // CS transcripts are sensitive but routinely shared within CS +
      // exec + the agent handling the case.
      default_acl: ["role:cs", "role:exec", `person:${raw.emp_id}`],
    };
  },

  extractStructuredFacts(record: SourceRecord, raw: RawSupportChat): Fact[] {
    const customer_id = `customer/${raw.customer_id}`;
    const product_id = `product/${raw.product_id}`;
    const agent_id = `person/${raw.emp_id}`;
    const validFrom = parseDate(raw.interaction_date);
    const acl = ["role:cs", "role:exec", `person:${raw.emp_id}`];

    return [
      makeFact({
        entity_id: customer_id,
        attribute: "contacted_support_about",
        value: product_id,
        type: "trajectory",
        source_id: record.id,
        author: "support-chat-adapter",
        acl,
        valid_from: validFrom,
      }),
      makeFact({
        entity_id: customer_id,
        attribute: "handled_by",
        value: agent_id,
        type: "trajectory",
        source_id: record.id,
        author: "support-chat-adapter",
        acl,
        valid_from: validFrom,
      }),
      makeFact({
        entity_id: agent_id,
        attribute: "handled_support_for",
        value: customer_id,
        type: "trajectory",
        source_id: record.id,
        author: "support-chat-adapter",
        acl,
        valid_from: validFrom,
      }),
    ];
  },
};
