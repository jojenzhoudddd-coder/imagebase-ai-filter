import pg from "pg";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { generateId } from "../idGenerator.js";
import { encryptSecret, previewSecret } from "./secretCrypto.js";
import {
  getIntegrationPreset,
  isSystemIntegrationProvider,
  listSystemIntegrationPresets,
} from "./providerCatalog.js";
import type {
  AgentIntegrationRow,
  IntegrationStatus,
  IntegrationToolManifest,
  IntegrationTransport,
} from "./types.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
pg.types.setTypeParser(1114, (str: string) => new Date(str + "Z"));
type QueryExecutor = Pick<pg.Pool | pg.PoolClient, "query">;

export class IntegrationValidationError extends Error {
  constructor(message: string, public readonly field?: string) {
    super(message);
    this.name = "IntegrationValidationError";
  }
}

export class IntegrationNotFoundError extends Error {
  constructor(id: string) {
    super(`integration not found: ${id}`);
    this.name = "IntegrationNotFoundError";
  }
}

export interface CreateIntegrationInput {
  agentId: string;
  providerKey: string;
  displayName?: string;
  transport?: IntegrationTransport;
  enabled?: boolean;
  config?: Record<string, any>;
  toolManifest?: IntegrationToolManifest[];
  scopes?: string[];
  credentials?: Record<string, string>;
}

export interface UpdateIntegrationInput {
  displayName?: string;
  transport?: IntegrationTransport;
  enabled?: boolean;
  status?: IntegrationStatus;
  lastError?: string | null;
  config?: Record<string, any>;
  toolManifest?: IntegrationToolManifest[];
  scopes?: string[];
  credentials?: Record<string, string>;
}

export interface DeleteIntegrationResult {
  ok: boolean;
  action: "deleted" | "reset" | "not_found";
  integration?: AgentIntegrationRow;
}

const VALID_TRANSPORTS = new Set<IntegrationTransport>(["mcp-stdio", "mcp-http", "cli"]);
const VALID_STATUS = new Set<IntegrationStatus>(["not_configured", "healthy", "error", "disabled"]);

export async function listAgentIntegrations(agentId: string): Promise<AgentIntegrationRow[]> {
  const { rows } = await pool.query(
    `
      SELECT i.*,
        COALESCE(
          json_agg(
            json_build_object('name', c.name, 'valuePreview', c."valuePreview")
            ORDER BY c.name
          ) FILTER (WHERE c.id IS NOT NULL),
          '[]'
        ) AS credentials
      FROM agent_integrations i
      LEFT JOIN agent_integration_credentials c ON c."integrationId" = i.id
      WHERE i."agentId" = $1
      GROUP BY i.id
      ORDER BY i."createdAt" DESC
    `,
    [agentId],
  );
  return rows.map(rowToIntegration);
}

export async function listEnabledIntegrations(agentId: string): Promise<AgentIntegrationRow[]> {
  const all = await listAgentIntegrations(agentId);
  return all.filter((i) => i.enabled);
}

export async function ensureSystemIntegrations(agentId: string): Promise<void> {
  let existing = await listAgentIntegrations(agentId);
  if (await deleteDuplicateSystemIntegrations(existing)) {
    existing = await listAgentIntegrations(agentId);
  }
  for (const preset of listSystemIntegrationPresets()) {
    if (hasSystemPresetInstance(existing, preset.key, preset.recommendedTransport)) continue;
    const displayName = preset.key === "lark" && existing.some((integration) => integration.providerKey === "lark")
      ? `${preset.displayName} CLI`
      : preset.displayName;
    await createAgentIntegration({
      agentId,
      providerKey: preset.key,
      displayName,
      transport: preset.recommendedTransport,
      enabled: false,
    });
  }
  await pool.query(
    `
      UPDATE agent_integrations
      SET status = 'not_configured',
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "agentId" = $1 AND status = 'disabled'
    `,
    [agentId],
  );
}

function hasSystemPresetInstance(
  integrations: AgentIntegrationRow[],
  providerKey: string,
  recommendedTransport: IntegrationTransport,
): boolean {
  if (providerKey === "lark") {
    return integrations.some((integration) =>
      integration.providerKey === providerKey && integration.transport === recommendedTransport
    );
  }
  return integrations.some((integration) => integration.providerKey === providerKey);
}

async function deleteDuplicateSystemIntegrations(
  integrations: AgentIntegrationRow[],
): Promise<boolean> {
  let changed = false;
  for (const preset of listSystemIntegrationPresets()) {
    const matches = integrations.filter((integration) => {
      if (integration.providerKey !== preset.key) return false;
      if (preset.key === "lark") return integration.transport === preset.recommendedTransport;
      return true;
    });
    if (matches.length <= 1) continue;

    const keep = [...matches].sort(compareSystemIntegrationKeepPriority)[0];
    const duplicateIds = matches
      .filter((integration) => integration.id !== keep.id)
      .map((integration) => integration.id);
    if (duplicateIds.length === 0) continue;
    await pool.query(
      `DELETE FROM agent_integrations WHERE id = ANY($1::text[])`,
      [duplicateIds],
    );
    await Promise.all(
      matches
        .filter((integration) => integration.id !== keep.id)
        .map((integration) => deleteIntegrationSandbox(integration)),
    );
    changed = true;
  }
  return changed;
}

function compareSystemIntegrationKeepPriority(
  a: AgentIntegrationRow,
  b: AgentIntegrationRow,
): number {
  const scoreDiff = systemIntegrationScore(b) - systemIntegrationScore(a);
  if (scoreDiff !== 0) return scoreDiff;
  return timestampMs(b.updatedAt ?? b.createdAt) - timestampMs(a.updatedAt ?? a.createdAt);
}

function systemIntegrationScore(integration: AgentIntegrationRow): number {
  return (integration.enabled ? 100 : 0)
    + (integration.status === "healthy" ? 80 : 0)
    + (integration.status === "error" ? 30 : 0)
    + (integration.credentials.length > 0 ? 20 : 0)
    + (integration.lastUsedAt ? 10 : 0);
}

function timestampMs(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

async function findReusableSystemIntegration(
  agentId: string,
  providerKey: string,
  transport: IntegrationTransport,
): Promise<AgentIntegrationRow | null> {
  const integrations = await listAgentIntegrations(agentId);
  const candidates = integrations.filter((integration) => {
    if (integration.providerKey !== providerKey) return false;
    if (providerKey === "lark") return integration.transport === transport;
    return true;
  });
  if (candidates.length === 0) return null;
  return [...candidates].sort(compareSystemIntegrationKeepPriority)[0];
}

export async function getAgentIntegration(
  id: string,
  opts?: { requireAgentId?: string },
): Promise<AgentIntegrationRow | null> {
  const { rows } = await pool.query(
    `
      SELECT i.*,
        COALESCE(
          json_agg(
            json_build_object('name', c.name, 'valuePreview', c."valuePreview")
            ORDER BY c.name
          ) FILTER (WHERE c.id IS NOT NULL),
          '[]'
        ) AS credentials
      FROM agent_integrations i
      LEFT JOIN agent_integration_credentials c ON c."integrationId" = i.id
      WHERE i.id = $1
      GROUP BY i.id
      LIMIT 1
    `,
    [id],
  );
  if (rows.length === 0) return null;
  const row = rowToIntegration(rows[0]);
  if (opts?.requireAgentId && row.agentId !== opts.requireAgentId) {
    throw new IntegrationNotFoundError(id);
  }
  return row;
}

export async function createAgentIntegration(
  input: CreateIntegrationInput,
): Promise<AgentIntegrationRow> {
  const agentId = cleanRequired(input.agentId, "agentId");
  const providerKey = cleanRequired(input.providerKey, "providerKey");
  const preset = getIntegrationPreset(providerKey);
  const displayName = cleanName(input.displayName || preset?.displayName || providerKey);
  const transport = normalizeTransport(input.transport || preset?.recommendedTransport || "cli");
  const config = normalizeObject({ ...(preset?.defaultConfig ?? {}), ...(input.config ?? {}) }, "config");
  validateCliCommandConfig(config, "config.command");
  const toolManifest = validateToolManifest(
    input.toolManifest ?? preset?.defaultTools ?? [],
  );
  const scopes = normalizeStringArray(input.scopes ?? preset?.scopes ?? []);
  const reusableSystemIntegration = isSystemIntegrationProvider(providerKey)
    ? await findReusableSystemIntegration(agentId, providerKey, transport)
    : null;

  if (reusableSystemIntegration) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `
          UPDATE agent_integrations
          SET "displayName" = $2,
              transport = $3,
              enabled = $4,
              status = 'not_configured',
              "lastError" = NULL,
              "configJson" = $5::jsonb,
              "toolManifest" = $6::jsonb,
              scopes = $7::text[],
              "updatedAt" = CURRENT_TIMESTAMP
          WHERE id = $1
        `,
        [
          reusableSystemIntegration.id,
          displayName,
          transport,
          input.enabled !== false,
          JSON.stringify(config),
          JSON.stringify(toolManifest),
          scopes,
        ],
      );
      if (input.credentials) {
        await replaceCredentials(reusableSystemIntegration.id, input.credentials, client);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    const updated = await getAgentIntegration(reusableSystemIntegration.id);
    if (!updated) throw new IntegrationNotFoundError(reusableSystemIntegration.id);
    return updated;
  }

  const id = await generateId("integration", async (candidate) => {
    const r = await pool.query("SELECT 1 FROM agent_integrations WHERE id = $1", [candidate]);
    return (r.rowCount ?? 0) > 0;
  });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `
        INSERT INTO agent_integrations
          (
            id, "agentId", "providerKey", "displayName", transport, enabled, status,
            "configJson", "toolManifest", scopes, "createdAt", "updatedAt"
          )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::text[], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `,
      [
        id,
        agentId,
        providerKey,
        displayName,
        transport,
        input.enabled !== false,
        "not_configured",
        JSON.stringify(config),
        JSON.stringify(toolManifest),
        scopes,
      ],
    );
    if (input.credentials) {
      await replaceCredentials(id, input.credentials, client);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  const created = await getAgentIntegration(id);
  if (!created) throw new IntegrationNotFoundError(id);
  return created;
}

export async function updateAgentIntegration(
  id: string,
  patch: UpdateIntegrationInput,
  opts?: { requireAgentId?: string },
): Promise<AgentIntegrationRow> {
  const existing = await getAgentIntegration(id, { requireAgentId: opts?.requireAgentId });
  if (!existing) throw new IntegrationNotFoundError(id);

  const sets: string[] = ['"updatedAt" = CURRENT_TIMESTAMP'];
  const values: unknown[] = [id];
  const add = (sql: string, value: unknown) => {
    values.push(value);
    sets.push(`${sql} = $${values.length}`);
  };
  if (patch.displayName !== undefined) add('"displayName"', cleanName(patch.displayName));
  if (patch.transport !== undefined) add("transport", normalizeTransport(patch.transport));
  if (patch.enabled !== undefined) {
    add("enabled", patch.enabled);
  }
  if (patch.status !== undefined) {
    if (!VALID_STATUS.has(patch.status)) {
      throw new IntegrationValidationError("invalid status", "status");
    }
    add("status", patch.status);
  }
  if (patch.lastError !== undefined) add('"lastError"', patch.lastError);
  if (patch.config !== undefined) {
    const config = normalizeObject(patch.config, "config");
    validateCliCommandConfig(config, "config.command");
    add('"configJson"', JSON.stringify(config));
  }
  if (patch.toolManifest !== undefined) {
    add('"toolManifest"', JSON.stringify(validateToolManifest(patch.toolManifest)));
  }
  if (patch.scopes !== undefined) add("scopes", normalizeStringArray(patch.scopes));

  if (sets.length > 1) {
    await pool.query(
      `UPDATE agent_integrations SET ${sets.join(", ")} WHERE id = $1`,
      values,
    );
  }
  if (patch.credentials) {
    await replaceCredentials(id, patch.credentials);
  }
  const updated = await getAgentIntegration(id);
  if (!updated) throw new IntegrationNotFoundError(id);
  return updated;
}

async function resetSystemIntegration(
  integration: AgentIntegrationRow,
): Promise<AgentIntegrationRow> {
  const preset = getIntegrationPreset(integration.providerKey);
  const displayName = preset?.displayName ?? integration.displayName;
  const config = normalizeObject(preset?.defaultConfig ?? {}, "config");
  const toolManifest = validateToolManifest(preset?.defaultTools ?? []);
  const scopes = normalizeStringArray(preset?.scopes ?? []);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `
        UPDATE agent_integrations
        SET "displayName" = $2,
            transport = $3,
            enabled = false,
            status = 'not_configured',
            "lastError" = NULL,
            "configJson" = $4::jsonb,
            "toolManifest" = $5::jsonb,
            scopes = $6::text[],
            "lastHealthAt" = NULL,
            "lastUsedAt" = NULL,
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE id = $1
      `,
      [
        integration.id,
        displayName,
        preset?.recommendedTransport ?? integration.transport,
        JSON.stringify(config),
        JSON.stringify(toolManifest),
        scopes,
      ],
    );
    await deleteCredentials(integration.id, client);
    await deleteIntegrationSandbox(integration);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  const reset = await getAgentIntegration(integration.id);
  if (!reset) throw new IntegrationNotFoundError(integration.id);
  return reset;
}

export async function deleteAgentIntegration(
  id: string,
  opts?: { requireAgentId?: string },
): Promise<DeleteIntegrationResult> {
  const existing = await getAgentIntegration(id, { requireAgentId: opts?.requireAgentId });
  if (!existing) return { ok: false, action: "not_found" };
  if (isSystemIntegrationProvider(existing.providerKey)) {
    const integration = await resetSystemIntegration(existing);
    return { ok: true, action: "reset", integration };
  }
  const r = await pool.query("DELETE FROM agent_integrations WHERE id = $1", [id]);
  if ((r.rowCount ?? 0) > 0) {
    await deleteIntegrationSandbox(existing);
  }
  return { ok: (r.rowCount ?? 0) > 0, action: "deleted" };
}

export async function markIntegrationHealth(
  id: string,
  status: IntegrationStatus,
  lastError?: string | null,
): Promise<void> {
  if (!VALID_STATUS.has(status)) throw new IntegrationValidationError("invalid status", "status");
  await pool.query(
    `
      UPDATE agent_integrations
      SET status = $2,
          "lastError" = $3,
          "lastHealthAt" = CURRENT_TIMESTAMP,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = $1
    `,
    [id, status, lastError ?? null],
  );
}

export async function markIntegrationUsed(id: string): Promise<void> {
  await pool.query(
    `UPDATE agent_integrations SET "lastUsedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP WHERE id = $1`,
    [id],
  );
}

export async function loadCredentialValues(integrationId: string): Promise<Record<string, string>> {
  const { decryptSecret } = await import("./secretCrypto.js");
  const { rows } = await pool.query(
    `SELECT name, "encryptedValue" FROM agent_integration_credentials WHERE "integrationId" = $1`,
    [integrationId],
  );
  const out: Record<string, string> = {};
  for (const row of rows) {
    out[row.name] = decryptSecret(row.encryptedValue);
  }
  return out;
}

async function replaceCredentials(
  integrationId: string,
  credentials: Record<string, string>,
  executor: QueryExecutor = pool,
): Promise<void> {
  for (const [rawName, rawValue] of Object.entries(credentials)) {
    const name = cleanRequired(rawName, "credentials.name");
    if (typeof rawValue !== "string" || rawValue.length === 0) continue;
    const id = await generateId("integrationCredential", async (candidate) => {
      const r = await executor.query("SELECT 1 FROM agent_integration_credentials WHERE id = $1", [candidate]);
      return (r.rowCount ?? 0) > 0;
    });
    await executor.query(
      `
        INSERT INTO agent_integration_credentials
          (id, "integrationId", name, "encryptedValue", "valuePreview", "createdAt", "updatedAt")
        VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT ("integrationId", name)
        DO UPDATE SET
          "encryptedValue" = EXCLUDED."encryptedValue",
          "valuePreview" = EXCLUDED."valuePreview",
          "updatedAt" = CURRENT_TIMESTAMP
      `,
      [id, integrationId, name, encryptSecret(rawValue), previewSecret(rawValue)],
    );
  }
}

async function deleteCredentials(
  integrationId: string,
  executor: QueryExecutor = pool,
): Promise<void> {
  await executor.query(
    `DELETE FROM agent_integration_credentials WHERE "integrationId" = $1`,
    [integrationId],
  );
}

async function deleteIntegrationSandbox(integration: AgentIntegrationRow): Promise<void> {
  const root = process.env.INTEGRATION_SANDBOX_ROOT ||
    path.join(os.homedir(), ".imagebase", "integration-sandboxes");
  const sandboxRoot = path.join(
    root,
    safeSandboxSegment(integration.providerKey),
    safeSandboxSegment(integration.agentId),
    safeSandboxSegment(integration.id),
  );
  await fsp.rm(sandboxRoot, { recursive: true, force: true });
}

function safeSandboxSegment(value: string): string {
  const out = value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  return out || "unknown";
}

function rowToIntegration(row: any): AgentIntegrationRow {
  const transport = row.transport as IntegrationTransport;
  const providerKey = row.providerKey;
  const rawToolManifest = Array.isArray(row.toolManifest) ? row.toolManifest : [];
  return {
    id: row.id,
    agentId: row.agentId,
    providerKey,
    displayName: row.displayName,
    transport,
    enabled: row.enabled,
    status: row.status,
    lastError: row.lastError ?? null,
    config: row.configJson ?? {},
    toolManifest: effectiveToolManifest(providerKey, transport, rawToolManifest),
    scopes: Array.isArray(row.scopes) ? row.scopes : [],
    lastHealthAt: row.lastHealthAt ?? null,
    lastUsedAt: row.lastUsedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    credentials: Array.isArray(row.credentials) ? row.credentials : [],
  };
}

function effectiveToolManifest(
  providerKey: string,
  transport: IntegrationTransport,
  rawToolManifest: IntegrationToolManifest[],
): IntegrationToolManifest[] {
  const byName = new Map<string, IntegrationToolManifest>();
  for (const tool of rawToolManifest) {
    if (isToolCompatibleWithTransport(tool, transport)) {
      byName.set(tool.name, tool);
    }
  }

  const preset = getIntegrationPreset(providerKey);
  for (const tool of preset?.defaultTools ?? []) {
    if (isToolCompatibleWithTransport(tool, transport) && !byName.has(tool.name)) {
      byName.set(tool.name, tool);
    }
  }

  return Array.from(byName.values());
}

function isToolCompatibleWithTransport(
  tool: IntegrationToolManifest,
  transport: IntegrationTransport,
): boolean {
  if (!tool || typeof tool.name !== "string") return false;
  if (transport === "cli") return tool.mode === "cli";
  return tool.mode === "mcp";
}

function cleanRequired(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new IntegrationValidationError(`${field} is required`, field);
  }
  return value.trim();
}

function cleanName(value: unknown): string {
  const name = cleanRequired(value, "displayName");
  if (name.length > 80) {
    throw new IntegrationValidationError("displayName must be <= 80 chars", "displayName");
  }
  return name;
}

function normalizeTransport(value: unknown): IntegrationTransport {
  if (!VALID_TRANSPORTS.has(value as IntegrationTransport)) {
    throw new IntegrationValidationError("transport must be mcp-stdio | mcp-http | cli", "transport");
  }
  return value as IntegrationTransport;
}

function normalizeObject(value: unknown, field: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new IntegrationValidationError(`${field} must be an object`, field);
  }
  return value as Record<string, any>;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && Boolean(v.trim())).map((v) => v.trim());
}

export function validateToolManifest(raw: unknown): IntegrationToolManifest[] {
  if (!Array.isArray(raw)) {
    throw new IntegrationValidationError("toolManifest must be an array", "toolManifest");
  }
  if (raw.length > 50) {
    throw new IntegrationValidationError("toolManifest supports at most 50 tools", "toolManifest");
  }
  return raw.map((item, idx) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new IntegrationValidationError(`toolManifest[${idx}] must be an object`, "toolManifest");
    }
    const t = item as Record<string, any>;
    const name = cleanRequired(t.name, `toolManifest[${idx}].name`);
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(name)) {
      throw new IntegrationValidationError(
        `toolManifest[${idx}].name must be 1-80 chars of letters, numbers, _ or -`,
        "toolManifest",
      );
    }
    const mode = t.mode === "mcp" || t.mode === "cli" ? t.mode : null;
    if (!mode) {
      throw new IntegrationValidationError(`toolManifest[${idx}].mode must be mcp | cli`, "toolManifest");
    }
    const command = typeof t.command === "string" && t.command.trim() ? t.command.trim() : undefined;
    if (command) validateCliCommandConfig({ command }, `toolManifest[${idx}].command`);
    return {
      name,
      description: typeof t.description === "string" && t.description.trim()
        ? t.description.trim().slice(0, 1000)
        : `Integration tool ${name}`,
      mode,
      remoteName: typeof t.remoteName === "string" ? t.remoteName.trim() : undefined,
      inputSchema: normalizeInputSchema(t.inputSchema),
      command,
      args: Array.isArray(t.args) ? t.args.map(String).slice(0, 100) : undefined,
      output: t.output === "json" ? "json" : "text",
      readOnly: t.readOnly !== false,
      danger: t.danger === true,
      timeoutMs: typeof t.timeoutMs === "number" && t.timeoutMs > 0
        ? Math.min(t.timeoutMs, 180_000)
        : undefined,
    };
  });
}

function validateCliCommandConfig(config: Record<string, any>, field: string): void {
  if (typeof config.command !== "string" || !config.command.trim()) return;
  if (/[;&|`$<>]/.test(config.command)) {
    throw new IntegrationValidationError(
      "CLI command must be a binary/path, not a shell expression",
      field,
    );
  }
}

function normalizeInputSchema(value: unknown): IntegrationToolManifest["inputSchema"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { type: "object", properties: {} };
  }
  const schema = value as any;
  if (schema.type !== "object" || !schema.properties || typeof schema.properties !== "object") {
    return { type: "object", properties: {} };
  }
  return {
    type: "object",
    properties: schema.properties,
    required: Array.isArray(schema.required) ? schema.required.map(String) : undefined,
  };
}
