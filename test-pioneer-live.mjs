/**
 * Live probe — hits Pioneer's real API once and prints the raw GLiNER2
 * response plus the mapped ExtractorOutput.
 *
 * Doesn't touch the graph DB so it can run while the API server is up.
 *
 * Run:
 *   npm run -w @spine/api extract --  # (sets up env path)
 *   # or directly:
 *   node --env-file-if-exists=.env.local --import=tsx test-pioneer-live.mjs
 */
import { callPioneer } from "./packages/extractor/src/pioneer-client.ts";

const apiKey = process.env.PIONEER_API_KEY;
if (!apiKey) {
  console.error("PIONEER_API_KEY not set. Did .env.local load?");
  process.exit(1);
}

// Stub resolver — recognizes the names in the test source so we can
// see registry-typed relations resolve end-to-end. The real ingestion
// pipeline uses the LocalResolver loaded from the graph; this stub just
// fakes a couple of Person mappings for the probe.
const stubResolver = {
  resolve(text) {
    const out = [];
    for (const [surface, entity_id, entity_type] of [
      ["Alice", "person/emp_alice", "Person"],
      ["Bob", "person/emp_bob", "Person"],
      ["Carol", "person/emp_carol", "Person"],
      ["Dave", "person/emp_dave", "Person"],
      ["Acme Corp", "customer/acme", "Customer"],
    ]) {
      let idx = 0;
      while ((idx = text.indexOf(surface, idx)) >= 0) {
        out.push({
          span: [idx, idx + surface.length],
          surface,
          entity_id,
          entity_type,
          confidence: 0.95,
          method: "test-stub",
        });
        idx += surface.length;
      }
    }
    return out;
  },
  getEntity() { return undefined; },
  size() { return { entities: 5, surface_forms: 5 }; },
};

const fakeSource = {
  id: "email/probe",
  type: "email",
  external_id: "probe",
  subject: "Phoenix migration — status check",
  content: [
    "Hi Alice,",
    "",
    "Quick update on the Phoenix migration project. Bob is still owning the schema work, but he's blocked on the Q3 budget review.",
    "",
    "We need to commit to drafting the new vendor contract by Friday and get sign-off from Carol. Sentiment in the room is cautiously optimistic.",
    "",
    "Customer Acme Corp has been pushing for an earlier ship date — I told them end of August was the realistic call.",
    "",
    "Cheers,",
    "Dave",
  ].join("\n"),
  metadata: {},
  ingested_at: new Date(),
  default_acl: ["employee:all"],
};

const model = process.env.PIONEER_MODEL ?? "fastino/gliner2-multi-large-v1";
console.log(`→ Pioneer (${model})...\n`);

const t0 = performance.now();
let result;
try {
  result = await callPioneer({
    apiKey,
    model,
    source: fakeSource,
    resolver: stubResolver,
  });
} catch (err) {
  console.error(`\nFAIL: ${err.message}`);
  process.exit(1);
}
const elapsed = performance.now() - t0;
console.log(`Elapsed: ${elapsed.toFixed(0)}ms\n`);

console.log("─── Raw GLiNER2 response ───");
console.log(JSON.stringify(result.raw, null, 2));

console.log("\n─── Mapped ExtractorOutput ───");
console.log("new_entities:");
for (const e of result.output.new_entities) {
  console.log(`  - ${e.proposed_id} (${e.type}) "${e.name}"`);
}
console.log("facts:");
for (const f of result.output.facts) {
  console.log(
    `  - ${f.entity_id}.${f.attribute} = ${f.value}  [${f.fact_type}, conf=${f.confidence}]`,
  );
}

// Pioneer returns entities/relations as type-keyed objects, not arrays.
// Sum the array lengths across types to get a flat count.
const countNested = (obj) =>
  obj ? Object.values(obj).reduce((acc, arr) => acc + (arr?.length ?? 0), 0) : 0;
const rawEntityCount = countNested(result.raw.entities);
const rawRelationCount = countNested(result.raw.relation_extraction);
console.log(
  `\nDone. ${rawEntityCount} entities, ${rawRelationCount} relations from Pioneer; ` +
    `${result.output.new_entities.length} new_entities + ${result.output.facts.length} facts after mapping.`,
);
