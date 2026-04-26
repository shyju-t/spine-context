import { z } from "zod";
import {
  type Fact,
  type SourceAdapter,
  type SourceRecord,
  makeFact,
} from "@spine/schema";
import { safeReadFile } from "./safe-fs.js";

/**
 * Sales adapter — EnterpriseBench Customer_Relation_Management/sales.json.
 *
 * Pure transactional records — no free text, no LLM. Each row becomes
 * one Source (so the receipt is preserved + auditable) and emits one
 * trajectory Fact on the customer:
 *
 *   customer/<id>.purchased = product/<id>   (valid_from = Date_of_Purchase)
 *
 * Plus structured price facts so a Customer entity page surfaces total
 * spend, discount-seeking behaviour, etc. without any LLM.
 *
 * 13,510 rows in the EnterpriseBench dump — that's roughly 13,510 facts,
 * which is a lot but well within Kuzu's comfort zone.
 *
 * ACL: sales rows are scoped to exec/cs (commerce + customer-success
 * roles); they're not on the all-employee bulletin board.
 */

const RawSaleSchema = z
  .object({
    sales_record_id: z.union([z.string(), z.number()]).transform(String),
    product_id: z.string(),
    customer_id: z.string(),
    discounted_price: z.union([z.string(), z.number()]).optional(),
    actual_price: z.union([z.string(), z.number()]).optional(),
    discount_percentage: z.union([z.string(), z.number()]).optional(),
    Date_of_Purchase: z.string().optional(),
  })
  .passthrough();
export type RawSale = z.infer<typeof RawSaleSchema>;

function parseDate(s: string | undefined): Date {
  if (!s) return new Date();
  const d = new Date(s);
  return isNaN(d.getTime()) ? new Date() : d;
}

export const salesAdapter: SourceAdapter<RawSale> = {
  type: "sales",

  async *discover(location: string): AsyncIterable<RawSale> {
    const text = await safeReadFile(location);
    const data = JSON.parse(text);
    if (!Array.isArray(data)) {
      throw new Error(`[sales] expected JSON array in ${location}`);
    }
    let skipped = 0;
    let firstReported = false;
    for (const raw of data) {
      const parsed = RawSaleSchema.safeParse(raw);
      if (!parsed.success) {
        skipped += 1;
        if (!firstReported) {
          console.warn(
            `[sales] first skip — ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`,
          );
          firstReported = true;
        }
        continue;
      }
      yield parsed.data;
    }
    if (skipped > 0) console.warn(`[sales] skipped ${skipped} malformed rows`);
  },

  normalize(raw: RawSale): SourceRecord {
    const date = parseDate(raw.Date_of_Purchase);
    return {
      id: `sales/${raw.sales_record_id}`,
      type: "sales",
      external_id: raw.sales_record_id,
      subject: `Sale ${raw.sales_record_id} — ${raw.customer_id} bought ${raw.product_id}`,
      // Structured "receipt" rendering — no prose, but readable in the
      // Inspector source viewer if anyone clicks through.
      content: [
        `Sale: ${raw.sales_record_id}`,
        `Customer: ${raw.customer_id}`,
        `Product: ${raw.product_id}`,
        raw.Date_of_Purchase ? `Date: ${raw.Date_of_Purchase}` : "",
        raw.actual_price !== undefined ? `Actual price: ${raw.actual_price}` : "",
        raw.discounted_price !== undefined
          ? `Discounted price: ${raw.discounted_price}`
          : "",
        raw.discount_percentage !== undefined
          ? `Discount %: ${raw.discount_percentage}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: {
        sales_record_id: raw.sales_record_id,
        product_id: raw.product_id,
        customer_id: raw.customer_id,
        actual_price: raw.actual_price ?? null,
        discounted_price: raw.discounted_price ?? null,
        discount_percentage: raw.discount_percentage ?? null,
        date_of_purchase: raw.Date_of_Purchase ?? null,
      },
      ingested_at: date,
      // Sales data: visible to commerce + execs, not the broad employee base.
      default_acl: ["role:exec", "role:cs", "role:sales"],
    };
  },

  extractStructuredFacts(record: SourceRecord, raw: RawSale): Fact[] {
    const customer_id = `customer/${raw.customer_id}`;
    const product_id = `product/${raw.product_id}`;
    const validFrom = parseDate(raw.Date_of_Purchase);
    const acl = ["role:exec", "role:cs", "role:sales"];

    const facts: Fact[] = [];

    // Trajectory: customer purchased product on this date.
    facts.push(
      makeFact({
        entity_id: customer_id,
        attribute: "purchased",
        value: product_id,
        type: "trajectory",
        source_id: record.id,
        author: "sales-adapter",
        acl,
        valid_from: validFrom,
      }),
    );

    // Reverse direction so a Product page can show its buyers.
    facts.push(
      makeFact({
        entity_id: product_id,
        attribute: "sold_to",
        value: customer_id,
        type: "trajectory",
        source_id: record.id,
        author: "sales-adapter",
        acl,
        valid_from: validFrom,
      }),
    );

    // Optional discount snapshot — kept on the sale itself, attached to
    // the customer entity. Only emit when we have a real number.
    if (raw.discount_percentage !== undefined && raw.discount_percentage !== null) {
      facts.push(
        makeFact({
          entity_id: customer_id,
          attribute: "discount_received",
          value: String(raw.discount_percentage),
          type: "trajectory",
          source_id: record.id,
          author: "sales-adapter",
          acl,
          valid_from: validFrom,
        }),
      );
    }

    return facts;
  },
};
