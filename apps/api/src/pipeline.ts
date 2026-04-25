import type { SourceAdapter, SourceRecord } from "@spine/schema";
import type { Graph } from "@spine/graph";

export interface IngestStats {
  records: number;
  facts: number;
  errors: number;
}

export interface PipelineOptions {
  graph: Graph;
  /**
   * Per-record hook for adapter-specific side-writes (Person nodes,
   * Customer nodes, edges, etc.). Called after the Source node and any
   * structured facts are written.
   */
  onRecord?: (record: SourceRecord, raw: unknown) => Promise<void> | void;

  /** Cap the number of records ingested. Useful for smoke tests. */
  limit?: number;
}

/**
 * Run an adapter against a location.
 *
 * For each yielded raw record:
 *   1. normalize → SourceRecord
 *   2. write Source node
 *   3. extractStructuredFacts (if defined) → write Facts
 *   4. invoke onRecord hook
 *
 * The LLM extractor is NOT called here. That stage will be added once the
 * extractor package exists; it consumes Source.content and emits more Facts.
 */
export async function ingest<Raw>(
  adapter: SourceAdapter<Raw>,
  location: string,
  opts: PipelineOptions,
): Promise<IngestStats> {
  const stats: IngestStats = { records: 0, facts: 0, errors: 0 };
  const limit = opts.limit ?? Infinity;

  for await (const raw of adapter.discover(location)) {
    if (stats.records >= limit) break;

    try {
      const record = adapter.normalize(raw);
      await opts.graph.insertSource(record);
      stats.records += 1;

      if (adapter.extractStructuredFacts) {
        const facts = adapter.extractStructuredFacts(record, raw);
        for (const f of facts) {
          await opts.graph.insertFact(f);
        }
        stats.facts += facts.length;
      }

      if (opts.onRecord) await opts.onRecord(record, raw);
    } catch (err) {
      stats.errors += 1;
      const msg = (err as Error).message ?? String(err);
      console.warn(`[ingest:${adapter.type}] error: ${msg}`);
    }
  }

  return stats;
}
