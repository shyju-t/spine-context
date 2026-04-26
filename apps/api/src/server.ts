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
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
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

console.log(`[boot] opening kuzu DB at ${dbPath}`);
const graph = new Graph(dbPath);
console.log("[boot] running graph.init() (DDL pass)");
await graph.init();
console.log("[boot] graph.init() complete");

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

  // Per-source-type breakdown so the landing page can show "we
  // processed N emails, M chats, K reviews, etc." Best-effort: a
  // failure here returns an empty record rather than failing the
  // whole stats response.
  let sources_by_type: Record<string, number> = {};
  try {
    const rows = await graph.query<{ type: string; total: bigint | number }>(
      `MATCH (s:Source) RETURN s.type AS type, count(s) AS total ORDER BY total DESC`,
    );
    for (const r of rows) {
      const v = r.total;
      sources_by_type[r.type] =
        typeof v === "bigint" ? Number(v) : (v ?? 0);
    }
  } catch {
    sources_by_type = {};
  }

  // LLM extraction coverage per source type. Counts distinct sources
  // that have at least one extractor:* fact, broken down by which
  // extractor authored it. Lets the demo answer "how much of each
  // source pile has the LLM actually walked over?" without resorting
  // to ad-hoc DB probes.
  type CoverageRow = {
    source_type: string;
    extractor: string;
    sources_extracted: bigint | number;
    facts_authored: bigint | number;
  };
  const extractor_coverage: Record<
    string,
    { extracted_sources: number; by_extractor: Record<string, { sources: number; facts: number }> }
  > = {};
  try {
    const rows = await graph.query<CoverageRow>(`
      MATCH (f:Fact), (s:Source)
      WHERE f.source_id = s.id AND f.author STARTS WITH 'extractor:'
      RETURN s.type AS source_type,
             f.author AS extractor,
             count(DISTINCT s.id) AS sources_extracted,
             count(f) AS facts_authored
    `);
    for (const r of rows) {
      const sourceCount =
        typeof r.sources_extracted === "bigint"
          ? Number(r.sources_extracted)
          : Number(r.sources_extracted ?? 0);
      const factCount =
        typeof r.facts_authored === "bigint"
          ? Number(r.facts_authored)
          : Number(r.facts_authored ?? 0);
      const tag = r.extractor.replace(/^extractor:/, "");
      if (!extractor_coverage[r.source_type]) {
        extractor_coverage[r.source_type] = {
          extracted_sources: 0,
          by_extractor: {},
        };
      }
      extractor_coverage[r.source_type].by_extractor[tag] = {
        sources: sourceCount,
        facts: factCount,
      };
    }
    // Compute extracted_sources (distinct, across all extractors) per type.
    // The aggregate above gives per-(type, extractor) distinct counts, so
    // a single source extracted by both Gemini and Pioneer would be
    // counted twice if we just summed. Re-query for the distinct total.
    const totalRows = await graph.query<{
      source_type: string;
      total: bigint | number;
    }>(`
      MATCH (f:Fact), (s:Source)
      WHERE f.source_id = s.id AND f.author STARTS WITH 'extractor:'
      RETURN s.type AS source_type, count(DISTINCT s.id) AS total
    `);
    for (const r of totalRows) {
      const v = typeof r.total === "bigint" ? Number(r.total) : Number(r.total ?? 0);
      if (extractor_coverage[r.source_type]) {
        extractor_coverage[r.source_type].extracted_sources = v;
      }
    }
  } catch {
    // Leave coverage empty on failure rather than failing the whole stats call.
  }

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
    sources_by_type,
    extractor_coverage,
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

// ───────────────── Static frontend (production deploy) ─────────────────
//
// In dev the Vite server runs on port 5173 and proxies /api → here.
// In the Cloud Run image we bake the built frontend into apps/web/dist
// and let Hono serve it as static files. /api/* and /mcp are registered
// above so they win — anything else falls through to serveStatic, which
// serves index.html for / and the hashed assets for /assets/*. SPA
// fallback: any unknown path returns index.html so direct-URL access
// (e.g. /conflicts) still loads the app and lets client state route.

// Defensive boot: log progress, wrap each registration so any error
// surfaces in Cloud Run logs instead of crashing silently.
console.log("[boot] static-serve registration begins");
const staticDirEnv = process.env.SPINE_STATIC_DIR;
if (staticDirEnv) {
  try {
    const staticDir = resolve(staticDirEnv);
    if (existsSync(staticDir)) {
      const indexPath = join(staticDir, "index.html");
      const indexHtml = existsSync(indexPath)
        ? readFileSync(indexPath, "utf8")
        : null;
      const relRoot = relative(process.cwd(), staticDir) || ".";

      // Asset middleware — serveStatic with no `index` option (some
      // versions don't honour it the way we expect; the SPA-fallback
      // routes below handle the index.html serving explicitly).
      app.use("/*", serveStatic({ root: relRoot }));

      // Explicit / and * routes for index.html — serves the React app
      // for the root and falls back for any unknown path so direct-URL
      // access (e.g. /conflicts) loads the SPA cleanly.
      if (indexHtml) {
        app.get("/", (c) => c.html(indexHtml));
        app.get("*", (c) => c.html(indexHtml));
      }
      console.log(
        `[boot] web: serving ${staticDir} (root=${relRoot}, index=${indexHtml ? "yes" : "no"})`,
      );
    } else {
      console.warn(
        `[boot] SPINE_STATIC_DIR=${staticDir} does not exist; static frontend NOT mounted`,
      );
    }
  } catch (err) {
    console.error("[boot] static-serve registration FAILED:", err);
  }
}
console.log("[boot] static-serve registration done");

// Bind to all interfaces (0.0.0.0) — Cloud Run requires this; the
// container's port is otherwise unreachable from outside its
// loopback. Local dev is unaffected; localhost still resolves.
const hostname = "0.0.0.0";
console.log(`[spine-api] listening on http://${hostname}:${port}`);
console.log(`             db:  ${dbPath}`);
console.log(`             rest: http://${hostname}:${port}/api/*`);
console.log(`             mcp:  http://${hostname}:${port}/mcp`);
serve({ fetch: app.fetch, port, hostname });
