import { Graph } from "@spine/graph";
const g = new Graph("data/spine.db");
const counts = await g.query(
  "MATCH (s:Source) RETURN s.type AS type, count(s) AS total ORDER BY total DESC",
);
console.log("sources by type:");
for (const r of counts) console.log(`  ${r.total}\t${r.type}`);

const factCount = await g.query("MATCH (f:Fact) RETURN count(f) AS total");
console.log(`facts in graph: ${factCount[0]?.total ?? 0}`);
