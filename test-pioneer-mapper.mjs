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

const fakeRaw = {
  entities: [
    { type: "project", text: "Phoenix Migration", span: [10, 28], confidence: 0.91 },
    { type: "commitment", text: "draft contract by Friday", span: [50, 73], confidence: 0.84 },
    { type: "topic", text: "Q3 Budget Review", span: [100, 116], confidence: 0.78 },
    { type: "person", text: "Alice Chen", span: [200, 210], confidence: 0.99 },
    { type: "customer", text: "Acme Corp", span: [220, 229], confidence: 0.97 },
    // mistyped — GLiNER2 calls Alice a customer; we should drop this fact later
    { type: "customer", text: "Alice Chen", span: [200, 210], confidence: 0.4 },
  ],
  relations: [
    {
      type: "owns",
      subject: { type: "project", text: "Phoenix Migration" },
      object: { type: "person", text: "Alice Chen" },
      confidence: 0.85,
    },
    {
      type: "manages",
      subject: { type: "person", text: "Alice Chen" },
      object: { type: "person", text: "Random Stranger Not In Resolver" },
      confidence: 0.7,
    },
    {
      type: "blocked_by",
      subject: { type: "project", text: "Phoenix Migration" },
      object: { type: "topic", text: "Q3 Budget Review" },
      confidence: 0.62,
    },
    {
      // Unknown relation type — should be dropped.
      type: "smells_like",
      subject: { type: "person", text: "Alice Chen" },
      object: { type: "customer", text: "Acme Corp" },
      confidence: 0.9,
    },
  ],
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
