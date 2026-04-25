/**
 * Unit-level test of the GLiNER2 → ExtractorOutput mapper.
 * No DB, no network — uses a stubbed resolver so we can exercise the
 * mapping logic in isolation.
 */
import { pioneerToExtractorOutput } from "./packages/extractor/src/pioneer-client.ts";

// Stubbed resolver — only `resolve()` is called by the mapper.
const stubResolver = {
  resolve(text) {
    // Pretend "Alice Chen" is a known person and "Acme Corp" a known customer.
    const out = [];
    for (const [surface, entity_id, entity_type] of [
      ["Alice Chen", "person/emp_0042", "Person"],
      ["Acme Corp", "customer/acme", "Customer"],
    ]) {
      const idx = text.indexOf(surface);
      if (idx >= 0) {
        out.push({
          span: [idx, idx + surface.length],
          surface,
          entity_id,
          entity_type,
          confidence: 0.95,
          method: "test-stub",
        });
      }
    }
    return out;
  },
  getEntity() { return undefined; },
  size() { return { entities: 2, surface_forms: 2 }; },
};

// Real GLiNER2 shape: type-keyed object for entities, separate
// relation_extraction object also type-keyed, head/tail with text+span.
const fakeRaw = {
  entities: {
    project: [
      { text: "Phoenix Migration", start: 10, end: 28, confidence: 0.91 },
    ],
    commitment: [
      { text: "draft contract by Friday", start: 50, end: 73, confidence: 0.84 },
    ],
    topic: [{ text: "Q3 Budget Review", start: 100, end: 116, confidence: 0.78 }],
    person: [
      { text: "Alice Chen", start: 200, end: 210, confidence: 0.99 },
      // GLiNER2 sometimes also tags Alice (mistakenly) as customer below.
    ],
    customer: [
      { text: "Acme Corp", start: 220, end: 229, confidence: 0.97 },
      // Same span tagged as both customer (high) and below — should keep customer.
      { text: "Alice Chen", start: 200, end: 210, confidence: 0.4 },
    ],
  },
  relation_extraction: {
    owns: [
      {
        head: { text: "Phoenix Migration", start: 10, end: 28 },
        tail: { text: "Alice Chen", start: 200, end: 210 },
        confidence: 0.85,
      },
    ],
    manages: [
      {
        head: { text: "Alice Chen", start: 200, end: 210 },
        tail: { text: "Random Stranger Not In Resolver" },
        confidence: 0.7,
      },
    ],
    blocked_by: [
      {
        head: { text: "Phoenix Migration", start: 10, end: 28 },
        tail: { text: "Q3 Budget Review", start: 100, end: 116 },
        confidence: 0.62,
      },
    ],
    // Unknown relation type — should be dropped.
    smells_like: [
      {
        head: { text: "Alice Chen", start: 200, end: 210 },
        tail: { text: "Acme Corp", start: 220, end: 229 },
        confidence: 0.9,
      },
    ],
  },
};

const fakeSource = {
  id: "email/test_synthetic",
  type: "email",
  external_id: "test",
  subject: "test",
  content:
    "discussing Phoenix Migration. need draft contract by Friday and the Q3 Budget Review. Alice Chen at Acme Corp",
  metadata: {},
  ingested_at: new Date(),
  default_acl: ["employee:all"],
};

const out = pioneerToExtractorOutput(fakeRaw, fakeSource, stubResolver);
console.log("new_entities:");
for (const e of out.new_entities) {
  console.log(`  - ${e.proposed_id} (${e.type}) "${e.name}"`);
}
console.log();
console.log("facts:");
for (const f of out.facts) {
  console.log(
    `  - ${f.entity_id}.${f.attribute} = ${f.value}  [${f.fact_type}, conf=${f.confidence}]`,
  );
}

// Assertions
const assert = (cond, msg) => {
  if (!cond) {
    console.error(`\nFAIL: ${msg}`);
    process.exit(1);
  }
};

assert(out.new_entities.length === 3, "should have 3 new entities (project, commitment, topic)");
assert(out.new_entities.some((e) => e.proposed_id === "project/phoenix_migration"), "missing project slug");
assert(out.new_entities.some((e) => e.proposed_id === "commitment/draft_contract_by_friday"), "missing commitment slug");
assert(out.new_entities.some((e) => e.proposed_id === "topic/q3_budget_review"), "missing topic slug");

const ownsAlice = out.facts.find(
  (f) => f.entity_id === "project/phoenix_migration" && f.attribute === "owner",
);
assert(ownsAlice, "owns relation didn't produce an owner fact on the project");
assert(ownsAlice.value === "person/emp_0042", "owner fact didn't resolve Alice to canonical ID");

const blocked = out.facts.find(
  (f) => f.entity_id === "project/phoenix_migration" && f.attribute === "blocker",
);
assert(blocked, "blocked_by relation didn't produce a blocker fact");
assert(blocked.value === "topic/q3_budget_review", "blocker fact didn't reference proposed Topic id");

assert(
  !out.facts.some((f) => f.attribute === "smells_like"),
  "unknown relation type should have been dropped",
);

assert(
  !out.facts.some((f) => f.attribute === "manages"),
  "manages relation pointing at unresolved object should have been dropped",
);

console.log("\nAll assertions passed.");
