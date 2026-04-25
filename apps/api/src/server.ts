/**
 * Spine HTTP API.
 *
 * Wraps the same query layer the MCP server uses. Used by the
 * Inspector UI in apps/web.
 *
 * Roles passed via `?as_role=` query param (comma-separated). Examples:
 *   /api/entity?q=Ravi+Kumar&as_role=employee:all,role:hr
 *   /api/source/email/abc?as_role=role:exec
 */
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Graph } from "@spine/graph";
import { findConflicts, resolveConflict } from "./conflicts.js";
import { registerSpineTools } from "./mcp-tools.js";
import {
  findEntityByQuery,
  getFactsForEntity,
  getSourceById,
  getSourcesForEntity,
  listPersons,
  searchSources,
} from "./query.js";

const baseDir = process.env.INIT_CWD ?? process.cwd();
const dbPath =
  process.env.SPINE_DB ?? join(baseDir, "data/spine.db");
const port = Number(process.env.SPINE_PORT ?? 3001);

const graph = new Graph(dbPath);
await graph.init();

// ───────────────── HTTP app ─────────────────

const app = new Hono();

// Permissive CORS — local dev only; the Inspector runs on a different port.
app.use("/api/*", cors());
app.use("/mcp", cors());

// ───────────────── MCP endpoint ─────────────────
//
// Stateless mode: per request, spin up a fresh McpServer + transport pair
// connected to the shared Graph. The graph instance is reused (so we don't
// re-init Kuzu); only the MCP protocol state is per-request. This is the
// pattern the MCP SDK documents for serverless / multi-client HTTP and
// avoids "server already initialized" issues that come from sharing one
// McpServer across initialize calls.

app.all("/mcp", async (c) => {
  const server = new McpServer(
    { name: "spine", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  registerSpineTools(server, graph);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless: no session tracking
  });
  await server.connect(transport);

  return transport.handleRequest(c.req.raw);
});

function rolesFromQuery(qs: URLSearchParams): { roles: string[] } {
  const raw = qs.get("as_role");
  if (!raw) return { roles: ["employee:all"] };
  const roles = raw
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  return { roles: roles.length ? roles : ["employee:all"] };
}

app.get("/api/health", (c) => c.json({ ok: true, db: dbPath }));

app.get("/api/entity", async (c) => {
  const url = new URL(c.req.url);
  const q = url.searchParams.get("q") ?? "";
  if (!q.trim()) return c.json({ error: "q required" }, 400);
  const ctx = rolesFromQuery(url.searchParams);

  const entity = await findEntityByQuery(graph, q);
  if (!entity) return c.json({ entity: null });

  const factsRes = await getFactsForEntity(graph, entity.id, ctx);
  const sourcesRes = await getSourcesForEntity(
    graph,
    entity.id,
    entity.type,
    ctx,
    20,
  );

  return c.json({
    entity,
    facts: factsRes.facts,
    redacted_facts: factsRes.redacted,
    sources: sourcesRes.sources,
    redacted_sources: sourcesRes.redacted,
  });
});

app.get("/api/source/*", async (c) => {
  // source_id can contain slashes (e.g. "email/abc"); take everything after /api/source/
  const url = new URL(c.req.url);
  const path = url.pathname;
  const sourceId = decodeURIComponent(path.replace(/^\/api\/source\//, ""));
  const ctx = rolesFromQuery(url.searchParams);

  const result = await getSourceById(graph, sourceId, ctx);
  if (!result.source) {
    return c.json(
      {
        source: null,
        redacted: result.redacted,
        message: result.redacted
          ? "Source exists but is not visible to your role(s)."
          : "Source not found.",
      },
      result.redacted ? 403 : 404,
    );
  }
  return c.json({ source: result.source });
});

app.get("/api/search", async (c) => {
  const url = new URL(c.req.url);
  const q = url.searchParams.get("q") ?? "";
  if (!q.trim()) return c.json({ error: "q required" }, 400);
  const ctx = rolesFromQuery(url.searchParams);
  const limit = Number(url.searchParams.get("limit") ?? 10);

  // Tier 1: entity match
  const entity = await findEntityByQuery(graph, q);
  if (entity) {
    const factsRes = await getFactsForEntity(graph, entity.id, ctx);
    const sourcesRes = await getSourcesForEntity(
      graph,
      entity.id,
      entity.type,
      ctx,
      limit,
    );
    return c.json({
      kind: "entity_hit",
      entity,
      facts: factsRes.facts,
      redacted_facts: factsRes.redacted,
      sources: sourcesRes.sources,
      redacted_sources: sourcesRes.redacted,
    });
  }
  // Tier 2: full-text
  const ftRes = await searchSources(graph, q, ctx, limit);
  return c.json({
    kind: "source_hits",
    sources: ftRes.sources,
    redacted_sources: ftRes.redacted,
  });
});

app.get("/api/stats", async (c) => {
  // Compact summary for the Inspector landing page. Best-effort: any
  // count failure returns -1 for that field rather than failing the whole
  // response.
  async function count(label: string): Promise<number> {
    try {
      const rows = await graph.query<{ total: bigint | number }>(
        `MATCH (n:${label}) RETURN count(n) AS total`,
      );
      const v = rows[0]?.total;
      return typeof v === "bigint" ? Number(v) : (v ?? 0);
    } catch {
      return -1;
    }
  }
  const [sources, persons, customers, vendors, clients, products, topics, projects, facts] =
    await Promise.all([
      count("Source"),
      count("Person"),
      count("Customer"),
      count("Vendor"),
      count("Client"),
      count("Product"),
      count("Topic"),
      count("Project"),
      count("Fact"),
    ]);
  return c.json({
    sources,
    persons,
    customers,
    vendors,
    clients,
    products,
    topics,
    projects,
    facts,
    entities: persons + customers + vendors + clients + products + topics + projects,
  });
});

app.get("/api/persons", async (c) => {
  const url = new URL(c.req.url);
  const department = url.searchParams.get("department") ?? undefined;
  const level = url.searchParams.get("level") ?? undefined;
  const limit = Number(url.searchParams.get("limit") ?? 50);
  const persons = await listPersons(graph, { department, level }, limit);
  return c.json({ persons });
});

// ───────────────── Conflicts ─────────────────

app.get("/api/conflicts", async (c) => {
  const url = new URL(c.req.url);
  const ctx = rolesFromQuery(url.searchParams);
  const limit = Number(url.searchParams.get("limit") ?? 50);
  const conflicts = await findConflicts(graph, ctx, limit);
  return c.json({ conflicts });
});

app.post("/api/conflicts/resolve", async (c) => {
  const body = (await c.req.json()) as {
    winning_fact_id?: string;
    resolved_by_user?: string;
    reason?: string;
  };
  if (!body.winning_fact_id || !body.resolved_by_user) {
    return c.json(
      { error: "winning_fact_id and resolved_by_user are required" },
      400,
    );
  }
  const result = await resolveConflict(graph, {
    winning_fact_id: body.winning_fact_id,
    resolved_by_user: body.resolved_by_user,
    reason: body.reason ?? "human-resolved",
  });
  return c.json(result);
});

console.log(`[spine-api] listening on http://localhost:${port}`);
console.log(`             db:  ${dbPath}`);
console.log(`             rest: http://localhost:${port}/api/*`);
console.log(`             mcp:  http://localhost:${port}/mcp`);
serve({ fetch: app.fetch, port });
