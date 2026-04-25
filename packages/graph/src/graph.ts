import * as kuzu from "kuzu";
import type {
  Client,
  Commitment,
  Customer,
  Decision,
  EntityType,
  Fact,
  Person,
  Product,
  Project,
  SourceRecord,
  Topic,
  Vendor,
} from "@spine/schema";
import { ALL_DDL } from "./ddl.js";

/**
 * Thin wrapper around a Kuzu embedded database.
 *
 * All persistence flows through this class. Adapters and the ingestion
 * pipeline never touch Kuzu directly.
 */
export class Graph {
  private db: kuzu.Database;
  private conn: kuzu.Connection;

  constructor(public readonly path: string) {
    this.db = new kuzu.Database(path);
    this.conn = new kuzu.Connection(this.db);
  }

  /** Run DDL. Safe to call repeatedly; "already exists" errors are ignored. */
  async init(): Promise<void> {
    for (const stmt of ALL_DDL) {
      try {
        await this.conn.query(stmt);
      } catch (err) {
        const msg = (err as Error).message ?? "";
        if (!/already exists|Binder exception.*already exists/i.test(msg)) {
          throw err;
        }
      }
    }
  }

  // ─────────── Sources ───────────

  async insertSource(s: SourceRecord): Promise<void> {
    const prep = await this.conn.prepare(`
      MERGE (n:Source {id: $id})
      SET n.type = $type,
          n.external_id = $external_id,
          n.subject = $subject,
          n.content = $content,
          n.metadata = $metadata,
          n.ingested_at = $ingested_at,
          n.acl = $acl
    `);
    await this.conn.execute(prep, {
      id: s.id,
      type: s.type,
      external_id: s.external_id,
      subject: s.subject ?? "",
      content: s.content,
      metadata: JSON.stringify(s.metadata ?? {}),
      ingested_at: s.ingested_at.toISOString(),
      acl: JSON.stringify(s.default_acl ?? ["employee:all"]),
    });
  }

  // ─────────── Facts ───────────

  async insertFact(f: Fact): Promise<void> {
    const prep = await this.conn.prepare(`
      CREATE (n:Fact {
        id: $id,
        entity_id: $entity_id,
        attribute: $attribute,
        value: $value,
        type: $type,
        valid_from: $valid_from,
        valid_to: $valid_to,
        tx_from: $tx_from,
        tx_to: $tx_to,
        source_id: $source_id,
        source_span_start: $source_span_start,
        source_span_end: $source_span_end,
        confidence: $confidence,
        author: $author,
        acl: $acl,
        override_by: $override_by,
        override_reason: $override_reason
      })
    `);
    await this.conn.execute(prep, {
      id: f.id,
      entity_id: f.entity_id,
      attribute: f.attribute,
      // Kuzu fact.value is STRING — coerce non-string values for v1.
      // Typed values (number/bool) live in the Fact schema; we store the
      // canonical string here and re-parse on read if needed.
      value: factValueToString(f.value),
      type: f.type,
      valid_from: f.valid_from?.toISOString() ?? "",
      valid_to: f.valid_to?.toISOString() ?? "",
      tx_from: f.tx_from.toISOString(),
      tx_to: f.tx_to?.toISOString() ?? "",
      source_id: f.source_id,
      source_span_start: f.source_span?.[0] ?? -1,
      source_span_end: f.source_span?.[1] ?? -1,
      confidence: f.confidence,
      author: f.author,
      acl: JSON.stringify(f.acl),
      override_by: f.override_by ?? "",
      override_reason: f.override_reason ?? "",
    });
  }

  // ─────────── Persons ───────────

  async upsertPerson(p: Person): Promise<void> {
    const prep = await this.conn.prepare(`
      MERGE (n:Person {id: $id})
      SET n.emp_id = $emp_id,
          n.name = $name,
          n.email = $email,
          n.level = $level,
          n.category = $category,
          n.aliases = $aliases
    `);
    await this.conn.execute(prep, {
      id: p.id,
      emp_id: p.emp_id ?? "",
      name: p.name,
      email: p.email ?? "",
      level: p.level ?? "",
      category: p.category ?? "",
      aliases: JSON.stringify(p.aliases ?? []),
    });
  }

  // ─────────── Customer / Product / Client / Vendor / Project / Topic ───────────

  async upsertCustomer(c: Customer): Promise<void> {
    const prep = await this.conn.prepare(`
      MERGE (n:Customer {id: $id})
      SET n.customer_id = $customer_id,
          n.name = $name,
          n.aliases = $aliases
    `);
    await this.conn.execute(prep, {
      id: c.id,
      customer_id: c.customer_id,
      name: c.name,
      aliases: JSON.stringify(c.aliases ?? []),
    });
  }

  async upsertProduct(p: Product): Promise<void> {
    const prep = await this.conn.prepare(`
      MERGE (n:Product {id: $id})
      SET n.product_id = $product_id,
          n.name = $name,
          n.category = $category,
          n.aliases = $aliases
    `);
    await this.conn.execute(prep, {
      id: p.id,
      product_id: p.product_id,
      name: p.name,
      category: p.category ?? "",
      aliases: JSON.stringify(p.aliases ?? []),
    });
  }

  async upsertClient(c: Client): Promise<void> {
    const prep = await this.conn.prepare(`
      MERGE (n:Client {id: $id})
      SET n.client_id = $client_id,
          n.name = $name,
          n.industry = $industry,
          n.contact_person_name = $contact_person_name,
          n.aliases = $aliases
    `);
    await this.conn.execute(prep, {
      id: c.id,
      client_id: c.client_id,
      name: c.name,
      industry: c.industry ?? "",
      contact_person_name: c.contact_person_name ?? "",
      aliases: JSON.stringify(c.aliases ?? []),
    });
  }

  async upsertVendor(v: Vendor): Promise<void> {
    const prep = await this.conn.prepare(`
      MERGE (n:Vendor {id: $id})
      SET n.vendor_id = $vendor_id,
          n.name = $name,
          n.industry = $industry,
          n.aliases = $aliases
    `);
    await this.conn.execute(prep, {
      id: v.id,
      vendor_id: v.vendor_id,
      name: v.name,
      industry: v.industry ?? "",
      aliases: JSON.stringify(v.aliases ?? []),
    });
  }

  async upsertProject(p: Project): Promise<void> {
    const prep = await this.conn.prepare(`
      MERGE (n:Project {id: $id})
      SET n.name = $name,
          n.aliases = $aliases
    `);
    await this.conn.execute(prep, {
      id: p.id,
      name: p.name,
      aliases: JSON.stringify(p.aliases ?? []),
    });
  }

  async upsertTopic(t: Topic): Promise<void> {
    const prep = await this.conn.prepare(`
      MERGE (n:Topic {id: $id})
      SET n.name = $name,
          n.aliases = $aliases
    `);
    await this.conn.execute(prep, {
      id: t.id,
      name: t.name,
      aliases: JSON.stringify(t.aliases ?? []),
    });
  }

  async upsertDecision(d: Decision): Promise<void> {
    const prep = await this.conn.prepare(`
      MERGE (n:Decision {id: $id})
      SET n.name = $name,
          n.aliases = $aliases
    `);
    await this.conn.execute(prep, {
      id: d.id,
      name: d.name,
      aliases: JSON.stringify(d.aliases ?? []),
    });
  }

  async upsertCommitment(c: Commitment): Promise<void> {
    const prep = await this.conn.prepare(`
      MERGE (n:Commitment {id: $id})
      SET n.name = $name,
          n.aliases = $aliases
    `);
    await this.conn.execute(prep, {
      id: c.id,
      name: c.name,
      aliases: JSON.stringify(c.aliases ?? []),
    });
  }

  // ─────────── Edges ───────────

  async addManages(managerId: string, reportId: string): Promise<void> {
    const prep = await this.conn.prepare(`
      MATCH (m:Person {id: $managerId}), (r:Person {id: $reportId})
      MERGE (m)-[:Manages]->(r)
    `);
    await this.conn.execute(prep, { managerId, reportId });
  }

  /**
   * Mentions edge: Source -[:Mentions{Type}]-> Entity.
   *
   * Kuzu requires a separate rel table per (FROM, TO) label pair, so we
   * dispatch on entity type rather than using a single generic edge.
   * Whitelist guards against Cypher injection via entity_type.
   */
  async addMentions(
    sourceId: string,
    entityId: string,
    entityType: EntityType,
    role: string,
    confidence: number,
  ): Promise<void> {
    const allowed: Record<EntityType, string> = {
      Person: "MentionsPerson",
      Customer: "MentionsCustomer",
      Product: "MentionsProduct",
      Client: "MentionsClient",
      Vendor: "MentionsVendor",
      Project: "MentionsProject",
      Topic: "MentionsTopic",
      Decision: "MentionsDecision",
      Commitment: "MentionsCommitment",
    };
    const relTable = allowed[entityType];
    if (!relTable) {
      throw new Error(`addMentions: unsupported entityType ${entityType}`);
    }
    // Cypher with interpolated label (whitelisted above) and parameterized
    // values. MERGE on the rel keeps it idempotent across re-runs.
    const cypher = `
      MATCH (s:Source {id: $sourceId}), (e:${entityType} {id: $entityId})
      MERGE (s)-[r:${relTable}]->(e)
      SET r.role = $role, r.confidence = $confidence
    `;
    const prep = await this.conn.prepare(cypher);
    await this.conn.execute(prep, {
      sourceId,
      entityId,
      role,
      confidence,
    });
  }

  // ─────────── Generic query ───────────

  async query<T = Record<string, unknown>>(
    cypher: string,
    params: Record<string, unknown> = {},
  ): Promise<T[]> {
    // Kuzu 0.6 has issues evaluating aggregate functions through the
    // prepare/execute path. When no params are passed, use the raw
    // conn.query() route — that path supports aggregations correctly.
    const hasParams = Object.keys(params).length > 0;
    const result = hasParams
      ? await this.conn.execute(await this.conn.prepare(cypher), params)
      : await this.conn.query(cypher);
    return (await result.getAll()) as T[];
  }

  async close(): Promise<void> {
    // Kuzu handles cleanup on process exit; closing here is best-effort.
    if (typeof (this.conn as unknown as { close?: () => void }).close === "function") {
      (this.conn as unknown as { close: () => void }).close();
    }
    if (typeof (this.db as unknown as { close?: () => void }).close === "function") {
      (this.db as unknown as { close: () => void }).close();
    }
  }
}

function factValueToString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  return String(v);
}
