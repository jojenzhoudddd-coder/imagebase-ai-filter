/**
 * Local filesystem implementation of BlobStorage.
 *
 * Maps every `key` to `<root>/<key>`. Default root is `~/.imagebase` (or
 * `IMAGEBASE_HOME` env). All writes use `fs.promises`; reads / writes
 * support buffer or stream forms.
 *
 * Path-traversal safety: every key is normalized via `path.posix.normalize`,
 * then rejected if it escapes the root via `..` or absolute paths. This is
 * critical because keys can come from user input (e.g. SKILL.md filenames).
 *
 * 详见 services/storage/types.ts 顶部说明。
 */

import { promises as fs, createReadStream, createWriteStream } from "fs";
import path from "path";
import type { BlobStat, BlobStorage } from "./types.js";

export class LocalFsStorage implements BlobStorage {
  constructor(private readonly root: string) {
    if (!root || typeof root !== "string") {
      throw new Error("LocalFsStorage: root must be a non-empty string");
    }
    if (!path.isAbsolute(root)) {
      throw new Error(`LocalFsStorage: root must be absolute, got "${root}"`);
    }
  }

  /** Resolve a user-supplied key into an absolute fs path under `root`,
   *  rejecting any traversal attempt. */
  private resolveSafe(key: string): string {
    if (typeof key !== "string" || key.length === 0) {
      throw new Error("BlobStorage: key must be a non-empty string");
    }
    if (key.startsWith("/") || key.startsWith("\\")) {
      throw new Error(`BlobStorage: absolute keys not allowed: "${key}"`);
    }
    // Normalize (handles `./` `//` `a/../b`) then check it didn't escape.
    const normalized = path.posix.normalize(key);
    if (normalized.startsWith("..") || normalized === "." || normalized === "") {
      throw new Error(`BlobStorage: unsafe key: "${key}"`);
    }
    // posix → native (Windows uses backslash) for the join.
    const native = normalized.split("/").join(path.sep);
    const resolved = path.resolve(this.root, native);
    // Defense in depth: ensure resolved path is still under root.
    const rootResolved = path.resolve(this.root);
    const rel = path.relative(rootResolved, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`BlobStorage: unsafe key escaped root: "${key}"`);
    }
    return resolved;
  }

  async read(key: string): Promise<string> {
    return await fs.readFile(this.resolveSafe(key), "utf-8");
  }

  async readBuffer(key: string): Promise<Buffer> {
    return await fs.readFile(this.resolveSafe(key));
  }

  async write(key: string, content: string | Buffer): Promise<void> {
    const target = this.resolveSafe(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (typeof content === "string") {
      await fs.writeFile(target, content, "utf-8");
    } else {
      await fs.writeFile(target, content);
    }
  }

  async list(prefix: string): Promise<string[]> {
    let target: string;
    try {
      target = this.resolveSafe(prefix);
    } catch {
      // Empty / "." prefix — list from root.
      if (prefix === "" || prefix === "." || prefix === "/") {
        target = path.resolve(this.root);
      } else {
        throw arguments.length > 0 ? new Error(`BlobStorage.list: invalid prefix "${prefix}"`) : new Error("BlobStorage.list: invalid prefix");
      }
    }
    const stat = await fs.stat(target).catch(() => null);
    if (!stat) return [];
    if (stat.isFile()) {
      // The prefix itself is a file — return a single key.
      return [this.toKey(target)];
    }
    if (!stat.isDirectory()) return [];
    const out: string[] = [];
    await this.walk(target, out);
    return out;
  }

  /** Recursively walk a directory, pushing every file's key into `out`. */
  private async walk(dir: string, out: string[]): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await this.walk(full, out);
      } else if (e.isFile()) {
        out.push(this.toKey(full));
      }
    }
  }

  /** Convert an absolute fs path under `root` back to a forward-slash key. */
  private toKey(abs: string): string {
    const rel = path.relative(this.root, abs);
    return rel.split(path.sep).join("/");
  }

  async delete(key: string): Promise<void> {
    const target = this.resolveSafe(key);
    try {
      await fs.unlink(target);
    } catch (err: any) {
      if (err?.code === "ENOENT") return; // idempotent
      throw err;
    }
  }

  async deletePrefix(prefix: string): Promise<void> {
    const target = this.resolveSafe(prefix);
    try {
      await fs.rm(target, { recursive: true, force: true });
    } catch (err: any) {
      if (err?.code === "ENOENT") return;
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.resolveSafe(key));
      return true;
    } catch {
      return false;
    }
  }

  async readStream(key: string): Promise<NodeJS.ReadableStream> {
    const target = this.resolveSafe(key);
    // Pre-check existence so we throw eagerly rather than emitting an
    // error event on the stream (which the caller might not have wired up).
    await fs.access(target);
    return createReadStream(target);
  }

  async writeStream(
    key: string,
  ): Promise<{ stream: NodeJS.WritableStream; done: Promise<void> }> {
    const target = this.resolveSafe(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const stream = createWriteStream(target);
    const done = new Promise<void>((resolve, reject) => {
      stream.on("finish", () => resolve());
      stream.on("error", reject);
    });
    return { stream, done };
  }

  async move(srcKey: string, dstKey: string): Promise<void> {
    const src = this.resolveSafe(srcKey);
    const dst = this.resolveSafe(dstKey);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    try {
      await fs.rename(src, dst);
    } catch (err: any) {
      // EXDEV — cross-device. Fall back to copy + unlink.
      if (err?.code === "EXDEV") {
        await fs.copyFile(src, dst);
        await fs.unlink(src);
        return;
      }
      throw err;
    }
  }

  async copy(srcKey: string, dstKey: string): Promise<void> {
    const src = this.resolveSafe(srcKey);
    const dst = this.resolveSafe(dstKey);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.copyFile(src, dst);
  }

  async stat(key: string): Promise<BlobStat | null> {
    try {
      const s = await fs.stat(this.resolveSafe(key));
      if (!s.isFile()) return null;
      return { size: s.size, lastModified: s.mtime };
    } catch (err: any) {
      if (err?.code === "ENOENT") return null;
      throw err;
    }
  }
}
