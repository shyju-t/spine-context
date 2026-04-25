#!/usr/bin/env node
/**
 * Spine MCP server (stdio transport).
 *
 * Standalone process for clients that spawn an MCP child via stdio
 * (legacy path). Most clients should use the HTTP transport mounted
 * on /mcp by apps/api/src/server.ts instead.
 *
 * Note: this and the HTTP variant cannot both run against the same
 * Kuzu DB simultaneously (single-writer lock). Prefer the HTTP path
 * unless you have a stdio-only client.
 */
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Graph } from "@spine/graph";
import { registerSpineTools } from "./mcp-tools.js";

const baseDir = process.env.INIT_CWD ?? process.cwd();
const dbPath = process.env.SPINE_DB ?? join(baseDir, "data/spine.db");

const graph = new Graph(dbPath);
await graph.init();

const server = new McpServer(
  { name: "spine", version: "0.1.0" },
  { capabilities: { tools: {} } },
);
registerSpineTools(server, graph);

await server.connect(new StdioServerTransport());

process.stderr.write(`[spine-mcp] connected, db=${dbPath}\n`);
