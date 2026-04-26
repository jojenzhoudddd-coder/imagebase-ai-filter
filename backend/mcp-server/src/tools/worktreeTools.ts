/**
 * Worktree MCP tools (PR5 Agent Workflow).
 *
 * Surface for code-parallel concurrent workflows: host creates N worktrees
 * (real git worktrees), spawns subagents per worktree to write code in
 * isolation, then merges back to main. Conflict-on-merge returns structured
 * file list + previews so host can decide auto-resolve via LLM or ask user.
 *
 * V1 limits:
 *   - Backing repo path must be set via WORKTREE_REPO_PATH env var
 *   - Per-user max 10 active worktrees
 *   - File reads/writes sandboxed under ~/.imagebase/agent-worktrees/<userId>/
 *   - No npm install / build inside worktree (text edits + git only)
 */

import type { ToolContext, ToolDefinition } from "./tableTools.js";
import {
  createWorktree,
  listWorktrees,
  readWorktreeFile,
  writeWorktreeFile,
  gitDiffWorktree,
  gitStatusWorktree,
  commitAndMergeWorktree,
  cleanupWorktree,
} from "../../../src/services/worktreeManager.js";

function userIdFromCtx(ctx?: ToolContext): string {
  // V1: agentId 作 user 维度 partition key (一个 user 一个 agent 当前)
  return ctx?.agentId || "anonymous";
}

export const worktreeTools: ToolDefinition[] = [
  {
    name: "create_worktree",
    description:
      "为并发代码任务创建一个 git worktree (真实隔离的 working dir + branch)。需要 host 先有一个 runId 把 N 个 worktree 关联起来。" +
      "用于 concurrent-code 模板:多 subagent 各自在不同 worktree 写代码,最后 host 合并。" +
      "需要 WORKTREE_REPO_PATH 环境变量指向一个有效 git 仓库。",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "本次并发任务的 run id (host 自己生成,关联多个 worktree)" },
        branchSuffix: { type: "string", description: "branch 后缀,会被 prefix 成 agent/<runId>/<suffix>" },
      },
      required: ["runId", "branchSuffix"],
    },
    danger: true,
    handler: async (args, ctx?: ToolContext): Promise<string> => {
      try {
        const rec = await createWorktree({
          userId: userIdFromCtx(ctx),
          runId: String(args.runId).trim(),
          branchSuffix: String(args.branchSuffix).trim() || "branch",
        });
        return JSON.stringify({ id: rec.id, branch: rec.branch, path: rec.path, baseSha: rec.baseSha });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  },
  {
    name: "list_worktrees",
    description: "列出当前用户所有 active worktree (含 path / branch / runId)。",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, ctx?: ToolContext): Promise<string> => {
      try {
        const list = await listWorktrees(userIdFromCtx(ctx));
        return JSON.stringify({ worktrees: list });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  },
  {
    name: "read_worktree_file",
    description: "读 worktree 内某个文件 (相对路径)。",
    inputSchema: {
      type: "object",
      properties: {
        worktreeId: { type: "string" },
        path: { type: "string", description: "相对 worktree 根的路径,如 'src/index.ts'" },
      },
      required: ["worktreeId", "path"],
    },
    handler: async (args, ctx?: ToolContext): Promise<string> => {
      try {
        const content = await readWorktreeFile(
          userIdFromCtx(ctx),
          String(args.worktreeId),
          String(args.path),
        );
        return JSON.stringify({ content });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  },
  {
    name: "write_worktree_file",
    description: "写文件到 worktree (sandbox 限制在该 worktree 路径内)。subagent 用这个修改代码。",
    inputSchema: {
      type: "object",
      properties: {
        worktreeId: { type: "string" },
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["worktreeId", "path", "content"],
    },
    handler: async (args, ctx?: ToolContext): Promise<string> => {
      try {
        await writeWorktreeFile(
          userIdFromCtx(ctx),
          String(args.worktreeId),
          String(args.path),
          String(args.content),
        );
        return JSON.stringify({ ok: true });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  },
  {
    name: "git_diff_worktree",
    description: "拿 worktree 当前 diff (含 untracked)。host 看完 diff 决定是否 merge。",
    inputSchema: { type: "object", properties: { worktreeId: { type: "string" } }, required: ["worktreeId"] },
    handler: async (args, ctx?: ToolContext): Promise<string> => {
      try {
        const diff = await gitDiffWorktree(userIdFromCtx(ctx), String(args.worktreeId));
        // 截断防 OOM
        return JSON.stringify({ diff: diff.length > 50000 ? diff.slice(0, 50000) + "\n…(truncated)" : diff });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  },
  {
    name: "git_status_worktree",
    description: "拿 worktree 文件状态 (短格式 short status)。",
    inputSchema: { type: "object", properties: { worktreeId: { type: "string" } }, required: ["worktreeId"] },
    handler: async (args, ctx?: ToolContext): Promise<string> => {
      try {
        const status = await gitStatusWorktree(userIdFromCtx(ctx), String(args.worktreeId));
        return JSON.stringify({ status });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  },
  {
    name: "merge_worktree_into_main",
    description:
      "提交 worktree 当前修改并 merge 到主仓库 HEAD branch。冲突时不强行解决,返回结构化的 conflicts 列表 (file + preview),host 决定是 LLM 自动解决还是询问用户。",
    inputSchema: {
      type: "object",
      properties: {
        worktreeId: { type: "string" },
        commitMessage: { type: "string", description: "默认 'agent: <branch> work'" },
      },
      required: ["worktreeId"],
    },
    danger: true,
    handler: async (args, ctx?: ToolContext): Promise<string> => {
      try {
        const result = await commitAndMergeWorktree(
          userIdFromCtx(ctx),
          String(args.worktreeId),
          String(args.commitMessage ?? "").trim() || "agent worktree merge",
        );
        return JSON.stringify(result);
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  },
  {
    name: "cleanup_worktree",
    description: "删除 worktree + 分支。merge 完成或放弃任务后调用。",
    inputSchema: { type: "object", properties: { worktreeId: { type: "string" } }, required: ["worktreeId"] },
    danger: true,
    handler: async (args, ctx?: ToolContext): Promise<string> => {
      try {
        await cleanupWorktree(userIdFromCtx(ctx), String(args.worktreeId));
        return JSON.stringify({ ok: true });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  },
  {
    // V2.6 B12 LLM auto-resolve conflicts.
    // Host 在 merge_worktree_into_main 失败拿到 conflicts[] 后调这个工具:
    // 内部 spawn_subagent 让 LLM 用 read/write_worktree_file 把每个冲突文件
    // 写成干净版本。完成后 host 决定 retry merge 还是 escalate 用户。
    name: "resolve_conflicts_with_llm",
    description:
      "用 LLM 自动解决 git merge 冲突。前置:刚 merge_worktree_into_main 返回 success=false + conflicts[]。" +
      "工具内部 spawn 一个 subagent (默认 claude-opus-4.7),只允许它调 read_worktree_file / write_worktree_file。" +
      "Subagent 读冲突文件 → 产出合并版本 → 写回(必须无 <<<<<<<<< 标记)。完成后 host 应再次 git_status_worktree 验证,然后重 commit/merge。" +
      "若 LLM 判断不了某个文件应当如何合并,会跳过并报告;host 应 escalate 用户。",
    inputSchema: {
      type: "object",
      properties: {
        worktreeId: { type: "string" },
        conflicts: {
          type: "array",
          items: { type: "string" },
          description: "冲突文件相对路径列表(merge 返回值的 conflicts 字段)",
        },
        model: { type: "string", description: "默认 claude-opus-4.7" },
      },
      required: ["worktreeId", "conflicts"],
    },
    handler: async (args, ctx?: ToolContext): Promise<string> => {
      if (!ctx?.spawnSubagent) {
        return JSON.stringify({ error: "spawn_subagent 不可用,无法用 LLM 解冲突" });
      }
      const conflicts = Array.isArray(args.conflicts) ? args.conflicts.map(String) : [];
      if (conflicts.length === 0) {
        return JSON.stringify({ error: "conflicts 为空" });
      }
      const model = String(args.model || "claude-opus-4.7");
      const userPrompt =
        `worktree ${String(args.worktreeId)} 有 git merge 冲突,需要你解决。\n\n` +
        `冲突文件:${conflicts.join(", ")}\n\n` +
        `严格流程,逐文件:\n` +
        `1. read_worktree_file({worktreeId, filePath}) 读出含冲突标记的内容\n` +
        `2. 分析两侧冲突 (HEAD vs branch),产出合理合并版本 (代码逻辑通顺、不丢双方修改、不引入破坏性 API 变更)\n` +
        `3. write_worktree_file({worktreeId, filePath, content}) 写回干净版本 (不再有 <<<<<<< / ======= / >>>>>>> 标记)\n\n` +
        `所有文件处理完后简短汇报。判断不了的文件跳过并指出原因。`;
      try {
        const r = await ctx.spawnSubagent({
          modelId: model,
          systemPrompt:
            "你是代码合并专家。**只用 read_worktree_file / write_worktree_file 这两个工具完成任务**。" +
            "写回时必须确保文件内不再有 git conflict 标记。完成后简短汇报。",
          userPrompt,
          allowedTools: ["read_worktree_file", "write_worktree_file"],
          maxRounds: Math.max(conflicts.length * 3, 6),
        });
        return JSON.stringify({
          subagentRunId: r.runId,
          success: r.success,
          summary: r.finalText,
          note: "host 接下来应 git_status_worktree 验证,通过后再 merge_worktree_into_main",
        });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  },
];
