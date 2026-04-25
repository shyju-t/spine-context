#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { FileCache } from "@spine/cache";
import { Extractor, type ExtractorOutput } from "@spine/extractor";
import { Graph } from "@spine/graph";
import { LocalResolver, type Mention } from "@spine/resolver";
import type {
  EntityType,
  Fact,
  SourceRecord,
  SourceType,
} from "@spine/schema";

interface CliArgs {
  db: string;
  cache: string;
  model: string;
  limit: number;
  concurrency: number;
  sourceType?: SourceType;
  dryRun: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = "true";
      }
    }
  }
  const baseDir = process.env.INIT_CWD ?? process.cwd();
  return {
    db: out.db ?? join(baseDir, "data/spine.db"),
    cache: out.cache ?? join(baseDir, "data/cache/extractor"),
    model: out.model ?? "gemini-2.5-flash",
    limit: out.limit ? Number(out.limit) : 20,
    concurrency: out.concurrency ? Number(out.concurrency) : 10,
    sourceType: (out["source-type"] as SourceType) || undefined,
    dryRun: out["dry-run"] === "true",
    force: out["force"] === "true",
  };
}

/**
 * Bounded-concurrency map. Runs `worker` against `items` with up to
 * `concurrency` calls in flight at once. Preserves output order.
 * No external dep — keeps the workspace lean.
 */
async function boundedMap<I, O>(
  items: I[],
  concurrency: number,
  worker: (item: I, idx: number) => Promise<O>,
): Promise<O[]> {
  const results: O[] = new Array(items.length);
  let next = 0;
  async function runner() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: n }, () => runner()));
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY && !process.env.GOOGLE_API_KEY) {
    throw new Error(
      "Set GOOGLE_GENERATIVE_AI_API_KEY (or GOOGLE_API_KEY) before running.",
    );
  }
  // Vercel AI SDK reads GOOGLE_GENERATIVE_AI_API_KEY by default.
  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY && process.env.GOOGLE_API_KEY) {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = process.env.GOOGLE_API_KEY;
  }

  console.log(`[extract] starting`);
  console.log(`  db:           ${args.db}`);
  console.log(`  cache:        ${args.cache}`);
  console.log(`  model:        ${args.model}`);
  console.log(`  limit:        ${args.limit}`);
  console.log(`  concurrency:  ${args.concurrency}`);
  console.log(
    `  persistence:  ${args.dryRun ? "DRY RUN (no writes)" : "ON (writing to graph)"}`,
  );
  if (args.sourceType) console.log(`  type:         ${args.sourceType}`);

  const graph = new Graph(args.db);
  await graph.init();

  // 1. Load resolver from current graph state
  const resolver = new LocalResolver();
  const t0 = performance.now();
  const stats = await resolver.load(graph);
  console.log(
    `[resolver] loaded ${stats.total_entities} entities, ${stats.total_surface_forms} forms in ${(performance.now() - t0).toFixed(1)}ms`,
  );

  // 2. Cache + Extractor
  const cache = new FileCache<ExtractorOutput>(args.cache);
  const extractor = new Extractor({ resolver, cache, model: args.model });

  // 3. Pull a mix of sources to extract from. Sources that already have
  //    extractor-authored facts are excluded so we don't re-process them.
  const { sources, alreadyExtracted } = await loadSourceMix(
    graph,
    args.limit,
    args.sourceType,
    args.force,
  );
  if (alreadyExtracted > 0) {
    console.log(
      `[extract] skipping ${alreadyExtracted} already-extracted sources`,
    );
  }
  console.log(`[extract] processing ${sources.length} new sources`);
  if (sources.length === 0) {
    console.log(
      `[extract] nothing new to extract — all candidates already done`,
    );
    return;
  }

  // Persistence runs AFTER extraction to keep Kuzu writes serialized
  // (Kuzu's embedded connection is single-writer; concurrent inserts
  // would just queue).
  const persistTotals = {
    facts: 0,
    new_entities: 0,
    mentions: 0,
    fact_errors: 0,
  };

  const t_batch_start = performance.now();
  const results = await boundedMap(sources, args.concurrency, async (s) => {
    const md = parseMetadata(s.metadata as unknown as string);
    const ctx: { sender_emp_id?: string; recipient_emp_id?: string } = {};
    if (md.sender_emp_id) ctx.sender_emp_id = md.sender_emp_id as string;
    if (md.recipient_emp_id)
      ctx.recipient_emp_id = md.recipient_emp_id as string;

    try {
      const r = await extractor.extract({ source: s, ctx });
      const tag = r.cache_hit ? "[CACHE]" : `[${r.llm_ms.toFixed(0)}ms]`;
      console.log(
        `${tag} ${s.id}  facts=${r.output.facts.length}  new_entities=${r.output.new_entities.length}  mentions=${r.mentions.length}`,
      );
      return {
        source: s,
        output: r.output,
        mentions: r.mentions,
        facts: r.output.facts.length,
        new_entities: r.output.new_entities.length,
        mentions_count: r.mentions.length,
        cache_hit: r.cache_hit,
        llm_ms: r.llm_ms,
        ok: true as const,
      };
    } catch (err) {
      console.error(`[extract] FAILED ${s.id}:`, (err as Error).message);
      return {
        source: s,
        output: null,
        mentions: [] as Mention[],
        facts: 0,
        new_entities: 0,
        mentions_count: 0,
        cache_hit: false,
        llm_ms: 0,
        ok: false as const,
      };
    }
  });
  const t_batch_ms = performance.now() - t_batch_start;

  // Sequential persistence pass — Kuzu is single-writer.
  if (!args.dryRun) {
    console.log(`\n[persist] writing extraction results to graph`);
    const t_persist_start = performance.now();
    for (const r of results) {
      if (!r.ok || !r.output) continue;
      // LLM-derived facts inherit ACL from their source, set at ingest time.
      const sourceAcl = r.source.default_acl ?? ["employee:all"];
      const stats = await persistExtraction(
        graph,
        r.source,
        r.output,
        r.mentions,
        sourceAcl,
        args.model,
      );
      persistTotals.facts += stats.facts;
      persistTotals.new_entities += stats.new_entities;
      persistTotals.mentions += stats.mentions;
      persistTotals.fact_errors += stats.fact_errors;
    }
    console.log(
      `[persist] facts=${persistTotals.facts}, new_entities=${persistTotals.new_entities}, mentions=${persistTotals.mentions}, fact_errors=${persistTotals.fact_errors} (${((performance.now() - t_persist_start) / 1000).toFixed(1)}s)`,
    );
  }

  // 4. Aggregate
  const okResults = results.filter((r) => r.ok);
  console.log(`\n[extract] summary`);
  console.log(`  sources processed:    ${okResults.length} / ${results.length}`);
  console.log(`  cache hits:           ${extractor.stats.cache_hits}`);
  console.log(`  llm calls:            ${extractor.stats.llm_calls}`);
  console.log(`  errors:               ${extractor.stats.errors}`);
  console.log(`  total facts:          ${extractor.stats.total_facts}`);
  console.log(`  total new_entities:   ${extractor.stats.total_new_entities}`);
  console.log(
    `  batch wall time:      ${(t_batch_ms / 1000).toFixed(1)}s (concurrency=${args.concurrency})`,
  );
  if (extractor.stats.llm_calls > 0) {
    const totalLlmMs = results
      .filter((r) => !r.cache_hit)
      .reduce((s, r) => s + r.llm_ms, 0);
    console.log(
      `  avg per-call ms:      ${(totalLlmMs / extractor.stats.llm_calls).toFixed(0)} (sum-of-call-times / call-count)`,
    );
    console.log(
      `  effective throughput: ${((extractor.stats.llm_calls / t_batch_ms) * 1000).toFixed(2)} calls/sec`,
    );
  }

  if (!args.dryRun) {
    console.log(`\n[persist] totals`);
    console.log(`  facts written:        ${persistTotals.facts}`);
    console.log(`  new entities written: ${persistTotals.new_entities}`);
    console.log(`  mentions written:     ${persistTotals.mentions}`);
    console.log(`  fact insert errors:   ${persistTotals.fact_errors}`);
  }

  // Sample facts inspection: read directly from the cache files.
  console.log(
    `\n[extract] cached outputs available at: ${args.cache}/<hash>/output.json`,
  );
}

// ───────────── Persistence ─────────────

interface PersistStats {
  facts: number;
  new_entities: number;
  mentions: number;
  fact_errors: number;
}

/**
 * Materialize an extractor output into the graph.
 *
 *   1. new_entities → upsert correct node type (Topic / Project / Decision /
 *      Commitment) so that facts referencing them have a target.
 *   2. pre-resolved mentions → Source-[:Mentions{Type}]->Entity edges.
 *   3. extracted facts → Fact nodes with provenance pointing to the source.
 *
 * Facts whose entity_id can't be matched to either an existing canonical
 * entity OR an LLM-proposed new_entity are still written — query time
 * will simply find no node on the other end. We could skip them; for v1,
 * we keep them since the entity_id is still meaningful as a string ID.
 */
async function persistExtraction(
  graph: Graph,
  source: SourceRecord,
  output: ExtractorOutput,
  mentions: Mention[],
  sourceAcl: string[],
  model: string,
): Promise<PersistStats> {
  const stats: PersistStats = {
    facts: 0,
    new_entities: 0,
    mentions: 0,
    fact_errors: 0,
  };

  // 1. Materialize LLM-proposed new entities first so facts referencing
  //    them have a node on the other side.
  for (const e of output.new_entities) {
    try {
      const entity = {
        id: e.proposed_id,
        name: e.name,
        aliases: e.aliases ?? [],
      };
      switch (e.type) {
        case "Topic":
          await graph.upsertTopic(entity);
          break;
        case "Project":
          await graph.upsertProject(entity);
          break;
        case "Decision":
          await graph.upsertDecision(entity);
          break;
        case "Commitment":
          await graph.upsertCommitment(entity);
          break;
      }
      stats.new_entities += 1;
    } catch (err) {
      console.warn(
        `[persist] entity ${e.proposed_id} skipped: ${(err as Error).message}`,
      );
    }
  }

  // 2. Pre-resolved mentions → edges. Only use mentions with confidence
  //    above a low threshold so noisy first-name matches don't pollute.
  for (const m of mentions) {
    if (m.confidence < 0.5) continue;
    try {
      await graph.addMentions(
        source.id,
        m.entity_id,
        m.entity_type as EntityType,
        m.method,
        m.confidence,
      );
      stats.mentions += 1;
    } catch {
      // entity may not exist (e.g., first_name pointing to a person we
      // didn't ingest); skip silently
    }
  }

  // 3. Facts.
  for (const f of output.facts) {
    const fact: Fact = {
      id: randomUUID(),
      entity_id: f.entity_id,
      attribute: f.attribute,
      value: f.value,
      type: f.fact_type,
      valid_from: null,
      valid_to: null,
      tx_from: new Date(),
      tx_to: null,
      source_id: source.id,
      source_span:
        f.source_span_start !== null && f.source_span_end !== null
          ? [f.source_span_start, f.source_span_end]
          : null,
      confidence: f.confidence,
      author: `extractor:${model}`,
      acl: sourceAcl,
      override_by: null,
      override_reason: null,
    };
    try {
      await graph.insertFact(fact);
      stats.facts += 1;
    } catch (err) {
      stats.fact_errors += 1;
      // Log only the first to avoid spam
      if (stats.fact_errors === 1) {
        console.warn(
          `[persist] first fact insert error: ${(err as Error).message}`,
        );
      }
    }
  }

  return stats;
}

async function loadSourceMix(
  graph: Graph,
  limit: number,
  type?: SourceType,
  force = false,
): Promise<{ sources: SourceRecord[]; alreadyExtracted: number }> {
  // Source IDs that already have at least one extractor-authored Fact.
  // We use these to skip re-selection at the picking layer (LLM-cache
  // would skip them anyway, but this also avoids loading their content
  // and running the resolver). --force overrides this — used when
  // re-extracting after a prompt change.
  const extractedIds = force ? new Set<string>() : await getExtractedSourceIds(graph);

  const cols = `s.id AS id, s.type AS type, s.external_id AS external_id, s.subject AS subject, s.content AS content, s.metadata AS metadata, s.ingested_at AS ingested_at, s.acl AS acl`;

  // Pull more candidates than `limit` to leave room for filtering.
  // For the already-extracted set we know the count, so multiplier scales.
  const overFetch = Math.max(limit + extractedIds.size + 50, limit * 2);

  if (type) {
    const rows = await graph.query<RawSourceRow>(
      `MATCH (s:Source) WHERE s.type = '${type}' RETURN ${cols} LIMIT ${overFetch}`,
    );
    const all = rows.map(rowToSource);
    const filtered = all.filter((s) => !extractedIds.has(s.id));
    return {
      sources: filtered.slice(0, limit),
      alreadyExtracted: all.length - filtered.length,
    };
  }
  // Mix: split limit across email, chat, kb roughly evenly
  const per = Math.ceil(overFetch / 3);
  const types: SourceType[] = ["email", "chat", "kb"];
  const all: SourceRecord[] = [];
  for (const t of types) {
    const rows = await graph.query<RawSourceRow>(
      `MATCH (s:Source) WHERE s.type = '${t}' RETURN ${cols} LIMIT ${per}`,
    );
    all.push(...rows.map(rowToSource));
  }
  const filtered = all.filter((s) => !extractedIds.has(s.id));
  return {
    sources: filtered.slice(0, limit),
    alreadyExtracted: all.length - filtered.length,
  };
}

/**
 * Source IDs that already have at least one extractor-authored Fact.
 * Authoritative skip-list so we don't waste resolver cycles or risk
 * silent re-extraction.
 */
async function getExtractedSourceIds(graph: Graph): Promise<Set<string>> {
  const rows = await graph.query<{ source_id: string }>(
    `MATCH (f:Fact) WHERE f.author STARTS WITH 'extractor:' RETURN DISTINCT f.source_id AS source_id`,
  );
  return new Set(rows.map((r) => r.source_id));
}

interface RawSourceRow {
  id: string;
  type: string;
  external_id: string;
  subject: string;
  content: string;
  metadata: string;
  ingested_at: string;
  acl: string;
}

function rowToSource(r: RawSourceRow): SourceRecord {
  return {
    id: r.id,
    type: r.type as SourceType,
    external_id: r.external_id,
    subject: r.subject,
    content: r.content,
    metadata: parseMetadata(r.metadata),
    ingested_at: new Date(r.ingested_at),
    default_acl: parseAclArray(r.acl),
  };
}

function parseAclArray(json: string | null | undefined): string[] {
  if (!json) return ["employee:all"];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as string[]) : ["employee:all"];
  } catch {
    return ["employee:all"];
  }
}

function parseMetadata(s: string | null | undefined): Record<string, unknown> {
  if (!s) return {};
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
