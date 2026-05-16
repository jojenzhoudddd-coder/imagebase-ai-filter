-- Agent Integration Platform
--
-- Integrations are agent-owned capability bridges to external platforms.
-- A row describes one installed integration and its safe tool manifest.
-- Credentials are stored separately so API responses can return metadata
-- without ever serialising encrypted secret material.

CREATE TABLE "agent_integrations" (
  "id"             TEXT PRIMARY KEY,
  "agentId"        TEXT NOT NULL,
  "providerKey"    TEXT NOT NULL,
  "displayName"    TEXT NOT NULL,
  "transport"      TEXT NOT NULL,
  "enabled"        BOOLEAN NOT NULL DEFAULT true,
  "status"         TEXT NOT NULL DEFAULT 'not_configured',
  "lastError"      TEXT,
  "configJson"     JSONB NOT NULL DEFAULT '{}',
  "toolManifest"   JSONB NOT NULL DEFAULT '[]',
  "scopes"         TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "lastHealthAt"   TIMESTAMP(3),
  "lastUsedAt"     TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "agent_integrations_agentId_fkey"
    FOREIGN KEY ("agentId") REFERENCES "agents"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "agent_integrations_agentId_idx"
  ON "agent_integrations"("agentId");

CREATE INDEX "agent_integrations_agentId_enabled_idx"
  ON "agent_integrations"("agentId", "enabled");

CREATE INDEX "agent_integrations_providerKey_idx"
  ON "agent_integrations"("providerKey");

CREATE TABLE "agent_integration_credentials" (
  "id"              TEXT PRIMARY KEY,
  "integrationId"   TEXT NOT NULL,
  "name"            TEXT NOT NULL,
  "encryptedValue"  TEXT NOT NULL,
  "valuePreview"    TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "agent_integration_credentials_integrationId_fkey"
    FOREIGN KEY ("integrationId") REFERENCES "agent_integrations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "agent_integration_credentials_integrationId_name_key"
  ON "agent_integration_credentials"("integrationId", "name");

CREATE INDEX "agent_integration_credentials_integrationId_idx"
  ON "agent_integration_credentials"("integrationId");
