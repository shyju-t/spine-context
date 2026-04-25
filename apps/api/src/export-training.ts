#!/usr/bin/env node
/**
 * Export GLiNER2 training data from the extractor cache for Pioneer
 * fine-tuning.
 *
 * What this does:
 *   1. Walks `data/cache/extractor/<shard>/<hash>/{input,output}.json`
 *   2. For each (source, gemini-output) pair, applies the closed-vocab
 *      mapping in `packages/extractor/src/pioneer-schema.ts`:
 *        - facts with non-null spans whose entity_id maps to a known
 *          entity type → labeled entity surfaces
 *        - facts whose attribute is sentiment-like with a recognized
 *          value → per-source `sentiment` classification
 *        - per-source `fact_type` classification = majority vote of
 *          all kept facts' fact_type
 *      Everything else is dropped and counted in REJECT_REPORT.md.
 *   3. Stratified train/val split (80/20 by default), grouped by source
 *      type so emails/chats/kb/hr balance across both splits.
 *   4. Writes train.jsonl, val.jsonl, SCHEMA_STATS.md, REJECT_REPORT.md
 *      to `data/training/`.
 *
 * Usage:
 *   npm run -w @spine/api export-training -- --val-fraction 0.2
 *   npm run -w @spine/api export-training -- --cache data/cache/extractor --out data/training
 */
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  SPINE_SCHEMA,
  SCHEMA_ENTITY_TYPES,
  classifySentimentValue,
  emptyStats,
  entityTypeFromId,
  isSentimentAttribute,
  renderSchemaMarkdown,
  type SchemaStats,
} from "@spine/extractor";

interface CliArgs {
  cache: string;
  out: string;
  valFraction: number;
  seed: number;
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
    cache: out.cache ?? join(baseDir, "data/cache/extractor"),
    out: out.out ?? join(baseDir, "data/training"),
    valFraction: out["val-fraction"] ? Number(out["val-fraction"]) : 0.2,
    seed: out.seed ? Number(out.seed) : 42,
  };
}

// ─────────── Cache record shapes (mirror extract.ts conventions) ───────────

interface CachedInput {
  version?: string;
  model?: string;
  inputs: {
    source_id: string;
    source_type: string;
    content: string;
    mentions?: Array<{ entity_id: string; surface: string; method: string }>;
    ctx?: Record<string, unknown>;
  };
}

interface CachedFact {
  entity_id: string;
  attribute: string;
  value: string;
  fact_type: "static" | "procedural" | "trajectory";
  confidence: number;
  source_span_start: number | null;
  source_span_end: number | null;
  reasoning?: string;
}

interface CachedOutput {
  new_entities?: Array<{
    proposed_id: string;
    type: string;
    name: string;
    aliases?: string[];
  }>;
  facts: CachedFact[];
}

// ─────────── GLiNER2 training-record shape ───────────

interface TrainingRecord {
  input: string;
  output: {
    entities?: Record<string, string[]>;
    classifications?: Array<{
      task: string;
      labels: string[];
      true_label: string[];
    }>;
  };
  /** Provenance — kept in JSONL via a sidecar field that GLiNER2 ignores. */
  meta: {
    source_id: string;
    source_type: string;
  };
}

// ─────────── Walk the cache ───────────

async function* walkCache(
  cacheDir: string,
): AsyncGenerator<{ inputPath: string; outputPath: string }> {
  let shards: string[];
  try {
    shards = await readdir(cacheDir);
  } catch (err) {
    throw new Error(
      `Cannot read cache dir ${cacheDir}: ${(err as Error).message}`,
    );
  }
  for (const shard of shards) {
    const shardPath = join(cacheDir, shard);
    let entries: string[];
    try {
      entries = await readdir(shardPath);
    } catch {
      continue; // not a directory
    }
    for (const e of entries) {
      const dir = join(shardPath, e);
      yield {
        inputPath: join(dir, "input.json"),
        outputPath: join(dir, "output.json"),
      };
    }
  }
}

// ─────────── Conversion ───────────

/**
 * Resolve a fact's entity_id to a GLiNER2 entity-type, accounting for
 * Gemini's well-known prefix drift (the "LLM occasionally violates
 * id-prefix convention" gap from STATE.md). Without this, ~20% of facts
 * silently dropped because Gemini wrote `new_entity/foo` instead of
 * `topic/foo`.
 *
 * Order of checks:
 *   1. Canonical prefix (`person/`, `customer/`, ...) — fast path
 *   2. `new_entity/X` or `new_entities/X` → look X up in the
 *      output.new_entities array to recover the LLM-declared type
 *   3. Compound prefixes Gemini sometimes invents (`new_project/`,
 *      `new_feature/`, `new_topic/`, `new_commitment/`, `new_product/`)
 *   4. Known-non-entity prefixes (`kb/`, `meeting/`, `task/`) → drop
 *
 * Returns null if we can't confidently classify.
 */
function resolveEntityType(
  entity_id: string,
  newEntityTypeById: Map<string, string>,
): string | null {
  // 1. Canonical
  const canonical = entityTypeFromId(entity_id);
  if (canonical) return canonical;

  // 2. new_entity/X or new_entities/X — cross-reference
  // proposed_ids in output.new_entities INCLUDE the `new_entity/` prefix
  // already (e.g. "new_entity/diverse_talent_acquisition_strategies"), so
  // we look up the full entity_id, not the stripped slug.
  if (
    entity_id.startsWith("new_entity/") ||
    entity_id.startsWith("new_entities/")
  ) {
    const direct = newEntityTypeById.get(entity_id);
    if (direct) return canonicalNewEntityType(direct);
    // Fallback: also try the slug-only key, in case some outputs use that
    const slug = entity_id.split("/").slice(1).join("/");
    const slugHit = newEntityTypeById.get(slug);
    if (slugHit) return canonicalNewEntityType(slugHit);
    return null;
  }

  // 3. Compound prefixes
  if (entity_id.startsWith("new_project/")) return "project";
  if (entity_id.startsWith("new_feature/")) return "project";
  if (entity_id.startsWith("new_topic/")) return "topic";
  if (entity_id.startsWith("new_commitment/")) return "commitment";
  if (entity_id.startsWith("new_product/")) return "product";
  if (entity_id.startsWith("new_decision/")) return "decision";

  // 4. Known-non-entity — explicit drop list (silences "unknown" noise)
  if (
    entity_id.startsWith("kb/") ||
    entity_id.startsWith("meeting/") ||
    entity_id.startsWith("task/")
  ) {
    return null;
  }

  return null;
}

function canonicalNewEntityType(t: string): string | null {
  const map: Record<string, string> = {
    Topic: "topic",
    Project: "project",
    Decision: "decision",
    Commitment: "commitment",
  };
  return map[t] ?? null;
}

function buildTrainingRecord(
  input: CachedInput,
  output: CachedOutput,
  stats: SchemaStats,
): TrainingRecord | null {
  const content = input.inputs.content;
  const sourceId = input.inputs.source_id;
  const sourceType = input.inputs.source_type;

  // Build proposed_id → type / name maps for new_entity/ resolution
  const newEntityTypeById = new Map<string, string>();
  const newEntityNameById = new Map<string, string>();
  for (const ne of output.new_entities ?? []) {
    if (ne.proposed_id && ne.type) {
      newEntityTypeById.set(ne.proposed_id, ne.type);
      if (ne.name) newEntityNameById.set(ne.proposed_id, ne.name);
    }
  }

  // entities[type] = surfaces (deduped)
  const entities: Record<string, Set<string>> = {};
  const sentimentVotes: Record<string, number> = {};
  const factTypeVotes: Record<string, number> = {
    static: 0,
    procedural: 0,
    trajectory: 0,
  };

  // ── 1. Entity surfaces from input.mentions (the GOLD source) ──
  // These come from LocalResolver — clean, deterministic, and the surface
  // strings are verbatim text that appears in the source content.
  for (const m of input.inputs.mentions ?? []) {
    stats.total_mentions += 1;
    const entType = resolveEntityType(m.entity_id, newEntityTypeById);
    if (!entType) {
      stats.mentions_dropped_unknown_type += 1;
      continue;
    }
    if (!SCHEMA_ENTITY_TYPES.has(entType)) {
      stats.mentions_dropped_outside_schema += 1;
      continue; // e.g. resolver matched a `meeting/` ID — not in our 9 types
    }
    const surface = m.surface?.trim();
    if (!surface || surface.length === 0 || surface.length > 200) {
      stats.mentions_dropped_empty_surface += 1;
      continue;
    }
    if (content.indexOf(surface) < 0) {
      stats.mentions_dropped_surface_not_in_content += 1;
      continue;
    }
    (entities[entType] ??= new Set()).add(surface);
    stats.mentions_kept += 1;
  }

  // ── 2. LLM-proposed entity names + aliases — secondary surface source ──
  // The resolver only knows about pre-existing entities; new things the
  // LLM identified (Topics, Projects, Commitments, Decisions) live in
  // output.new_entities with `name` + `aliases`. Aliases are critical:
  // the cache audit showed only 15% of `name` strings appear verbatim in
  // content, but 74% of (name OR alias) do. Without aliases, Decision
  // and Commitment classes were starved.
  for (const ne of output.new_entities ?? []) {
    const entType = canonicalNewEntityType(ne.type);
    if (!entType || !SCHEMA_ENTITY_TYPES.has(entType)) continue;
    const candidates: string[] = [];
    if (ne.name) candidates.push(ne.name);
    for (const alias of ne.aliases ?? []) {
      if (alias) candidates.push(alias);
    }
    let added = false;
    for (const raw of candidates) {
      const cand = raw.trim();
      if (!cand || cand.length < 3 || cand.length > 200) continue;
      if (content.indexOf(cand) < 0) continue;
      (entities[entType] ??= new Set()).add(cand);
      added = true;
    }
    if (added) stats.llm_proposed_names_added += 1;
    else stats.llm_proposed_names_not_in_content += 1;
  }

  // ── 3. Sentiment + fact_type votes from facts ──
  // Facts no longer drive entity extraction (their spans are evidence
  // spans, not mention spans, so slicing them yielded garbage in v1.0).
  // They DO still tell us per-source sentiment and the dominant fact_type.
  for (const fact of output.facts) {
    stats.total_facts += 1;
    factTypeVotes[fact.fact_type] += 1;
    if (isSentimentAttribute(fact.attribute)) {
      const label = classifySentimentValue(fact.value);
      if (label) {
        sentimentVotes[label] = (sentimentVotes[label] ?? 0) + 1;
        stats.facts_kept_as_sentiment += 1;
      } else {
        stats.facts_dropped_sentiment_unmapped += 1;
      }
    }
  }

  // Build output
  const recOut: TrainingRecord["output"] = {};
  const entityKeys = Object.keys(entities);
  if (entityKeys.length > 0) {
    recOut.entities = {};
    for (const k of entityKeys) {
      recOut.entities[k] = [...entities[k]];
    }
  }
  const classifications: TrainingRecord["output"]["classifications"] = [];
  if (Object.keys(sentimentVotes).length > 0) {
    const winner = Object.entries(sentimentVotes).sort(
      (a, b) => b[1] - a[1],
    )[0][0];
    classifications.push({
      task: "sentiment",
      labels: SPINE_SCHEMA.classifications.find((c) => c.name === "sentiment")!
        .labels,
      true_label: [winner],
    });
  }
  // fact_type majority — only emit if we kept at least one fact
  const totalVotes = Object.values(factTypeVotes).reduce((a, b) => a + b, 0);
  if (totalVotes > 0) {
    const winner = Object.entries(factTypeVotes).sort(
      (a, b) => b[1] - a[1],
    )[0][0];
    classifications.push({
      task: "fact_type",
      labels: SPINE_SCHEMA.classifications.find((c) => c.name === "fact_type")!
        .labels,
      true_label: [winner],
    });
  }
  if (classifications.length > 0) recOut.classifications = classifications;

  // Skip records that ended up empty — no signal for the model.
  if (!recOut.entities && !recOut.classifications) return null;

  stats.outputs_with_at_least_one_label += 1;
  return {
    input: content,
    output: recOut,
    meta: { source_id: sourceId, source_type: sourceType },
  };
}

// ─────────── Stratified split ───────────

/** Mulberry32 — small deterministic PRNG so the split is reproducible. */
function mulberry32(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rand: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function stratifiedSplit(
  records: TrainingRecord[],
  valFraction: number,
  seed: number,
): { train: TrainingRecord[]; val: TrainingRecord[] } {
  const byType = new Map<string, TrainingRecord[]>();
  for (const r of records) {
    const arr = byType.get(r.meta.source_type) ?? [];
    arr.push(r);
    byType.set(r.meta.source_type, arr);
  }
  const train: TrainingRecord[] = [];
  const val: TrainingRecord[] = [];
  const rand = mulberry32(seed);
  for (const [, group] of byType) {
    const shuffled = shuffle(group, rand);
    const valSize = Math.max(1, Math.round(shuffled.length * valFraction));
    val.push(...shuffled.slice(0, valSize));
    train.push(...shuffled.slice(valSize));
  }
  return { train, val };
}

// ─────────── Reports ───────────

function renderStatsMarkdown(
  stats: SchemaStats,
  trainCount: number,
  valCount: number,
  entityCountsTrain: Record<string, number>,
  entityCountsVal: Record<string, number>,
): string {
  const lines: string[] = [];
  lines.push("# Schema-curated export — stats");
  lines.push("");
  lines.push("## Pipeline");
  lines.push("");
  lines.push(
    "Entity surfaces come from `input.mentions` (LocalResolver output, deterministic) " +
      "+ LLM-proposed names from `output.new_entities`. Fact spans are NOT used for " +
      "entity supervision — they're evidence spans, not mention spans.",
  );
  lines.push("");
  lines.push("## Cache → curated counts");
  lines.push("");
  lines.push(`- **Cache outputs walked**: ${stats.total_outputs}`);
  lines.push("");
  lines.push(`### Mentions pipeline (entities)`);
  lines.push(`- Total mentions seen: ${stats.total_mentions}`);
  lines.push(`- **Kept**: ${stats.mentions_kept}`);
  lines.push(
    `- Dropped — unknown entity_id type: ${stats.mentions_dropped_unknown_type}`,
  );
  lines.push(
    `- Dropped — outside schema (e.g. meeting/): ${stats.mentions_dropped_outside_schema}`,
  );
  lines.push(
    `- Dropped — empty/oversized surface: ${stats.mentions_dropped_empty_surface}`,
  );
  lines.push(
    `- Dropped — surface not found in content: ${stats.mentions_dropped_surface_not_in_content}`,
  );
  lines.push("");
  lines.push(`### LLM-proposed names (secondary entity source)`);
  lines.push(`- **Added**: ${stats.llm_proposed_names_added}`);
  lines.push(
    `- Skipped — name not verbatim in content: ${stats.llm_proposed_names_not_in_content}`,
  );
  lines.push("");
  lines.push(`### Facts pipeline (sentiment + fact_type only)`);
  lines.push(`- Total facts seen: ${stats.total_facts}`);
  lines.push(
    `- Kept as sentiment vote: ${stats.facts_kept_as_sentiment}`,
  );
  lines.push(
    `- Dropped — sentiment value unmapped: ${stats.facts_dropped_sentiment_unmapped}`,
  );
  lines.push("");
  lines.push(
    `- **Sources with ≥1 label after curation**: ${stats.outputs_with_at_least_one_label}`,
  );
  lines.push("");
  lines.push(`## Final split`);
  lines.push("");
  lines.push(`- train.jsonl: **${trainCount}** records`);
  lines.push(`- val.jsonl: **${valCount}** records`);
  lines.push("");
  lines.push(`## Entity coverage (surface counts)`);
  lines.push("");
  lines.push("| type | train | val |");
  lines.push("|---|---:|---:|");
  const types = new Set([
    ...Object.keys(entityCountsTrain),
    ...Object.keys(entityCountsVal),
  ]);
  const ordered = [...types].sort(
    (a, b) =>
      (entityCountsTrain[b] ?? 0) - (entityCountsTrain[a] ?? 0),
  );
  for (const t of ordered) {
    lines.push(
      `| ${t} | ${entityCountsTrain[t] ?? 0} | ${entityCountsVal[t] ?? 0} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

// ─────────── Main ───────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log(`[export-training] starting`);
  console.log(`  cache:         ${args.cache}`);
  console.log(`  out:           ${args.out}`);
  console.log(`  val fraction:  ${args.valFraction}`);
  console.log(`  seed:          ${args.seed}`);

  const stats = emptyStats();
  const records: TrainingRecord[] = [];
  let parseErrors = 0;

  for await (const { inputPath, outputPath } of walkCache(args.cache)) {
    let inputRaw: string;
    let outputRaw: string;
    try {
      inputRaw = await readFile(inputPath, "utf8");
      outputRaw = await readFile(outputPath, "utf8");
    } catch {
      continue; // missing pair — skip silently
    }
    let input: CachedInput;
    let output: CachedOutput;
    try {
      input = JSON.parse(inputRaw);
      output = JSON.parse(outputRaw);
    } catch {
      parseErrors += 1;
      continue;
    }
    stats.total_outputs += 1;
    const rec = buildTrainingRecord(input, output, stats);
    if (rec) records.push(rec);
  }

  console.log(
    `[export-training] processed ${stats.total_outputs} cached outputs (${parseErrors} parse errors)`,
  );

  const { train, val } = stratifiedSplit(records, args.valFraction, args.seed);

  console.log(
    `[export-training] split: train=${train.length}, val=${val.length}`,
  );

  // Per-entity-type coverage (input to stats markdown + console summary)
  const countEntities = (recs: TrainingRecord[]): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const r of recs) {
      for (const [t, surfaces] of Object.entries(r.output.entities ?? {})) {
        out[t] = (out[t] ?? 0) + surfaces.length;
      }
    }
    return out;
  };
  const entityCountsTrain = countEntities(train);
  const entityCountsVal = countEntities(val);

  await mkdir(args.out, { recursive: true });
  // JSONL — one record per line; meta sidecar field is ignored by GLiNER2.
  await writeFile(
    join(args.out, "train.jsonl"),
    train.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  await writeFile(
    join(args.out, "val.jsonl"),
    val.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  await writeFile(
    join(args.out, "SCHEMA_STATS.md"),
    renderStatsMarkdown(
      stats,
      train.length,
      val.length,
      entityCountsTrain,
      entityCountsVal,
    ),
  );
  await writeFile(
    join(args.out, "PIONEER_SCHEMA.md"),
    renderSchemaMarkdown(),
  );

  console.log(`\n[export-training] entity-label counts in train set:`);
  for (const [t, c] of Object.entries(entityCountsTrain).sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`  ${c.toString().padStart(5)}  ${t}`);
  }

  console.log(`\n[export-training] outputs written to: ${args.out}`);
  console.log(`  train.jsonl              ${train.length} records`);
  console.log(`  val.jsonl                ${val.length} records`);
  console.log(`  SCHEMA_STATS.md          coverage report`);
  console.log(`  PIONEER_SCHEMA.md        schema spec for Pioneer chat`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
