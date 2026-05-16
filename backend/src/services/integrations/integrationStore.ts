import pg from "pg";
import { generateId } from "../idGenerator.js";
import { encryptSecret, previewSecret } from "./secretCrypto.js";
import { getIntegrationPreset, listSystemIntegrationPresets } from "./providerCatalog.js";
import type {
  AgentIntegrationRow,
  IntegrationStatus,
  IntegrationToolManifest,
  IntegrationTransport,
} from "./types.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
pg.types.setTypeParser(1114, (str: string) => new Date(str + "Z"));

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
  const existing = await listAgentIntegrations(agentId);
  const existingProviders = new Set(existing.map((integration) => integration.providerKey));
  for (const preset of listSystemIntegrationPresets()) {
    if (existingProviders.has(preset.key)) continue;
    await createAgentIntegration({
      agentId,
      providerKey: preset.key,
      transport: preset.recommendedTransport,
      enabled: false,
    });
  }
  await pool.query(
    `UPDATE agent_integrations SET status = 'not_configured' WHERE "agentId" = $1 AND status = 'disabled'`,
    [agentId],
  );
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
  const id = await generateId("integration", async (candidate) => {
    const r = await pool.query("SELECT 1 FROM agent_integrations WHERE id = $1", [candidate]);
    return (r.rowCount ?? 0) > 0;
  });

  await pool.query(
    `
      INSERT INTO agent_integrations
        (id, "agentId", "providerKey", "displayName", transport, enabled, status, "configJson", "toolManifest", scopes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::text[])
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
    await replaceCredentials(id, input.credentials);
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

export async function deleteAgentIntegration(
  id: string,
  opts?: { requireAgentId?: string },
): Promise<boolean> {
  const existing = await getAgentIntegration(id, { requireAgentId: opts?.requireAgentId });
  if (!existing) return false;
  const r = await pool.query("DELETE FROM agent_integrations WHERE id = $1", [id]);
  return (r.rowCount ?? 0) > 0;
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
): Promise<void> {
  for (const [rawName, rawValue] of Object.entries(credentials)) {
    const name = cleanRequired(rawName, "credentials.name");
    if (typeof rawValue !== "string" || rawValue.length === 0) continue;
    const id = await generateId("integrationCredential", async (candidate) => {
      const r = await pool.query("SELECT 1 FROM agent_integration_credentials WHERE id = $1", [candidate]);
      return (r.rowCount ?? 0) > 0;
    });
    await pool.query(
      `
        INSERT INTO agent_integration_credentials
          (id, "integrationId", name, "encryptedValue", "valuePreview")
        VALUES ($1, $2, $3, $4, $5)
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

function rowToIntegration(row: any): AgentIntegrationRow {
  return {
    id: row.id,
    agentId: row.agentId,
    providerKey: row.providerKey,
    displayName: row.displayName,
    transport: row.transport,
    enabled: row.enabled,
    status: row.status,
    lastError: row.lastError ?? null,
    config: row.configJson ?? {},
    toolManifest: Array.isArray(row.toolManifest) ? row.toolManifest : [],
    scopes: Array.isArray(row.scopes) ? row.scopes : [],
    lastHealthAt: row.lastHealthAt ?? null,
    lastUsedAt: row.lastUsedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    credentials: Array.isArray(row.credentials) ? row.credentials : [],
  };
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
