/**
 * PR4-prep test driver — exercises BlobStorage interface + LocalFsStorage.
 *
 * Run:
 *   cd backend && npx tsx scripts/blobstore-prep-test.ts
 *
 * Tests use ephemeral temp directories (mkdtemp). Never touches ~/.imagebase.
 *
 * Pattern follows skill-pr{1,2,3}-test.ts: assert() helper + per-case
 * try/catch + final summary. Each test is wrapped in a function so we can
 * iterate the catalog cleanly.
 */
import * as dotenv from "dotenv";
dotenv.config();

import { promises as fs, existsSync } from "fs";
import * as os from "os";
import * as path from "path";

// Dynamic import after dotenv so env propagates correctly.
const storage = await import("../src/services/storage/index.js");
const { getBlobStorage, _resetBlobStorageForTest, LocalFsStorage } = storage;

interface TestResult {
  id: string;
  status: "PASS" | "FAIL";
  error?: string;
}
const results: TestResult[] = [];

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function assertThrows(fn: () => Promise<unknown> | unknown, msg: string): Promise<void> {
  return Promise.resolve()
    .then(() => fn())
    .then(
      () => {
        throw new Error(`expected throw but didn't: ${msg}`);
      },
      () => {
        /* OK — expected throw */
      },
    );
}

async function withFreshStorage(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bs-test-"));
  process.env.IMAGEBASE_HOME = root;
  delete process.env.BLOB_STORAGE_BACKEND;
  _resetBlobStorageForTest();
  return {
    root,
    cleanup: async () => {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

async function run(id: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ id, status: "PASS" });
  } catch (err) {
    results.push({
      id,
      status: "FAIL",
      error: err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err),
    });
  }
}

// ─── P0: Core interface ───────────────────────────────────────────────

await run("BS-01", async () => {
  const { root, cleanup } = await withFreshStorage();
  try {
    const s = getBlobStorage();
    assert(s instanceof LocalFsStorage, "expected LocalFsStorage");
    await s.write("hello.txt", "world");
    const onDisk = path.join(root, "hello.txt");
    assert(existsSync(onDisk), `file should exist at ${onDisk}`);
    assert((await fs.readFile(onDisk, "utf-8")) === "world", "content mismatch");
  } finally {
    await cleanup();
  }
});

await run("BS-02", async () => {
  const { cleanup } = await withFreshStorage();
  try {
    process.env.BLOB_STORAGE_BACKEND = "local";
    _resetBlobStorageForTest();
    const s = getBlobStorage();
    assert(s instanceof LocalFsStorage, "expected LocalFsStorage with explicit local");
  } finally {
    delete process.env.BLOB_STORAGE_BACKEND;
    await cleanup();
  }
});

await run("BS-03", async () => {
  const { cleanup } = await withFreshStorage();
  try {
    process.env.BLOB_STORAGE_BACKEND = "s3";
    _resetBlobStorageForTest();
    let threw = false;
    try {
      getBlobStorage();
    } catch (err) {
      threw = true;
      const msg = err instanceof Error ? err.message : String(err);
      assert(/not implemented|launch/i.test(msg), `unhelpful s3 error: ${msg}`);
    }
    assert(threw, "expected throw for backend=s3");
  } finally {
    delete process.env.BLOB_STORAGE_BACKEND;
    _resetBlobStorageForTest();
    await cleanup();
  }
});

await run("BS-04", async () => {
  const { cleanup } = await withFreshStorage();
  try {
    process.env.BLOB_STORAGE_BACKEND = "foo";
    _resetBlobStorageForTest();
    let threw = false;
    try {
      getBlobStorage();
    } catch (err) {
      threw = true;
      const msg = err instanceof Error ? err.message : String(err);
      assert(/unknown/i.test(msg), `unhelpful unknown-backend error: ${msg}`);
    }
    assert(threw, "expected throw for backend=foo");
  } finally {
    delete process.env.BLOB_STORAGE_BACKEND;
    _resetBlobStorageForTest();
    await cleanup();
  }
});

await run("BS-05", async () => {
  const { cleanup } = await withFreshStorage();
  try {
    const a = getBlobStorage();
    const b = getBlobStorage();
    assert(a === b, "singleton should return same instance");
  } finally {
    await cleanup();
  }
});

await run("BS-06", async () => {
  const { cleanup } = await withFreshStorage();
  try {
    const a = getBlobStorage();
    _resetBlobStorageForTest();
    const b = getBlobStorage();
    assert(a !== b, "after reset, should rebuild");
  } finally {
    await cleanup();
  }
});

await run("BS-07", async () => {
  let threw = false;
  try {
    new LocalFsStorage("relative/path");
  } catch (err) {
    threw = true;
    const msg = err instanceof Error ? err.message : String(err);
    assert(/absolute/i.test(msg), `unhelpful: ${msg}`);
  }
  assert(threw, "expected throw for relative root");
});

await run("BS-08", async () => {
  for (const bad of ["", null, undefined, 42]) {
    let threw = false;
    try {
      new LocalFsStorage(bad as unknown as string);
    } catch {
      threw = true;
    }
    assert(threw, `expected throw for root=${JSON.stringify(bad)}`);
  }
});

// ─── P0: read / write / exists / delete ──────────────────────────────

await run("BS-10", async () => {
  const { cleanup } = await withFreshStorage();
  try {
    const s = getBlobStorage();
    await s.write("k.txt", "abc");
    assert((await s.read("k.txt")) === "abc", "roundtrip mismatch");
  } finally {
    await cleanup();
  }
});

await run("BS-11", async () => {
  const { root, cleanup } = await withFreshStorage();
  try {
    const s = getBlobStorage();
    await s.write("a/b/c.txt", "hi");
    assert(existsSync(path.join(root, "a/b/c.txt")), "intermediate dirs not created");
  } finally {
    await cleanup();
  }
});

await run("BS-12", async () => {
  const { cleanup } = await withFreshStorage();
  try {
    const s = getBlobStorage();
    const buf = Buffer.from([0xff, 0x00, 0x42]);
    await s.write("bin.dat", buf);
    const got = await s.readBuffer("bin.dat");
    assert(got.equals(buf), `binary roundtrip mismatch: got ${got.toString("hex")}`);
  } finally {
    await cleanup();
  }
});

await run("BS-13", async () => {
  const { cleanup } = await withFreshStorage();
  try {
    const s = getBlobStorage();
    await s.write("k.txt", "v1");
    await s.write("k.txt", "v2");
    assert((await s.read("k.txt")) === "v2", "overwrite failed");
  } finally {
    await cleanup();
  }
});

await run("BS-14", async () => {
  const { cleanup } = await withFreshStorage();
  try {
    const s = getBlobStorage();
    await assertThrows(() => s.read("nope.txt"), "read missing should throw");
  } finally {
    await cleanup();
  }
});

await run("BS-15", async () => {
  const { cleanup } = await withFreshStorage();
  try {
    const s = getBlobStorage();
    await assertThrows(() => s.readBuffer("nope.txt"), "readBuffer missing should throw");
  } finally {
    await cleanup();
  }
});

await run("BS-16", async () => {
  const { cleanup } = await withFreshStorage();
  try {
    const s = getBlobStorage();
    await s.write("a/b.txt", "x");
    assert((await s.exists("a/b.txt")) === true, "existing should be true");
    assert((await s.exists("nope.txt")) === false, "missing should be false");
    // Directory key — semantics doc'd as "filesystem does report exists"
    // (fs.access returns ok for directories). We don't gate on file vs dir.
    // Just verify it doesn't throw.
    await s.exists("a");
  } finally {
    await cleanup();
  }
});

await run("BS-17", async () => {
  const { cleanup } = await withFreshStorage();
  try {
    const s = getBlobStorage();
    await s.write("k.txt", "x");
    await s.delete("k.txt");
    assert((await s.exists("k.txt")) === false, "delete didn't remove");
  } finally {
    await cleanup();
  }
});

await run("BS-18", async () => {
  const { cleanup } = await withFreshStorage();
  try {
    const s = getBlobStorage();
    await s.delete("nope.txt"); // should NOT throw
  } finally {
    await cleanup();
  }
});

// ─── P0: list / deletePrefix ─────────────────────────────────────────

await run("BS-20", async () => {
  const { cleanup } = await withFreshStorage();
  try {
    const s = getBlobStorage();
    await s.write("a/b/c.txt", "1");
    await s.write("a/b/d.txt", "2");
    await s.write("a/e.txt", "3");
    const got = (await s.list("a")).sort();
    assert(
      JSON.stringify(got) === JSON.stringify(["a/b/c.txt", "a/b/d.txt", "a/e.txt"]),
      `list a expected 3 keys, got ${JSON.stringify(got)}`,
    );
  } finally {
    await cleanup();
  }
});

await run("BS-21", async () => {
  const { cleanup } = await withFreshStorage();
  try {
    const s = getBlobStorage();
    await s.write("a/b/c.txt", "1");
    await s.write("a/b/d.txt", "2");
    await s.write("a/e.txt", "3");
    const got = (await s.list("a/b")).sort();
    assert(
      JSON.stringify(got) === JSON.stringify(["a/b/c.txt", "a/b/d.txt"]),
      `list a/b expected 2 keys, got ${JSON.stringify(got)}`,
    );
  } finally {
    await cleanup();
  }
});

await run("BS-22", async () => {
  const { cleanup } = await withFreshStorage();
  try {
    const s = getBlobStorage();
    const got = await s.list("nope");
    assert(Array.isArray(got) && got.length === 0, "missing prefix should return []");
  } finally {
    await cleanup();
  }
});

await run("BS-23", async () => {
  const { cleanup } = await withFreshStorage();
  try {
    const s = getBlobStorage();
    await s.write("top.txt", "x");
    // Some impls reject "" — but "." should always work.
    const got = await s.list(".").catch(() => null);
    if (got === null) {
      // try empty string
      const got2 = await s.list("").catch(() => null);
      assert(got2 !== null, 'list("") or list(".") should not throw');
      assert(got2!.includes("top.txt"), `expected top.txt in ${JSON.stringify(got2)}`);
    } else {
      assert(got.includes("top.txt"), `expected top.txt in ${JSON.stringify(got)}`);
    }
  } finally {
    await cleanup();
  }
});

await run("BS-24", async () => {
  const { cleanup } = await withFreshStorage();
  try {
    const s = getBlobStorage();
    await s.write("a/b/c.txt", "1");
    await s.write("a/b/d.txt", "2");
    await s.write("a/e.txt", "3");
    await s.deletePrefix("a/b");
    const got = (await s.list("a")).sort();
    assert(
      JSON.stringify(got) === JSON.stringify(["a/e.txt"]),
      `expected only a/e.txt, got ${JSON.stringify(got)}`,
    );
  } finally {
    await cleanup();
  }
});

await run("BS-25", async () => {
  const { cleanup } = await withFreshStorage();
  try {
    const s = getBlobStorage();
    await s.deletePrefix("nope/missing"); // should NOT throw
  } finally {
    await cleanup();
  }
});

await run("BS-26", async () => {
  const { root, cleanup } = await withFreshStorage();
  try {
    const s = getBlobStorage();
    await s.write("a/b/c.txt", "1");
    await s.deletePrefix("a");
    assert(!existsSync(path.join(root, "a")), "directory should be gone");
  } finally {
    await cleanup();
  }
});

// ─── P0: streams ─────────────────────────────────────────────────────

await run("BS-30", async () => {
  const { cleanup } = await withFreshStorage();
  try {
    const s = getBlobStorage();
    const { stream, done } = await s.writeStream("big.bin");
    const chunk = Buffer.alloc(64 * 1024, 0xab);
    for (let i = 0; i < 16; i++) {
      const ok = stream.write(chunk);
      if (!ok) await new Promise((r) => stream.once("drain", r));
    }
    stream.end();
    await done;
    const got = await s.readBuffer("big.bin");
    assert(got.length === 1024 * 1024, `size mismatch: got ${got.length}`);
  } finally {
    await cleanup();
  }
});

await run("BS-31", async () => {
  const { cleanup } = await withFreshStorage();
  try {
    const s = getBlobStorage();
    await s.write("plain.txt", "hello world");
    const rs = await s.readStream("plain.txt");
    let acc = "";
    for await (const chunk of rs as AsyncIterable<Buffer | string>) {
      acc += chunk.toString();
    }
    assert(acc === "hello world", `stream read mismatch: ${acc}`);
  } finally {
    await cleanup();
  }
});

await run("BS-32", async () => {
  const { cleanup } = await withFreshStorage();
  try {
    const s = getBlobStorage();
    await assertThrows(() => s.readStream("nope.txt"), "readStream missing should throw eagerly");
  } finally {
    await cleanup();
  }
});

await run("BS-33", async () => {
  const { root, cleanup } = await withFreshStorage();
  try {
    const s = getBlobStorage();
    const { stream, done } = await s.writeStream("nested/path/file.bin");
    stream.end(Buffer.from("x"));
    await done;
    assert(existsSync(path.join(root, "nested/path/file.bin")), "nested file not created");
  } finally {
    await cleanup();
  }
});

// ─── P0: move / copy / stat ──────────────────────────────────────────

await run("BS-40", async () => {
  const { cleanup } = await withFreshStorage();
  try {
    const s = getBlobStorage();
    await s.write("src.txt", "x");
    await s.move("src.txt", "dst.txt");
    assert((await s.read("dst.txt")) === "x", "move dst missing content");
    assert((await s.exists("src.txt")) === false, "src should be gone after move");
  } finally {
    await cleanup();
  }
});

await run("BS-41", async () => {
  const { cleanup } = await withFreshStorage();
  try {
    const s = getBlobStorage();
    await s.write("src.txt", "x");
    await s.move("src.txt", "deep/nested/dst.txt");
    assert((await s.read("deep/nested/dst.txt")) === "x", "move into nested failed");
  } finally {
    await cleanup();
  }
});

await run("BS-42", async () => {
  const { cleanup } = await withFreshStorage();
  try {
    const s = getBlobStorage();
    await s.write("src.txt", "x");
    await s.copy("src.txt", "dst.txt");
    assert((await s.read("src.txt")) === "x", "copy lost src");
    assert((await s.read("dst.txt")) === "x", "copy lost dst");
  } finally {
    await cleanup();
  }
});

await run("BS-43", async () => {
  const { cleanup } = await withFreshStorage();
  try {
    const s = getBlobStorage();
    await s.write("k.txt", "abcdef"); // 6 bytes
    const st = await s.stat("k.txt");
    assert(st !== null, "stat returned null for existing");
    assert(st!.size === 6, `size expected 6, got ${st!.size}`);
    assert(st!.lastModified instanceof Date, "lastModified not Date");
  } finally {
    await cleanup();
  }
});

await run("BS-44", async () => {
  const { cleanup } = await withFreshStorage();
  try {
    const s = getBlobStorage();
    const st = await s.stat("nope.txt");
    assert(st === null, "stat missing should be null");
  } finally {
    await cleanup();
  }
});

// ─── P0: path-traversal safety (CRITICAL) ────────────────────────────

const traversalKeys: { id: string; key: unknown }[] = [
  { id: "BS-50", key: "../escape.txt" },
  { id: "BS-51", key: "../etc/passwd" },
  { id: "BS-52", key: "/absolute/path" },
  { id: "BS-53", key: "a/../../escape.txt" },
  { id: "BS-54", key: "\\..\\escape.txt" },
  { id: "BS-55", key: "" },
  { id: "BS-56", key: null },
];
for (const { id, key } of traversalKeys) {
  await run(id, async () => {
    const { cleanup } = await withFreshStorage();
    try {
      const s = getBlobStorage();
      await assertThrows(
        () => s.write(key as string, "x"),
        `write should reject unsafe key ${JSON.stringify(key)}`,
      );
    } finally {
      await cleanup();
    }
  });
}

await run("BS-57", async () => {
  const { cleanup } = await withFreshStorage();
  try {
    const s = getBlobStorage();
    await s.write("./normal.txt", "x");
    assert((await s.read("normal.txt")) === "x", "./ should normalize and work");
  } finally {
    await cleanup();
  }
});

await run("BS-58", async () => {
  const { cleanup } = await withFreshStorage();
  try {
    const s = getBlobStorage();
    await assertThrows(
      () => s.delete("../etc/passwd"),
      "delete should reject unsafe key",
    );
  } finally {
    await cleanup();
  }
});

await run("BS-59", async () => {
  // After all the prior traversal attempts, scan parent of temp roots for leak.
  // Each test cleans up its own root, so a leak would manifest as a stray file
  // in os.tmpdir(). We just verify the OS tmpdir top level still has expected
  // structure (no "escape.txt" / etc.) — best-effort sanity check.
  const tmp = os.tmpdir();
  const entries = await fs.readdir(tmp).catch(() => [] as string[]);
  const suspicious = entries.filter((e) => /^escape|^etc$|^passwd$/.test(e));
  assert(
    suspicious.length === 0,
    `traversal leaked these into ${tmp}: ${JSON.stringify(suspicious)}`,
  );
});

// ─── P1: edge cases ──────────────────────────────────────────────────

await run("BS-70", async () => {
  const { cleanup } = await withFreshStorage();
  try {
    const s = getBlobStorage();
    await s.write("中文/路径/文件.txt", "你好");
    assert((await s.read("中文/路径/文件.txt")) === "你好", "unicode roundtrip failed");
  } finally {
    await cleanup();
  }
});

await run("BS-71", async () => {
  const { cleanup } = await withFreshStorage();
  try {
    const s = getBlobStorage();
    const segments = Array.from({ length: 20 }, (_, i) => `seg${i}`);
    const key = segments.join("/") + "/file.txt";
    await s.write(key, "deep");
    assert((await s.read(key)) === "deep", "deep path failed");
  } finally {
    await cleanup();
  }
});

await run("BS-72", async () => {
  const { cleanup } = await withFreshStorage();
  try {
    const s = getBlobStorage();
    await s.write("empty.txt", "");
    assert((await s.read("empty.txt")) === "", "empty content roundtrip failed");
  } finally {
    await cleanup();
  }
});

await run("BS-73", async () => {
  const { cleanup } = await withFreshStorage();
  try {
    const s = getBlobStorage();
    await Promise.all(
      Array.from({ length: 50 }, (_, i) => s.write(`concurrent/${i}.txt`, String(i))),
    );
    const got = await Promise.all(
      Array.from({ length: 50 }, (_, i) => s.read(`concurrent/${i}.txt`)),
    );
    for (let i = 0; i < 50; i++) {
      assert(got[i] === String(i), `concurrent[${i}] mismatch: ${got[i]}`);
    }
  } finally {
    await cleanup();
  }
});

await run("BS-74", async () => {
  const { cleanup } = await withFreshStorage();
  try {
    const s = getBlobStorage();
    await Promise.all([
      s.write("race.txt", "A"),
      s.write("race.txt", "B"),
      s.write("race.txt", "C"),
    ]);
    const final = await s.read("race.txt");
    assert(["A", "B", "C"].includes(final), `unexpected final: ${final}`);
  } finally {
    await cleanup();
  }
});

// ─── Summary ─────────────────────────────────────────────────────────

const passed = results.filter((r) => r.status === "PASS").length;
const failed = results.filter((r) => r.status === "FAIL").length;
console.log("\n=== PR4-prep RESULTS ===");
console.log(`Total: ${results.length}, PASS: ${passed}, FAIL: ${failed}\n`);
for (const r of results) {
  if (r.status === "FAIL") {
    console.log(`✗ ${r.id}: ${r.error}`);
  }
}
const passedIds = results.filter((r) => r.status === "PASS").map((r) => r.id).join(", ");
console.log(`\nPassed: ${passedIds}\n`);
process.exit(failed > 0 ? 1 : 0);
