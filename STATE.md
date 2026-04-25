# State — Saturday Apr 25, end of afternoon

## What's working end-to-end

```
EnterpriseBench (data/enterprise-bench/)
       │
       ▼
   Adapters (email, hr, chat, kb + registries)
       │
       ▼
   Pipeline (ingest)  ──────────►  Kuzu graph
       │                            • 1,460 Source nodes
       │                            • 1,260 Person + 90 Customer + 1,351 Product
       │                            • 400 Client + 400 Vendor + 31 Topic + ...
       │                            • 15,328 Facts (structured + LLM-extracted)
       │                            • Manages, Mentions* edges
       ▼
   Decoupled extractor (extract)
       │
       ├─► LocalResolver (3.5k entities, 11.8k surface forms, ~1ms/source)
       ├─► FileCache (content-hashed, JSON on disk)
       └─► Gemini 2.5 Flash via Vercel AI SDK
              (thinking off, concurrency=10, cached, ~7s/call)
```

## Packages built

| Package | Lines | Status |
|---|---|---|
| `@spine/schema` | ~150 | done |
| `@spine/graph` | ~280 | done |
| `@spine/adapters` | ~600 | done — email, hr, chat, kb + registries |
| `@spine/cache` | ~140 | done — atomic writes, 2-char shard, version-bump invalidation |
| `@spine/resolver` | ~350 | done — multi-pass with confidence scoring |
| `@spine/extractor` | ~200 | done — Vercel AI SDK + Gemini + Zod + thinking-off |
| `@spine/api` | ~400 | done — `ingest` + `extract` CLIs |

## CLI commands available

```bash
# Stage 1 — ingest external data
npm run ingest -- --source all
npm run ingest -- --source email --limit 100   # source-specific
npm run ingest -- --source registries           # just canonical entity catalogs

# Stage 2 — LLM enrichment (decoupled, idempotent, concurrent, cached)
npm run -w @spine/api extract -- --limit 20 --concurrency 10
npm run -w @spine/api extract -- --limit 50 --dry-run
npm run -w @spine/api extract -- --source-type chat --limit 100

# Diagnostic
npm run -w @spine/api resolver-test
```

## Performance baselines

| Operation | Time |
|---|---|
| Resolver load (3.5k entities) | 47 ms |
| Resolver per source | 1–2 ms |
| Extractor per call (cold, thinking off) | ~7 s |
| Extractor 20 sources at c=10 | 18 s wall |
| Extractor 20 sources from cache | 0.4 s |
| Persistence 260 facts + 53 entities + 103 mentions | 0.3 s |

Scaling math at c=10: 200 sources ≈ 3 min, 27k full ≈ 6.7 h.

## Decisions locked in this session

- npm workspaces (not pnpm — avoided install friction)
- KuzuDB 0.6.1 — works despite "deprecated" notice; quirks captured (count alias clashes, no array params, segfault on close)
- TypeScript end-to-end
- Gemini 2.5 Flash with thinking disabled (3.4× speedup, no quality loss)
- Concurrency 10 sweet spot (c=20 marginal gain)
- ACL inheritance: LLM facts inherit ACL from their source
- No embeddings (rule-based + LLM adjudication; revival kit in DEFERRED.md)
- No admin UI (policies in YAML — engine not built yet)

## Known polish gaps (caught during 20-source persist)

1. **Topic-ID drift across calls.** LLM proposes `topic/cross_departmental_goals` and `topic/cross_departmental_goals_quarterly_reviews` for the same concept in different sources. Post-resolution / topic-canonicalization step needed.
2. **LLM occasionally violates id-prefix convention.** Saw `new_entity/employee_retention_topic` instead of `topic/...`. Needs prompt tightening.
3. **Mentions edges only for Person**. Topics/Commitments created by the LLM aren't in the pre-resolver index, so the resolver doesn't emit edges to them. Need to re-resolve after extraction or have the extractor emit explicit Source→NewEntity mentions.
4. **Cross-source entity resolution at LLM proposal time.** Currently the LLM doesn't see Topics created by *previous* extraction calls. Each call starts fresh. Means duplicate Topic nodes per concept.

## Not yet built

- **Policy engine** (read `policies.yaml`, narrow ACL at fact-write time)
- **MCP server** (`@modelcontextprotocol/sdk`, exposes `query_entity` + `search_context`)
- **Inspector UI** (Lovable-scaffolded React + entity page + graph explorer)
- **Conflict engine + Entire integration** (detect contradictions, route to human queue)
- **Audit log** (append-only fact-access log)
- **Demo entity selection** (scan graph for hero employee/customer/topic)
- **Demo Loom recording**

## How to resume tomorrow morning

```bash
cd "/Users/shyju/Documents/hackathon projects/spine-big-berlin-hack"
# All deps already installed via npm install
# Graph state preserved at data/spine.db
# Cache preserved at data/cache/extractor (20 sources extracted)
# Just open the brief + this file:
open PROJECT_BRIEF.md STATE.md DEFERRED.md
```

## Next-action candidates (not prioritized)

| Option | Time | Demo impact |
|---|---|---|
| Run extractor on 200-source targeted sample (hero entities) | 30 min | High — populates demo beats |
| Build MCP server with `query_entity` + `search_context` tools | 2–3 h | High — needed to demo Claude querying the graph |
| Build basic Inspector UI in Lovable (entity page + role switcher) | 3–4 h | High — visual demo backbone |
| Build policy engine (YAML → ACL enforcement at query time) | 2 h | Medium — RBAC story for the demo |
| Topic-canonicalization post-pass | 1 h | Medium — cleaner graph for screenshots |
| Conflict engine + Entire integration | 2 h | High for beat 5 |
| Demo entity selection / sampling script | 30 min | Foundational — picks hero employee/customer/project |

Current best guess at critical path for the demo: **demo entity selection → targeted extraction → MCP server → Inspector UI**.
