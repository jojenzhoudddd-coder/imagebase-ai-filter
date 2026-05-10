/**
 * Admin-only MCP tools — read-only database queries.
 *
 * These tools are ONLY exposed to admin users' agents. Non-admin agents
 * never see them in the tool list and cannot call them.
 *
 * Safety: all queries are SELECT-only. The tool validates the SQL and
 * rejects any DML/DDL statements.
 */

import type { ToolDefinition, ToolContext } from "./tableTools.js";

const FORBIDDEN_KEYWORDS = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|COPY|ATTACH|PRAGMA|SET|EXPORT|IMPORT)\b/i;

export const adminTools: ToolDefinition[] = [
  {
    name: "admin_query_db",
    description:
      "Execute a read-only SQL query against the system database. " +
      "ONLY SELECT statements are allowed — any DML/DDL will be rejected. " +
      "Use this to inspect user data, token usage, conversations, agents, etc. " +
      "Available tables: users, agents, conversations, messages, token_usage, " +
      "workspaces, orgs, org_members, tables, records, ideas, designs, tastes, " +
      "demos, knowledge_entries, user_skills, workflow_runs, subagent_runs, " +
      "agency_sessions, agency_milestones, agency_checkpoints, custom_models, mentions. " +
      "Important: Prisma uses camelCase column names (e.g. userId, createdAt, totalTokens). " +
      "Table names are lowercase (e.g. users, token_usage).",
    inputSchema: {
      type: "object" as const,
      properties: {
        sql: {
          type: "string",
          description: "The SELECT SQL query to execute. Must start with SELECT or WITH.",
        },
        limit: {
          type: "number",
          description: "Max rows to return (default 100, max 500).",
        },
      },
      required: ["sql"],
    },
    handler: async (args: Record<string, unknown>, _ctx?: ToolContext): Promise<string> => {
      const sql = (args.sql as string || "").trim();
      const limit = Math.min(Math.max(Number(args.limit) || 100, 1), 500);

      if (!/^\s*(SELECT|WITH)\b/i.test(sql)) {
        return JSON.stringify({ error: "Only SELECT queries are allowed. Query must start with SELECT or WITH." });
      }
      if (FORBIDDEN_KEYWORDS.test(sql)) {
        return JSON.stringify({ error: "Query contains forbidden keywords. Only read-only SELECT queries are allowed." });
      }

      const hasLimit = /\bLIMIT\s+\d+/i.test(sql);
      const finalSql = hasLimit ? sql : `${sql} LIMIT ${limit}`;

      try {
        const pg = await import("pg");
        const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL });
        const result = await pool.query(finalSql);
        await pool.end();
        return JSON.stringify({
          rowCount: result.rowCount,
          columns: result.fields.map((f: any) => f.name),
          rows: result.rows,
        });
      } catch (err: any) {
        return JSON.stringify({ error: `Query failed: ${err.message}` });
      }
    },
  },
  {
    name: "admin_list_tables",
    description:
      "List all database tables with their row counts. " +
      "Useful for understanding the system's data structure.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
    handler: async (_args: Record<string, unknown>, _ctx?: ToolContext): Promise<string> => {
      try {
        const pg = await import("pg");
        const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL });
        const result = await pool.query(`
          SELECT schemaname, tablename,
                 (xpath('/row/cnt/text()', xml_count))[1]::text::bigint AS row_count
          FROM (
            SELECT schemaname, tablename,
                   query_to_xml('SELECT count(*) AS cnt FROM ' || quote_ident(schemaname) || '.' || quote_ident(tablename), false, true, '') AS xml_count
            FROM pg_tables
            WHERE schemaname = 'public'
            ORDER BY tablename
          ) t
        `);
        await pool.end();
        return JSON.stringify({ tables: result.rows });
      } catch (err: any) {
        return JSON.stringify({ error: `Failed to list tables: ${err.message}` });
      }
    },
  },
];
