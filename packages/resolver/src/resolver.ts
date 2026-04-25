import type { Graph } from "@spine/graph";
import type { EntityType } from "@spine/schema";
import type {
  CanonicalEntity,
  Mention,
  ResolverContext,
  ResolverStats,
  SurfaceForm,
} from "./types.js";

/**
 * LocalResolver — pre-LLM entity resolution.
 *
 * Loaded once from the graph's canonical entities (Person, Customer,
 * Product, Client, Vendor, Project, Topic). For each entity we generate
 * multiple "surface forms" — strings the entity might be referred to as
 * in source text — each with a method label and base confidence.
 *
 * resolve(text) scans for matches and returns Mentions ordered by
 * confidence with overlapping spans deduped.
 *
 * Performance approach: for each surface form, do a fast lowercase
 * String.includes() check; only on positives do we run the
 * word-boundary regex to get exact spans. ~8k surface forms × 1KB
 * source ≈ <50ms per source on a laptop.
 */
export class LocalResolver {
  private entities = new Map<string, CanonicalEntity>(); // entity_id → entity
  private surfaceForms: Array<{
    text: string;
    text_lower: string;
    method: SurfaceForm["method"];
    base_confidence: number;
    entity_id: string;
    entity_type: EntityType;
  }> = [];
  private personByEmpId = new Map<string, string>();   // emp_0431 → person/emp_0431

  // ───────── Loading ─────────

  async load(graph: Graph): Promise<ResolverStats> {
    const stats: ResolverStats = {
      total_entities: 0,
      total_surface_forms: 0,
      by_type: {
        Person: 0,
        Customer: 0,
        Product: 0,
        Client: 0,
        Vendor: 0,
        Project: 0,
        Topic: 0,
      },
    };

    // Person — emp_id, email, full name, first-initial+last, last name, first name
    const persons = await graph.query<{
      id: string;
      emp_id: string;
      name: string;
      email: string;
      aliases: string;
    }>(
      `MATCH (p:Person) RETURN p.id AS id, p.emp_id AS emp_id, p.name AS name, p.email AS email, p.aliases AS aliases`,
    );
    for (const p of persons) {
      const aliases = parseAliases(p.aliases);
      const sfs = personSurfaceForms(p.name, p.emp_id, p.email, aliases);
      this.addEntity({ id: p.id, type: "Person", display_name: p.name, surface_forms: sfs });
      if (p.emp_id) this.personByEmpId.set(p.emp_id, p.id);
      stats.by_type.Person += 1;
    }

    // Customer
    const customers = await graph.query<{
      id: string;
      customer_id: string;
      name: string;
      aliases: string;
    }>(
      `MATCH (c:Customer) RETURN c.id AS id, c.customer_id AS customer_id, c.name AS name, c.aliases AS aliases`,
    );
    for (const c of customers) {
      const aliases = parseAliases(c.aliases);
      const sfs: SurfaceForm[] = [];
      // EnterpriseBench customer_ids are weird short codes derived from
      // customer names ("arout" → "thomas hardy", "quick" → "horst kloss"),
      // and many collide with common English words. Skip them entirely;
      // the full customer name is unique and reliable.
      if (c.name && c.name.length >= 4) {
        sfs.push({
          text: c.name,
          text_lower: c.name.toLowerCase(),
          method: "full_name",
          base_confidence: 0.95,
        });
      }
      for (const a of aliases) {
        if (a.length >= 4) {
          sfs.push({
            text: a,
            text_lower: a.toLowerCase(),
            method: "alias",
            base_confidence: 0.9,
          });
        }
      }
      this.addEntity({ id: c.id, type: "Customer", display_name: c.name, surface_forms: sfs });
      stats.by_type.Customer += 1;
    }

    // Product — product names are very long & often product-jargon-laden;
    // match by product_id only, skip name-based matching to avoid noise
    const products = await graph.query<{
      id: string;
      product_id: string;
      name: string;
    }>(
      `MATCH (p:Product) RETURN p.id AS id, p.product_id AS product_id, p.name AS name`,
    );
    for (const p of products) {
      const sfs: SurfaceForm[] = [];
      if (p.product_id) {
        sfs.push({
          text: p.product_id,
          text_lower: p.product_id.toLowerCase(),
          method: "id",
          base_confidence: 1.0,
        });
      }
      this.addEntity({ id: p.id, type: "Product", display_name: p.name.slice(0, 80), surface_forms: sfs });
      stats.by_type.Product += 1;
    }

    // Client
    const clients = await graph.query<{
      id: string;
      client_id: string;
      name: string;
      contact_person_name: string;
      aliases: string;
    }>(
      `MATCH (c:Client) RETURN c.id AS id, c.client_id AS client_id, c.name AS name, c.contact_person_name AS contact_person_name, c.aliases AS aliases`,
    );
    for (const c of clients) {
      const aliases = parseAliases(c.aliases);
      const sfs: SurfaceForm[] = [];
      if (c.client_id) {
        sfs.push({
          text: c.client_id,
          text_lower: c.client_id.toLowerCase(),
          method: "id",
          base_confidence: 1.0,
        });
      }
      if (c.name && c.name.length >= 4) {
        sfs.push({
          text: c.name,
          text_lower: c.name.toLowerCase(),
          method: "full_name",
          base_confidence: 0.95,
        });
      }
      for (const a of aliases) {
        if (a.length >= 4) {
          sfs.push({
            text: a,
            text_lower: a.toLowerCase(),
            method: "alias",
            base_confidence: 0.9,
          });
        }
      }
      this.addEntity({ id: c.id, type: "Client", display_name: c.name, surface_forms: sfs });
      stats.by_type.Client += 1;
    }

    // Vendor
    const vendors = await graph.query<{
      id: string;
      vendor_id: string;
      name: string;
      aliases: string;
    }>(
      `MATCH (v:Vendor) RETURN v.id AS id, v.vendor_id AS vendor_id, v.name AS name, v.aliases AS aliases`,
    );
    for (const v of vendors) {
      const aliases = parseAliases(v.aliases);
      const sfs: SurfaceForm[] = [];
      if (v.vendor_id) {
        sfs.push({
          text: v.vendor_id,
          text_lower: v.vendor_id.toLowerCase(),
          method: "id",
          base_confidence: 1.0,
        });
      }
      if (v.name && v.name.length >= 4) {
        sfs.push({
          text: v.name,
          text_lower: v.name.toLowerCase(),
          method: "full_name",
          base_confidence: 0.95,
        });
      }
      for (const a of aliases) {
        if (a.length >= 4) {
          sfs.push({
            text: a,
            text_lower: a.toLowerCase(),
            method: "alias",
            base_confidence: 0.9,
          });
        }
      }
      this.addEntity({ id: v.id, type: "Vendor", display_name: v.name, surface_forms: sfs });
      stats.by_type.Vendor += 1;
    }

    // Project & Topic — usually empty initially; LLM populates them
    const projects = await graph.query<{
      id: string;
      name: string;
      aliases: string;
    }>(
      `MATCH (n:Project) RETURN n.id AS id, n.name AS name, n.aliases AS aliases`,
    );
    for (const p of projects) {
      const aliases = parseAliases(p.aliases);
      const sfs: SurfaceForm[] = [
        ...(p.name && p.name.length >= 3
          ? [
              {
                text: p.name,
                text_lower: p.name.toLowerCase(),
                method: "full_name" as const,
                base_confidence: 0.95,
              },
            ]
          : []),
        ...aliases
          .filter((a) => a.length >= 3)
          .map((a) => ({
            text: a,
            text_lower: a.toLowerCase(),
            method: "alias" as const,
            base_confidence: 0.9,
          })),
      ];
      this.addEntity({ id: p.id, type: "Project", display_name: p.name, surface_forms: sfs });
      stats.by_type.Project += 1;
    }

    const topics = await graph.query<{
      id: string;
      name: string;
      aliases: string;
    }>(
      `MATCH (n:Topic) RETURN n.id AS id, n.name AS name, n.aliases AS aliases`,
    );
    for (const t of topics) {
      const aliases = parseAliases(t.aliases);
      const sfs: SurfaceForm[] = [
        ...(t.name && t.name.length >= 3
          ? [
              {
                text: t.name,
                text_lower: t.name.toLowerCase(),
                method: "full_name" as const,
                base_confidence: 0.95,
              },
            ]
          : []),
        ...aliases
          .filter((a) => a.length >= 3)
          .map((a) => ({
            text: a,
            text_lower: a.toLowerCase(),
            method: "alias" as const,
            base_confidence: 0.9,
          })),
      ];
      this.addEntity({ id: t.id, type: "Topic", display_name: t.name, surface_forms: sfs });
      stats.by_type.Topic += 1;
    }

    stats.total_entities = this.entities.size;
    stats.total_surface_forms = this.surfaceForms.length;
    return stats;
  }

  private addEntity(e: CanonicalEntity): void {
    this.entities.set(e.id, e);
    for (const sf of e.surface_forms) {
      this.surfaceForms.push({
        text: sf.text,
        text_lower: sf.text_lower,
        method: sf.method,
        base_confidence: sf.base_confidence,
        entity_id: e.id,
        entity_type: e.type,
      });
    }
  }

  // ───────── Resolution ─────────

  resolve(text: string, ctx: ResolverContext = {}): Mention[] {
    if (!text) return [];
    const lowerText = text.toLowerCase();
    const mentions: Mention[] = [];

    // Surface-form scan: cheap String.includes() filter, then word-boundary
    // regex for exact span. Multiple passes are folded into one loop because
    // each surface form already carries its method/confidence.
    for (const sf of this.surfaceForms) {
      if (!lowerText.includes(sf.text_lower)) continue;

      // Word boundaries: anchor against alphanumeric edges so substrings
      // inside words don't match (e.g. "Hardy" inside "Hardye").
      const pattern = new RegExp(escapeRegex(sf.text), "gi");
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(text)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        if (!isWordBoundary(text, start, end)) continue;
        mentions.push({
          span: [start, end],
          surface: m[0],
          entity_id: sf.entity_id,
          entity_type: sf.entity_type,
          confidence: sf.base_confidence,
          method: sf.method,
        });
      }
    }

    // Context shortcuts: "I"/"me"/"my" → sender, "you"/"your" → recipient.
    if (ctx.sender_emp_id) {
      const senderId = this.personByEmpId.get(ctx.sender_emp_id);
      if (senderId) {
        for (const surf of ["I", "me", "my", "myself"]) {
          const re = new RegExp(`\\b${surf}\\b`, "g");
          let m: RegExpExecArray | null;
          while ((m = re.exec(text)) !== null) {
            mentions.push({
              span: [m.index, m.index + m[0].length],
              surface: m[0],
              entity_id: senderId,
              entity_type: "Person",
              confidence: 0.95,
              method: "context",
            });
          }
        }
      }
    }
    if (ctx.recipient_emp_id) {
      const recipientId = this.personByEmpId.get(ctx.recipient_emp_id);
      if (recipientId) {
        for (const surf of ["you", "your", "yourself"]) {
          const re = new RegExp(`\\b${surf}\\b`, "gi");
          let m: RegExpExecArray | null;
          while ((m = re.exec(text)) !== null) {
            mentions.push({
              span: [m.index, m.index + m[0].length],
              surface: m[0],
              entity_id: recipientId,
              entity_type: "Person",
              confidence: 0.85,
              method: "context",
            });
          }
        }
      }
    }

    // Dedup overlapping spans: prefer higher confidence; ties go to longer span.
    return dedupOverlaps(mentions);
  }

  /** Diagnostic: get the entity by ID (for the extractor's prompt). */
  getEntity(id: string): CanonicalEntity | undefined {
    return this.entities.get(id);
  }

  /** Total entities & surface forms loaded. */
  size(): { entities: number; surface_forms: number } {
    return {
      entities: this.entities.size,
      surface_forms: this.surfaceForms.length,
    };
  }
}

// ───────── helpers ─────────

function parseAliases(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

/** Generate Person surface forms with conventional confidence levels. */
function personSurfaceForms(
  name: string,
  empId: string | undefined,
  email: string | undefined,
  aliases: string[],
): SurfaceForm[] {
  const out: SurfaceForm[] = [];

  if (empId) {
    out.push({
      text: empId,
      text_lower: empId.toLowerCase(),
      method: "id",
      base_confidence: 1.0,
    });
  }
  if (email) {
    out.push({
      text: email,
      text_lower: email.toLowerCase(),
      method: "email",
      base_confidence: 1.0,
    });
    // Also match the email's local-part (e.g. "raj.patel" without domain)
    const local = email.split("@")[0];
    if (local && local.length >= 4 && local !== name.toLowerCase()) {
      out.push({
        text: local,
        text_lower: local.toLowerCase(),
        method: "email",
        base_confidence: 0.9,
      });
    }
  }

  if (name) {
    out.push({
      text: name,
      text_lower: name.toLowerCase(),
      method: "full_name",
      base_confidence: 0.95,
    });

    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      const first = parts[0];
      const last = parts[parts.length - 1];

      // "R. Patel" / "R Patel"
      if (first.length >= 1 && last.length >= 3) {
        const initialLast = `${first[0]}. ${last}`;
        out.push({
          text: initialLast,
          text_lower: initialLast.toLowerCase(),
          method: "first_initial",
          base_confidence: 0.7,
        });
      }
      // "Patel"
      if (last.length >= 4) {
        out.push({
          text: last,
          text_lower: last.toLowerCase(),
          method: "last_name",
          base_confidence: 0.3,
        });
      }
      // "Raj"
      if (first.length >= 3) {
        out.push({
          text: first,
          text_lower: first.toLowerCase(),
          method: "first_name",
          base_confidence: 0.2,
        });
      }
    }
  }

  for (const a of aliases) {
    if (a.length >= 3) {
      out.push({
        text: a,
        text_lower: a.toLowerCase(),
        method: "alias",
        base_confidence: 0.9,
      });
    }
  }

  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Verify the substring at [start, end) is bounded by a non-alphanumeric
 * character (or string boundary). Avoids matching substrings inside
 * larger words.
 */
function isWordBoundary(text: string, start: number, end: number): boolean {
  const before = start === 0 ? "" : text[start - 1];
  const after = end >= text.length ? "" : text[end];
  const isAlnum = (c: string) => /[A-Za-z0-9_]/.test(c);
  return !isAlnum(before) && !isAlnum(after);
}

/**
 * Drop mentions whose spans are subsets of higher-confidence mentions.
 * If two mentions have the same span, prefer higher confidence; on ties,
 * prefer earlier method (id > email > full_name > alias > ...).
 */
function dedupOverlaps(mentions: Mention[]): Mention[] {
  if (mentions.length === 0) return [];

  // Sort: longer span first, then higher confidence. So when we walk the
  // list, an earlier mention is always at least as "strong" as later ones
  // it might overlap with.
  const sorted = [...mentions].sort((a, b) => {
    const lenA = a.span[1] - a.span[0];
    const lenB = b.span[1] - b.span[0];
    if (lenA !== lenB) return lenB - lenA;
    return b.confidence - a.confidence;
  });

  const kept: Mention[] = [];
  for (const m of sorted) {
    const overlaps = kept.some(
      (k) =>
        // k contains m, or m contains k (k is already kept and "stronger")
        (k.span[0] <= m.span[0] && k.span[1] >= m.span[1]) ||
        (m.span[0] <= k.span[0] && m.span[1] >= k.span[1]),
    );
    if (!overlaps) kept.push(m);
  }

  // Return in document order for downstream readability.
  kept.sort((a, b) => a.span[0] - b.span[0]);
  return kept;
}
