# Deferred decisions

Things we chose *not* to build in the 48h hackathon scope, with enough reasoning and setup notes that we can revive any of them quickly post-hackathon.

---

## 1. Embeddings / vector-based entity resolution

**Status**: deferred
**Decided**: 2026-04-24, pre-hackathon scoping
**Trigger to revive**: any of the conditions in "When to add back" below

### Why we considered embeddings

Enumerated six possible uses in Spine:

| Use | What it would solve | Verdict |
|---|---|---|
| Entity resolution | "Sarah Chen" = "schen@acme.com" = "S. Chen" = emp#4782 | Maybe — the only real candidate |
| Semantic fact search | "escalated customers" finds facts phrased as "angry client" | No — the brief rules out chatbot-style retrieval; we return typed facts via structured queries |
| Attribute normalization | "VP of Engineering" = "Vice President of Engineering" | No — handled in the extractor prompt |
| Fact deduplication | Two facts saying the same thing in different words | No — conflict engine keys on structured `(entity, attribute)` |
| Entity disambiguation in source | "Sarah" in an email — which Sarah? | No — extractor has source context (signatures, thread, headers) |
| Entity-page search in Inspector UI | User types "Sarah" → candidate list | No — substring/prefix search is plenty for 48h-scale data |

Only entity resolution survived the challenge. And even there, rule-based + LLM adjudication beats embeddings at 48h scale.

### Why we dropped it for the hackathon

Comparison of approaches for entity resolution:

| Factor | Rule-based + LLM adjudication | Embedding-based |
|---|---|---|
| Implementation time | ~3 hours | ~4 hours + normalization edge cases |
| New dependencies | Zero | Embedding API + vector storage on every node |
| Cost | Tiny (LLM calls only on ambiguous cases, <5%) | API call per mention even when unambiguous |
| Debuggability | "Rule X matched" — readable | "Cosine 0.87 vs 0.84" — opaque |
| Handles typos | Fuzzy match (Jaro-Winkler, Levenshtein) | Yes |
| Handles aliases (Bob↔Robert) | Needs nickname dictionary | Unreliable — embeddings don't cleanly encode nicknames |
| Scale ceiling | Fine to ~10k entities | Fine beyond that |
| Rate-limit risk (hackathon Gemini free tier) | Low | High on bulk ingest |

For the simulated dataset (expected hundreds to low thousands of entities), rule-based is simpler, cheaper, more debuggable, and **just as accurate**. Embeddings earn their keep at millions-of-entities scale, not 48h demo scale.

What dropping embeddings saved us:
- Whole API dependency (no embedding provider decision)
- Fallback chain (Gemini → Voyage → local Xenova)
- Vector storage on every Kuzu node
- L2 normalization logic for gemini-embedding-001 dim-truncation
- Rate-limit firefighting on bulk ingest

What we lost:
- Nothing the demo shows — demo pitches the graph, provenance, ACL, conflict resolution; nobody asks how entity names got matched

### When to add back

Any of:
1. **Scale**: active graph exceeds ~10k entities and rule-based matching starts producing drift
2. **Semantic search in Inspector**: v2 feature — "show me everything about customer dissatisfaction" across differently-worded facts
3. **Cross-lingual**: company has data in multiple languages and entity mentions don't align lexically
4. **"Similar entities" UI surface**: recommending related nodes on an entity page
5. **Source-to-entity disambiguation on low-context sources**: if extraction ever runs on short, context-poor snippets where the source doesn't disambiguate the mention

### Revival kit (pick up from here)

**Recommended model**: `gemini-embedding-001` — same API family as our Gemini generation credits, so one credential.

**Config**:
- Dimensions: 768 (manual L2 normalization required after truncation — `gemini-embedding-001` does not auto-normalize)
- Task types: `RETRIEVAL_DOCUMENT` for stored canonical entity forms, `RETRIEVAL_QUERY` at lookup
- Input token limit: 2,048 (plenty for entity mentions)
- Price: $0.15 / 1M input tokens; Batch API at 50% off for bulk initial ingest

**Fallback chain if Gemini RPM gates hit**:
1. Gemini Batch API (50% off, async, higher throughput) — preferred for bulk ingest
2. Voyage AI `voyage-3-lite` — $0.02/1M tokens, free-tier credits on signup
3. Local: `@xenova/transformers` with `BAAI/bge-small-en-v1.5` — 384-dim, runs in Node via WASM, zero network

**Install + code (TypeScript)**:

```bash
pnpm add @google/genai
```

```typescript
// packages/llm/embedder.ts
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });

export interface Embedder {
  embedForStorage(texts: string[]): Promise<number[][]>;
  embedForQuery(text: string): Promise<number[]>;
}

function l2Normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm === 0 ? v : v.map(x => x / norm);
}

export const geminiEmbedder: Embedder = {
  async embedForStorage(texts) {
    const { embeddings } = await ai.models.embedContent({
      model: 'gemini-embedding-001',
      contents: texts,
      config: {
        taskType: 'RETRIEVAL_DOCUMENT',
        outputDimensionality: 768,
      },
    });
    return embeddings.map(e => l2Normalize(e.values));
  },

  async embedForQuery(text) {
    const { embeddings } = await ai.models.embedContent({
      model: 'gemini-embedding-001',
      contents: [text],
      config: {
        taskType: 'RETRIEVAL_QUERY',
        outputDimensionality: 768,
      },
    });
    return l2Normalize(embeddings[0].values);
  },
};
```

**Integration points**:
- Store `embedding: DOUBLE[768]` on every entity node in Kuzu
- On new mention: `embedForQuery(mention)` → cosine search existing nodes → threshold decision
- On entity commit: `embedForStorage(canonical_name + aliases)` → store vector alongside node properties
- Thresholds to tune empirically: `> 0.85` → auto-merge, `0.70–0.85` → review queue, `< 0.70` → new entity

**Sources verified 2026-04-24**:
- [Gemini Embedding GA — Google Developers Blog](https://developers.googleblog.com/gemini-embedding-available-gemini-api/)
- [Embeddings API docs](https://ai.google.dev/gemini-api/docs/embeddings)
- [gemini-embedding-001 model page](https://ai.google.dev/gemini-api/docs/models/gemini-embedding-001)

---

## 2. Admin UI for roles, policies, users

**Status**: deferred
**Trigger to revive**: any enterprise pilot past the "demo" stage; compliance/IT admins need a configuration surface that isn't YAML

Scope when we revive:
- Users & roles CRUD
- Policy rule builder (visual, compiles to current `policies.yaml` schema)
- Source connections + per-source ACL cascade
- Model configuration (extractor, embedder, confidence thresholds)
- Policy sandbox ("test as user X" preview)

Demo of the 48h version: read-only rendering of `policies.yaml` could be added easily if we want to show the admin dimension without building full CRUD.

---

## 3. Local-LLM extraction path

**Status**: scaffolded, not demoed
**Trigger to revive**: first enterprise pilot where data sovereignty is a hard requirement

The `Extractor` interface is already designed for this. Post-hackathon work:
- Implement `packages/llm/backends/ollama.ts`
- Document model choices (llama3.1:8b for dev laptops, llama3.1:70b for production)
- Add a config toggle in `policies.yaml` → `extractor.backend: "gemini" | "ollama"`
- Benchmark accuracy parity vs. Gemini on a reference set
- Quantify latency trade-off in docs

---

## 4. Timeline view

**Status**: cut if tight during 48h
**Trigger to revive**: post-hackathon; audit/compliance users want to see temporal evolution of a node's facts

---

## 5. Graph explorer (full version)

**Status**: may degrade to table view during 48h if React Flow integration takes too long
**Trigger to revive**: when demo polish time is available post-hackathon

---

## 6. Real-time streaming ingestion

**Status**: deferred; batch ingestion only for hackathon
**Trigger to revive**: first production pilot (batch is fine for design partners, not for live systems)

---

---

## 7. Extraction prompt: task-level attributes hung off Person

**Status**: deferred
**Trigger to revive**: prompt iteration session before re-extracting

### Why this matters

The LLM occasionally attaches task-level attributes — `due_date`, `status`,
`blocker`, `owner` — directly to a `person/<emp_id>` instead of materializing
them as `Commitment` / `Project` / `Topic` entities and linking the person as
owner/assignee.

Concretely seen in our run:
- `person/emp_1087` had four different `due_date` values across four emails.
  Each was a different commitment the person had taken on. The LLM should
  have produced four `Commitment` entities, each with its own `due_date` and
  with `owner = person/emp_1087`. Instead it bunched the dates onto the Person.

This produces:
- False conflicts in the Conflict Queue (mitigated for now via entity-type-aware
  conflict rules — `due_date` on `Person` no longer flagged)
- Lost structure: we can't query "what commitments does emp_1087 own?" because
  the commitments were never materialized

### Fix path

Tighten the system prompt in `packages/extractor/src/prompt.ts`:

> Task-level attributes (due_date, status, blocker, owner) MUST be attached
> to a `Commitment`, `Project`, or `Topic` entity — never directly to a
> `Person`. If you see a person committing to do X by Y, propose a new
> Commitment entity with `owner = person/<id>` and `due_date = Y`.

Bump `PROMPT_VERSION` so the cache invalidates, re-run extract on the same
sources, replace the bad facts.

---

## 8. Extraction prompt: entity-id prefix violations

**Status**: deferred
**Trigger to revive**: same prompt-iteration session

### Why this matters

The schema requires `proposed_id` to follow conventions (`topic/<slug>`,
`project/<slug>`, `commitment/<slug>`, `decision/<slug>`). The LLM
occasionally returns IDs like:
- `new_entity/employee_retention_topic`
- `new_entities/meeting_dependencies_resource_assignments`
- `new_project_management_tools`
- `new_feature/...`

These end up as legitimate node entries in the graph with bad prefixes,
which means:
- They show up in conflict queues with `new_entity/` etc.
- Resolver doesn't recognize their entity type via prefix lookup
- The git-style "everything has a clear type" story breaks

### Fix path

1. Strengthen the extractor system prompt with "the proposed_id MUST start
   with `topic/`, `project/`, `commitment/`, or `decision/`. Anything else
   will be rejected."
2. Add a post-validation step in the extractor that rejects malformed IDs
   before persistence.
3. (Optional) write a one-time migration: sniff the `new_entity/`-prefixed
   nodes, infer the right type from their facts, rename the IDs.

---

## 9. Extractor prompt v2 is too restrictive on smaller models

**Status**: shipped to repo, never run at scale
**Trigger to revive**: morning quota reset → re-extract OR Pioneer fine-tuning lands

### Symptom

The v2 prompt (`extractor-v2`) was designed to fix bugs we saw in v1: prefix
violations, role mis-attribution, prose-as-label values. It includes hard
rules with negative framing ("WRONG: don't do X") and an example with a
"NOTE THIS EXAMPLE OMITS:" section.

When we couldn't re-test on `gemini-2.5-flash` (daily RPD exhausted), we
fell back to other models:

| Model | v1 prompt facts/source | v2 prompt facts/source |
|---|---|---|
| gemini-2.5-flash | 12 | (untested due to quota) |
| gemini-2.5-flash-lite | 6 | 0 |
| gemini-3-flash-preview | (untested) | 0 |
| gemini-3.1-flash-lite-preview | (untested) | 0 |

Every smaller / preview model produced **0 facts** on the same source where
v1+flash produced 12. The "OMIT" framing dominates their behavior.

### Fix path

Three refinements likely needed:

1. **Reframe rules positively**: replace "WRONG: don't do X / RIGHT: do Y"
   with "When you see X, emit Y" — single positive instruction.
2. **Drop the explicit OMIT note** at the end of the example. Smaller
   models latch onto it.
3. **Add a positive abundance hint**: "If the source describes 5 actions,
   emit 5 action facts. Don't artificially trim."

The schema regex on `proposed_id` is good guardrail and stays.

When `gemini-2.5-flash` quota refills, re-test on the same hero source and
verify ≥10 facts. Only then do a full 700-source re-extract.

---

## Format convention

Each deferred item:
1. **Why we considered it** — the problem it would solve
2. **Why we dropped it** — the specific tradeoff that made deferral correct
3. **When to add back** — concrete triggers
4. **Revival kit** — install commands, code snippets, integration points, so resuming is a read-and-paste, not a re-research
