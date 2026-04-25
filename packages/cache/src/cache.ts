import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * File-based content-hashed cache.
 *
 * Layout:
 *   <root>/
 *     ab/
 *       cdef0123.../
 *         input.json    (what we hashed, for debugging)
 *         output.json   (the cached value)
 *
 * Two-character shard prefix prevents one giant directory of 30k entries
 * from making `ls` cry. Atomic writes via tmp-file + rename so a crash
 * mid-write can't corrupt the cache.
 *
 * Cache key is a SHA-256 of a JSON canonicalization of all inputs that
 * could change the response. Cache buster: bump `version` on the
 * CacheKeyInput to force a full-cache invalidation in one line.
 */

export interface CacheKeyInput {
  /** Bump to invalidate the entire cache when prompt logic changes. */
  version: string;
  /** Model identifier — different models get different cache entries. */
  model: string;
  /** Anything else that affects the response. */
  inputs: Record<string, unknown>;
}

export interface CacheStats {
  hits: number;
  misses: number;
  writes: number;
}

export class FileCache<T = unknown> {
  readonly stats: CacheStats = { hits: 0, misses: 0, writes: 0 };

  constructor(public readonly root: string) {}

  hashKey(key: CacheKeyInput): string {
    // Canonical stringify (sorted keys) so semantically identical inputs
    // hash to the same string regardless of insertion order.
    const payload = JSON.stringify({
      version: key.version,
      model: key.model,
      inputs: stableStringify(key.inputs),
    });
    return createHash("sha256").update(payload).digest("hex");
  }

  pathFor(hash: string): { dir: string; outputPath: string; inputPath: string } {
    const shard = hash.slice(0, 2);
    const rest = hash.slice(2);
    const dir = join(this.root, shard, rest);
    return {
      dir,
      outputPath: join(dir, "output.json"),
      inputPath: join(dir, "input.json"),
    };
  }

  async get(key: CacheKeyInput): Promise<T | undefined> {
    const hash = this.hashKey(key);
    const { outputPath } = this.pathFor(hash);
    try {
      const text = await readFile(outputPath, "utf8");
      this.stats.hits += 1;
      return JSON.parse(text) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        // Corrupted or unreadable — treat as miss but log
        console.warn(
          `[cache] read failed for ${hash.slice(0, 8)}: ${(err as Error).message}`,
        );
      }
      this.stats.misses += 1;
      return undefined;
    }
  }

  async put(key: CacheKeyInput, value: T): Promise<void> {
    const hash = this.hashKey(key);
    const { dir, outputPath, inputPath } = this.pathFor(hash);
    await mkdir(dir, { recursive: true });
    await atomicWrite(inputPath, JSON.stringify(key, null, 2));
    await atomicWrite(outputPath, JSON.stringify(value));
    this.stats.writes += 1;
  }

  /**
   * Convenience wrapper: lookup → on miss, run loader, store, return.
   */
  async getOrCompute(
    key: CacheKeyInput,
    loader: () => Promise<T>,
  ): Promise<{ value: T; hit: boolean }> {
    const cached = await this.get(key);
    if (cached !== undefined) return { value: cached, hit: true };
    const fresh = await loader();
    await this.put(key, fresh);
    return { value: fresh, hit: false };
  }

  resetStats(): void {
    this.stats.hits = 0;
    this.stats.misses = 0;
    this.stats.writes = 0;
  }
}

// ─────────── helpers ───────────

async function atomicWrite(path: string, contents: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, contents, "utf8");
  await rename(tmp, path);
}

/**
 * Stable JSON stringify with sorted keys at every depth, so that two
 * objects with the same content but different key insertion order
 * produce the same string.
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(val).sort()) {
        sorted[k] = (val as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return val;
  });
}
