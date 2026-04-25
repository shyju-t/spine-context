import { Graph } from "@spine/graph";
const g = new Graph("data/spine.db");

const entityId = process.argv[2] ?? "project/product_launch";

const facts = await g.query(
  `MATCH (f:Fact) WHERE f.entity_id = '${entityId}'
   RETURN f.attribute AS a, f.value AS v, f.source_id AS sid, f.author AS auth, f.acl AS acl, f.tx_from AS tx
   ORDER BY f.tx_from`,
);

console.log(`\n${entityId} — ${facts.length} facts total\n`);

const byAttr = new Map();
for (const f of facts) {
  if (!byAttr.has(f.a)) byAttr.set(f.a, []);
  byAttr.get(f.a).push(f);
}

console.log("attribute distribution:");
for (const [attr, fs] of [...byAttr].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${String(fs.length).padStart(4)}  ${attr}`);
}
console.log();

console.log("source diversity:");
const bySrcType = new Map();
for (const f of facts) {
  const t = f.sid?.split("/")[0] ?? "?";
  bySrcType.set(t, (bySrcType.get(t) ?? 0) + 1);
}
for (const [t, c] of [...bySrcType].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(c).padStart(4)}  ${t}`);
}
console.log();

console.log("authors:");
const byAuthor = new Map();
for (const f of facts) byAuthor.set(f.auth, (byAuthor.get(f.auth) ?? 0) + 1);
for (const [a, c] of [...byAuthor].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(c).padStart(4)}  ${a}`);
}
console.log();

console.log("sample status facts (first 8):");
const statusFacts = facts.filter((f) => /status|state|current/i.test(f.a)).slice(0, 8);
for (const f of statusFacts) {
  const v = String(f.v).slice(0, 60);
  console.log(`  ${f.a}: ${v}${String(f.v).length > 60 ? "…" : ""}  [${f.sid}]`);
}
console.log();

console.log("sample owner/blocker/due_date facts:");
const ob = facts.filter((f) => /owner|blocker|due/i.test(f.a)).slice(0, 8);
for (const f of ob) {
  console.log(`  ${f.a}: ${String(f.v).slice(0, 80)}  [${f.sid}]`);
}
