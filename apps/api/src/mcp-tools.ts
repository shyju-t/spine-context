/**
 * Spine MCP tool definitions.
 *
 * Single source of truth for what tools the MCP server exposes. Both
 * the stdio entrypoint (mcp.ts) and the HTTP transport mounted on
 * /mcp (server.ts) register the same set against their own McpServer
 * instance.
 *
 * Each tool calls the query layer (query.ts) directly — the same code
 * path the REST endpoints use. ACL filtering happens inside the query
 * layer, not at this layer.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Graph } from "@spine/graph";
import {
  findEntityByQuery,
  getFactsForEntity,
  getSourceById,
  getSourcesForEntity,
  listPersons,
  searchSources,
} from "./query.js";

const TextContent = (text: string) =>
  ({ type: "text" as const, text }) satisfies { type: "text"; text: string };

/**
 * Spine ACL tokens are namespaced (`role:exec`, `employee:all`, `person:emp_X`).
 * MCP clients (Claude Desktop, etc) often pass the bare role name — `"exec"`,
 * `"hr"` — because that's how a human would describe themselves. We accept
 * both forms here so the demo doesn't flunk on a syntactic mismatch.
 *
 * The canonical form is preserved when callers already namespace; aliasing
 * only kicks in for known bare names.
 */
function normalizeRoles(input: string[] | undefined): string[] {
  const raw = input && input.length > 0 ? input : ["employee:all"];
  const out = new Set<string>();
  for (const r of raw) {
    const t = r.trim();
    if (!t) continue;
    if (t.includes(":")) {
      out.add(t);
      continue;
    }
    const lower = t.toLowerCase();
    if (lower === "employee" || lower === "all" || lower === "everyone") {
      out.add("employee:all");
      continue;
    }
    // Bare role name → role:<name>. Covers "exec", "hr", "cs", "engineer", etc.
    out.add(`role:${lower}`);
  }
  return [...out];
}

const AS_ROLE_DESC =
  "Role tags the caller can claim. A fact is visible only if its ACL " +
  "intersects this list. Pass an array of strings using these forms: " +
  "'employee:all' (default — broadly visible facts), " +
  "'role:exec' (executive view), " +
  "'role:hr' (HR-only fields like salary, performance), " +
  "'role:cs' (customer-success view), " +
  "'person:emp_<id>' (self-scoped). " +
  "Bare names like 'exec' or 'hr' are also accepted and auto-prefixed to 'role:exec'/'role:hr'. " +
  "Examples: ['role:exec'], ['role:hr', 'person:emp_0040'], ['employee:all'].";

export function registerSpineTools(server: McpServer, graph: Graph): void {
  server.tool(
    "query_entity",
    {
      entity: z
        .string()
        .describe(
          "Entity name or ID. Examples: 'Raj Patel', 'person/emp_0431', 'Acme Corp', 'topic/q2_launch'.",
        ),
      as_role: z.array(z.string()).optional().describe(AS_ROLE_DESC),
      sources_limit: z.number().int().optional(),
    },
    async ({ entity, as_role, sources_limit }) => {
      const ctx = { roles: normalizeRoles(as_role) };
      const resolved = await findEntityByQuery(graph, entity);
      if (!resolved) {
        return {
          content: [
            TextContent(
              `No entity found for "${entity}". Try search_context for a fuzzy match.`,
            ),
          ],
        };
      }
      const factsRes = await getFactsForEntity(graph, resolved.id, ctx);
      const sourcesRes = await getSourcesForEntity(
        graph,
        resolved.id,
        resolved.type,
        ctx,
        sources_limit ?? 10,
      );
      return {
        content: [
          TextContent(
            JSON.stringify(
              {
                entity: resolved,
                facts: factsRes.facts,
                redacted_facts: factsRes.redacted,
                sources: sourcesRes.sources,
                redacted_sources: sourcesRes.redacted,
                note:
                  factsRes.redacted > 0 || sourcesRes.redacted > 0
                    ? `${factsRes.redacted} fact(s) and ${sourcesRes.redacted} source(s) hidden — caller's roles do not satisfy ACL.`
                    : null,
              },
              null,
              2,
            ),
          ),
        ],
      };
    },
  );

  server.tool(
    "search_context",
    {
      query: z
        .string()
        .describe(
          "Free-form query. Tries entity match first; falls back to full-text search over Source content.",
        ),
      as_role: z.array(z.string()).optional().describe(AS_ROLE_DESC),
      limit: z.number().int().optional(),
    },
    async ({ query, as_role, limit }) => {
      const ctx = { roles: normalizeRoles(as_role) };
      const lim = limit ?? 10;

      const entity = await findEntityByQuery(graph, query);
      if (entity) {
        const factsRes = await getFactsForEntity(graph, entity.id, ctx);
        const sourcesRes = await getSourcesForEntity(
          graph,
          entity.id,
          entity.type,
          ctx,
          lim,
        );
        return {
          content: [
            TextContent(
              JSON.stringify(
                {
                  kind: "entity_hit",
                  entity,
                  facts: factsRes.facts,
                  sources: sourcesRes.sources,
                  redacted_facts: factsRes.redacted,
                  redacted_sources: sourcesRes.redacted,
                },
                null,
                2,
              ),
            ),
          ],
        };
      }

      const ftRes = await searchSources(graph, query, ctx, lim);
      return {
        content: [
          TextContent(
            JSON.stringify(
              {
                kind: "source_hits",
                sources: ftRes.sources,
                redacted_sources: ftRes.redacted,
              },
              null,
              2,
            ),
          ),
        ],
      };
    },
  );

  server.tool(
    "get_source",
    {
      source_id: z
        .string()
        .describe("Source ID, e.g. 'email/4226322d-...' or 'kb/9'."),
      as_role: z.array(z.string()).optional().describe(AS_ROLE_DESC),
    },
    async ({ source_id, as_role }) => {
      const ctx = { roles: normalizeRoles(as_role) };
      const result = await getSourceById(graph, source_id, ctx);
      if (!result.source) {
        return {
          content: [
            TextContent(
              result.redacted
                ? `Source ${source_id} exists but is not visible to your role(s). ACL check failed.`
                : `Source ${source_id} not found.`,
            ),
          ],
        };
      }
      return {
        content: [TextContent(JSON.stringify(result.source, null, 2))],
      };
    },
  );

  server.tool(
    "list_persons",
    {
      department: z.string().optional(),
      level: z.string().optional(),
      limit: z.number().int().optional(),
    },
    async ({ department, level, limit }) => {
      const persons = await listPersons(
        graph,
        { department, level },
        limit ?? 50,
      );
      return {
        content: [TextContent(JSON.stringify(persons, null, 2))],
      };
    },
  );
}
