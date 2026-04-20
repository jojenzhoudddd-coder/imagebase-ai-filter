import { metaTools } from "../../mcp-server/src/tools/metaTools.js";
import { readSoul, readProfile, ensureAgentFiles } from "../services/agentService.js";

async function main() {
  await ensureAgentFiles("agent_test");
  const byName = Object.fromEntries(metaTools.map((t) => [t.name, t]));

  const r1 = await byName["update_profile"].handler(
    { content: "# 用户画像\n\n- 语言: 中文\n- 时区: GMT+8\n" },
    { agentId: "agent_test" }
  );
  console.log("update_profile:", r1);

  const r2 = await byName["update_soul"].handler(
    { content: "# 我是谁\n\n我叫 Claw，偏好简洁直接。\n" },
    { agentId: "agent_test" }
  );
  console.log("update_soul:", r2);

  const r3 = await byName["create_memory"].handler(
    { title: "CRM 启动", body: "今天开始搭 CRM 系统。", tags: ["crm", "milestone"] },
    { agentId: "agent_test" }
  );
  console.log("create_memory:", r3);

  console.log("--- profile.md after write ---");
  console.log(await readProfile("agent_test"));
  console.log("--- soul.md after write ---");
  console.log(await readSoul("agent_test"));

  const r4 = await byName["update_profile"].handler({ content: "   " }, { agentId: "agent_test" });
  console.log("empty content rejection:", r4);

  const r5 = await byName["create_memory"].handler(
    { title: "Fallback test", body: "no agentId" }
  );
  console.log("no-ctx fallback (defaults to agent_default):", r5);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
