/**
 * Find entities where Pioneer contributed heavily — useful for demo
 * angles where we want both extractors visibly contributing.
 */
import { Graph } from "@spine/graph";
const g = new Graph("data/spine.db");

const rows = await g.query(`
  MATCH (f:Fact)
  WHERE f.author STARTS WITH 'extractor:'
  RETURN f.entity_id AS entity_id,
         f.author AS author,
         count(f) AS total
`);

const byEntity = new Map();
for (const r of rows) {
  if (!byEntity.has(r.entity_id))
    byEntity.set(r.entity_id, { gemini: 0, pioneer: 0, total: 0 });
  const b = byEntity.get(r.entity_id);
  if (r.author.includes("gemini")) b.gemini += Number(r.total);
  else if (r.author.includes("pioneer")) b.pioneer += Number(r.total);
  b.total += Number(r.total);
}

const ranked = [...byEntity.entries()]
  .filter(([_, b]) => b.pioneer >= 3 && b.gemini >= 1)
  .sort((a, b) => {
    // Score: prefer entities with both extractors AND high totals
    const balance = (x) => Math.min(x.gemini, x.pioneer * 4);
    return balance(b[1]) + b[1].total / 20 - (balance(a[1]) + a[1].total / 20);
  })
  .slice(0, 12);

console.log("Entities with both extractors contributing (top 12):\n");
for (const [id, b] of ranked) {
  console.log(`  ${id}`);
  console.log(`    gemini=${b.gemini}  pioneer=${b.pioneer}  total=${b.total}`);
}
