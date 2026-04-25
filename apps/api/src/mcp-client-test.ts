/**
 * Programmatic MCP client test — spawns the spine MCP server over
 * stdio and exercises each tool. Confirms protocol-level wiring,
 * tool registration, and end-to-end output shape.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  // Resolve absolute DB path so the MCP child doesn't depend on cwd guessing.
  const repoRoot = process.env.INIT_CWD ?? process.cwd();
  const transport = new StdioClientTransport({
    command: "tsx",
    args: ["src/mcp.ts"],
    env: {
      ...(process.env as Record<string, string>),
      SPINE_DB: `${repoRoot.replace(/\/apps\/api$/, "")}/data/spine.db`,
    },
  });

  const client = new Client(
    { name: "spine-mcp-tester", version: "0.0.1" },
    { capabilities: {} },
  );
  await client.connect(transport);

  console.log("=== List of tools ===");
  const tools = await client.listTools();
  for (const t of tools.tools) {
    console.log(`  - ${t.name}: ${t.description?.slice(0, 80) ?? ""}`);
  }

  console.log("\n=== query_entity 'Ravi Kumar' as employee:all ===");
  const r1 = await client.callTool({
    name: "query_entity",
    arguments: { entity: "Ravi Kumar" },
  });
  console.log(extractText(r1).slice(0, 600));

  console.log("\n=== query_entity 'Ravi Kumar' as role:hr ===");
  const r2 = await client.callTool({
    name: "query_entity",
    arguments: { entity: "Ravi Kumar", as_role: ["employee:all", "role:hr"] },
  });
  const r2Text = extractText(r2);
  // Show whether salary/performance facts now appear.
  const visible = (r2Text.match(/"attribute": "([^"]+)"/g) ?? []).slice(0, 30);
  console.log(`  attributes returned: ${visible.length}`);
  console.log(`  includes salary?  ${r2Text.includes('"attribute": "salary"')}`);
  console.log(
    `  includes performance_rating?  ${r2Text.includes('"attribute": "performance_rating"')}`,
  );

  console.log("\n=== search_context 'vendor management' as role:exec ===");
  const r3 = await client.callTool({
    name: "search_context",
    arguments: {
      query: "vendor management",
      as_role: ["employee:all", "role:exec"],
      limit: 3,
    },
  });
  const text3 = extractText(r3);
  const kindMatch = text3.match(/"kind": "([^"]+)"/);
  console.log(`  result kind: ${kindMatch?.[1] ?? "?"}`);
  console.log(text3.slice(0, 600));

  console.log("\n=== get_source on a real source ===");
  const r4 = await client.callTool({
    name: "get_source",
    arguments: { source_id: "email/4226322d-0ea5-4344-945a-c00172c6a840" },
  });
  console.log(extractText(r4).slice(0, 400));

  console.log("\n=== list_persons in HR department ===");
  const r5 = await client.callTool({
    name: "list_persons",
    arguments: { department: "HR", limit: 3 },
  });
  console.log(extractText(r5).slice(0, 500));

  await client.close();
}

function extractText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
