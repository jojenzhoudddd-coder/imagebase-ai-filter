/**
 * PR4 test driver — Skill fs 化 (SKILL.md 双层 + workflows/ + 直接编辑生效)。
 *
 * Run: cd backend && npx tsx scripts/skill-pr4-test.ts
 *
 * Each test gets a fresh temp `IMAGEBASE_HOME` so we don't touch real fs.
 * DB still uses prod (cleanup at end via prefix match).
 */
import * as dotenv from "dotenv";
dotenv.config();

import { promises as fs, existsSync } from "fs";
import * as os from "os";
import * as path from "path";
import yaml from "js-yaml";

const TEST_PREFIX = "__test_pr4_";

interface TestResult {
  id: string;
  status: "PASS" | "FAIL";
  error?: string;
}
const results: TestResult[] = [];
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
async function run(id: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ id, status: "PASS" });
    console.log(`  [PASS] ${id}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ id, status: "FAIL", error: message });
    console.log(`  [FAIL] ${id} — ${message}`);
  }
}

// Per-test temp dir helper — fresh BlobStorage root.
async function withFreshFs<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pr4-"));
  const oldHome = process.env.IMAGEBASE_HOME;
  process.env.IMAGEBASE_HOME = root;
  delete process.env.BLOB_STORAGE_BACKEND;
  const storage = await import("../src/services/storage/index.js");
  storage._resetBlobStorageForTest();
  try {
    return await fn(root);
  } finally {
    process.env.IMAGEBASE_HOME = oldHome;
    storage._resetBlobStorageForTest();
    await fs.rm(root, { recursive: true, force: true });
  }
}

// Lazy import to ensure module sees per-test env via _resetBlobStorageForTest.
async function importStore() {
  return await import("../src/services/userSkill/userSkillStore.js");
}
async function importFs() {
  return await import("../src/services/userSkill/skillFs.js");
}

const validDoc = {
  rootNodeId: "n1",
  nodes: {
    n1: { id: "n1", kind: "trigger", source: "chat-message", next: "n2" },
    n2: { id: "n2", kind: "action", type: "mcp_tool", tool: "list_tables" },
  },
};

const OWNER = { ownerType: "agent" as const, ownerId: "agent_default" };

// ─── PR4-01: fs layout ─────────────────────────────────────────────────

await run("PR4-01-skill-md-exists", async () => {
  await withFreshFs(async (root) => {
    const store = await importStore();
    const r = await store.createUserSkill({
      ...OWNER,
      name: `${TEST_PREFIX}01`,
      description: "desc",
      triggers: ["k1"],
      promptFragment: "body content",
      workflowDocs: [validDoc],
    });
    try {
      const skillMdPath = path.join(root, r.dirPath, "SKILL.md");
      assert(existsSync(skillMdPath), `SKILL.md missing at ${skillMdPath}`);
      const wf0Path = path.join(root, r.dirPath, "workflows/0.json");
      assert(existsSync(wf0Path), `workflows/0.json missing at ${wf0Path}`);
    } finally {
      await store.deleteUserSkill(r.id);
    }
  });
});

await run("PR4-02-frontmatter-shape", async () => {
  await withFreshFs(async (root) => {
    const store = await importStore();
    const r = await store.createUserSkill({
      ...OWNER,
      name: `${TEST_PREFIX}02`,
      description: "desc here",
      triggers: ["t1", "t2"],
      promptFragment: "body",
      toolWhitelist: ["list_tables", "get_table"],
    });
    try {
      const md = await fs.readFile(path.join(root, r.dirPath, "SKILL.md"), "utf-8");
      const fmMatch = md.match(/^---\n([\s\S]*?)\n---\n/);
      assert(fmMatch, "frontmatter delimiters missing");
      const fm = yaml.load(fmMatch[1]) as Record<string, unknown>;
      assert(fm.id === r.id, `id mismatch: ${fm.id} vs ${r.id}`);
      assert(fm.name === `${TEST_PREFIX}02`, "name mismatch");
      assert(fm.description === "desc here", "description mismatch");
      assert(
        Array.isArray(fm.triggers) &&
          (fm.triggers as string[]).length === 2 &&
          (fm.triggers as string[])[0] === "t1",
        "triggers mismatch",
      );
      assert(
        Array.isArray(fm.allowed_tools) &&
          (fm.allowed_tools as string[]).includes("list_tables"),
        "allowed_tools mismatch",
      );
      assert(typeof fm.created_at === "string", "created_at missing");
    } finally {
      await store.deleteUserSkill(r.id);
    }
  });
});

await run("PR4-03-body-is-prompt", async () => {
  await withFreshFs(async (root) => {
    const store = await importStore();
    const r = await store.createUserSkill({
      ...OWNER,
      name: `${TEST_PREFIX}03`,
      triggers: ["t"],
      promptFragment: "## Section\n\nbody text\nwith newlines",
    });
    try {
      const md = await fs.readFile(path.join(root, r.dirPath, "SKILL.md"), "utf-8");
      // body is everything after second `---\n`
      const m = md.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
      assert(m, "body capture failed");
      const body = (m![1] ?? "").replace(/^\n+/, "").replace(/\n+$/, "");
      assert(
        body === "## Section\n\nbody text\nwith newlines",
        `body mismatch: ${JSON.stringify(body)}`,
      );
    } finally {
      await store.deleteUserSkill(r.id);
    }
  });
});

await run("PR4-04-workflow-files-numbered", async () => {
  await withFreshFs(async (root) => {
    const store = await importStore();
    const docs = [validDoc, validDoc, validDoc];
    const r = await store.createUserSkill({
      ...OWNER,
      name: `${TEST_PREFIX}04`,
      triggers: ["t"],
      workflowDocs: docs,
    });
    try {
      for (let i = 0; i < 3; i++) {
        const p = path.join(root, r.dirPath, `workflows/${i}.json`);
        assert(existsSync(p), `workflows/${i}.json missing`);
      }
    } finally {
      await store.deleteUserSkill(r.id);
    }
  });
});

// ─── PR4-10: round-trip ──────────────────────────────────────────────

await run("PR4-10-roundtrip-prompt", async () => {
  await withFreshFs(async () => {
    const store = await importStore();
    const r = await store.createUserSkill({
      ...OWNER,
      name: `${TEST_PREFIX}10`,
      triggers: ["t"],
      promptFragment: "the body",
    });
    try {
      const got = await store.getUserSkill(r.id);
      assert(got, "get returned null");
      assert(got!.promptFragment === "the body", `roundtrip pf: ${got!.promptFragment}`);
    } finally {
      await store.deleteUserSkill(r.id);
    }
  });
});

await run("PR4-11-roundtrip-workflows", async () => {
  await withFreshFs(async () => {
    const store = await importStore();
    const r = await store.createUserSkill({
      ...OWNER,
      name: `${TEST_PREFIX}11`,
      triggers: ["t"],
      workflowDocs: [validDoc, validDoc],
    });
    try {
      const got = await store.getUserSkill(r.id);
      assert(got, "get returned null");
      assert(got!.workflowDocs?.length === 2, `workflowDocs count: ${got!.workflowDocs?.length}`);
      assert(got!.workflowDocs![0].rootNodeId === "n1", "workflow rootNode mismatch");
    } finally {
      await store.deleteUserSkill(r.id);
    }
  });
});

await run("PR4-12-roundtrip-triggers-order", async () => {
  await withFreshFs(async () => {
    const store = await importStore();
    const r = await store.createUserSkill({
      ...OWNER,
      name: `${TEST_PREFIX}12`,
      triggers: ["zebra", "alpha", "midd"],
      promptFragment: "x",
    });
    try {
      const got = await store.getUserSkill(r.id);
      assert(
        JSON.stringify(got!.triggers) === JSON.stringify(["zebra", "alpha", "midd"]),
        `triggers order: ${JSON.stringify(got!.triggers)}`,
      );
    } finally {
      await store.deleteUserSkill(r.id);
    }
  });
});

await run("PR4-13-source-attribution", async () => {
  await withFreshFs(async () => {
    const store = await importStore();
    const r = await store.createUserSkill({
      ...OWNER,
      name: `${TEST_PREFIX}13`,
      triggers: ["t"],
      promptFragment: "x",
      sourceConversationId: "conv_abc",
      sourceWorkflowRunId: "wfr_xyz",
    });
    try {
      const got = await store.getUserSkill(r.id);
      assert(got!.sourceConversationId === "conv_abc", "sourceConv mismatch");
      assert(got!.sourceWorkflowRunId === "wfr_xyz", "sourceWfr mismatch");
    } finally {
      await store.deleteUserSkill(r.id);
    }
  });
});

// ─── PR4-20: update / delete fs effects ───────────────────────────────

await run("PR4-20-update-name-rewrites-fm", async () => {
  await withFreshFs(async (root) => {
    const store = await importStore();
    const r = await store.createUserSkill({
      ...OWNER,
      name: `${TEST_PREFIX}20a`,
      triggers: ["t"],
      promptFragment: "x",
    });
    try {
      await store.updateUserSkill(r.id, { name: `${TEST_PREFIX}20b` });
      const md = await fs.readFile(path.join(root, r.dirPath, "SKILL.md"), "utf-8");
      assert(md.includes(`name: ${TEST_PREFIX}20b`), "frontmatter name not updated");
      const got = await store.getUserSkill(r.id);
      assert(got!.name === `${TEST_PREFIX}20b`, "DB index name not updated");
    } finally {
      await store.deleteUserSkill(r.id);
    }
  });
});

await run("PR4-21-update-prompt-rewrites-body", async () => {
  await withFreshFs(async (root) => {
    const store = await importStore();
    const r = await store.createUserSkill({
      ...OWNER,
      name: `${TEST_PREFIX}21`,
      triggers: ["t"],
      promptFragment: "old body",
    });
    try {
      await store.updateUserSkill(r.id, { promptFragment: "new body content" });
      const md = await fs.readFile(path.join(root, r.dirPath, "SKILL.md"), "utf-8");
      assert(md.includes("new body content"), "body not updated");
      assert(!md.includes("old body"), "old body lingered");
    } finally {
      await store.deleteUserSkill(r.id);
    }
  });
});

await run("PR4-22-update-workflows-rewrites-files", async () => {
  await withFreshFs(async (root) => {
    const store = await importStore();
    const r = await store.createUserSkill({
      ...OWNER,
      name: `${TEST_PREFIX}22`,
      triggers: ["t"],
      workflowDocs: [validDoc, validDoc, validDoc],
    });
    try {
      // shrink to one
      await store.updateUserSkill(r.id, { workflowDocs: [validDoc] });
      assert(existsSync(path.join(root, r.dirPath, "workflows/0.json")), "workflows/0.json missing");
      assert(!existsSync(path.join(root, r.dirPath, "workflows/1.json")), "workflows/1.json should be gone");
      assert(!existsSync(path.join(root, r.dirPath, "workflows/2.json")), "workflows/2.json should be gone");
    } finally {
      await store.deleteUserSkill(r.id);
    }
  });
});

await run("PR4-23-delete-removes-dir", async () => {
  await withFreshFs(async (root) => {
    const store = await importStore();
    const r = await store.createUserSkill({
      ...OWNER,
      name: `${TEST_PREFIX}23`,
      triggers: ["t"],
      promptFragment: "x",
    });
    const dir = path.join(root, r.dirPath);
    assert(existsSync(dir), "dir should exist after create");
    await store.deleteUserSkill(r.id);
    assert(!existsSync(dir), "dir should be gone after delete");
  });
});

// ─── PR4-30: external editing (key fs-first feature) ─────────────────

await run("PR4-30-external-edit-frontmatter", async () => {
  await withFreshFs(async (root) => {
    const store = await importStore();
    const r = await store.createUserSkill({
      ...OWNER,
      name: `${TEST_PREFIX}30`,
      description: "old desc",
      triggers: ["old"],
      promptFragment: "x",
    });
    try {
      // External user edits SKILL.md directly
      const skillMdPath = path.join(root, r.dirPath, "SKILL.md");
      const cur = await fs.readFile(skillMdPath, "utf-8");
      const edited = cur
        .replace(/description: old desc/, "description: NEW DESC")
        .replace(/- old/, "- NEW_TRIGGER");
      await fs.writeFile(skillMdPath, edited, "utf-8");
      // Read via store — should see the new values from fs
      const got = await store.getUserSkill(r.id);
      assert(got!.description === "NEW DESC", `external desc not picked up: ${got!.description}`);
      assert(
        got!.triggers.includes("NEW_TRIGGER"),
        `external triggers not picked up: ${JSON.stringify(got!.triggers)}`,
      );
    } finally {
      await store.deleteUserSkill(r.id);
    }
  });
});

await run("PR4-31-external-edit-body", async () => {
  await withFreshFs(async (root) => {
    const store = await importStore();
    const r = await store.createUserSkill({
      ...OWNER,
      name: `${TEST_PREFIX}31`,
      triggers: ["t"],
      promptFragment: "old body",
    });
    try {
      const skillMdPath = path.join(root, r.dirPath, "SKILL.md");
      const cur = await fs.readFile(skillMdPath, "utf-8");
      const edited = cur.replace(/old body/, "EDITED EXTERNALLY");
      await fs.writeFile(skillMdPath, edited, "utf-8");
      const got = await store.getUserSkill(r.id);
      assert(
        got!.promptFragment === "EDITED EXTERNALLY",
        `external body not picked up: ${got!.promptFragment}`,
      );
    } finally {
      await store.deleteUserSkill(r.id);
    }
  });
});

// ─── PR4-40: dsl validator still runs ────────────────────────────────

await run("PR4-40-dangerous-dsl-rejected", async () => {
  await withFreshFs(async () => {
    const store = await importStore();
    let threw = false;
    try {
      await store.createUserSkill({
        ...OWNER,
        name: `${TEST_PREFIX}40`,
        triggers: ["t"],
        workflowDocs: [
          {
            rootNodeId: "n1",
            nodes: {
              n1: { id: "n1", kind: "trigger", source: "chat-message", next: "n2" },
              n2: { id: "n2", kind: "action", type: "mcp_tool", tool: 'eval("evil")' },
            },
          },
        ],
      });
    } catch (err) {
      threw = true;
      const m = err instanceof Error ? err.message : String(err);
      assert(/eval/i.test(m), `error didn't mention eval: ${m}`);
    }
    assert(threw, "dangerous DSL should be rejected");
  });
});

await run("PR4-41-rollback-on-fs-failure", async () => {
  // We can't easily simulate fs failure mid-write. Instead, verify that a
  // duplicate-name conflict (which is a synchronous DB error) doesn't leave
  // an orphan dir.
  await withFreshFs(async (root) => {
    const store = await importStore();
    const r1 = await store.createUserSkill({
      ...OWNER,
      name: `${TEST_PREFIX}41`,
      triggers: ["t"],
      promptFragment: "x",
    });
    try {
      let threw = false;
      try {
        await store.createUserSkill({
          ...OWNER,
          name: `${TEST_PREFIX}41`, // dup
          triggers: ["t"],
          promptFragment: "y",
        });
      } catch {
        threw = true;
      }
      assert(threw, "dup-name create should throw");
      // Only one dir exists for this owner
      const dir = path.join(root, "agents", OWNER.ownerId, "skills");
      const entries = existsSync(dir) ? await fs.readdir(dir) : [];
      assert(entries.length === 1, `expected 1 skill dir, got ${entries.length}`);
    } finally {
      await store.deleteUserSkill(r1.id);
    }
  });
});

// ─── PR4-50: skillFs unit tests ──────────────────────────────────────

await run("PR4-50-parse-roundtrip", async () => {
  const skillFs = await importFs();
  const fm = {
    id: "test_id",
    name: "test",
    description: "d",
    when_to_use: "d",
    triggers: ["a", "b"],
    created_at: "2026-04-29T00:00:00Z",
    updated_at: "2026-04-29T00:00:00Z",
  };
  const md = skillFs.serializeSkillMd(fm, "## hello\n\nworld");
  const parsed = skillFs.parseSkillMd(md);
  assert(parsed.frontmatter.id === fm.id, "fm round-trip failed");
  assert(parsed.body.trim() === "## hello\n\nworld", `body: ${JSON.stringify(parsed.body)}`);
});

await run("PR4-51-malformed-yaml-throws", async () => {
  const skillFs = await importFs();
  const bad = "---\nname: [unclosed\n---\nbody";
  let threw = false;
  try {
    skillFs.parseSkillMd(bad);
  } catch {
    threw = true;
  }
  assert(threw, "malformed yaml should throw");
});

await run("PR4-52-missing-frontmatter-throws", async () => {
  const skillFs = await importFs();
  const noFm = "## just a markdown body, no frontmatter";
  let threw = false;
  try {
    skillFs.parseSkillMd(noFm);
  } catch (err) {
    threw = true;
    const m = err instanceof Error ? err.message : String(err);
    assert(/frontmatter/i.test(m), `error should mention frontmatter: ${m}`);
  }
  assert(threw, "missing frontmatter should throw");
});

await run("PR4-53-skill-dir-path-format", async () => {
  const skillFs = await importFs();
  const p = skillFs.skillDirPath("agent_x", "id_y");
  assert(p === "agents/agent_x/skills/id_y/", `unexpected path: ${p}`);
});

await run("PR4-54-skill-dir-path-rejects-traversal", async () => {
  const skillFs = await importFs();
  for (const bad of [["../evil", "x"], ["x", "../evil"], ["a/b", "x"], ["x", "a/b"]]) {
    let threw = false;
    try {
      skillFs.skillDirPath(bad[0], bad[1]);
    } catch {
      threw = true;
    }
    assert(threw, `should reject ${JSON.stringify(bad)}`);
  }
});

// ─── PR4-60: list / pagination ────────────────────────────────────────

await run("PR4-60-list-returns-all", async () => {
  await withFreshFs(async () => {
    const store = await importStore();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await store.createUserSkill({
        ...OWNER,
        name: `${TEST_PREFIX}60_${i}`,
        triggers: ["t"],
        promptFragment: `body${i}`,
      });
      ids.push(r.id);
    }
    try {
      const list = await store.listUserSkills(OWNER);
      const seen = list.filter((r) => ids.includes(r.id));
      assert(seen.length === 3, `expected 3 in list, got ${seen.length}`);
      // Each row should have its own promptFragment
      const bodies = seen.map((r) => r.promptFragment).sort();
      assert(
        JSON.stringify(bodies) === JSON.stringify(["body0", "body1", "body2"]),
        `bodies: ${JSON.stringify(bodies)}`,
      );
    } finally {
      for (const id of ids) await store.deleteUserSkill(id);
    }
  });
});

// ─── Summary ─────────────────────────────────────────────────────────

const passed = results.filter((r) => r.status === "PASS").length;
const failed = results.filter((r) => r.status === "FAIL").length;
console.log("\n=== PR4 RESULTS ===");
console.log(`Total: ${results.length}, PASS: ${passed}, FAIL: ${failed}`);

// DB cleanup
const store = await import("../src/services/userSkill/userSkillStore.js");
const prisma = store._getPrismaForTest();
const stale = await prisma.userSkill.findMany({
  where: { name: { startsWith: TEST_PREFIX } },
});
for (const r of stale) {
  try {
    await store.deleteUserSkill(r.id);
  } catch {
    await prisma.userSkill.delete({ where: { id: r.id } }).catch(() => {});
  }
}
console.log(`[cleanup] removed ${stale.length} ${TEST_PREFIX}* rows`);

process.exit(failed > 0 ? 1 : 0);
