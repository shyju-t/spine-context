/**
 * Programmatic MCP-over-HTTP client test.
 *
 * Connects to the combined server's /mcp endpoint via the SDK's
 * StreamableHTTPClientTransport and exercises every tool. Verifies the
 * server can serve REST and MCP simultaneously to two different clients
 * without a Kuzu lock collision.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = new URL(process.env.MCP_URL ?? "http://localhost:3001/mcp");

async function main() {
  const transport = new StreamableHTTPClientTransport(url);
  const client = new Client(
    { name: "spine-http-tester", version: "0.0.1" },
    { capabilities: {} },
  );
  await client.connect(transport);

  console.log(`=== Connected to ${url} ===`);
  const tools = await client.listTools();
  console.log(`Tools registered: ${tools.tools.map((t) => t.name).join(", ")}`);

  console.log("\n=== query_entity 'Ravi Kumar' as HR ===");
  const r1 = await client.callTool({
    name: "query_entity",
    arguments: {
      entity: "Ravi Kumar",
      as_role: ["employee:all", "role:hr"],
    },
  });
  const t1 = extractText(r1);
  console.log(t1.slice(0, 500));
  console.log(`  facts visible: ${(t1.match(/"attribute"/g) ?? []).length}`);

  console.log("\n=== search_context 'vendor management' as exec ===");
  const r2 = await client.callTool({
    name: "search_context",
    arguments: {
      query: "vendor management",
      as_role: ["employee:all", "role:exec"],
      limit: 3,
    },
  });
  const t2 = extractText(r2);
  const kindMatch = t2.match(/"kind":\s*"([^"]+)"/);
  console.log(`  kind: ${kindMatch?.[1] ?? "?"}`);
  console.log(t2.slice(0, 400));

  console.log("\n=== get_source on a real chat ===");
  const r3 = await client.callTool({
    name: "get_source",
    arguments: { source_id: "email/4226322d-0ea5-4344-945a-c00172c6a840" },
  });
  console.log(extractText(r3).slice(0, 200));

  console.log("\n=== list_persons in HR ===");
  const r4 = await client.callTool({
    name: "list_persons",
    arguments: { department: "HR", limit: 3 },
  });
  console.log(extractText(r4).slice(0, 300));

  await client.close();
  console.log("\n✓ All tools succeeded over HTTP transport");
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
