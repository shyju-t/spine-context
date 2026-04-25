# Spine

**The compiled state of your company.** A role-aware, time-versioned fact graph
that sits underneath every AI integration in an enterprise — humans browse it
through an Inspector, AI agents query it through MCP, every answer carries
provenance back to its source span.

Submitted to **[Big Berlin Hack](https://techeurope.notion.site/bigberlinhack)**'s
[Qontext track](https://qontext.ai), April 25–26 2026.

---

## The problem

Today, every AI tool in a company reconstructs *"what's true about our
business"* from scratch on every query — re-RAG'ing scattered sources
wastefully, inconsistently, without receipts, without access control. Five
specific failure modes:

1. **Reconstruction cost** — every query re-derives company reality from scratch
2. **Inconsistency** — same question, different source subsets sampled, different answer
3. **No provenance at the fact level** — answers without receipts erode trust
4. **No surgical update semantics** — when sources change, the AI's "knowledge" doesn't update coherently
5. **No role-aware access** — privacy and compliance are afterthoughts

Companies throw engineering at each separately. Spine is the missing layer.

## What Spine does

```
             unstructured enterprise sources
       (emails, chats, policy docs, KB, CRM, HR)
                         │
            ┌────────────▼────────────┐
            │  Source-agnostic        │
            │  ingestion adapters     │
            └────────────┬────────────┘
                         │
            ┌────────────▼────────────┐    ┌──────────────────┐
            │  LLM extractor          │ ←─ │ LocalResolver    │
            │  (Gemini 2.5 Flash)     │    │ (3.5k entities,  │
            │  Pre-resolves entities, │    │  rule-based,     │
            │  emits typed facts      │    │  no embeddings)  │
            └────────────┬────────────┘    └──────────────────┘
                         │
            ┌────────────▼────────────┐    ┌──────────────────┐
            │  KuzuDB graph           │ ←─ │ Conflict engine  │
            │  Source · Fact · Person │    │ (entity-type     │
            │  Topic · Project · ...  │    │  aware rules)    │
            └────────┬───────┬────────┘    └──────────────────┘
                     │       │
        ┌────────────▼─┐   ┌─▼──────────────────────────┐
        │  REST + MCP  │   │  Inspector UI              │
        │  (Hono)      │   │  Entity pages · Timeline   │
        │  /api/* /mcp │   │  Conflict Queue · Roles    │
        └──────────────┘   └────────────────────────────┘
              ↑                   ↑
       AI agents             Humans (employees, exec, HR, CS)
       (Claude Desktop,      with role-based ACL
        Cursor, custom)      filtering visible facts
```

Every fact is `(entity_id, attribute, value, type, source_id, source_span,
confidence, acl, author)`. Every Inspector view is a derived rendering of
the underlying graph. Every MCP tool call returns the same facts the
Inspector shows — different protocols, same source of truth.

## Why Spine vs RAG

| | RAG | Spine |
|---|---|---|
| **Storage** | Document chunks + embeddings | Typed facts in a graph with provenance |
| **Retrieval** | Vector-search top-K chunks | Resolve entity → pull facts |
| **Answer shape** | 3 passages, possibly contradicting | One fact with source span |
| **LLM role** | Mandatory — composes answer | Optional — facts are already structured |
| **Updates** | Re-embed the document | Update one fact in place; history preserved |
| **ACL** | Document-level | Fact-level |
| **Conflicts** | Hidden in noisy retrieval | Surfaced in the Conflict Queue |
| **Identity** | "Raj" and "Mr. Patel" are different strings | Resolved to one canonical Person |
| **Pitch line** | Search engine over text | **Compiled state of the company** |

dbt for unstructured knowledge.

## Quick start

Prerequisites: Node 22+, a Gemini API key.

```bash
# 1. Clone + install
git clone git@github.com:shyju-t/spine-context.git
cd spine-context
npm install

# 2. API key
cp .env.local.example .env.local
# edit .env.local, set GOOGLE_GENERATIVE_AI_API_KEY=...

# 3. Get the EnterpriseBench dataset (130 MB, EMNLP 2025)
huggingface-cli download AST-FRI/EnterpriseBench \
  --repo-type dataset --local-dir data/enterprise-bench

# 4. Ingest sources into the graph (no LLM, ~30 s)
npm run -w @spine/api ingest -- --source registries
npm run -w @spine/api ingest -- --source hr
npm run -w @spine/api ingest -- --source email --limit 1000
npm run -w @spine/api ingest -- --source chat --limit 1000
npm run -w @spine/api ingest -- --source kb --limit 1000

# 5. LLM-enrich (cached, concurrent, idempotent — ~10 min for 700 sources)
npm run -w @spine/api extract -- --limit 700 --concurrency 10

# 6. Boot the server (REST + MCP) and the Inspector UI
npm run -w @spine/api server   # → http://localhost:3001
# in a second terminal:
npm run -w @spine/web dev      # → http://localhost:5173
```

Open `http://localhost:5173`. Try queries like *"Ravi Kumar"*, *"Vendor
Management Challenges"*, *"Castillo Inc"*, *"quarterly reviews"*. Switch
the role dropdown to watch ACLs gate visible facts.

## Connect to Claude Desktop or Cursor

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "spine": { "url": "http://localhost:3001/mcp" }
  }
}
```

Same shape for Cursor's `mcp.json`. Then ask Claude things like *"Use spine
to look up Ravi Kumar — what's his role?"*

## Repo layout

```
apps/
  api/              REST API + MCP-over-HTTP server (Hono)
                    Ingestion CLI · Extract CLI · Test scripts
  web/              Inspector UI (Vite + React + Tailwind)
packages/
  schema/           Zod schemas: Fact, SourceRecord, SourceAdapter, Entity types
  graph/            KuzuDB wrapper: DDL + insert/upsert/edge helpers
  adapters/         Source adapters: email, hr, chat, kb, registries
  cache/            File-based content-hashed extractor cache
  resolver/         LocalResolver: pre-LLM entity resolution
  extractor/        LLM extractor: prompt + Gemini + Zod schema
data/               Local DB + cache + dataset (gitignored)
PROJECT_BRIEF.md    Full design doc with architecture, demo narrative
USE_CASES.md        13 real-world use cases
DEFERRED.md         Decisions deliberately deferred + revival kits
STATE.md            Snapshot of build state at end of Saturday
```

## Partner technologies used

| Tech | Where |
|---|---|
| **Google Gemini** | LLM extractor (`packages/extractor/`) |
| **Lovable** | StatsStrip component on the home page (`apps/web/src/components/StatsStrip.tsx`) |
| **Pioneer (Fastino)** | GLiNER2 schema export for fine-tuning (`packages/extractor/src/pioneer-schema.ts`, `apps/api/src/export-training.ts`) |
| **Aikido** | Repo connected for security scan |

## What's deferred (and why)

See [`DEFERRED.md`](./DEFERRED.md). Quick highlights:

- **Embeddings** — rule-based + LLM adjudication outperforms at this scale; revival kit included
- **Admin UI** — policies live in `policies.yaml`; visual editor is post-hackathon
- **Local LLM** — `Extractor` interface designed for it; only Gemini ships
- **Streaming ingestion** — batch is fine for the demo

## License

MIT — see [`LICENSE`](./LICENSE) (TBD; will add).

## Acknowledgments

Built on the **EnterpriseBench** dataset by Vishwakarma et al. (EMNLP 2025).
The synthetic company name *Inazuma.co* and all employee/customer/vendor
data come from that benchmark.
