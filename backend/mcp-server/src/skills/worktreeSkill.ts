/**
 * Worktree skill (PR5 Agent Workflow).
 *
 * Tier 2 — opt-in. Activates on keywords like "并行写代码 / 多 worktree /
 * concurrent-code". Bundles the 8 worktree tools (create / list / read /
 * write / diff / status / merge / cleanup).
 *
 * V1 limits (mirrored in worktreeManager + tools):
 *   - WORKTREE_REPO_PATH env var must be set (a checked-out git repo)
 *   - Per-user max 10 active worktrees
 *   - File ops sandboxed to ~/.imagebase/agent-worktrees/<userId>/
 *   - No npm install / build inside worktree (text edits + git only)
 *
 * Recommended workflow (host's mental model):
 *   1. Plan task split → decide N branches
 *   2. for i in 1..N: create_worktree({runId, branchSuffix:`mod_${i}`})
 *   3. for i in 1..N (parallel via spawn_subagent): subagent edits files
 *      via write_worktree_file / read_worktree_file
 *   4. for i in 1..N: git_diff_worktree → review
 *   5. for i in 1..N: merge_worktree_into_main → on conflict, host's LLM
 *      decides (ask user / auto-resolve / abort)
 *   6. for i in 1..N: cleanup_worktree
 */

import type { SkillDefinition } from "./types.js";
import { worktreeTools } from "../tools/worktreeTools.js";

export const worktreeSkill: SkillDefinition = {
  name: "worktree-skill",
  displayName: "并发代码 worktree",
  description:
    "并行修改代码场景:host 创建多个 git worktree,派发 subagent 各自隔离写代码,最后统一 merge 回主分支。" +
    "适用于多模块独立开发 / 重构 / 大型 feature 拆分。",
  artifacts: [],
  when: "用户要求并发改代码 / 多模块并行开发 / 让 N 个 AI 同时实现 X",
  triggers: [
    /并行.*开发/,
    /多模块.*并行/,
    /worktree/i,
    /concurrent.?code/i,
    /并发.*代码/, // 并发 代码
    "并行实现",
    "拆分模块",
  ],
  softDeps: ["workflow-skill"],
  tools: worktreeTools,
  promptFragment: `# Worktree 调度规则 (concurrent-code)

## 何时使用
- 用户明确说"并行实现 N 个模块" / "多个 worktree 同时改" / 类似表达
- 任务可清晰拆分成互不冲突的子模块 (改不同文件 / 不同目录最优)

## 工作流程
1. 先估算拆分:N 不超过 4。每个 subagent 一个 worktree。
2. 用同一 \`runId\` (host 自己生成) 关联多个 worktree
3. \`create_worktree({runId, branchSuffix:"模块名"})\` 创建 N 个
4. 通过 \`spawn_subagent\` 让每个 subagent 在它的 worktree 内修改:
   - subagent system prompt 提供 worktreeId + sandbox 限制说明
   - subagent 用 \`read_worktree_file\` / \`write_worktree_file\` 改代码
5. 全部 subagent 完成后 \`git_diff_worktree\` 看每个 diff
6. 顺序 \`merge_worktree_into_main\` —— 第一次冲突时:
   - 把 conflicts.preview 给用户看,让用户决定
   - 或者再 \`spawn_subagent\` 调一个 reviewer 模型 propose 解决方案
7. 全部 merge 完后 \`cleanup_worktree\` 收尾

## 安全
- subagent 不可写 worktree 之外路径 (sandbox 自动拒绝)
- 默认不允许 subagent 直接调 \`merge_worktree_into_main\` (是 danger 工具) —— host 自己 merge
- 单 user 同时 worktree 数 ≤ 10`,
};
