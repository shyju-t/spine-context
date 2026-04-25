#!/usr/bin/env node
import { join } from "node:path";
import { Graph } from "@spine/graph";
import {
  enterpriseBenchEmailAdapter,
  hrAdapter,
  enterpriseBenchChatAdapter,
  inazumaOverflowAdapter,
  loadCustomers,
  loadProducts,
  loadClients,
  loadVendors,
  rawEmployeeManagesEdges,
  rawEmployeeToPerson,
  type RawEmployee,
} from "@spine/adapters";
import { ingest } from "./pipeline.js";

type SourceFlag =
  | "all"
  | "email"
  | "hr"
  | "chat"
  | "kb"
  | "registries";

interface CliArgs {
  data: string;
  db: string;
  source: SourceFlag;
  limit?: number;
}

const VALID_SOURCES: SourceFlag[] = [
  "all",
  "email",
  "hr",
  "chat",
  "kb",
  "registries",
];

function parseArgs(argv: string[]): CliArgs {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = "true";
      }
    }
  }
  const source = (out.source ?? "all") as SourceFlag;
  if (!VALID_SOURCES.includes(source)) {
    throw new Error(
      `unknown --source: ${source}. Valid: ${VALID_SOURCES.join(", ")}`,
    );
  }
  // npm sets INIT_CWD to where the user invoked the command (repo root),
  // while process.cwd() under `npm run -w` is the workspace dir.
  const baseDir = process.env.INIT_CWD ?? process.cwd();
  return {
    data: out.data ?? join(baseDir, "data/enterprise-bench"),
    db: out.db ?? join(baseDir, "data/spine.db"),
    source,
    limit: out.limit ? Number(out.limit) : undefined,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log(`[spine] ingestion starting`);
  console.log(`  data:   ${args.data}`);
  console.log(`  db:     ${args.db}`);
  console.log(`  source: ${args.source}`);
  if (args.limit) console.log(`  limit:  ${args.limit}`);

  const graph = new Graph(args.db);
  await graph.init();

  if (args.source === "email" || args.source === "all") {
    const stats = await ingest(
      enterpriseBenchEmailAdapter,
      join(args.data, "Enterprise_mail_system/emails.json"),
      { graph, limit: args.limit },
    );
    console.log(
      `[email] ingested ${stats.records} sources, ${stats.facts} facts, ${stats.errors} errors`,
    );
  }

  if (args.source === "hr" || args.source === "all") {
    // HR ingestion has side-effects: write Person nodes + Manages edges.
    const pendingEdges: Array<{ manager_id: string; report_id: string }> = [];

    const stats = await ingest(
      hrAdapter,
      join(args.data, "Human_Resource_Management/Employees/employees.json"),
      {
        graph,
        limit: args.limit,
        async onRecord(_record, raw) {
          const employee = raw as RawEmployee;
          await graph.upsertPerson(rawEmployeeToPerson(employee));
          pendingEdges.push(...rawEmployeeManagesEdges(employee));
        },
      },
    );

    // Write edges only after all Person nodes are inserted, so MATCH
    // succeeds on both sides.
    let edgeCount = 0;
    let edgeErrors = 0;
    for (const edge of pendingEdges) {
      try {
        await graph.addManages(edge.manager_id, edge.report_id);
        edgeCount += 1;
      } catch {
        // Skip edges where one endpoint isn't in employees.json
        edgeErrors += 1;
      }
    }

    console.log(
      `[hr] ingested ${stats.records} sources, ${stats.facts} facts, ${edgeCount} manages-edges (${edgeErrors} skipped), ${stats.errors} errors`,
    );
  }

  if (args.source === "chat" || args.source === "all") {
    const stats = await ingest(
      enterpriseBenchChatAdapter,
      join(args.data, "Collaboration_tools/conversations.json"),
      { graph, limit: args.limit },
    );
    console.log(
      `[chat] ingested ${stats.records} sources, ${stats.facts} facts, ${stats.errors} errors`,
    );
  }

  if (args.source === "kb" || args.source === "all") {
    const stats = await ingest(
      inazumaOverflowAdapter,
      join(args.data, "Inazuma_Overflow/overflow.json"),
      { graph, limit: args.limit },
    );
    console.log(
      `[kb] ingested ${stats.records} sources, ${stats.facts} facts, ${stats.errors} errors`,
    );
  }

  if (args.source === "registries" || args.source === "all") {
    const customers = await loadCustomers(
      join(args.data, "Customer_Relation_Management/customers.json"),
    );
    for (const c of customers) await graph.upsertCustomer(c);

    const products = await loadProducts(
      join(args.data, "Customer_Relation_Management/products.json"),
    );
    for (const p of products) await graph.upsertProduct(p);

    const clients = await loadClients(
      join(args.data, "Business_and_Management/clients.json"),
    );
    for (const c of clients) await graph.upsertClient(c);

    const vendors = await loadVendors(
      join(args.data, "Business_and_Management/vendors.json"),
    );
    for (const v of vendors) await graph.upsertVendor(v);

    console.log(
      `[registries] customers=${customers.length}, products=${products.length}, clients=${clients.length}, vendors=${vendors.length}`,
    );
  }

  // Quick sanity counts per node type. Kuzu 0.6 wants count(n), not count(*).
  const tables = [
    "Source",
    "Person",
    "Fact",
    "Customer",
    "Product",
    "Client",
    "Vendor",
    "Project",
    "Topic",
  ] as const;
  const counts: Record<string, number> = {};
  for (const t of tables) {
    try {
      const rows = await graph.query<{ total: bigint | number }>(
        `MATCH (n:${t}) RETURN count(n) AS total`,
      );
      const v = rows[0]?.total;
      counts[t] = typeof v === "bigint" ? Number(v) : (v ?? 0);
    } catch (err) {
      console.warn(`[counts] ${t}:`, (err as Error).message);
      counts[t] = -1;
    }
  }
  try {
    const rows = await graph.query<{ total: bigint | number }>(
      `MATCH ()-[r:Manages]->() RETURN count(r) AS total`,
    );
    const v = rows[0]?.total;
    counts["Manages"] = typeof v === "bigint" ? Number(v) : (v ?? 0);
  } catch (err) {
    console.warn(`[counts] Manages:`, (err as Error).message);
    counts["Manages"] = -1;
  }
  console.log(`[counts]`, counts);

  // Skip explicit graph.close() — Kuzu 0.6 has a destructor-ordering quirk
  // that occasionally segfaults on shutdown. Data is already persisted by
  // this point; relying on process-exit cleanup is safe and quieter.
  console.log(`[spine] done`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
