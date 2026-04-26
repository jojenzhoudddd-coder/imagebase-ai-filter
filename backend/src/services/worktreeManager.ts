/**
 * Worktree manager (PR5 Agent Workflow).
 *
 * Provides safe git worktree operations for the concurrent-code workflow:
 * host agent dispatches multiple subagents to independent worktrees, each
 * writes/edits code in isolation, then host invokes a merge tool to bring
 * everything back to main.
 *
 * **Sandbox boundary**:
 *   - All worktrees live under `~/.imagebase/agent-worktrees/<userId>/<runId>/`
 *   - File path operations enforce `path.resolve(...).startsWith(SANDBOX)`
 *     before any read/write — subagents cannot escape the sandbox
 *   - Per-user max 10 active worktrees (cleanup cron purges 7-day-old)
 *   - All git commands are spawned via `execFile` with explicit argv (no shell)
 *
 * **V1 limitations**:
 *   - The "main repo" backing a worktree must be checked out separately by
 *     the user; this manager doesn't clone arbitrary URLs (security: clone
 *     URL = arbitrary attacker-controlled remote). User specifies repo by
 *     a configured `WORKTREE_REPO_PATH` env var pointing to a local repo
 *   - No npm install / build inside worktree — V1 only supports text-level
 *     code edits + git diff/merge
 */

import path from "path";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";

const execFileP = promisify(execFile);

// Root sandbox dir for all agent worktrees, partitioned by user.
const ROOT = process.env.WORKTREE_ROOT || path.join(os.homedir(), ".imagebase/agent-worktrees");
// Backing repo path (user must check it out manually for V1).
const BACKING_REPO = process.env.WORKTREE_REPO_PATH;

const MAX_WORKTREES_PER_USER = 10;

export interface WorktreeRecord {
  id: string;
  userId: string;
  runId: string;
  branch: string;
  path: string; // absolute
  createdAt: number;
  baseSha?: string;
}

// In-memory registry; persisted on disk in `<ROOT>/<userId>/registry.json`
const userRegistries = new Map<string, WorktreeRecord[]>();

async function ensureUserDir(userId: string): Promise<string> {
  const dir = path.join(ROOT, userId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function loadRegistry(userId: string): Promise<WorktreeRecord[]> {
  if (userRegistries.has(userId)) return userRegistries.get(userId)!;
  const dir = await ensureUserDir(userId);
  const file = path.join(dir, "registry.json");
  try {
    const raw = await fs.readFile(file, "utf8");
    const list = JSON.parse(raw) as WorktreeRecord[];
    userRegistries.set(userId, list);
    return list;
  } catch {
    userRegistries.set(userId, []);
    return [];
  }
}

async function saveRegistry(userId: string): Promise<void> {
  const list = userRegistries.get(userId) ?? [];
  const dir = await ensureUserDir(userId);
  const file = path.join(dir, "registry.json");
  await fs.writeFile(file, JSON.stringify(list, null, 2), "utf8");
}

function isInsideSandbox(p: string, userId: string): boolean {
  const userRoot = path.resolve(ROOT, userId);
  const target = path.resolve(p);
  return target === userRoot || target.startsWith(userRoot + path.sep);
}

async function gitInRepo(repoPath: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileP("git", ["-C", repoPath, ...args], { maxBuffer: 10 * 1024 * 1024 });
}

export async function createWorktree(opts: {
  userId: string;
  runId: string;
  branchSuffix: string;
}): Promise<WorktreeRecord> {
  if (!BACKING_REPO) {
    throw new Error(
      "WORKTREE_REPO_PATH env var not set; concurrent-code workflow requires a configured backing repo on disk",
    );
  }
  // 校验 BACKING_REPO 是 git repo
  try {
    await gitInRepo(BACKING_REPO, ["rev-parse", "--git-dir"]);
  } catch {
    throw new Error(`WORKTREE_REPO_PATH (${BACKING_REPO}) is not a valid git repository`);
  }
  const list = await loadRegistry(opts.userId);
  if (list.length >= MAX_WORKTREES_PER_USER) {
    throw new Error(`per-user worktree limit ${MAX_WORKTREES_PER_USER} exceeded`);
  }

  const id = `wt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const branch = `agent/${opts.runId}/${opts.branchSuffix.replace(/[^a-z0-9_-]/gi, "_")}`;
  const wtPath = path.join(ROOT, opts.userId, id);
  if (!isInsideSandbox(wtPath, opts.userId)) {
    throw new Error("worktree path escapes sandbox");
  }

  // git worktree add -b <branch> <wtPath> HEAD
  await gitInRepo(BACKING_REPO, ["worktree", "add", "-b", branch, wtPath, "HEAD"]);

  let baseSha: string | undefined;
  try {
    const r = await gitInRepo(wtPath, ["rev-parse", "HEAD"]);
    baseSha = r.stdout.trim();
  } catch {}

  const rec: WorktreeRecord = {
    id,
    userId: opts.userId,
    runId: opts.runId,
    branch,
    path: wtPath,
    createdAt: Date.now(),
    baseSha,
  };
  list.push(rec);
  await saveRegistry(opts.userId);
  return rec;
}

export async function listWorktrees(userId: string): Promise<WorktreeRecord[]> {
  return loadRegistry(userId);
}

export async function getWorktree(userId: string, id: string): Promise<WorktreeRecord | null> {
  const list = await loadRegistry(userId);
  return list.find((w) => w.id === id) ?? null;
}

export async function readWorktreeFile(userId: string, worktreeId: string, relPath: string): Promise<string> {
  const wt = await getWorktree(userId, worktreeId);
  if (!wt) throw new Error(`worktree ${worktreeId} not found`);
  const abs = path.resolve(wt.path, relPath);
  if (!isInsideSandbox(abs, userId)) throw new Error("path escapes sandbox");
  return fs.readFile(abs, "utf8");
}

export async function writeWorktreeFile(
  userId: string,
  worktreeId: string,
  relPath: string,
  content: string,
): Promise<void> {
  const wt = await getWorktree(userId, worktreeId);
  if (!wt) throw new Error(`worktree ${worktreeId} not found`);
  const abs = path.resolve(wt.path, relPath);
  if (!isInsideSandbox(abs, userId)) throw new Error("path escapes sandbox");
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

export async function gitDiffWorktree(userId: string, worktreeId: string): Promise<string> {
  const wt = await getWorktree(userId, worktreeId);
  if (!wt) throw new Error(`worktree ${worktreeId} not found`);
  // 包含 unstaged + staged + untracked。
  await gitInRepo(wt.path, ["add", "-N", "."]); // intent-to-add 让 untracked 出现在 diff
  const r = await gitInRepo(wt.path, ["diff", "HEAD"]);
  return r.stdout;
}

export async function gitStatusWorktree(userId: string, worktreeId: string): Promise<string> {
  const wt = await getWorktree(userId, worktreeId);
  if (!wt) throw new Error(`worktree ${worktreeId} not found`);
  const r = await gitInRepo(wt.path, ["status", "--short"]);
  return r.stdout;
}

export interface MergeResult {
  success: boolean;
  conflicts?: Array<{ file: string; preview: string }>;
  mergedSha?: string;
  log: string;
}

/**
 * Commit + merge worktree's branch into main repo's HEAD branch.
 * V1 strategy: octopus-style merge if multiple worktrees, but here we
 * just merge ONE worktree at a time. Caller is expected to call this
 * sequentially for each worktree.
 *
 * Conflict policy:`halt-and-report` — abort merge, return structured
 * conflict list for the host to decide (auto-resolve via LLM tool / ask user).
 */
export async function commitAndMergeWorktree(
  userId: string,
  worktreeId: string,
  commitMessage: string,
): Promise<MergeResult> {
  if (!BACKING_REPO) throw new Error("WORKTREE_REPO_PATH not set");
  const wt = await getWorktree(userId, worktreeId);
  if (!wt) throw new Error(`worktree ${worktreeId} not found`);
  const log: string[] = [];

  // Stage everything + commit
  await gitInRepo(wt.path, ["add", "-A"]);
  try {
    const r = await gitInRepo(wt.path, ["commit", "-m", commitMessage]);
    log.push(r.stdout || "(committed)");
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (/nothing to commit/i.test(errMsg)) {
      log.push("(no changes)");
    } else {
      throw err;
    }
  }

  // Merge worktree's branch into BACKING_REPO's current branch
  try {
    const r = await gitInRepo(BACKING_REPO, ["merge", "--no-ff", "--no-edit", wt.branch]);
    log.push(r.stdout);
  } catch (err) {
    // Look for conflicts via `git diff --name-only --diff-filter=U`
    let conflicts: Array<{ file: string; preview: string }> = [];
    try {
      const cf = await gitInRepo(BACKING_REPO, ["diff", "--name-only", "--diff-filter=U"]);
      const files = cf.stdout.split("\n").filter(Boolean);
      conflicts = await Promise.all(
        files.map(async (f) => {
          try {
            const fullPath = path.resolve(BACKING_REPO, f);
            const content = await fs.readFile(fullPath, "utf8");
            const preview = content
              .split("\n")
              .slice(0, 30)
              .join("\n");
            return { file: f, preview };
          } catch {
            return { file: f, preview: "(read failed)" };
          }
        }),
      );
    } catch {}
    if (conflicts.length > 0) {
      // Abort the merge so the repo stays clean
      try {
        await gitInRepo(BACKING_REPO, ["merge", "--abort"]);
        log.push("merge aborted due to conflicts");
      } catch {}
      return { success: false, conflicts, log: log.join("\n") };
    }
    throw err;
  }

  // Success — capture merged sha
  let mergedSha: string | undefined;
  try {
    const r = await gitInRepo(BACKING_REPO, ["rev-parse", "HEAD"]);
    mergedSha = r.stdout.trim();
  } catch {}

  return { success: true, mergedSha, log: log.join("\n") };
}

export async function cleanupWorktree(userId: string, worktreeId: string): Promise<void> {
  if (!BACKING_REPO) throw new Error("WORKTREE_REPO_PATH not set");
  const list = await loadRegistry(userId);
  const idx = list.findIndex((w) => w.id === worktreeId);
  if (idx < 0) return;
  const wt = list[idx];
  // git worktree remove --force <path>
  try {
    await gitInRepo(BACKING_REPO, ["worktree", "remove", "--force", wt.path]);
  } catch {}
  // Delete branch (force in case some commits never made it)
  try {
    await gitInRepo(BACKING_REPO, ["branch", "-D", wt.branch]);
  } catch {}
  // Just in case dir still exists
  try {
    await fs.rm(wt.path, { recursive: true, force: true });
  } catch {}
  list.splice(idx, 1);
  userRegistries.set(userId, list);
  await saveRegistry(userId);
}
