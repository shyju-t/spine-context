import { z } from "zod";
import {
  type Fact,
  type SourceAdapter,
  type SourceRecord,
  makeFact,
} from "@spine/schema";
import { safeReadFile } from "./safe-fs.js";

/**
 * IT ticket adapter — EnterpriseBench
 *   IT_Service_Management/it_tickets.json
 *
 * Each row is one ticket: who raised it, who's assigned, the priority,
 * the issue body and the resolution body. Both prose fields go to the
 * LLM extractor for blockers, action items, decision rationale, etc.
 * Structured fields give us raised-by / assigned-to person links and
 * priority directly.
 *
 * ACL: tickets are internal-IT scope by default — visible to the
 * raiser, the assignee, and exec. Not on the broad employee feed.
 */

const RawTicketSchema = z
  .object({
    id: z.union([z.string(), z.number()]).transform(String),
    priority: z.string().optional(),
    raised_by_emp_id: z.string().optional(),
    emp_id: z.string().optional(),
    assigned_date: z.string().optional(),
    Issue: z.string().optional(),
    Resolution: z.string().optional(),
  })
  .passthrough();
export type RawTicket = z.infer<typeof RawTicketSchema>;

function parseDate(s: string | undefined): Date {
  if (!s) return new Date();
  const d = new Date(s);
  return isNaN(d.getTime()) ? new Date() : d;
}

export const itTicketAdapter: SourceAdapter<RawTicket> = {
  type: "ticket",

  async *discover(location: string): AsyncIterable<RawTicket> {
    const text = await safeReadFile(location);
    const data = JSON.parse(text);
    if (!Array.isArray(data)) {
      throw new Error(`[ticket] expected JSON array in ${location}`);
    }
    let skipped = 0;
    let firstReported = false;
    for (const raw of data) {
      const parsed = RawTicketSchema.safeParse(raw);
      if (!parsed.success) {
        skipped += 1;
        if (!firstReported) {
          console.warn(
            `[ticket] first skip — ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`,
          );
          firstReported = true;
        }
        continue;
      }
      yield parsed.data;
    }
    if (skipped > 0) console.warn(`[ticket] skipped ${skipped} malformed rows`);
  },

  normalize(raw: RawTicket): SourceRecord {
    const date = parseDate(raw.assigned_date);
    const issuePreview = (raw.Issue ?? "").slice(0, 60).replace(/\s+/g, " ");
    const acl: string[] = ["role:exec"];
    if (raw.raised_by_emp_id) acl.push(`person:${raw.raised_by_emp_id}`);
    if (raw.emp_id) acl.push(`person:${raw.emp_id}`);
    return {
      id: `ticket/${raw.id}`,
      type: "ticket",
      external_id: raw.id,
      subject: `Ticket ${raw.id}${raw.priority ? ` (${raw.priority})` : ""}: ${issuePreview}…`,
      content: [
        `Ticket: ${raw.id}`,
        raw.priority ? `Priority: ${raw.priority}` : "",
        raw.raised_by_emp_id ? `Raised by: ${raw.raised_by_emp_id}` : "",
        raw.emp_id ? `Assigned to: ${raw.emp_id}` : "",
        raw.assigned_date ? `Assigned date: ${raw.assigned_date}` : "",
        ``,
        raw.Issue ? `# Issue\n${raw.Issue}` : "",
        ``,
        raw.Resolution ? `# Resolution\n${raw.Resolution}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: {
        ticket_id: raw.id,
        priority: raw.priority ?? null,
        raised_by_emp_id: raw.raised_by_emp_id ?? null,
        emp_id: raw.emp_id ?? null,
        assigned_date: raw.assigned_date ?? null,
      },
      ingested_at: date,
      default_acl: acl,
    };
  },

  extractStructuredFacts(record: SourceRecord, raw: RawTicket): Fact[] {
    const validFrom = parseDate(raw.assigned_date);
    const acl: string[] = ["role:exec"];
    if (raw.raised_by_emp_id) acl.push(`person:${raw.raised_by_emp_id}`);
    if (raw.emp_id) acl.push(`person:${raw.emp_id}`);

    const facts: Fact[] = [];
    if (raw.raised_by_emp_id) {
      facts.push(
        makeFact({
          entity_id: `person/${raw.raised_by_emp_id}`,
          attribute: "raised_ticket",
          value: `ticket/${raw.id}`,
          type: "trajectory",
          source_id: record.id,
          author: "ticket-adapter",
          acl,
          valid_from: validFrom,
        }),
      );
    }
    if (raw.emp_id) {
      facts.push(
        makeFact({
          entity_id: `person/${raw.emp_id}`,
          attribute: "assigned_ticket",
          value: `ticket/${raw.id}`,
          type: "trajectory",
          source_id: record.id,
          author: "ticket-adapter",
          acl,
          valid_from: validFrom,
        }),
      );
    }
    if (raw.priority && raw.emp_id) {
      facts.push(
        makeFact({
          entity_id: `person/${raw.emp_id}`,
          attribute: "ticket_priority_handled",
          value: raw.priority,
          type: "trajectory",
          source_id: record.id,
          author: "ticket-adapter",
          acl,
          valid_from: validFrom,
        }),
      );
    }
    return facts;
  },
};
