/**
 * Mention link syntax: `[@label](mention://type/id?table=...&design=...&idea=...)`
 *
 * We encode mentions as plain Markdown links so the source buffer stays
 * editable as ordinary text (you can cursor over them, delete them, paste
 * them around). The renderer pattern-matches the `mention://` scheme and
 * swaps the link for an interactive chip — everything else, inclusion in
 * paragraphs, tables, lists, falls out of react-markdown's normal pipeline.
 *
 * v4 mention types: `table` | `design` | `taste` | `idea` | `idea-section` | `model`.
 *  - table        → `mention://table/<tableId>`
 *  - design       → `mention://design/<designId>`
 *  - taste        → `mention://taste/<tasteId>?design=<designId>`
 *  - idea         → `mention://idea/<ideaId>`
 *  - idea-section → `mention://idea-section/<headingSlug>?idea=<ideaId>`
 *  - model        → `mention://model/<modelId>` (chat input only,V1 不支持 idea 内引用模型导航)
 *
 * Legacy v3 `view` mentions (`mention://view/<viewId>?table=<tableId>`) are
 * lazy-migrated to `table` at parse time:返回 `{type:"table", id:tableId}`
 * 让历史 idea content 不断链。下次用户保存时新链接才会写入新格式。
 */

import type { MentionHit, MentionType } from "../../types";

export interface ParsedMention {
  type: MentionType;
  id: string;
  label: string;
  tableId?: string;
  designId?: string;
  ideaId?: string;
  modelId?: string;
}

const MENTION_SCHEME = "mention://";

/** Build the Markdown link string for a mention picker selection. */
export function buildMentionLink(hit: MentionHit): string {
  const params: string[] = [];
  if (hit.type === "taste" && hit.designId) {
    params.push(`design=${encodeURIComponent(hit.designId)}`);
  }
  if (hit.type === "idea-section" && hit.ideaId) {
    params.push(`idea=${encodeURIComponent(hit.ideaId)}`);
  }
  const query = params.length ? `?${params.join("&")}` : "";
  // The id slot holds the type-appropriate identifier. For idea-section that
  // is the heading slug, not the idea id (we want the URL to be grep-able
  // as `…/idea-section/timeline?idea=…`).
  const href = `${MENTION_SCHEME}${hit.type}/${encodeURIComponent(hit.id)}${query}`;
  // The label is what appears inside the []. Prefix with "@" so plaintext
  // readers (without the renderer) still see it's a mention. Strip brackets
  // from the label so we don't accidentally break the Markdown link syntax.
  const label = `@${hit.label.replace(/[\[\]]/g, "")}`;
  return `[${label}](${href})`;
}

/** Parse a mention URL back into a structured ref, or null if the href
 * isn't a v4 mention scheme / is malformed. The parser is lenient — anything
 * that doesn't match falls back to normal link rendering. Also handles
 * legacy v3 `view` URIs by transparently migrating to `table`. */
export function parseMentionHref(href: string, label: string): ParsedMention | null {
  if (!href.startsWith(MENTION_SCHEME)) return null;
  const rest = href.slice(MENTION_SCHEME.length);
  const [path, query = ""] = rest.split("?");
  const slashIdx = path.indexOf("/");
  if (slashIdx < 0) return null;
  const rawType = path.slice(0, slashIdx);
  const id = decodeURIComponent(path.slice(slashIdx + 1));
  if (!rawType || !id) return null;

  const params = new URLSearchParams(query);
  const tableId = params.get("table") || undefined;
  const designId = params.get("design") || undefined;
  const ideaId = params.get("idea") || undefined;
  // Strip leading "@" from label for display — chip prepends its own.
  const cleanLabel = label.replace(/^@/, "");

  // Legacy v3 view → table migration:tableId 来自 query,作为新 mention 的 id
  if (rawType === "view") {
    if (!tableId) return null;
    return {
      type: "table",
      id: tableId,
      label: cleanLabel,
    };
  }

  if (
    rawType !== "table" &&
    rawType !== "design" &&
    rawType !== "taste" &&
    rawType !== "idea" &&
    rawType !== "idea-section" &&
    rawType !== "model"
  ) {
    return null;
  }

  return {
    type: rawType as MentionType,
    id,
    label: cleanLabel,
    tableId,
    designId,
    ideaId,
    modelId: rawType === "model" ? id : undefined,
  };
}
