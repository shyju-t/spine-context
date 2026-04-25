import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  type Fact,
  type Person,
  type SourceAdapter,
  type SourceRecord,
  makeFact,
} from "@spine/schema";

/**
 * HR adapter — reads EnterpriseBench
 *   Human_Resource_Management/Employees/employees.json.
 *
 * This adapter pulls double duty:
 *   1. Each employee record becomes one SourceRecord (the canonical text
 *      representation feeds the LLM extractor for skills/seniority/etc.).
 *   2. extractStructuredFacts() emits direct field-to-fact mappings —
 *      level, department, salary, performance, joining date, etc. — with
 *      sensitive attributes ACL-restricted up front.
 *   3. The CLI orchestrator also uses helpers below to write Person nodes
 *      and Manages edges into the graph.
 */

const RawEmployeeSchema = z
  .object({
    emp_id: z.string(),
    Name: z.string(),
    email: z.string().optional(),
    category: z.string().optional(),
    description: z.string().optional(),
    Experience: z.string().optional(),
    skills: z.string().optional(),
    Level: z.string().optional(),
    Salary: z.union([z.string(), z.number()]).optional(),
    DOJ: z.string().optional(),
    DOL: z.string().optional(),
    Age: z.union([z.string(), z.number()]).optional(),
    "Performance Rating": z.union([z.string(), z.number()]).optional(),
    "Marital Status": z.string().optional(),
    Gender: z.string().optional(),
    is_valid: z.union([z.string(), z.boolean(), z.number()]).optional(),
    reportees: z.array(z.string()).optional(),
    reports_to: z.string().nullable().optional(),
  })
  .passthrough();
export type RawEmployee = z.infer<typeof RawEmployeeSchema>;

export const hrAdapter: SourceAdapter<RawEmployee> = {
  type: "hr",

  async *discover(location: string): AsyncIterable<RawEmployee> {
    const text = await readFile(location, "utf8");
    const data = JSON.parse(text);
    if (!Array.isArray(data)) {
      throw new Error(`[hr] expected JSON array in ${location}`);
    }
    let skipped = 0;
    let firstSkipReported = false;
    for (const raw of data) {
      const parsed = RawEmployeeSchema.safeParse(raw);
      if (!parsed.success) {
        skipped += 1;
        if (!firstSkipReported) {
          console.warn(
            `[hr] first skip — error: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`,
          );
          firstSkipReported = true;
        }
        continue;
      }
      yield parsed.data;
    }
    if (skipped > 0) {
      console.warn(`[hr] skipped ${skipped} malformed records total`);
    }
  },

  normalize(raw: RawEmployee): SourceRecord {
    return {
      id: `hr/${raw.emp_id}`,
      type: "hr",
      external_id: raw.emp_id,
      subject: `${raw.Name} — ${raw.Level ?? "employee"} (${raw.category ?? "n/a"})`,
      content: [
        `Employee: ${raw.Name} (${raw.emp_id})`,
        raw.email ? `Email: ${raw.email}` : "",
        raw.category ? `Department: ${raw.category}` : "",
        raw.Level ? `Level: ${raw.Level}` : "",
        ``,
        raw.description ?? "",
        ``,
        raw.Experience ? `Experience: ${raw.Experience}` : "",
        raw.skills ? `Skills: ${raw.skills}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: { ...raw },
      ingested_at: new Date(),
      // Source-level ACL: HR records visible to all employees by default;
      // sensitive attributes (salary, performance) get narrower ACL at the
      // fact level, applied in extractStructuredFacts below.
      default_acl: ["employee:all"],
    };
  },

  extractStructuredFacts(record: SourceRecord, raw: RawEmployee): Fact[] {
    const facts: Fact[] = [];
    const entity_id = `person/${raw.emp_id}`;

    const make = (
      attribute: string,
      value: string | number | boolean | null,
      acl: string[],
      type: "static" | "trajectory" = "static",
    ) =>
      makeFact({
        entity_id,
        attribute,
        value,
        type,
        source_id: record.id,
        author: "hr-adapter",
        acl,
      });

    // ───── Public-ish facts ─────
    if (raw.Name) facts.push(make("name", raw.Name, ["employee:all"]));
    if (raw.email) facts.push(make("email", raw.email, ["employee:all"]));
    if (raw.category)
      facts.push(make("department", raw.category, ["employee:all"]));
    if (raw.Level) facts.push(make("level", raw.Level, ["employee:all"]));
    if (raw.DOJ)
      facts.push(make("date_of_joining", raw.DOJ, ["employee:all"]));

    // ───── Restricted facts (HR + Exec + self) ─────
    const personScope = [`person:${raw.emp_id}`, "role:hr", "role:exec"];
    if (raw.Salary !== undefined)
      facts.push(make("salary", String(raw.Salary), personScope));
    if (raw["Performance Rating"] !== undefined)
      facts.push(
        make("performance_rating", String(raw["Performance Rating"]), personScope),
      );
    if (raw.DOL)
      facts.push(make("date_of_leaving", raw.DOL, personScope));

    // ───── HR-only / sensitive demographic facts ─────
    const hrOnly = [`person:${raw.emp_id}`, "role:hr"];
    if (raw.Age !== undefined) facts.push(make("age", String(raw.Age), hrOnly));
    if (raw["Marital Status"])
      facts.push(make("marital_status", raw["Marital Status"], hrOnly));
    if (raw.Gender) facts.push(make("gender", raw.Gender, hrOnly));

    // ───── Trajectory: who someone reports to ─────
    if (raw.reports_to) {
      facts.push(
        make("reports_to", raw.reports_to, ["employee:all"], "trajectory"),
      );
    }

    return facts;
  },
};

// ───────── Helpers used by the ingestion CLI ─────────

/** Convert a raw employee record into a Person canonical entity. */
export function rawEmployeeToPerson(raw: RawEmployee): Person {
  return {
    id: `person/${raw.emp_id}`,
    emp_id: raw.emp_id,
    name: raw.Name,
    email: raw.email,
    level: raw.Level,
    category: raw.category,
    aliases: [],
  };
}

/**
 * Extract Manages relationships (manager → reportee) from a raw HR record.
 * Returned as ID pairs; caller writes the edges after all Person nodes
 * are inserted.
 */
export function rawEmployeeManagesEdges(
  raw: RawEmployee,
): Array<{ manager_id: string; report_id: string }> {
  const reports = raw.reportees ?? [];
  return reports.map((reporteeId) => ({
    manager_id: `person/${raw.emp_id}`,
    report_id: `person/${reporteeId}`,
  }));
}
