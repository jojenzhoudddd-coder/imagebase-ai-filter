/**
 * Skill filesystem layer (V2).
 *
 * Each user skill lives at `agents/<ownerId>/skills/<id>/` under BlobStorage:
 *
 *   agents/<ownerId>/skills/<skillId>/
 *     SKILL.md                  # YAML frontmatter + Markdown body
 *     workflows/                # one file per WorkflowDoc, indexed by manifest in frontmatter
 *       0.json
 *       1.json
 *
 * `SKILL.md` shape:
 *
 *     ---
 *     id: cmoii785q00007ikdo79t0yuf
 *     name: tech-research
 *     description: 调研某个技术的最新进展并写入 idea
 *     when_to_use: 用户说"调研 X 技术"
 *     triggers: [调研, research, 了解最新]
 *     allowed_tools: [web_search, web_fetch, create_idea, append_to_idea]
 *     workflows:
 *       - file: workflows/0.json
 *         title: bilingual-review
 *     source:
 *       conversation_id: conv_xxx
 *       workflow_run_id: wfr_xxx
 *     created_at: 2026-04-28T12:34:56Z
 *     updated_at: 2026-04-28T12:34:56Z
 *     ---
 *
 *     ## 流程
 *
 *     用户说"调研 X 技术"时:
 *     ...
 *
 * The Markdown body IS the promptFragment (gets injected into system prompt
 * when the skill is active). Frontmatter is what we read for catalog rendering
 * + activation routing without paying the body cost.
 *
 * 详见 docs/roadmap-post-skill-v1.md PR4 + docs/skill-creator-plan.md。
 */

import yaml from "js-yaml";
import { getBlobStorage } from "../storage/index.js";
import type { WorkflowDoc } from "../workflow/types.js";
import {
  validateWorkflowDocs,
  WorkflowDocValidationError,
} from "./workflowDocValidator.js";

// ─── DTO ─────────────────────────────────────────────────────────────────

export interface SkillFrontmatter {
  id: string;
  name: string;
  description: string;
  /** Free-text "when should I activate". Surfaced in skill catalog. */
  when_to_use?: string;
  triggers: string[];
  allowed_tools?: string[];
  workflows?: { file: string; title?: string }[];
  source?: {
    conversation_id?: string | null;
    workflow_run_id?: string | null;
  };
  created_at: string; // ISO
  updated_at: string; // ISO
}

export interface SkillFsRecord {
  frontmatter: SkillFrontmatter;
  body: string; // Markdown body (= promptFragment)
  workflowDocs: WorkflowDoc[]; // resolved from workflows/*.json
}

export class SkillFsError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "SkillFsError";
  }
}

// ─── Path helpers ────────────────────────────────────────────────────────

/** Build the BlobStorage key prefix for a skill. Always ends with `/`. */
export function skillDirPath(ownerId: string, skillId: string): string {
  if (!ownerId || !skillId) {
    throw new SkillFsError("skillDirPath: ownerId + skillId required");
  }
  // Sanitise — these go into fs paths. Reject suspicious chars early.
  if (/[\/\\.]/.test(ownerId) || /[\/\\.]/.test(skillId)) {
    throw new SkillFsError(`skillDirPath: ownerId/skillId may not contain / \\ .`);
  }
  return `agents/${ownerId}/skills/${skillId}/`;
}

const SKILL_FILE = "SKILL.md";
const WORKFLOWS_DIR = "workflows";

// ─── Read ────────────────────────────────────────────────────────────────

/** Parse `SKILL.md` (frontmatter + body). Throws on malformed yaml. */
export function parseSkillMd(content: string): { frontmatter: SkillFrontmatter; body: string } {
  // Match leading frontmatter block delimited by `---` lines.
  // Tolerate optional UTF-8 BOM + leading whitespace.
  const stripped = content.replace(/^﻿/, "");
  const m = stripped.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) {
    throw new SkillFsError(
      "SKILL.md missing frontmatter. Expected leading ---/--- block.",
    );
  }
  let frontmatter: SkillFrontmatter;
  try {
    frontmatter = yaml.load(m[1]) as SkillFrontmatter;
  } catch (err) {
    throw new SkillFsError("SKILL.md frontmatter YAML parse failed", err);
  }
  if (!frontmatter || typeof frontmatter !== "object") {
    throw new SkillFsError("SKILL.md frontmatter must be a YAML mapping");
  }
  return { frontmatter, body: m[2] ?? "" };
}

/** Serialize frontmatter + body back to a SKILL.md string. */
export function serializeSkillMd(
  frontmatter: SkillFrontmatter,
  body: string,
): string {
  // js-yaml's dump uses double-quote on strings with special chars,
  // disable refs (anchors), and never line-wrap (so triggers on one line).
  const yamlBlock = yaml.dump(frontmatter, {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
    sortKeys: false,
  });
  // Ensure trailing newline on body so editors don't complain.
  const trimmed = body.replace(/\s+$/, "");
  return `---\n${yamlBlock}---\n\n${trimmed}\n`;
}

/** Read the full skill (SKILL.md + all workflow files). */
export async function readSkill(dirPath: string): Promise<SkillFsRecord> {
  const blob = getBlobStorage();
  const md = await blob.read(joinPath(dirPath, SKILL_FILE));
  const { frontmatter, body } = parseSkillMd(md);
  // Resolve workflows by manifest. Falls back to discovering files in the dir
  // if manifest missing — keeps users editing manually less surprised.
  let manifest = Array.isArray(frontmatter.workflows) ? frontmatter.workflows : [];
  if (manifest.length === 0) {
    // Discover everything under workflows/
    const found = await blob
      .list(joinPath(dirPath, WORKFLOWS_DIR))
      .catch(() => [] as string[]);
    manifest = found
      .filter((k) => k.endsWith(".json"))
      .map((k) => ({ file: k.slice(dirPath.length) }));
  }
  const workflowDocs: WorkflowDoc[] = [];
  for (const w of manifest) {
    if (!w?.file) continue;
    const raw = await blob.read(joinPath(dirPath, w.file)).catch((err) => {
      throw new SkillFsError(`workflow file missing: ${w.file}`, err);
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new SkillFsError(`workflow file ${w.file} JSON parse failed`, err);
    }
    workflowDocs.push(parsed as WorkflowDoc);
  }
  return { frontmatter, body, workflowDocs };
}

/** Read just the frontmatter — cheaper, used for list / catalog. */
export async function readSkillFrontmatter(dirPath: string): Promise<SkillFrontmatter> {
  const blob = getBlobStorage();
  const md = await blob.read(joinPath(dirPath, SKILL_FILE));
  const { frontmatter } = parseSkillMd(md);
  return frontmatter;
}

// ─── Write ───────────────────────────────────────────────────────────────

export interface SkillWriteInput {
  dirPath: string;
  frontmatter: SkillFrontmatter;
  body: string;
  /** Provide raw doc objects (validator runs before write). */
  workflowDocs?: unknown[];
}

/**
 * Write the entire skill (SKILL.md + all workflows). Idempotent — wipes
 * the whole skill directory first so a partial old state can never linger.
 *
 * Validates workflowDocs (safeEval against danger keywords) before writing.
 */
export async function writeSkill(input: SkillWriteInput): Promise<void> {
  const blob = getBlobStorage();
  // Validate workflowDocs FIRST so we don't write a malformed half-state.
  let validatedDocs: WorkflowDoc[] = [];
  if (input.workflowDocs && input.workflowDocs.length > 0) {
    try {
      validatedDocs = validateWorkflowDocs(input.workflowDocs);
    } catch (err) {
      if (err instanceof WorkflowDocValidationError) {
        throw new SkillFsError(`workflowDocs invalid: ${err.message}`, err);
      }
      throw err;
    }
  }
  // Build manifest with stable filenames matching the index in workflowDocs.
  const manifest = validatedDocs.map((d, i) => ({
    file: `${WORKFLOWS_DIR}/${i}.json`,
    title: d.templateId ?? `workflow-${i}`,
  }));
  const fm: SkillFrontmatter = { ...input.frontmatter };
  fm.workflows = manifest.length > 0 ? manifest : undefined;

  // Wipe + rewrite. With the BlobStorage abstraction this is cheap.
  await blob.deletePrefix(input.dirPath);
  await blob.write(joinPath(input.dirPath, SKILL_FILE), serializeSkillMd(fm, input.body));
  for (let i = 0; i < validatedDocs.length; i++) {
    await blob.write(
      joinPath(input.dirPath, `${WORKFLOWS_DIR}/${i}.json`),
      JSON.stringify(validatedDocs[i], null, 2),
    );
  }
}

/** Delete the entire skill directory. Idempotent. */
export async function deleteSkill(dirPath: string): Promise<void> {
  const blob = getBlobStorage();
  await blob.deletePrefix(dirPath);
}

/** Whether SKILL.md exists at dirPath. */
export async function skillExists(dirPath: string): Promise<boolean> {
  const blob = getBlobStorage();
  return blob.exists(joinPath(dirPath, SKILL_FILE));
}

// ─── Path utility ────────────────────────────────────────────────────────

/** POSIX-only join: avoid Windows backslash creeping into BlobStorage keys. */
function joinPath(dir: string, sub: string): string {
  const a = dir.endsWith("/") ? dir.slice(0, -1) : dir;
  const b = sub.startsWith("/") ? sub.slice(1) : sub;
  return a === "" ? b : `${a}/${b}`;
}
