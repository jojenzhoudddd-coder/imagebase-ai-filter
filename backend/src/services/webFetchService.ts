/**
 * Web fetch service —— 拉一个网页 + Readability 抽正文 + 转 Markdown。
 *
 * Defenses:
 *   - SSRF: 只允许 http(s),拒 localhost / RFC1918 内网 / AWS metadata 169.254
 *   - Timeout 10s
 *   - 5MB body cap (raw HTML),50KB markdown cap
 *   - User-Agent 标明身份
 *
 * 返回:{ url, finalUrl, title, excerpt, contentMarkdown, byline?, fetchedAt }
 */

import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { promises as dnsPromises } from "dns";
import { isIP } from "net";

export interface WebFetchResult {
  url: string;
  finalUrl: string;
  title: string;
  excerpt: string;
  contentMarkdown: string;
  byline: string | null;
  contentLength: number;     // 原始 markdown 长度(截断前)
  truncated: boolean;
  fetchedAt: string;
}

const RAW_BYTE_CAP = 5 * 1024 * 1024;   // 5MB
const MARKDOWN_CAP = 50 * 1024;         // 50KB
const FETCH_TIMEOUT_MS = 10_000;

/** 主入口 */
export async function fetchAndExtract(rawUrl: string): Promise<WebFetchResult> {
  const url = validateAndNormalizeUrl(rawUrl);
  await assertNotInternalHost(url.hostname);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: "GET",
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Funature-Agent/1.0 (+https://imagebase.cc)",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en,zh-CN;q=0.9,zh;q=0.8",
      },
    });
  } catch (err: any) {
    clearTimeout(timer);
    if (err?.name === "AbortError") {
      throw new Error(`fetch timeout after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw new Error(`fetch failed: ${err?.message ?? String(err)}`);
  }
  clearTimeout(timer);

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }

  // Re-validate finalUrl after redirects (防 redirect 到内网)
  const finalUrl = new URL(res.url);
  if (finalUrl.hostname !== url.hostname) {
    await assertNotInternalHost(finalUrl.hostname);
  }

  // Read body with size cap
  const reader = res.body?.getReader();
  if (!reader) throw new Error("no response body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > RAW_BYTE_CAP) {
        await reader.cancel();
        throw new Error(`page exceeds ${Math.round(RAW_BYTE_CAP / 1024 / 1024)}MB cap`);
      }
      chunks.push(value);
    }
  }
  const buf = Buffer.concat(chunks);

  // Detect charset (header → meta) — fallback utf-8
  const ct = res.headers.get("content-type") || "";
  const charsetMatch = ct.match(/charset=([^;]+)/i);
  let charset = (charsetMatch?.[1] || "utf-8").trim().toLowerCase();
  // jsdom doesn't accept all charset labels; coerce common ones
  if (charset === "gb2312") charset = "gbk";
  let html: string;
  try {
    html = new TextDecoder(charset, { fatal: false }).decode(buf);
  } catch {
    html = buf.toString("utf-8");
  }

  // Readability
  const dom = new JSDOM(html, { url: finalUrl.toString() });
  const reader2 = new Readability(dom.window.document);
  const article = reader2.parse();
  if (!article) {
    throw new Error("failed to extract main content");
  }

  // HTML → Markdown
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  // 处理掉一些噪音
  turndown.remove(["script", "style", "iframe", "form", "noscript"]);
  let md = turndown.turndown(article.content || "");
  const fullLen = md.length;
  let truncated = false;
  if (md.length > MARKDOWN_CAP) {
    md = md.slice(0, MARKDOWN_CAP) + "\n\n…(truncated)";
    truncated = true;
  }

  return {
    url: rawUrl,
    finalUrl: finalUrl.toString(),
    title: (article.title || dom.window.document.title || "").trim(),
    excerpt: (article.excerpt || "").trim(),
    contentMarkdown: md,
    byline: article.byline?.trim() || null,
    contentLength: fullLen,
    truncated,
    fetchedAt: new Date().toISOString(),
  };
}

// ─── Validation helpers ────────────────────────────────────────────────

function validateAndNormalizeUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`invalid URL: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`only http(s) protocols allowed, got: ${u.protocol}`);
  }
  return u;
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => isNaN(p))) return false;
  // 10.0.0.0/8
  if (parts[0] === 10) return true;
  // 172.16.0.0/12
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  // 192.168.0.0/16
  if (parts[0] === 192 && parts[1] === 168) return true;
  // 127.0.0.0/8 loopback
  if (parts[0] === 127) return true;
  // 169.254.0.0/16 link-local + AWS metadata
  if (parts[0] === 169 && parts[1] === 254) return true;
  // 0.0.0.0/8
  if (parts[0] === 0) return true;
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // ::1 loopback
  if (lower === "::1" || lower === "::") return true;
  // fc00::/7 unique-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  // fe80::/10 link-local
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true;
  return false;
}

async function assertNotInternalHost(hostname: string): Promise<void> {
  // Lower-case
  const h = hostname.toLowerCase();
  // Block by name
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) {
    throw new Error(`internal host blocked: ${hostname}`);
  }
  // If it's already an IP literal, check directly
  const ipVer = isIP(h);
  if (ipVer === 4 && isPrivateIPv4(h)) {
    throw new Error(`private IPv4 blocked: ${hostname}`);
  }
  if (ipVer === 6 && isPrivateIPv6(h)) {
    throw new Error(`private IPv6 blocked: ${hostname}`);
  }
  if (ipVer !== 0) return;  // ip literal,已通过私有 IP 检查
  // Resolve DNS,确认所有 A/AAAA 记录都不是内网
  try {
    const addrs = await dnsPromises.lookup(h, { all: true });
    for (const a of addrs) {
      if (a.family === 4 && isPrivateIPv4(a.address)) {
        throw new Error(`hostname ${h} resolves to private IPv4 ${a.address}`);
      }
      if (a.family === 6 && isPrivateIPv6(a.address)) {
        throw new Error(`hostname ${h} resolves to private IPv6 ${a.address}`);
      }
    }
  } catch (err: any) {
    // DNS 失败,放行交给 fetch 自己报错(避免 false positive 把合法域名拒了)
    if (err?.code === "ENOTFOUND" || err?.code === "EAI_AGAIN") return;
    throw err;
  }
}
