-- Preserve pre-workspace Acknowledge entries by assigning legacy/global
-- knowledge rows to the owner's first workspace. This keeps existing
-- acknowledge content visible without making it shared across all workspaces.

UPDATE knowledge_entries AS ke
SET "workspaceId" = primary_ws.id
FROM agents AS a
JOIN LATERAL (
  SELECT w.id
  FROM workspaces AS w
  WHERE w."createdById" = a."userId"
  ORDER BY w."createdAt" ASC, w.id ASC
  LIMIT 1
) AS primary_ws ON TRUE
WHERE ke."workspaceId" IS NULL
  AND ke."agentId" = a.id;
