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

export function registerSpineTools(server: McpServer, graph: Graph): void {
  server.tool(
    "query_entity",
    {
      entity: z
        .string()
        .describe(
          "Entity name or ID. Examples: 'Raj Patel', 'person/emp_0431', 'Acme Corp', 'topic/q2_launch'.",
        ),
      as_role: z
        .array(z.string())
        .optional()
        .describe(
          "Role tags the caller can claim. Each fact's ACL must intersect for visibility. Default: ['employee:all'].",
        ),
      sources_limit: z.number().int().optional(),
    },
    async ({ entity, as_role, sources_limit }) => {
      const ctx = { roles: as_role ?? ["employee:all"] };
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
      as_role: z.array(z.string()).optional(),
      limit: z.number().int().optional(),
    },
    async ({ query, as_role, limit }) => {
      const ctx = { roles: as_role ?? ["employee:all"] };
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
      as_role: z.array(z.string()).optional(),
    },
    async ({ source_id, as_role }) => {
      const ctx = { roles: as_role ?? ["employee:all"] };
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
