import { generateObject } from "ai";
import { google } from "@ai-sdk/google";
import { FileCache } from "@spine/cache";
import type { LocalResolver } from "@spine/resolver";
import type { SourceRecord } from "@spine/schema";
import {
  PROMPT_VERSION,
  SYSTEM_PROMPT,
  buildUserPrompt,
} from "./prompt.js";
import {
  ExtractorOutputSchema,
  type ExtractorOutput,
  type PreResolvedMention,
} from "./types.js";

export interface ExtractorOptions {
  resolver: LocalResolver;
  cache: FileCache<ExtractorOutput>;
  /** Gemini model id, e.g. "gemini-2.0-flash". */
  model?: string;
  /** Override prompt version for cache busting (defaults to PROMPT_VERSION). */
  promptVersion?: string;
}

export interface ExtractRequest {
  source: SourceRecord;
  /** Optional resolver context (sender/recipient) for the source. */
  ctx?: {
    sender_emp_id?: string;
    recipient_emp_id?: string;
    date?: Date;
  };
}

export interface ExtractResult {
  output: ExtractorOutput;
  mentions: PreResolvedMention[];
  cache_hit: boolean;
  /** ms spent in the LLM call. 0 if cached. */
  llm_ms: number;
}

export class Extractor {
  private readonly model: string;
  private readonly promptVersion: string;
  readonly stats = {
    calls: 0,
    cache_hits: 0,
    llm_calls: 0,
    errors: 0,
    total_facts: 0,
    total_new_entities: 0,
  };

  constructor(private readonly opts: ExtractorOptions) {
    this.model = opts.model ?? "gemini-2.5-flash";
    this.promptVersion = opts.promptVersion ?? PROMPT_VERSION;
  }

  async extract(req: ExtractRequest): Promise<ExtractResult> {
    this.stats.calls += 1;

    // 1. Pre-resolve mentions (no LLM, deterministic)
    const mentions = this.opts.resolver.resolve(req.source.content, {
      source_type: req.source.type,
      sender_emp_id: req.ctx?.sender_emp_id,
      recipient_emp_id: req.ctx?.recipient_emp_id,
      date: req.ctx?.date,
    });

    // Build entity labels for prompt grounding.
    const entity_labels: Record<string, string> = {};
    for (const m of mentions) {
      if (entity_labels[m.entity_id]) continue;
      const ent = this.opts.resolver.getEntity(m.entity_id);
      if (ent) entity_labels[m.entity_id] = ent.display_name;
    }

    // 2. Cache lookup
    const cacheKey = {
      version: this.promptVersion,
      model: this.model,
      inputs: {
        source_id: req.source.id,
        source_type: req.source.type,
        content: req.source.content,
        mentions: mentions.map((m) => ({
          entity_id: m.entity_id,
          surface: m.surface,
          method: m.method,
        })),
        ctx: req.ctx ?? null,
      },
    };
    const cached = await this.opts.cache.get(cacheKey);
    if (cached) {
      this.stats.cache_hits += 1;
      this.stats.total_facts += cached.facts.length;
      this.stats.total_new_entities += cached.new_entities.length;
      return { output: cached, mentions, cache_hit: true, llm_ms: 0 };
    }

    // 3. LLM call
    const userPrompt = buildUserPrompt({
      source: req.source,
      mentions: mentions as PreResolvedMention[],
      entity_labels,
    });

    const t0 = performance.now();
    let output: ExtractorOutput;
    let usage: {
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
    } = {};
    try {
      const result = await generateObject({
        model: google(this.model),
        schema: ExtractorOutputSchema,
        system: SYSTEM_PROMPT,
        prompt: userPrompt,
        temperature: 0,
        providerOptions: {
          google: {
            // Disable Gemini 2.5's thinking-mode for extraction work —
            // we want fast structured output, not internal reasoning.
            // thinkingBudget=0 turns it off; we can dial up if quality drops.
            thinkingConfig: {
              thinkingBudget: 0,
              includeThoughts: false,
            },
          },
        },
      });
      output = result.object;
      usage = result.usage as typeof usage;
    } catch (err) {
      this.stats.errors += 1;
      throw err;
    }
    const llm_ms = performance.now() - t0;
    if (process.env.SPINE_LOG_USAGE === "1") {
      console.log(
        `[extractor] ${req.source.id}: ${llm_ms.toFixed(0)}ms, ` +
          `prompt=${usage.promptTokens ?? "?"}, completion=${usage.completionTokens ?? "?"}, total=${usage.totalTokens ?? "?"}`,
      );
    }

    this.stats.llm_calls += 1;
    this.stats.total_facts += output.facts.length;
    this.stats.total_new_entities += output.new_entities.length;

    // 4. Cache write
    await this.opts.cache.put(cacheKey, output);

    return { output, mentions, cache_hit: false, llm_ms };
  }

  /** Reset perf/quality counters (e.g. between iterations). */
  resetStats(): void {
    this.stats.calls = 0;
    this.stats.cache_hits = 0;
    this.stats.llm_calls = 0;
    this.stats.errors = 0;
    this.stats.total_facts = 0;
    this.stats.total_new_entities = 0;
  }
}
