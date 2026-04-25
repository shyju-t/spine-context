import { join } from "node:path";
import { Graph } from "@spine/graph";
import {
  findEntityByQuery,
  getFactsForEntity,
  getSourceById,
  getSourcesForEntity,
  searchSources,
} from "./query.js";

async function main() {
  const baseDir = process.env.INIT_CWD ?? process.cwd();
  const graph = new Graph(join(baseDir, "data/spine.db"));
  await graph.init();

  console.log("=== Resolve a real person by name ===");
  const ravi = await findEntityByQuery(graph, "Ravi Kumar");
  console.log(ravi);

  if (!ravi) {
    console.error("FATAL: 'Ravi Kumar' didn't resolve — graph is empty?");
    return;
  }

  console.log("\n=== Facts (caller as employee:all) ===");
  const empCtx = { roles: ["employee:all"] };
  const r1 = await getFactsForEntity(graph, ravi.id, empCtx);
  console.log(`  ${r1.facts.length} facts visible, ${r1.redacted} redacted`);
  for (const f of r1.facts.slice(0, 6)) {
    console.log(
      `    ${f.attribute} = ${JSON.stringify(f.value).slice(0, 80)} (acl=${f.acl})`,
    );
  }
  if (r1.facts.length > 6) console.log(`    ... ${r1.facts.length - 6} more`);

  console.log("\n=== Same facts, caller as role:hr (more visibility) ===");
  const hrCtx = { roles: ["employee:all", "role:hr"] };
  const r2 = await getFactsForEntity(graph, ravi.id, hrCtx);
  console.log(`  ${r2.facts.length} facts visible, ${r2.redacted} redacted`);

  console.log("\n=== Same facts, caller as exec ===");
  const execCtx = { roles: ["employee:all", "role:hr", "role:exec"] };
  const r3 = await getFactsForEntity(graph, ravi.id, execCtx);
  console.log(`  ${r3.facts.length} facts visible, ${r3.redacted} redacted`);

  console.log("\n=== Sources mentioning Ravi (employee:all) ===");
  const sourcesEmp = await getSourcesForEntity(
    graph,
    ravi.id,
    "Person",
    empCtx,
    10,
  );
  console.log(
    `  ${sourcesEmp.sources.length} sources visible, ${sourcesEmp.redacted} redacted`,
  );
  for (const s of sourcesEmp.sources.slice(0, 5)) {
    console.log(`    [${s.type}] ${s.id}  "${s.subject}"`);
  }

  console.log("\n=== Sources mentioning Ravi (exec) ===");
  const sourcesExec = await getSourcesForEntity(
    graph,
    ravi.id,
    "Person",
    execCtx,
    10,
  );
  console.log(
    `  ${sourcesExec.sources.length} sources visible, ${sourcesExec.redacted} redacted`,
  );

  console.log("\n=== Topic resolution (LLM-created) ===");
  const topic = await findEntityByQuery(graph, "topic/cross_departmental_goals");
  console.log(topic);
  if (topic) {
    const tFacts = await getFactsForEntity(graph, topic.id, empCtx);
    console.log(`  facts: ${tFacts.facts.length}`);
    for (const f of tFacts.facts.slice(0, 5)) {
      console.log(`    ${f.attribute} = ${JSON.stringify(f.value).slice(0, 80)}`);
    }
  }

  console.log("\n=== Full-text search 'vendor management' ===");
  const ftSearch = await searchSources(
    graph,
    "vendor management",
    empCtx,
    5,
  );
  console.log(
    `  ${ftSearch.sources.length} sources matched, ${ftSearch.redacted} redacted`,
  );
  for (const s of ftSearch.sources) {
    console.log(`    [${s.type}] ${s.id}  "${s.subject}"`);
  }

  console.log("\n=== Get a source by id ===");
  if (sourcesEmp.sources.length > 0) {
    const sId = sourcesEmp.sources[0].id;
    const sRes = await getSourceById(graph, sId, empCtx);
    if (sRes.source) {
      console.log(
        `  ${sRes.source.id} content (first 200 chars): ${sRes.source.content.slice(0, 200)}...`,
      );
    }
  }

  console.log("\n=== ACL test: try to see a salary fact as engineer ===");
  // Find a fact about Ravi where the ACL is HR-restricted
  const restrictedRows = r3.facts.filter(
    (f) => f.attribute === "salary" || f.attribute === "performance_rating",
  );
  if (restrictedRows.length > 0) {
    const sample = restrictedRows[0];
    console.log(`  fact "${sample.attribute}" has acl=${sample.acl}`);
    const engCtx = { roles: ["employee:all", "role:engineering"] };
    const engRes = await getFactsForEntity(graph, ravi.id, engCtx);
    const visible = engRes.facts.find(
      (f) => f.attribute === sample.attribute,
    );
    if (visible) {
      console.log(
        `  ✗ ACL leaked! engineer can see ${sample.attribute}`,
      );
    } else {
      console.log(
        `  ✓ ACL holds — engineer cannot see ${sample.attribute}; ${engRes.redacted} facts redacted`,
      );
    }
  } else {
    console.log("  (no restricted facts found in sample)");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
