/**
 * demoFileStore — Filesystem I/O for Demo source, build output, and
 * published snapshots.
 *
 * Layout (see docs/vibe-demo-plan.md §5.1):
 *   ~/.imagebase/demos/<demoId>/
 *     files/         source (authoritative, mutated by Agent / user)
 *     dist/          latest build output (served at /api/demos/<id>/preview/*)
 *     published/<N>/ immutable snapshot per publish (served at /share/:slug/*)
 *     build.log      last build stderr/stdout
 *
 * Path safety: every `write / read / delete` re-validates the provided
 * relative path through `resolvePath`. Paths are normalized and must stay
 * inside `files/`. No symlinks, no `..`.
 *
 * Concurrency: we don't enforce write locks at this layer. The single-process
 * Agent loop and the REST handlers both route through this module sequentially
 * in practice; if we grow to multi-replica backend we'll add advisory locks.
 */

import path from "path";
import os from "os";
import fs from "fs";
import fsp from "fs/promises";
import { randomBytes } from "crypto";

export const DEMO_HOME =
  process.env.DEMO_HOME || path.join(os.homedir(), ".imagebase", "demos");

export function demoRoot(demoId: string): string {
  return path.join(DEMO_HOME, sanitizeId(demoId));
}
export function demoFilesDir(demoId: string): string {
  return path.join(demoRoot(demoId), "files");
}
export function demoDistDir(demoId: string): string {
  return path.join(demoRoot(demoId), "dist");
}
export function demoPublishedDir(demoId: string, version: number): string {
  return path.join(demoRoot(demoId), "published", String(version));
}
export function demoBuildLogPath(demoId: string): string {
  return path.join(demoRoot(demoId), "build.log");
}

/** Prevent path traversal / invalid chars in the demoId param. */
function sanitizeId(id: string): string {
  if (!/^[a-zA-Z0-9_\-]+$/.test(id)) {
    throw new Error(`Invalid demoId: ${id}`);
  }
  return id;
}

/** Resolve a relative path inside demoFilesDir, guarding against escape. */
export function resolveFilePath(demoId: string, relPath: string): string {
  if (
    !relPath ||
    relPath.includes("\0") ||
    relPath.startsWith("/") ||
    relPath.startsWith("\\")
  ) {
    throw new Error(`Invalid file path: ${relPath}`);
  }
  const root = demoFilesDir(demoId);
  const resolved = path.resolve(root, relPath);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error(`Path escapes files/ root: ${relPath}`);
  }
  return resolved;
}

// ─── Lifecycle ────────────────────────────────────────────────────────────

export async function ensureDemoDir(demoId: string): Promise<void> {
  await fsp.mkdir(demoFilesDir(demoId), { recursive: true });
  await fsp.mkdir(demoDistDir(demoId), { recursive: true });
  await fsp.mkdir(path.join(demoRoot(demoId), "published"), { recursive: true });
}

export async function deleteDemoDir(demoId: string): Promise<void> {
  const root = demoRoot(demoId);
  try {
    await fsp.rm(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ─── Source files ─────────────────────────────────────────────────────────

export async function writeFile(
  demoId: string,
  relPath: string,
  content: string,
): Promise<void> {
  const abs = resolveFilePath(demoId, relPath);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  // Atomic write: .tmp rename so concurrent reads never see partial file.
  const tmp = abs + "." + randomBytes(4).toString("hex") + ".tmp";
  await fsp.writeFile(tmp, content, "utf-8");
  await fsp.rename(tmp, abs);
}

export async function readFile(demoId: string, relPath: string): Promise<string> {
  const abs = resolveFilePath(demoId, relPath);
  return fsp.readFile(abs, "utf-8");
}

export async function deleteFile(demoId: string, relPath: string): Promise<void> {
  const abs = resolveFilePath(demoId, relPath);
  await fsp.unlink(abs).catch((err) => {
    if (err.code !== "ENOENT") throw err;
  });
}

export async function fileExists(demoId: string, relPath: string): Promise<boolean> {
  try {
    const abs = resolveFilePath(demoId, relPath);
    await fsp.access(abs);
    return true;
  } catch {
    return false;
  }
}

export interface FileEntry {
  path: string;
  size: number;
  updatedAt: Date;
}

/** List all files under `files/`, recursively. Returns relative paths. */
export async function listFiles(demoId: string): Promise<FileEntry[]> {
  const root = demoFilesDir(demoId);
  const out: FileEntry[] = [];
  async function walk(dir: string, relBase: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = relBase ? path.join(relBase, e.name) : e.name;
      if (e.isDirectory()) {
        await walk(full, rel);
      } else if (e.isFile()) {
        const stat = await fsp.stat(full).catch(() => null);
        if (!stat) continue;
        out.push({ path: rel, size: stat.size, updatedAt: stat.mtime });
      }
    }
  }
  await walk(root, "");
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// ─── Dist (build output) ──────────────────────────────────────────────────

export async function clearDist(demoId: string): Promise<void> {
  const dir = demoDistDir(demoId);
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
  await fsp.mkdir(dir, { recursive: true });
}

export async function writeDist(
  demoId: string,
  relPath: string,
  content: string | Buffer,
): Promise<void> {
  const dir = demoDistDir(demoId);
  const abs = path.resolve(dir, relPath);
  if (!abs.startsWith(dir + path.sep) && abs !== dir) {
    throw new Error(`dist path escape: ${relPath}`);
  }
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content);
}

/** Absolute path helper for dist file — used by static serve. */
export function distFilePath(demoId: string, relPath: string): string {
  const dir = demoDistDir(demoId);
  const abs = path.resolve(dir, relPath);
  if (!abs.startsWith(dir + path.sep) && abs !== dir) {
    throw new Error(`dist path escape: ${relPath}`);
  }
  return abs;
}

export async function hasDist(demoId: string): Promise<boolean> {
  const indexHtml = path.join(demoDistDir(demoId), "index.html");
  try {
    await fsp.access(indexHtml);
    return true;
  } catch {
    return false;
  }
}

// ─── Published snapshots ──────────────────────────────────────────────────

export async function copyDistToPublished(
  demoId: string,
  version: number,
): Promise<void> {
  const src = demoDistDir(demoId);
  const dst = demoPublishedDir(demoId, version);
  await fsp.mkdir(dst, { recursive: true });
  await copyDir(src, dst);
}

export function publishedFilePath(
  demoId: string,
  version: number,
  relPath: string,
): string {
  const dir = demoPublishedDir(demoId, version);
  const abs = path.resolve(dir, relPath);
  if (!abs.startsWith(dir + path.sep) && abs !== dir) {
    throw new Error(`published path escape: ${relPath}`);
  }
  return abs;
}

async function copyDir(src: string, dst: string): Promise<void> {
  await fsp.mkdir(dst, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else if (e.isFile()) await fsp.copyFile(s, d);
  }
}

// ─── Build log ────────────────────────────────────────────────────────────

export async function writeBuildLog(demoId: string, log: string): Promise<void> {
  await fsp.writeFile(demoBuildLogPath(demoId), log, "utf-8");
}

export async function readBuildLog(demoId: string): Promise<string | null> {
  try {
    return await fsp.readFile(demoBuildLogPath(demoId), "utf-8");
  } catch {
    return null;
  }
}

// ─── Zip export (V1) ──────────────────────────────────────────────────────
//
// Pure Node, no `archiver` dependency — we stream a minimal ZIP by hand for
// the "download bundle" feature. Sufficient for < 10 text files which is
// the V1 Demo scope.

import { deflateRawSync } from "zlib";

export async function exportFilesAsZip(demoId: string): Promise<Buffer> {
  const files = await listFiles(demoId);
  const entries: Array<{ name: string; data: Buffer; crc: number; compressed: Buffer }> = [];

  for (const f of files) {
    const raw = await fsp.readFile(resolveFilePath(demoId, f.path));
    const crc = crc32(raw);
    const compressed = deflateRawSync(raw);
    entries.push({
      name: f.path.replace(/\\/g, "/"),
      data: raw,
      crc,
      compressed,
    });
  }

  const chunks: Buffer[] = [];
  let offset = 0;
  const centralEntries: Buffer[] = [];

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf-8");
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // local file header signature
    localHeader.writeUInt16LE(20, 4);         // version needed
    localHeader.writeUInt16LE(0x0800, 6);     // general purpose bit flag (utf-8 name)
    localHeader.writeUInt16LE(8, 8);          // compression method = deflate
    localHeader.writeUInt16LE(0, 10);         // last mod time
    localHeader.writeUInt16LE(0, 12);         // last mod date
    localHeader.writeUInt32LE(e.crc, 14);
    localHeader.writeUInt32LE(e.compressed.length, 18);
    localHeader.writeUInt32LE(e.data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length

    const entryOffset = offset;
    chunks.push(localHeader, nameBuf, e.compressed);
    offset += localHeader.length + nameBuf.length + e.compressed.length;

    // Central directory entry
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);        // version made by
    cdh.writeUInt16LE(20, 6);        // version needed
    cdh.writeUInt16LE(0x0800, 8);    // flags
    cdh.writeUInt16LE(8, 10);        // method
    cdh.writeUInt16LE(0, 12);        // mod time
    cdh.writeUInt16LE(0, 14);        // mod date
    cdh.writeUInt32LE(e.crc, 16);
    cdh.writeUInt32LE(e.compressed.length, 20);
    cdh.writeUInt32LE(e.data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);        // extra field length
    cdh.writeUInt16LE(0, 32);        // comment length
    cdh.writeUInt16LE(0, 34);        // disk #
    cdh.writeUInt16LE(0, 36);        // internal attrs
    cdh.writeUInt32LE(0, 38);        // external attrs
    cdh.writeUInt32LE(entryOffset, 42);
    centralEntries.push(Buffer.concat([cdh, nameBuf]));
  }

  const cdStart = offset;
  const cdBuf = Buffer.concat(centralEntries);
  chunks.push(cdBuf);
  offset += cdBuf.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20); // comment length
  chunks.push(eocd);

  return Buffer.concat(chunks);
}

// CRC32 implementation (table-less, good enough for per-file).
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}
