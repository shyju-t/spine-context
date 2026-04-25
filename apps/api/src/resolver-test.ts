import { join } from "node:path";
import { Graph } from "@spine/graph";
import { LocalResolver } from "@spine/resolver";

async function main() {
  const baseDir = process.env.INIT_CWD ?? process.cwd();
  const graph = new Graph(join(baseDir, "data/spine.db"));
  await graph.init();

  const resolver = new LocalResolver();
  const t0 = performance.now();
  const stats = await resolver.load(graph);
  const t1 = performance.now();
  console.log(`[resolver] loaded in ${(t1 - t0).toFixed(1)}ms`);
  console.log(`           entities: ${stats.total_entities}, surface_forms: ${stats.total_surface_forms}`);
  console.log(`           by_type:`, stats.by_type);

  // ── Test cases against the live graph ──
  const tests: Array<{ label: string; text: string; ctx?: any }> = [
    {
      label: "exact emp_id",
      text: "Please ask emp_0431 to review the doc.",
    },
    {
      label: "full name",
      text: "Hi Raj Patel, can you take a look?",
    },
    {
      label: "email match",
      text: "Replying to raj.patel@inazuma.com about the launch.",
    },
    {
      label: "context I/me",
      text: "I'll send the budget by Friday. Let me know.",
      ctx: { sender_emp_id: "emp_0431" },
    },
    {
      label: "ambiguous first name",
      text: "Raj approved that yesterday. Will follow up.",
    },
    {
      label: "client business name",
      text: "Update on the Castillo Inc engagement.",
    },
    {
      label: "product_id",
      text: "Customer complained about B0BQ3K23Y1 not arriving.",
    },
    {
      label: "noise (no entities)",
      text: "Just a quick checkin, hope all is well.",
    },
  ];

  for (const t of tests) {
    const ms = resolver.resolve(t.text, t.ctx ?? {});
    console.log(`\n--- ${t.label} ---`);
    console.log(`text: ${t.text}`);
    if (ms.length === 0) {
      console.log("  (no mentions)");
    } else {
      for (const m of ms) {
        const ent = resolver.getEntity(m.entity_id);
        console.log(
          `  [${m.span[0]},${m.span[1]}] "${m.surface}" → ${m.entity_id} (${ent?.display_name}) conf=${m.confidence.toFixed(2)} via ${m.method}`,
        );
      }
    }
  }

  // ── Resolution density on 3 real email source records ──
  console.log(`\n=== Real email sources ===`);
  const sources = await graph.query<{
    id: string;
    subject: string;
    content: string;
  }>(
    `MATCH (s:Source) WHERE s.type = 'email' RETURN s.id AS id, s.subject AS subject, s.content AS content LIMIT 3`,
  );
  for (const s of sources) {
    const t0 = performance.now();
    const ms = resolver.resolve(s.content);
    const t1 = performance.now();
    console.log(
      `\n${s.id} "${s.subject.slice(0, 60)}..."  (${(t1 - t0).toFixed(1)}ms, ${ms.length} mentions)`,
    );
    for (const m of ms.slice(0, 10)) {
      const ent = resolver.getEntity(m.entity_id);
      console.log(
        `  "${m.surface}" → ${m.entity_id} (${ent?.display_name?.slice(0, 50)}) conf=${m.confidence.toFixed(2)} via ${m.method}`,
      );
    }
    if (ms.length > 10) console.log(`  ... ${ms.length - 10} more`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
