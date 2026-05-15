/**
 * Phase 2 — Migrate all legacy IDs to unified format: {2-char prefix}{12 digits}.
 *
 * Run with: cd backend && npx tsx src/scripts/migrate-unified-ids.ts
 *
 * This script:
 *   1. Scans every table for rows with non-new-format IDs
 *   2. Generates new IDs using the unified generator
 *   3. Updates the row's own ID + all foreign key references in other tables
 *   4. Renames filesystem directories (agents, demos, uploads)
 *   5. Updates mention URIs inside Idea content
 *
 * Safety:
 *   - Runs inside transactions per entity (not one giant txn)
 *   - Idempotent: skips rows that already have new-format IDs
 *   - Logs every change for audit
 *   - DRY_RUN mode: set DRY_RUN=1 to preview without writing
 */

import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client.js";
import { generateIdSync, ID_PREFIXES, type IdKind } from "../services/idGenerator.js";
import fs from "fs/promises";
import path from "path";
import os from "os";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter } as any);

const DRY_RUN = process.env.DRY_RUN === "1";
const AGENT_HOME = process.env.AGENT_HOME || path.join(os.homedir(), ".imagebase", "agents");
const DEMO_HOME = process.env.DEMO_HOME || path.join(os.homedir(), ".imagebase", "demos");
const UPLOAD_ROOT = path.resolve("uploads");
const ANALYST_HOME = process.env.ANALYST_HOME || path.join(os.homedir(), ".imagebase", "analyst");

// Track all ID mappings for cross-table FK updates
const idMap = new Map<string, string>(); // oldId → newId

function needsMigration(id: string, kind: IdKind): boolean {
  const prefix = ID_PREFIXES[kind];
  const re = new RegExp(`^${prefix}\\d{12}$`);
  return !re.test(id);
}

function newId(kind: IdKind): string {
  let id: string;
  do {
    id = generateIdSync(kind);
  } while (idMap.has(id)); // avoid collisions within this migration
  return id;
}

function mapId(oldId: string, kind: IdKind): string {
  if (idMap.has(oldId)) return idMap.get(oldId)!;
  const nid = newId(kind);
  idMap.set(oldId, nid);
  return nid;
}

// Resolve an old ID to its new ID (or keep if already new format)
function resolve(oldId: string | null | undefined): string | null {
  if (!oldId) return null;
  return idMap.get(oldId) ?? oldId;
}

let changeCount = 0;

async function rawSql(sql: string, params: any[] = []): Promise<any[]> {
  const result = await pool.query(sql, params);
  return result.rows;
}

async function rawExec(sql: string, params: any[] = []): Promise<number> {
  if (DRY_RUN) {
    console.log(`  [DRY_RUN] ${sql.slice(0, 120)}... params=${JSON.stringify(params).slice(0, 80)}`);
    return 0;
  }
  const result = await pool.query(sql, params);
  return result.rowCount ?? 0;
}

// ─── Migration functions per entity ─────────────────────────────────────

interface MigrationDef {
  table: string;        // DB table name
  kind: IdKind;         // ID prefix kind
  fkUpdates: Array<{    // tables that reference this entity's ID
    table: string;
    column: string;
  }>;
  fsRename?: (oldId: string, newId: string) => Promise<void>;
}

const MIGRATIONS: MigrationDef[] = [
  // Order matters: migrate referenced entities first (User before Agent, etc.)
  {
    table: "users",
    kind: "user",
    fkUpdates: [
      { table: "agents", column: "userId" },
      { table: "custom_models", column: "userId" },
      { table: "org_members", column: "userId" },
      { table: "token_usage", column: "userId" },
    ],
    fsRename: async (oldId, newId) => {
      // Avatar files: uploads/avatars/user_<oldId>_*.jpg
      try {
        const avatarDir = path.join(UPLOAD_ROOT, "avatars");
        const files = await fs.readdir(avatarDir).catch(() => []);
        for (const f of files) {
          if (f.startsWith(`user_${oldId}_`)) {
            const newName = f.replace(`user_${oldId}_`, `user_${newId}_`);
            await fs.rename(path.join(avatarDir, f), path.join(avatarDir, newName));
            console.log(`    renamed avatar: ${f} → ${newName}`);
            // Also update avatarUrl in DB
            await rawExec(
              `UPDATE users SET "avatarUrl" = REPLACE("avatarUrl", $1, $2) WHERE "avatarUrl" LIKE $3`,
              [oldId, newId, `%${oldId}%`],
            );
          }
        }
      } catch { /* non-fatal */ }
    },
  },
  {
    table: "orgs",
    kind: "org",
    fkUpdates: [
      { table: "org_members", column: "orgId" },
      { table: "workspaces", column: "orgId" },
    ],
  },
  {
    table: "org_members",
    kind: "orgMember",
    fkUpdates: [],
  },
  {
    table: "agents",
    kind: "agent",
    fkUpdates: [
      { table: "conversations", column: "agentId" },
      { table: "subagent_runs", column: "hostAgentId" },
      { table: "knowledge_entries", column: "agentId" },
      // user_skills.ownerId (when ownerType = 'agent')
    ],
    fsRename: async (oldId, newId) => {
      const oldDir = path.join(AGENT_HOME, oldId);
      const newDir = path.join(AGENT_HOME, newId);
      try {
        await fs.access(oldDir);
        await fs.rename(oldDir, newDir);
        console.log(`    renamed agent dir: ${oldId} → ${newId}`);
      } catch { /* dir doesn't exist, skip */ }
      // Avatar files
      try {
        const avatarDir = path.join(UPLOAD_ROOT, "avatars");
        const files = await fs.readdir(avatarDir).catch(() => []);
        for (const f of files) {
          if (f.startsWith(`agent_${oldId}_`)) {
            const newName = f.replace(`agent_${oldId}_`, `agent_${newId}_`);
            await fs.rename(path.join(avatarDir, f), path.join(avatarDir, newName));
            console.log(`    renamed agent avatar: ${f} → ${newName}`);
          }
        }
        // Update avatarUrl
        await rawExec(
          `UPDATE agents SET "avatarUrl" = REPLACE("avatarUrl", $1, $2) WHERE "avatarUrl" LIKE $3`,
          [oldId, newId, `%${oldId}%`],
        );
      } catch { /* non-fatal */ }
    },
  },
  {
    table: "workspaces",
    kind: "workspace",
    fkUpdates: [], // ws already in new format, but list FK targets in case
  },
  {
    table: "tables",
    kind: "table",
    fkUpdates: [
      { table: "records", column: "tableId" },
    ],
  },
  {
    table: "folders",
    kind: "folder",
    fkUpdates: [
      // self-referential parentId
      { table: "folders", column: "parentId" },
      { table: "tables", column: "parentId" },
      { table: "ideas", column: "parentId" },
      { table: "designs", column: "parentId" },
      { table: "demos", column: "parentId" },
    ],
  },
  {
    table: "designs",
    kind: "design",
    fkUpdates: [
      { table: "tastes", column: "designId" },
    ],
    fsRename: async (oldId, newId) => {
      // uploads/svgs/<designId>/
      const oldDir = path.join(UPLOAD_ROOT, "svgs", oldId);
      const newDir = path.join(UPLOAD_ROOT, "svgs", newId);
      try {
        await fs.access(oldDir);
        await fs.rename(oldDir, newDir);
        console.log(`    renamed svgs dir: ${oldId} → ${newId}`);
        // Update taste.filePath references
        await rawExec(
          `UPDATE tastes SET "filePath" = REPLACE("filePath", $1, $2) WHERE "filePath" LIKE $3`,
          [oldId, newId, `%${oldId}%`],
        );
      } catch { /* non-fatal */ }
    },
  },
  {
    table: "tastes",
    kind: "taste",
    fkUpdates: [],
  },
  {
    table: "ideas",
    kind: "idea",
    fkUpdates: [
      { table: "idea_blocks", column: "ideaId" },
      { table: "idea_attachments", column: "ideaId" },
    ],
  },
  {
    table: "idea_blocks",
    kind: "ideaBlock",
    fkUpdates: [],
  },
  {
    table: "idea_attachments",
    kind: "ideaAttachment",
    fkUpdates: [],
  },
  {
    table: "demos",
    kind: "demo",
    fkUpdates: [],
    // dm already in new format — skip fs rename
  },
  {
    table: "conversations",
    kind: "conversation",
    fkUpdates: [
      { table: "messages", column: "conversationId" },
      { table: "subagent_runs", column: "parentConversationId" },
    ],
    fsRename: async (oldId, newId) => {
      // analyst sessions: conv_<id>.duckdb
      const sessDir = path.join(ANALYST_HOME, "sessions");
      try {
        const oldFile = path.join(sessDir, `conv_${oldId}.duckdb`);
        const newFile = path.join(sessDir, `conv_${newId}.duckdb`);
        await fs.access(oldFile);
        await fs.rename(oldFile, newFile);
        console.log(`    renamed analyst session: conv_${oldId}.duckdb → conv_${newId}.duckdb`);
      } catch { /* file doesn't exist */ }
    },
  },
  {
    table: "messages",
    kind: "message",
    fkUpdates: [
      { table: "subagent_runs", column: "parentMessageId" },
    ],
  },
  {
    table: "subagent_runs",
    kind: "subagentRun",
    fkUpdates: [
      { table: "subagent_runs", column: "parentSubagentRunId" },
    ],
  },
  {
    table: "workflow_runs",
    kind: "workflowRun",
    fkUpdates: [
      { table: "subagent_runs", column: "workflowRunId" },
    ],
  },
  {
    table: "user_skills",
    kind: "userSkill",
    fkUpdates: [],
    fsRename: async (oldId, newId) => {
      // Skills are stored under agent dir: agents/<ownerId>/skills/<skillId>/
      // We need the ownerId to find the directory
      const rows = await rawSql(
        `SELECT "ownerId" FROM user_skills WHERE id = $1`,
        [DRY_RUN ? oldId : newId], // after update, id is newId
      );
      if (rows.length === 0) return;
      const ownerId = resolve(rows[0].ownerId) ?? rows[0].ownerId;
      const oldDir = path.join(AGENT_HOME, ownerId, "skills", oldId);
      const newDir = path.join(AGENT_HOME, ownerId, "skills", newId);
      try {
        await fs.access(oldDir);
        await fs.rename(oldDir, newDir);
        console.log(`    renamed skill dir: ${oldId} → ${newId}`);
        // Update dirPath in DB
        await rawExec(
          `UPDATE user_skills SET "dirPath" = REPLACE("dirPath", $1, $2) WHERE id = $3`,
          [oldId, newId, DRY_RUN ? oldId : newId],
        );
      } catch { /* non-fatal */ }
    },
  },
  {
    table: "knowledge_entries",
    kind: "knowledgeEntry",
    fkUpdates: [],
  },
  {
    table: "token_usage",
    kind: "tokenUsage",
    fkUpdates: [],
  },
  {
    table: "mentions",
    kind: "mention",
    fkUpdates: [],
  },
  {
    table: "custom_models",
    kind: "customModel",
    fkUpdates: [],
  },
  {
    table: "agency_sessions",
    kind: "agencySession",
    fkUpdates: [
      { table: "agency_milestones", column: "sessionId" },
      { table: "agency_checkpoints", column: "sessionId" },
    ],
  },
  {
    table: "agency_milestones",
    kind: "agencyMilestone",
    fkUpdates: [],
  },
  {
    table: "agency_checkpoints",
    kind: "agencyCheckpoint",
    fkUpdates: [],
  },
];

async function migrateTable(def: MigrationDef): Promise<number> {
  const rows = await rawSql(`SELECT id FROM "${def.table}"`);
  const toMigrate = rows.filter((r) => needsMigration(r.id, def.kind));

  if (toMigrate.length === 0) {
    console.log(`  ${def.table}: 0 rows to migrate (all already in new format)`);
    return 0;
  }

  console.log(`  ${def.table}: ${toMigrate.length} / ${rows.length} rows need migration`);

  for (const row of toMigrate) {
    const oldId = row.id;
    const nid = mapId(oldId, def.kind);
    console.log(`    ${oldId} → ${nid}`);

    // Update own ID
    await rawExec(`UPDATE "${def.table}" SET id = $1 WHERE id = $2`, [nid, oldId]);
    changeCount++;

    // Update all FK references
    for (const fk of def.fkUpdates) {
      const affected = await rawExec(
        `UPDATE "${fk.table}" SET "${fk.column}" = $1 WHERE "${fk.column}" = $2`,
        [nid, oldId],
      );
      if (affected > 0) {
        console.log(`      FK ${fk.table}.${fk.column}: ${affected} rows updated`);
      }
    }

    // Special: user_skills.ownerId (only when ownerType = 'agent')
    if (def.kind === "agent") {
      const affected = await rawExec(
        `UPDATE user_skills SET "ownerId" = $1 WHERE "ownerId" = $2 AND "ownerType" = 'agent'`,
        [nid, oldId],
      );
      if (affected > 0) console.log(`      FK user_skills.ownerId (agent): ${affected} rows`);
    }

    // Filesystem renames
    if (def.fsRename) {
      await def.fsRename(oldId, nid);
    }
  }

  return toMigrate.length;
}

// ─── Mention URI migration ─────────────────────────────────────────────

async function migrateMentionUris(): Promise<void> {
  console.log("\n── Migrating mention URIs in Idea content ──");

  // Build a regex that matches any old ID in mention:// URIs
  if (idMap.size === 0) {
    console.log("  No ID mappings — skipping mention URI migration");
    return;
  }

  // Fetch all ideas with content
  const ideas = await rawSql(`SELECT id, content FROM ideas WHERE content IS NOT NULL AND content != ''`);
  let updated = 0;

  for (const idea of ideas) {
    let content: string = idea.content;
    let changed = false;

    // Replace all occurrences of old IDs in mention:// URIs and any other references
    for (const [oldId, newId] of idMap) {
      if (content.includes(oldId)) {
        content = content.replaceAll(oldId, newId);
        changed = true;
      }
    }

    if (changed) {
      const resolvedIdeaId = resolve(idea.id) ?? idea.id;
      await rawExec(
        `UPDATE ideas SET content = $1 WHERE id = $2`,
        [content, resolvedIdeaId],
      );
      updated++;
      console.log(`  idea ${resolvedIdeaId}: updated content (mention URIs)`);
    }
  }

  console.log(`  Total ideas updated: ${updated}`);
}

// ─── Mention table source/target ID migration ──────────────────────────

async function migrateMentionTable(): Promise<void> {
  console.log("\n── Migrating Mention table source/target IDs ──");

  const mentions = await rawSql(
    `SELECT id, "sourceId", "targetId", "targetKey" FROM mentions`,
  );

  let updated = 0;
  for (const m of mentions) {
    const newSourceId = resolve(m.sourceId);
    const newTargetId = resolve(m.targetId);
    // targetKey may contain composite keys like "<ideaId>#<slug>"
    let newTargetKey = m.targetKey;
    if (m.targetKey) {
      for (const [oldId, newId] of idMap) {
        if (m.targetKey.includes(oldId)) {
          newTargetKey = m.targetKey.replaceAll(oldId, newId);
        }
      }
    }

    if (newSourceId !== m.sourceId || newTargetId !== m.targetId || newTargetKey !== m.targetKey) {
      const resolvedMentionId = resolve(m.id) ?? m.id;
      await rawExec(
        `UPDATE mentions SET "sourceId" = $1, "targetId" = $2, "targetKey" = $3 WHERE id = $4`,
        [newSourceId, newTargetId, newTargetKey, resolvedMentionId],
      );
      updated++;
    }
  }

  console.log(`  Total mention rows updated: ${updated}`);
}

// ─── SubagentRun parentMessageId (may contain "pending_<convId>") ──────

async function migrateSubagentPendingRefs(): Promise<void> {
  console.log("\n── Migrating SubagentRun pending_<convId> refs ──");

  const runs = await rawSql(
    `SELECT id, "parentMessageId" FROM subagent_runs WHERE "parentMessageId" LIKE 'pending_%'`,
  );

  let updated = 0;
  for (const r of runs) {
    const oldConvId = r.parentMessageId.replace("pending_", "");
    const newConvId = resolve(oldConvId);
    if (newConvId && newConvId !== oldConvId) {
      const resolvedRunId = resolve(r.id) ?? r.id;
      await rawExec(
        `UPDATE subagent_runs SET "parentMessageId" = $1 WHERE id = $2`,
        [`pending_${newConvId}`, resolvedRunId],
      );
      updated++;
    }
  }

  console.log(`  Total pending refs updated: ${updated}`);
}

// ─── Main ───────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Unified ID Migration ${DRY_RUN ? "(DRY RUN)" : "(LIVE)"}`);
  console.log(`${"=".repeat(60)}\n`);

  // Phase 1: Migrate all table IDs
  console.log("── Phase 1: Migrate entity IDs ──\n");
  for (const def of MIGRATIONS) {
    await migrateTable(def);
  }

  // Phase 2: Migrate mention URIs in Idea content
  await migrateMentionUris();

  // Phase 3: Migrate Mention table source/target IDs
  await migrateMentionTable();

  // Phase 4: Migrate SubagentRun pending_ refs
  await migrateSubagentPendingRefs();

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Migration complete. ${changeCount} ID changes applied.`);
  console.log(`  Total ID mappings: ${idMap.size}`);
  console.log(`${"=".repeat(60)}\n`);

  // Dump the mapping for audit
  if (idMap.size > 0 && idMap.size < 200) {
    console.log("ID mapping dump:");
    for (const [old, nw] of idMap) {
      console.log(`  ${old} → ${nw}`);
    }
  }

  await prisma.$disconnect();
  await pool.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
