# Spine — the compiled state of your company

**Submitted to**: Big Berlin Hack — Qontext track
**Track brief**: *"Turn fragmented company data into a context base AI can operate on"* (qontext.ai)
**Event**: Big Berlin Hack · April 25–26, 2026 · The Delta Campus, Berlin
**Prize**: 1g gold bar per team member + private dinner with the Qontext team
**Submission deadline**: Sunday April 26, 14:00
**Team size**: up to 5

---

## TL;DR

Every AI tool in a company reconstructs "what's true about our business" from scratch on every query — re-RAG'ing scattered sources wastefully, inconsistently, without receipts, without access control. We build the compiled context layer that sits underneath every AI integration: a **role-aware, time-versioned fact graph**, browsable by humans through multiple views (entity pages, graph explorer, conflict queue), queryable by AI agents through MCP, with provenance on every answer and ACL at the fact level.

---

## The problem we're solving

Today, when someone in a company asks an AI "what's our refund policy for enterprise accounts?", the system vector-searches across mail, CRM, Notion, PDFs, Slack, and tickets, pulls some chunks, stuffs them into a prompt, and hopes the answer is grounded. This fails in five specific ways:

1. **Reconstruction cost** — every query re-derives company reality from scratch
2. **Inconsistency** — same question, different source subsets sampled, different answer
3. **No provenance at the fact level** — answers without receipts erode trust
4. **No surgical update semantics** — when sources change, the AI's "knowledge" doesn't update coherently
5. **No role-aware access** — privacy and compliance are either absent (AI leaks exec data to ICs) or crude (whole documents redacted when only one sentence was sensitive)

Companies throw engineering at each of these separately — one team solves entity resolution for sales, another solves policy retrieval for support, another bolts on redaction for HR. Every AI initiative rebuilds a crippled version of the same missing layer.

**That missing layer is the product.**

---

## Who uses it

| User | Example query | What they get back |
|---|---|---|
| **CS agent** | "Acme Corp, rep Alice promised 50% off on Jan 10 — policy? approved?" | Promise email + policy + CFO override, cited, in 5 seconds |
| **CEO / exec** | "Q2 status — shipped, slipped, at risk?" | Consolidated trajectory facts with **disagreements surfaced** (Eng says shipped, Sales says blocked — both cited), not flattened into a single false answer |
| **Engineer** | "How do we handle auth in the user service?" | Procedural facts with last-verified date; stale facts flagged |
| **New hire** | "Parental leave policy for part-timers in Germany?" | Definitive HR facts, region-scoped, without asking 5 people |
| **HR / Sales / Legal** | role-specific queries | Same graph, different slice, different ACL |
| **AI agent (any)** | MCP query | Structured facts with provenance — no more re-RAG'ing raw sources |

Same underlying graph. Multiple views per persona, filtered by role. Audit log on every access.

**Hero wedge for demo**: customer service. ROI is immediate and measurable (minutes saved per ticket × tickets), scope is bounded, failure mode is tolerable, expands naturally to the rest of the org.

---

## The product

### Storage: a property graph

- **Nodes** = entities (Person, Customer, Product, Project, Policy, …)
- **Edges** = relationships (manages, owns, applies_to, mentions, …)
- **Facts** live on nodes and edges as properties

### Fact schema

```
fact = {
  entity:         <node_id>
  attribute:      <string>              # "current_role", "salary_band", ...
  value:          <any>
  type:           static | procedural | trajectory
  valid_time:     (from, to)            # when it's true in the world
  transaction_time: (from, to)          # when it was recorded
  source_id:      <source_record_id>    # FK to Source node
  source_span:    (start, end)          # char offsets within source.content
  confidence:     0.0–1.0
  author:         extractor_id | user_id
  acl:            [role:…, person:…]    # who can see this
  override:       { by: user, reason: ... } | null
}
```

### Source storage and provenance

Raw source records live as first-class nodes in the graph. Each fact points back at its source and the exact character span within that source — so provenance is literal, not approximate, and the Inspector can highlight the line that produced the fact.

```
CREATE NODE TABLE Source(
  id              STRING,       -- e.g. "email/msg_8473"
  type            STRING,       -- email | crm | doc | slack | ticket
  external_id     STRING,       -- original ID in the source system
  subject         STRING,       -- "Summary of feature 1 for project"
  content         STRING,       -- full raw content (text)
  metadata        STRING,       -- JSON: from, to, date, thread, attachments
  ingested_at     TIMESTAMP,
  acl             STRING[],
  PRIMARY KEY(id)
)
```

Facts reference sources via `source_id` as a property (not an edge — one less join at read time) plus `source_span` for character-level precision.

Why sources are nodes, not just URIs:

- **Separate ACL**: a fact can be visible to all employees, but its source (a confidential HR email) may be role-restricted. Source ACL is orthogonal to fact ACL.
- **Reverse lookup**: "show me every fact derived from this email" is one query — powers auditing ("what did the AI learn from this record?").
- **One source → many facts**: an email with 3 extracted assertions = 1 Source node + 3 Fact rows. Clean normalization.

**Provenance click flow**:

```
1. UI  → GET /source/{source_id}  (role header)
2. API → check Source.acl vs user.roles
       → allowed: return source content + span to highlight
       → denied: return "source requires role:hr" marker
                 (the fact stays visible, the source link is redacted)
3. UI  → render source with the producing span highlighted
```

### Source adapters — pluggable, source-agnostic ingestion

The pipeline is neutral about source type. Adding a new source is a small adapter file, not a pipeline change. Everything downstream of `normalize()` (extract → resolve → conflict → policy → commit) is source-agnostic.

```typescript
interface SourceAdapter {
  type: string;                            // "email" | "crm" | "hr" | ...

  // Walk a location (dir / file / API) and yield raw records
  discover(location: string): AsyncIterable<RawRecord>;

  // Convert a raw record into a normalized SourceRecord
  normalize(raw: RawRecord): SourceRecord;

  // Optional: extract facts directly from structured fields (no LLM)
  // Used when the source has known schemas (HR, CRM, clients) — saves
  // most of our Gemini calls
  extractStructuredFacts?(record: SourceRecord): Fact[];

  // Optional: suggest default ACL based on source location/metadata
  defaultAcl?(record: SourceRecord): string[];
}

interface SourceRecord {
  id:           string;     // "email/msg_8473" — globally unique
  type:         string;     // adapter.type
  external_id:  string;     // original ID in source system
  subject?:     string;
  content:      string;     // canonical text representation
  metadata:     Record<string, any>;  // type-specific structured fields
  ingested_at:  Date;
}
```

**Two extraction modes per source**:

- **Structured** (when fields are known): direct field-to-fact mapping, no LLM call. Cheap, deterministic, debuggable. Use for HR employee records, CRM products/sales, client/vendor records.
- **Unstructured** (always, on `content`): the universal Gemini extractor with a `source_type` tag and type-specific few-shots. Use for email bodies, chat dialogues, policy documents, Q&A posts.

A typical record produces both: e.g., an HR employee record direct-maps `salary_band`, `level`, `manager_id` (structured) and LLM-extracts skill/seniority/leadership-style facts from the `description` text (unstructured).

The extractor prompt template is universal across sources — only the few-shot examples vary by `source_type`. **A new source = ~50 lines of adapter, no other changes.**

### Write pipeline

```
source records (email, CRM, docs, chat, tickets, ...)
  ↓
adapter.normalize → SourceRecord
  ↓
adapter.extractStructuredFacts (if defined)   → structured facts
  +
LLM extractor on record.content                → unstructured facts
  (typed: static / procedural / trajectory)
  ↓
entity resolver (rule-based, with LLM adjudication for ambiguous cases)
  • exact match on canonical name → hit? merge
  • email normalization (schen@acme → first-letter + last-name candidate)
  • fuzzy string match (Jaro-Winkler) → top-k candidates
  • nickname map (Bob↔Robert, Sue↔Susan)
  • if multiple candidates or low confidence → Gemini adjudicates
  ↓
conflict engine (detects, auto-resolves easy, escalates ambiguous to human queue)
  ↓
policy engine (applies policies.yaml → computes ACL for each fact)
  ↓
commit to graph (with provenance, ACL, timestamps preserved)
```

> Embeddings were considered and deferred — see `DEFERRED.md` for the reasoning and revival kit.

### Search and retrieval

Two-tier: structured first, unstructured fallback. Covers both *"tell me about X"* (the entity exists) and *"find references to X"* (discovery before an entity is formed).

**Tier 1 — Entity lookup** (the common case)

Resolve the query term against canonical names and aliases:

```cypher
MATCH (n)
WHERE n.canonical_name = $query
   OR $query IN n.aliases
RETURN n
```

On hit: pull facts, traverse back to sources.

```cypher
MATCH (f:Fact) WHERE f.entity_id = $matched_id RETURN f

MATCH (f:Fact)
WHERE f.entity_id = $matched_id AND f.source_id IS NOT NULL
RETURN DISTINCT f.source_id
```

The answer is the **entity** plus everything known about it — not a list of source matches. This is what separates Spine from full-text search.

**Tier 2 — Full-text fallback** (when Tier 1 misses)

Used for unresolved mentions and discovery queries:

```cypher
MATCH (s:Source)
WHERE s.content CONTAINS $query OR s.subject CONTAINS $query
RETURN s
ORDER BY s.ingested_at DESC
LIMIT $limit
```

Then surface facts derived from matched sources:

```cypher
MATCH (f:Fact)
WHERE f.source_id IN $matched_source_ids
RETURN f
```

Kuzu `CONTAINS` is O(n) scan. Fine at 48h scale (hundreds of sources). If it slows, add SQLite FTS5 alongside — logged in `DEFERRED.md`.

**MCP tool shape**

```typescript
server.tool('search_context', {
  query:   z.string(),
  as_role: z.string(),
  limit:   z.number().default(10),
}, async ({ query, as_role, limit }) => {
  const entity = await findEntityByName(query);
  if (entity) {
    return {
      type: 'entity_hit',
      entity,
      facts:   await getFactsForEntity(entity.id, as_role),
      sources: await getSourcesForFacts(entity.id, as_role),
    };
  }
  const sources = await fullTextSearch(query, as_role, limit);
  return {
    type: 'source_hits',
    sources,
    facts: await getFactsDerivedFrom(sources, as_role),
  };
});
```

ACL applied at every stage — users never see sources or facts their role doesn't cover.

**Walk-through: `search_context("feature 1")`**

Dataset: "feature 1" mentioned in 5 emails + 1 CRM record + 2 Slack messages. Entity resolver (at ingest) already merged "feature 1" as an alias of `Project Phoenix`.

1. Tier 1 hits on the alias → `Project Phoenix` node
2. Returns: all facts (`status`, `owner`, `deadline`, `blockers`) + 8 source records ordered by recency
3. Inspector renders the entity page with `aka: feature 1, Phoenix, Q2 launch` in the header

One clean answer. No list of mention-hits to dig through.

### Views (all rendered from the graph, no duplicated state)

| View | For | Purpose |
|---|---|---|
| **Entity page** | Humans, most-used | Per-node Markdown rendering: facts as prose + tables with clickable source badges |
| **Graph explorer** | Power users, analysts | Multi-hop traversal ("customers in escalation + their AEs + recent commits") |
| **Timeline** | Execs, auditors | Temporal evolution of a node's facts |
| **Conflict queue** | Reviewers | Facts where sources disagree — routable to the right humans |
| **Audit log** | Compliance, legal | Who accessed what, who edited what, when |
| **MCP API** | AI agents | Programmatic retrieval with provenance baked in |

Edits through any view mutate the graph. All other views reflect instantly. No duplication.

### Mental model: "git for your company's reality"

| git concept | Spine equivalent |
|---|---|
| commit | fact written |
| commit message | source + extraction reason |
| author | extractor version OR human user |
| `git blame` | who/what asserted this fact |
| `git log` | how the company's reality evolved |
| `git diff` | what changed between snapshots |
| branch | proposed edit pending review |
| merge conflict | two sources disagree; resolution routed to human |
| repo permissions | role-based ACL |

---

## Role-based access — first-class, fact-level

The enterprise non-negotiable. ACL lives on every fact, not on documents.

```
Fact {
  entity:    sarah_chen
  attribute: current_role
  value:     "VP Engineering"
  acl:       [employee:all, role:hr, role:exec]
  ...
}

Fact {
  entity:    sarah_chen
  attribute: salary_band
  value:     "L7"
  acl:       [role:hr, role:exec, person:sarah_chen]
  ...
}
```

Rules:

1. Every fact has an ACL, inherited from source, overridable by humans
2. Every query runs as a user with roles — facts filter accordingly
3. Redactions are **visible**: "2 additional facts require role:hr" (not silent)
4. Provenance respects ACL — if a fact is visible but its source isn't, source link is redacted, not the fact
5. Every access is logged: user, timestamp, facts returned, facts redacted

### Policy configuration — YAML, not admin UI

For the 48h build, ACL policies live in a YAML file committed to the repo. No admin UI. A policy engine reads the file at boot, watches for changes, and applies rules at fact write time.

```yaml
# policies.yaml
rules:
  - match: { source_folder: "hr@acme.com" }
    apply_acl: [role:hr, role:exec]

  - match: { attribute: "salary_band" }
    apply_acl: [role:hr, role:exec, person:self]

  - match: { attribute: "current_role" }
    apply_acl: [employee:all]

  - match: { entity_type: "Customer" }
    apply_acl: [role:sales, role:customer_support, role:exec]

users:
  - id: u_ceo     roles: [exec, employee:all]
  - id: u_eng42   roles: [engineering, employee:all]
  - id: u_cs07    roles: [customer_support, employee:all]
```

A fact's ACL at commit time = union of matching rules' ACLs. Humans can still override per-fact via the Inspector, which writes back to the graph (not the YAML).

Post-hackathon this file becomes the backing store for a visual policy editor. For the demo, editing YAML directly + hot-reloading the policy engine is the workflow.

---

## Extensibility: cloud-first, local-ready

The extractor is accessed through a single interface with two implementations. Gemini ships day one; an Ollama-backed local implementation is scaffolded, tested, and documented — not demoed.

```typescript
// packages/llm/extractor.ts
export interface Extractor {
  extract(source: SourceRecord): Promise<Fact[]>;
}

// packages/llm/backends/gemini.ts   ← ships
// packages/llm/backends/ollama.ts   ← scaffold + smoke test
```

Why bake in the abstraction even though local isn't in the demo:

- Every enterprise pilot opens with *"where does our data go?"* — the architecture must have an honest answer, even if the answer is *"swap one module."*
- Post-hackathon, dropping in a local backend is a day of work, not a rewrite.
- Readme has a `LOCAL_MODE.md` that shows the one-line config change to switch.

---

## Hackathon scope — 48 hours

### What we build

1. Source-agnostic ingestion pipeline + adapters for the EnterpriseBench dataset (see ingest plan below)
2. Fact extractor (Gemini-powered) with static/procedural/trajectory typing
3. Entity resolver (rule-based + LLM adjudication) with confidence scoring
4. Fact graph storage (KuzuDB, embedded)
5. Conflict engine with auto-resolve + Entire-backed human escalation
6. MCP server for AI query
7. Inspector UI (Lovable) with three views: entity page, graph explorer, conflict queue
8. ACL enforcement at query time with **visible** redactions
9. Audit log
10. A second, independent dataset (Enron email subset) to prove generalization

### EnterpriseBench ingest plan

Dataset: [AST-FRI/EnterpriseBench](https://huggingface.co/datasets/AST-FRI/EnterpriseBench), 130 MB, EMNLP 2025. Located at `data/enterprise-bench/`.

**Synthetic company**: `Inazuma.co` — D2C/e-commerce, Bangalore-based, ~1,260 employees. Use this name in the demo for authenticity.

**Format reality (from inspection)**: almost everything is JSON. Only `Policy_Documents/` and the `Resume/resumes/` PDFs need PDF parsing. `Resume/` also has a `resume_information.csv` we can use instead of parsing 1,013 PDFs.

| Source path | Adapter `type` | Records | Decision | Notes |
|---|---|---|---|---|
| `Enterprise_mail_system/emails.json` | `email` | 11,928 | **Ship** | sender/recipient `emp_id`, thread_id, subject, body, importance, category |
| `Human_Resource_Management/Employees/employees.json` | `hr` | 1,260 | **Ship** | `reports_to`/`reportees` already encode the org graph — direct-map; LLM only on `description`/`Experience` text |
| `Human_Resource_Management/Resume/resume_information.csv` | `resume` | ~1,013 | **Ship** | Use the CSV; skip the 1,013 PDFs in `resumes/` |
| `Customer_Relation_Management/customers.json` + `products.json` + `sales.json` | `crm` | 90 + 1,351 + 13,510 | **Ship** | Mostly direct-map; LLM on `about_product` text |
| `Policy_Documents/*.pdf` | `doc` | ~25 PDFs | **Ship** | `pdf-parse` per file → SourceRecord with extracted text |
| `Collaboration_tools/conversations.json` | `chat` | 2,897 | **Ship** | Multi-turn dialogue text — best source for beat 4 disagreements |
| `Inazuma_Overflow/overflow.json` | `kb` | 10,823 | **Stretch** | Stack-Overflow-style Q&A with `employee_id` — engineer beat |
| `IT_Service_Management/it_tickets.json` | `ticket` | 163 | **Stretch** | Tiny set; trivial to add (~30 min); IT/engineer context |
| `Business_and_Management/clients.json` | `client` | 400 | **Stretch** | Has `business_representative_employee` — link to HR |
| `Workspace/GitHub/GitHub.json` | — | 750 | Skip | Code-level (repo+path+code), weak signal-to-effort |
| `Enterprise Social Platform/posts.json` | — | 971 | Skip | Overlaps with conversations |
| `Business_and_Management/vendors.json` | — | 400 | Skip | Marginal; doesn't unlock a demo beat |

**Net**: 6 ship + 3 stretch + 3 skip. Stretches are small because the formats are uniform JSON — each is <1h of adapter + structured-fact mapping.

Because the pipeline is source-agnostic, skipped sources can be added opportunistically by writing one ~50-line adapter. No downstream changes.

### Demo entities — pick from the data, don't invent

The dataset doesn't contain a "Sarah Chen" or "Project Phoenix". For demo authenticity, pick real entities once ingestion runs:

- **Hero employee** for beat 2: scan `employees.json` for someone with rich cross-source presence (active emails, reportees, mentioned in conversations, has Overflow posts).
- **Hero customer** for beat 3: pick from the 90 customers in `customers.json` — find one with sales records + an interesting cross-reference in emails.
- **Hero project / disagreement** for beat 4: scan `conversations.json` for an actual cross-team dispute (digital marketing, vendor management, product launches all surface in the data).

Update the demo narrative table once these are picked. Keep current beat names (Sarah Chen, Project Phoenix) as placeholders.

### `tasks.jsonl` is not what we expected

The benchmark's `tasks.jsonl` (22 MB, 483 entries) contains ReAct agent traces with tool definitions, not simple Q&A pairs. **Don't try to "pass benchmark tasks" in the demo** — the format doesn't fit our retrieval-via-MCP story. Use the data dirs only; ignore `tasks.jsonl` for the demo.

### What we explicitly don't build

- **Admin UI** — policies live in `policies.yaml`; role switcher in the Inspector header is a dev widget for the demo, not a product surface
- Real-time streaming ingestion (batch is fine)
- Production SSO/IAM integration — demo with 3 hardcoded user profiles
- Timeline view (cut if tight)
- Mobile / responsive polish
- Multi-language extraction
- Local-LLM demo path (scaffolded, documented, not run during the Loom)

---

## Demo narrative (2-minute Loom)

| Beat | What the judge sees | Duration |
|---|---|---|
| **1. Ingest** | Dataset → graph. Facts stream in with source links. Counter ticks up. | 15s |
| **2. Same question, three users** | "What's Sarah Chen working on?" as CEO → full answer. As engineer → role + projects, "2 facts redacted" visible. As CS agent → "not a customer entity, did you mean...?" | 30s |
| **3. CS agent in action** | Refund-dispute scenario. Query returns promise email + policy + CFO override in 5 seconds, all cited. | 25s |
| **4. CEO conflict surface** | Q2 status query returns consolidated view with *live disagreement* between Engineering and Sales on Project Phoenix — both cited, timestamped, not flattened. | 20s |
| **5. Surgical update + human edit preservation** | Drop a new email. Show graph diff — one property updates. Prior human annotation on the node preserved. | 15s |
| **6. Conflict routed to Entire** | Contradictory email drops. Conflict queue lights up. Human resolves with reason. Override persisted; future confirming sources boost confidence around the override. | 15s |
| **7. Generalize** | Swap to Enron subset. System rebuilds with different schema. No hardcoded assumptions. | 10s |
| **8. Close** | "Every AI integration in your company should route through this layer." Claude instance querying the MCP server. | 10s |

Total ~2:20 → trim to 2:00 in edit.

---

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│  USERS                                                          │
│   ├─ humans → Inspector (Lovable-scaffolded React)              │
│   │    • entity page  • graph explorer                          │
│   │    • conflict queue  • audit log                            │
│   │    • role switcher (dev widget, top-right)                  │
│   └─ AI agents → MCP server (TypeScript SDK, stdio transport)   │
├────────────────────────────────────────────────────────────────┤
│  QUERY / MUTATION LAYER (Hono)                                  │
│   • ACL enforcement (policy engine + per-fact overrides)        │
│   • provenance preservation                                     │
│   • time-aware reads                                            │
│   • audit log on every call                                     │
├────────────────────────────────────────────────────────────────┤
│  POLICY ENGINE   ←──── policies.yaml (hot-reloaded)             │
│   Rules applied at fact write time to compute ACL.              │
│   Per-fact overrides from the Inspector take precedence.        │
├────────────────────────────────────────────────────────────────┤
│  GRAPH STORAGE (KuzuDB, embedded)                               │
│   nodes:  typed entities                                        │
│   edges:  typed relationships                                   │
│   props:  facts {src, conf, author, acl, valid_t, tx_t, ovr}    │
├────────────────────────────────────────────────────────────────┤
│  WRITE PIPELINE                                                 │
│   ingest → extract → resolve entities →                         │
│   conflict-check → apply policy → commit                        │
│           │                                                     │
│           └── Extractor abstraction (Extractor interface)       │
│                 ├─ gemini.ts   (day 1, used in demo)            │
│                 └─ ollama.ts   (scaffold, local mode)           │
├────────────────────────────────────────────────────────────────┤
│  SOURCE ADAPTERS                                                │
│   email · CRM · docs · chat · tickets                           │
└────────────────────────────────────────────────────────────────┘
```

---

## Tech stack decisions

**Language**: TypeScript end-to-end. One repo, one package manager, one type system. Zod schemas flow from ingest → extractor → Kuzu → MCP → UI with zero codegen.

| Layer | Pick | Notes |
|---|---|---|
| Runtime | **Node 22 LTS** | Bun considered; Node is safer for Kuzu native bindings |
| Package manager | **pnpm** (workspaces) | `apps/api`, `apps/mcp`, `apps/web`, `packages/{schema,graph,llm,policy}` |
| Backend HTTP | **Hono** | Lightweight, fast, great TS ergonomics |
| Schema / validation | **Zod** | Source of truth for Fact/Node/Edge shapes |
| LLM client | **Vercel AI SDK** (`ai` + `@ai-sdk/google`) | `generateObject` + Zod = typed structured output |
| Extractor (day 1) | **Gemini** via AI SDK | Required partner tech |
| Extractor (scaffold) | **Ollama** backend via HTTP | Not demoed; proves the abstraction |
| Entity resolution | Rule-based + LLM adjudication (no embeddings) | Exact / email-normalized / fuzzy (Jaro-Winkler) / nickname-map; Gemini adjudicates ambiguous cases. See `DEFERRED.md` for when to add embeddings back |
| Graph DB | **KuzuDB** (embedded, Node bindings) | Real graph semantics, zero infra |
| Policy engine | Custom, YAML-driven, hot-reloaded | `js-yaml` to parse, `chokidar` to watch |
| MCP server | **`@modelcontextprotocol/sdk`** | Official TS SDK |
| Frontend scaffold | **Lovable** (React + Vite + Tailwind + shadcn/ui) | Required partner tech |
| Server state (UI) | **TanStack Query** | Cache + refetch for Inspector |
| Graph viz | **React Flow** | Prettier, ships faster than Cytoscape |
| Markdown rendering | `react-markdown` + `remark-gfm` | Entity page bodies |
| Human-in-loop | **Entire** | Required partner tech; conflict escalation queue |
| Security scan | **Aikido** (side prize) | Free €1000 if we connect repo |

**Partner technologies used (≥3 required)**: Gemini + Lovable + Entire = 3 core. Optionally + Tavily for external fact enrichment (=4). Aikido as side prize (not counted toward the 3).

### What we're deliberately not pulling in

- **LangChain / LlamaIndex** — abstracts the wrong things; direct LLM calls + Zod are clearer
- **Prisma / Drizzle** — KuzuDB queried directly, not via ORM
- **Next.js** — no SSR need; Vite + React is faster
- **Vector DB** (Pinecone, Weaviate, pgvector) — no embeddings in v1; graph-native storage only
- **NextAuth / Clerk** — 3 hardcoded profiles for demo
- **Turborepo / Nx** — pnpm workspaces are enough
- **Docker** — local dev only; ngrok if MCP needs to be reachable

---

## Milestones

### Saturday

| Time | Task |
|---|---|
| 10:00–11:00 | Dataset exploration. Understand provided schema. Sketch entity types. |
| 11:00–13:00 | Graph schema + KuzuDB setup + email ingest adapter |
| 13:00–14:00 | Lunch. Draft extractor prompts. |
| 14:00–18:00 | Fact extractor (Gemini) + entity resolver + first facts landing in graph |
| 18:00–19:00 | Dinner |
| 19:00–23:00 | Conflict engine + Entire integration for escalation |
| 23:00–02:00 | Inspector UI scaffold in Lovable. Entity page view working. |

### Sunday

| Time | Task |
|---|---|
| 08:00–11:00 | MCP server. ACL enforcement. Audit log. |
| 11:00–12:30 | Graph explorer view. Second dataset (Enron) ingest. Generalization proof. |
| 12:30–13:00 | Lunch. Record Loom demo. |
| 13:00–13:45 | Final polish. README. GitHub public. Aikido scan screenshot. |
| 13:45–14:00 | Submit via form. |

---

## Risks & planned cuts

| Risk | Mitigation / Cut plan |
|---|---|
| Extractor accuracy too low | Narrow attribute set; depth over breadth; lower temperature; add few-shot examples |
| Graph complexity overflows 48h | Cut timeline view first; graph explorer degrades to a table view |
| Provided dataset unusable | Switch fully to Enron + a public CRM sample (pre-loaded Friday night) |
| Lovable scaffold slow | Hand-roll minimal Vite+React; keep Lovable only for conflict queue (protects partner-tech count) |
| ACL enforcement buggy | 3 hardcoded user profiles (CEO / engineer / CS) + 3 hardcoded policy rules; full policy engine can degrade to a switch statement |
| Policy YAML parser bugs | Ship with policies hardcoded in TS as fallback; YAML is the stretch goal |
| Kuzu Node bindings unstable | Fallback to Postgres + JSONB with graph-as-self-joins (plan B, ~4h switch cost) |

---

## Pitch one-liner

> **Spine compiles your company into a single, role-aware, time-versioned fact graph — the one place humans and AI go to find out what's true, with receipts on every answer.**

---

## Open questions to close tonight

1. **Team size** and who's building which layer (write pipeline / graph+policy / MCP / UI)
2. **Dataset pre-flight** — load Enron email subset locally so Saturday is a swap, not a cold start
3. **Repo scaffold** — pnpm workspace with `apps/api`, `apps/mcp`, `apps/web`, `packages/{schema,graph,llm,policy}`; TS strict on, Zod + Hono + Kuzu installed, `pnpm dev` working end-to-end for a hello-world fact insert+query
4. **Gemini credits** — confirm on-site accounts will be available; have a personal key as backup
5. **Lovable** — redeem code `COMM-BIG-PVDK` for Pro Plan 1
6. **Aikido** — free trial at `app.aikido.dev/login`, connect the repo once created
7. **policies.yaml v0** — draft the 4–6 starter rules tonight so Saturday's extraction has something to apply
