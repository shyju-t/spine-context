import { z } from "zod";
import {
  type Fact,
  type SourceAdapter,
  type SourceRecord,
  makeFact,
} from "@spine/schema";
import { safeReadFile } from "./safe-fs.js";

/**
 * Product-sentiment adapter — EnterpriseBench
 *   Customer_Relation_Management/Product Sentiment/product_sentiment.json
 *
 * Each row is one customer review of one product. The structured ids let
 * us write Customer ↔ Product link facts up front; the prose body
 * (`review_content`) goes through the LLM extractor for sentiment label,
 * pain points, feature requests, etc.
 *
 * ACL: reviews are typically internal feedback collected by the
 * company — visible across the employee base but ranked under PII for
 * the customer.
 *
 * 13,510 rows. Structured facts are cheap (one per row); LLM extraction
 * should be capped (--limit on the extract CLI) for cost.
 */

const RawReviewSchema = z
  .object({
    sentiment_id: z.union([z.string(), z.number()]).transform(String),
    product_id: z.string(),
    customer_id: z.string(),
    review_content: z.string(),
    review_date: z.string().optional(),
  })
  .passthrough();
export type RawReview = z.infer<typeof RawReviewSchema>;

function parseDate(s: string | undefined): Date {
  if (!s) return new Date();
  const d = new Date(s);
  return isNaN(d.getTime()) ? new Date() : d;
}

export const productSentimentAdapter: SourceAdapter<RawReview> = {
  type: "review",

  async *discover(location: string): AsyncIterable<RawReview> {
    const text = await safeReadFile(location);
    const data = JSON.parse(text);
    if (!Array.isArray(data)) {
      throw new Error(`[review] expected JSON array in ${location}`);
    }
    let skipped = 0;
    let firstReported = false;
    for (const raw of data) {
      const parsed = RawReviewSchema.safeParse(raw);
      if (!parsed.success) {
        skipped += 1;
        if (!firstReported) {
          console.warn(
            `[review] first skip — ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`,
          );
          firstReported = true;
        }
        continue;
      }
      yield parsed.data;
    }
    if (skipped > 0) console.warn(`[review] skipped ${skipped} malformed rows`);
  },

  normalize(raw: RawReview): SourceRecord {
    const date = parseDate(raw.review_date);
    const preview = raw.review_content.slice(0, 60).replace(/\s+/g, " ");
    return {
      id: `review/${raw.sentiment_id}`,
      type: "review",
      external_id: raw.sentiment_id,
      subject: `Review by ${raw.customer_id} of ${raw.product_id}: ${preview}…`,
      content: [
        `Customer: ${raw.customer_id}`,
        `Product: ${raw.product_id}`,
        raw.review_date ? `Date: ${raw.review_date}` : "",
        ``,
        raw.review_content,
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: {
        sentiment_id: raw.sentiment_id,
        product_id: raw.product_id,
        customer_id: raw.customer_id,
        review_date: raw.review_date ?? null,
      },
      ingested_at: date,
      // Customer reviews: broadly visible internally so PMs / CS / exec
      // can read sentiment without filing a request.
      default_acl: ["employee:all"],
    };
  },

  extractStructuredFacts(record: SourceRecord, raw: RawReview): Fact[] {
    const customer_id = `customer/${raw.customer_id}`;
    const product_id = `product/${raw.product_id}`;
    const validFrom = parseDate(raw.review_date);
    const acl = ["employee:all"];

    return [
      makeFact({
        entity_id: product_id,
        attribute: "reviewed_by",
        value: customer_id,
        type: "trajectory",
        source_id: record.id,
        author: "review-adapter",
        acl,
        valid_from: validFrom,
      }),
      makeFact({
        entity_id: customer_id,
        attribute: "reviewed_product",
        value: product_id,
        type: "trajectory",
        source_id: record.id,
        author: "review-adapter",
        acl,
        valid_from: validFrom,
      }),
    ];
  },
};
