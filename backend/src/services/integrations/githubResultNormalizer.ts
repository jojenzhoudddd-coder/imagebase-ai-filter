export interface GithubDisplayItem {
  title: string;
  type?: string;
  url?: string;
  id?: string;
  number?: number;
  state?: string;
  owner?: string;
  repository?: string;
  updatedAt?: string;
  summary?: string;
}

export interface GithubDisplayResult {
  kind: "items" | "object" | "empty";
  total?: number;
  hasMore?: boolean;
  items?: GithubDisplayItem[];
  preview?: Array<{ key: string; value: string }>;
  message: string;
}

export function normalizeGithubToolResult(result: unknown): GithubDisplayResult | null {
  if (isAuthFlowResult(result)) return null;
  const value = unwrapGithubResult(result);
  const items = findGithubItems(value);
  if (items) {
    const displayItems = items.slice(0, 20).map(toDisplayItem);
    const total = readFirstNumberDeep(value, ["total_count", "totalCount", "repositoryCount", "issueCount", "pullRequestCount"]);
    const hasMore = readFirstBooleanDeep(value, ["hasNextPage", "has_more", "hasMore"]);
    return {
      kind: displayItems.length ? "items" : "empty",
      total: total ?? items.length,
      hasMore: hasMore ?? undefined,
      items: displayItems,
      message: buildItemsMessage(displayItems, {
        rawCount: items.length,
        total,
        hasMore,
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

export function buildGithubResultMessage(result: unknown): string {
  return normalizeGithubToolResult(result)?.message ?? "执行成功，没有返回可展示结果。";
}

function buildItemsMessage(
  items: GithubDisplayItem[],
  meta: { rawCount: number; total?: number | null; hasMore?: boolean | null },
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
  if (meta.hasMore) lines.push("还有更多结果，可继续翻页。");
  return lines.join("\n");
}

function formatDisplayItem(item: GithubDisplayItem): string {
  const titlePrefix = typeof item.number === "number" ? `#${item.number} ` : "";
  const parts = [`${titlePrefix}${item.title || "未命名结果"}`];
  if (item.type) parts.push(`类型：${item.type}`);
  if (item.state) parts.push(`状态：${item.state}`);
  if (item.owner) parts.push(`作者/所有者：${item.owner}`);
  if (item.repository) parts.push(`仓库：${item.repository}`);
  if (item.updatedAt) parts.push(`更新时间：${item.updatedAt}`);
  if (item.url) parts.push(`链接：${item.url}`);
  if (!item.url && item.id) parts.push(`标识：${item.id}`);
  if (item.summary && item.summary !== item.title) parts.push(`摘要：${truncateText(item.summary, 180)}`);
  return parts.join("\n   ");
}

function toDisplayItem(input: unknown): GithubDisplayItem {
  const item = unwrapNode(input);
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return { title: truncateText(String(item ?? ""), 220) || "空结果" };
  }
  const record = item as Record<string, unknown>;
  const fullName = readFirstOwnString(record, ["fullName", "nameWithOwner", "full_name"]) ||
    repoFullName(record);
  const title = cleanText(fullName ||
    readFirstOwnString(record, [
      "title",
      "name",
      "displayName",
      "workflowName",
      "tagName",
      "login",
      "path",
      "subject",
    ])) || "未命名结果";
  const number = readFirstNumberDeep(item, ["number", "runNumber", "run_number"]);
  const type = repoVisibility(record) ||
    cleanText(readFirstStringDeep(item, ["__typename", "type", "event", "visibility"])) ||
    undefined;
  const state = cleanText(readFirstStringDeep(item, ["state", "status", "conclusion"])) || undefined;
  const url = readFirstStringDeep(item, ["html_url", "url", "webUrl", "permalink", "app_url"]) ?? undefined;
  const repository = cleanText(
    readNestedString(record, ["repository", "nameWithOwner"]) ||
    readNestedString(record, ["repository", "fullName"]) ||
    readNestedString(record, ["repository", "full_name"]) ||
    readNestedString(record, ["repo", "fullName"]) ||
    readNestedString(record, ["repo", "full_name"]),
  ) || undefined;
  const owner = cleanText(
    readNestedString(record, ["author", "login"]) ||
    readNestedString(record, ["owner", "login"]) ||
    readNestedString(record, ["user", "login"]) ||
    readNestedString(record, ["actor", "login"]),
  ) || undefined;
  const summary = cleanText(readFirstStringDeep(item, [
    "description",
    "bodyText",
    "body_text",
    "body",
    "excerpt",
    "summary",
  ])) || undefined;
  return {
    title,
    type,
    state,
    url,
    id: readFirstStringDeep(item, ["id", "node_id", "databaseId"]) ?? undefined,
    number: number ?? undefined,
    owner,
    repository,
    updatedAt: readFirstStringDeep(item, ["updatedAt", "updated_at", "pushedAt", "createdAt", "created_at"]) ?? undefined,
    summary,
  };
}

function unwrapGithubResult(value: unknown): unknown {
  let cur = value;
  for (let i = 0; i < 4; i += 1) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return cur;
    const record = cur as Record<string, unknown>;
    if (record.data !== undefined && Object.keys(record).length <= 3) {
      cur = record.data;
      continue;
    }
    if (record.result !== undefined && Object.keys(record).length <= 4) {
      cur = record.result;
      continue;
    }
    return cur;
  }
  return cur;
}

function findGithubItems(value: unknown, depth = 0): unknown[] | null {
  if (Array.isArray(value)) return value.map(unwrapNode);
  if (!value || typeof value !== "object" || depth > 5) return null;
  const record = value as Record<string, unknown>;
  if (isGithubDisplayObject(record)) return [record];
  const preferredKeys = [
    "items",
    "nodes",
    "edges",
    "repositories",
    "issues",
    "pullRequests",
    "workflowRuns",
    "workflow_runs",
    "jobs",
    "check_runs",
    "runs",
    "comments",
    "releases",
    "assets",
  ];
  for (const key of preferredKeys) {
    if (Array.isArray(record[key])) return (record[key] as unknown[]).map(unwrapNode);
  }
  for (const key of preferredKeys) {
    const found = findGithubItems(record[key], depth + 1);
    if (found) return found;
  }
  for (const nested of Object.values(record)) {
    const found = findGithubItems(nested, depth + 1);
    if (found) return found;
  }
  return null;
}

function isGithubDisplayObject(record: Record<string, unknown>): boolean {
  if (typeof record.fullName === "string" || typeof record.nameWithOwner === "string" || typeof record.full_name === "string") {
    return true;
  }
  if (
    typeof record.title === "string" &&
    (typeof record.number === "number" || typeof record.url === "string" || typeof record.html_url === "string")
  ) {
    return true;
  }
  if (
    typeof record.name === "string" &&
    (typeof record.html_url === "string" || typeof record.url === "string") &&
    (record.owner || record.visibility || record.private !== undefined)
  ) {
    return true;
  }
  if (
    typeof record.login === "string" &&
    (typeof record.html_url === "string" || typeof record.url === "string") &&
    (record.type || record.site_admin !== undefined)
  ) {
    return true;
  }
  return false;
}

function unwrapNode(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (record.node && typeof record.node === "object") return record.node;
  return value;
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

function isAuthFlowResult(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (record.providerKey === "github" &&
    (record.status === "pending" || record.status === "authorized" || record.status === "needs_auth")) ||
    record.errorType === "missing_scope";
}

function formatScalarPreview(value: unknown): string {
  if (typeof value === "string") return truncateText(cleanText(value), 180);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return truncateText(JSON.stringify(value), 240);
  } catch {
    return String(value);
  }
}

function readNestedString(record: Record<string, unknown>, path: string[]): string | null {
  let cur: unknown = record;
  for (const key of path) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  if (typeof cur === "string" && cur.trim()) return cur.trim();
  if (typeof cur === "number" || typeof cur === "boolean") return String(cur);
  return null;
}

function repoFullName(record: Record<string, unknown>): string | null {
  const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : "";
  if (!name) return null;
  const owner = readNestedString(record, ["owner", "login"]);
  return owner ? `${owner}/${name}` : null;
}

function repoVisibility(record: Record<string, unknown>): string | null {
  const visibility = typeof record.visibility === "string" && record.visibility.trim()
    ? record.visibility.trim()
    : "";
  if (visibility) return visibility;
  if (typeof record.isPrivate === "boolean") return record.isPrivate ? "private" : "public";
  if (typeof record.private === "boolean") return record.private ? "private" : "public";
  return null;
}

function readFirstOwnString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const raw = record[key];
    if (typeof raw === "string" && raw.trim()) return raw.trim();
    if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  }
  return null;
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
    if (typeof raw === "string" && Number.isFinite(Number(raw))) return Number(raw);
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

function cleanText(value: string | null): string {
  if (!value) return "";
  return value.replace(/\s+/g, " ").trim();
}
