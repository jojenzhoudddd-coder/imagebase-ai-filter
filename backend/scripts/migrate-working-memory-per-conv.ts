/**
 * V3.0 PR2 一次性迁移脚本:把所有 agent 的老 working.jsonl 拆成 per-conv。
 *
 * 用法:
 *   npx tsx backend/scripts/migrate-working-memory-per-conv.ts --dry
 *   npx tsx backend/scripts/migrate-working-memory-per-conv.ts --apply
 *
 * dry 模式:只打印每个 agent 的影响 turn 数,不改文件
 * apply 模式:真的执行迁移(每个 agent 一次,幂等)
 *
 * 部署流程:
 *   1) prod 上跑 --dry 看影响数,确认 OK
 *   2) 跑 --apply,backup .bak 留 30 天
 *   3) 30 天后由 cleanup cron 删 .bak
 */

import fs from "fs/promises";
import path from "path";
import os from "os";
import { migrateLegacyWorkingMemory, readWorkingMemory } from "../src/services/agentService.js";

async function main() {
  const mode = process.argv.includes("--apply") ? "apply" : "dry";
  const root = process.env.AGENT_HOME || path.join(os.homedir(), ".imagebase", "agents");

  // List all agent directories
  const agentIds: string[] = [];
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) agentIds.push(e.name);
    }
  } catch (err: any) {
    if (err.code === "ENOENT") {
      console.log(`[migrate] AGENT_HOME ${root} 不存在,无需迁移`);
      return;
    }
    throw err;
  }

  console.log(`[migrate] mode=${mode}  root=${root}  agents=${agentIds.length}`);

  let totalAgentsAffected = 0;
  let totalTurnsMigrated = 0;
  let skipped = 0;

  for (const agentId of agentIds) {
    if (mode === "dry") {
      // dry:读老文件,统计 turns + uniq convIds
      const flatPath = path.join(root, agentId, "memory", "working.jsonl");
      try {
        await fs.access(flatPath);
      } catch {
        skipped++;
        continue;
      }
      const entries = await readWorkingMemory(agentId);
      const convs = new Set(entries.map((e) => e.conversationId).filter(Boolean));
      console.log(
        `  [dry] ${agentId}: ${entries.length} turns across ${convs.size} convs (unknown: ${
          entries.filter((e) => !e.conversationId).length
        })`
      );
      if (entries.length > 0) {
        totalAgentsAffected++;
        totalTurnsMigrated += entries.length;
      }
    } else {
      const r = await migrateLegacyWorkingMemory(agentId);
      if (r.migrated) {
        if (r.movedTurns > 0) {
          totalAgentsAffected++;
          totalTurnsMigrated += r.movedTurns;
          console.log(`  [apply] ${agentId}: 迁移 ${r.movedTurns} turns`);
        } else {
          console.log(`  [apply] ${agentId}: 老文件为空,改名为 .bak`);
        }
      } else {
        skipped++;
      }
    }
  }

  console.log(
    `\n[migrate] 完成:agentsAffected=${totalAgentsAffected}  turnsMigrated=${totalTurnsMigrated}  skipped=${skipped}`
  );
  if (mode === "dry") {
    console.log(`\n再跑一次 --apply 来真正执行迁移`);
  }
}

main().catch((err) => {
  console.error("[migrate] 失败:", err);
  process.exit(1);
});
