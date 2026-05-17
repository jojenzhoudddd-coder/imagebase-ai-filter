export interface LarkDisplayItem {
  title: string;
  type?: string;
  url?: string;
  id?: string;
  owner?: string;
  updatedAt?: string;
  summary?: string;
}

export interface LarkDisplayResult {
  kind: "items" | "object" | "empty";
  total?: number;
  hasMore?: boolean;
  pageToken?: string;
  items?: LarkDisplayItem[];
  preview?: Array<{ key: string; value: string }>;
  message: string;
}

export function normalizeLarkToolResult(result: unknown): LarkDisplayResult | null {
  const value = unwrapLarkResult(result);
  if (isMissingOrPendingAuth(value)) return null;
  const items = findLarkResultItems(value);
  if (items) {
    const displayItems = items.slice(0, 20).map(toDisplayItem);
    const total = readFirstNumberDeep(value, ["total", "Total"]);
    const hasMore = readFirstBooleanDeep(value, ["has_more", "HasMore", "hasMore"]);
    const pageToken = readFirstStringDeep(value, ["page_token", "pageToken"]);
    return {
      kind: displayItems.length ? "items" : "empty",
      total: total ?? items.length,
      hasMore: hasMore ?? undefined,
      pageToken: pageToken ?? undefined,
      items: displayItems,
      message: buildItemsMessage(displayItems, {
        rawCount: items.length,
        total,
        hasMore,
        pageToken,
      }),
    };
  }
  const preview = objectPreview(value);
  if (preview.length) {
    return {
      kind: "object",
      preview,
      message: `执行成功，返回结果如下：\n${preview.map((entry) => `- ${entry.key}：${entry.value}`).join("\n")}`,
    };
  }
  return {
    kind: "empty",
    message: "执行成功，没有返回可展示结果。",
  };
}

export function buildLarkResultMessage(result: unknown): string {
  return normalizeLarkToolResult(result)?.message ?? "执行成功，没有返回可展示结果。";
}

function buildItemsMessage(
  items: LarkDisplayItem[],
  meta: { rawCount: number; total?: number | null; hasMore?: boolean | null; pageToken?: string | null },
): string {
  if (!items.length) return "执行成功，没有找到匹配结果。";
  const visible = items.slice(0, 5);
  const totalText = Number.isFinite(meta.total as number) ? String(meta.total) : String(meta.rawCount);
  const lines = [
    `执行成功，返回 ${totalText} 条结果${items.length > visible.length ? `，先展示前 ${visible.length} 条` : ""}：`,
  ];
  visible.forEach((item, index) => {
    lines.push(`${index + 1}. ${formatDisplayItem(item)}`);
  });
  if (meta.hasMore) {
    lines.push("还有更多结果，可继续翻页。");
  }
  return lines.join("\n");
}

function formatDisplayItem(item: LarkDisplayItem): string {
  const parts = [item.title || "未命名结果"];
  if (item.type) parts.push(`类型：${item.type}`);
  if (item.owner) parts.push(`所有者：${item.owner}`);
  if (item.updatedAt) parts.push(`更新时间：${item.updatedAt}`);
  if (item.url) parts.push(`链接：${item.url}`);
  if (!item.url && item.id) parts.push(`标识：${item.id}`);
  if (item.summary && item.summary !== parts[0]) parts.push(`摘要：${truncateText(item.summary, 160)}`);
  return parts.join("\n   ");
}

function toDisplayItem(item: unknown): LarkDisplayItem {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return { title: truncateText(String(item ?? ""), 220) || "空结果" };
  }
  const title = cleanLarkDisplayText(readFirstStringDeep(item, [
    "title_highlighted",
    "title",
    "name_highlighted",
    "name",
    "file_name",
    "doc_name",
    "sheet_name",
    "summary",
  ])) || "未命名结果";
  return {
    title,
    type: cleanLarkDisplayText(readFirstStringDeep(item, [
      "entity_type",
      "doc_types",
      "type",
      "doc_type",
      "file_type",
      "obj_type",
      "resource_type",
    ])) || undefined,
    url: readFirstStringDeep(item, ["url", "link", "app_link", "web_url", "share_url"]) ?? undefined,
    id: readFirstStringDeep(item, [
      "id",
      "token",
      "file_token",
      "doc_token",
      "document_id",
      "wiki_token",
      "node_token",
      "obj_token",
    ]) ?? undefined,
    owner: cleanLarkDisplayText(readFirstStringDeep(item, ["owner_name", "edit_user_name"])) || undefined,
    updatedAt: cleanLarkDisplayText(readFirstStringDeep(item, ["update_time_iso", "last_open_time_iso"])) || undefined,
    summary: cleanLarkDisplayText(readFirstStringDeep(item, [
      "summary_highlighted",
      "snippet",
      "excerpt",
      "description",
      "content",
      "text",
      "preview",
    ])) || undefined,
  };
}

function unwrapLarkResult(value: unknown): unknown {
  let cur = value;
  for (let i = 0; i < 4; i += 1) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return cur;
    const record = cur as Record<string, unknown>;
    if (record.data !== undefined) {
      cur = record.data;
      continue;
    }
    if (record.result !== undefined) {
      cur = record.result;
      continue;
    }
    return cur;
  }
  return cur;
}

function findLarkResultItems(value: unknown, depth = 0): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object" || depth > 4) return null;
  const record = value as Record<string, unknown>;
  const preferredKeys = ["results", "items", "list", "records", "docs", "files", "children", "events"];
  for (const key of preferredKeys) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  for (const key of preferredKeys) {
    const nested = findLarkResultItems(record[key], depth + 1);
    if (nested) return nested;
  }
  for (const nested of Object.values(record)) {
    const found = findLarkResultItems(nested, depth + 1);
    if (found) return found;
  }
  return null;
}

function objectPreview(value: unknown): Array<{ key: string; value: string }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const text = truncateText(String(value ?? ""), 500);
    return text ? [{ key: "value", value: text }] : [];
  }
  return Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && v !== null && typeof v !== "function")
    .slice(0, 8)
    .map(([key, v]) => ({ key, value: formatScalarPreview(v) }));
}

function isMissingOrPendingAuth(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.status === "pending" || record.errorType === "missing_scope";
}

function formatScalarPreview(value: unknown): string {
  if (typeof value === "string") return truncateText(cleanLarkDisplayText(value), 180);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return truncateText(JSON.stringify(value), 240);
  } catch {
    return String(value);
  }
}

function readFirstStringDeep(value: unknown, keys: string[], depth = 0): string | null {
  if (!value || typeof value !== "object" || depth > 3) return null;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const raw = record[key];
    if (typeof raw === "string" && raw.trim()) return raw.trim();
    if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  }
  for (const nested of Object.values(record)) {
    const found = readFirstStringDeep(nested, keys, depth + 1);
    if (found) return found;
  }
  return null;
}

function readFirstNumberDeep(value: unknown, keys: string[], depth = 0): number | null {
  if (!value || typeof value !== "object" || depth > 3) return null;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const raw = record[key];
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  }
  for (const nested of Object.values(record)) {
    const found = readFirstNumberDeep(nested, keys, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function readFirstBooleanDeep(value: unknown, keys: string[], depth = 0): boolean | null {
  if (!value || typeof value !== "object" || depth > 3) return null;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const raw = record[key];
    if (typeof raw === "boolean") return raw;
  }
  for (const nested of Object.values(record)) {
    const found = readFirstBooleanDeep(nested, keys, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function truncateText(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function cleanLarkDisplayText(value: string | null): string {
  if (!value) return "";
  return decodeHtmlEntities(value)
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    const named: Record<string, string> = {
      amp: "&",
      lt: "<",
      gt: ">",
      quot: "\"",
      apos: "'",
      nbsp: " ",
    };
    const lower = entity.toLowerCase();
    if (named[lower]) return named[lower];
    if (lower.startsWith("#x")) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (lower.startsWith("#")) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return match;
  });
}
