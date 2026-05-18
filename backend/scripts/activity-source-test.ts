import assert from "node:assert/strict";
import { parseActivitySource } from "../src/services/conversationStore.js";
import { toSkillDefinition } from "../src/services/userSkill/userSkillRegistry.js";
import { integrationIdFromToolName } from "../src/services/integrations/integrationSkillRegistry.js";
import type { UserSkillRow } from "../src/services/userSkill/userSkillStore.js";

const parsed = parseActivitySource(
  "skill:table-skill,sk123456789012 habit:habit_system_evolve integration:ig123456789012",
);
assert.deepEqual(parsed.skills, ["table-skill", "sk123456789012"]);
assert.deepEqual(parsed.habits, ["habit_system_evolve"]);
assert.deepEqual(parsed.integrations, ["ig123456789012"]);

const duplicateParsed = parseActivitySource("skill:table-skill,table-skill integration:ig1,ig1");
assert.deepEqual(duplicateParsed.skills, ["table-skill"]);
assert.deepEqual(duplicateParsed.integrations, ["ig1"]);

const row: UserSkillRow = {
  id: "sk123456789012",
  ownerType: "agent",
  ownerId: "ag123456789012",
  name: "Daily report",
  description: "Summarize daily work",
  triggers: ["daily"],
  promptFragment: null,
  workflowDocs: null,
  toolWhitelist: null,
  sourceConversationId: null,
  sourceWorkflowRunId: null,
  enabled: true,
  invokedCount: 0,
  lastInvokedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  dirPath: "agents/ag123456789012/skills/sk123456789012/",
};
const skill = toSkillDefinition(row);
assert.deepEqual(skill.sourceRef, { type: "skill", id: "sk123456789012" });
assert.equal(skill.name, "Daily report");

assert.equal(
  integrationIdFromToolName("integration_ig123456789012_search_repos"),
  "ig123456789012",
);

console.log("activity-source tests passed");
process.exit(0);
