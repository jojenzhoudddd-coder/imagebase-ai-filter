/**
 * Mention link syntax: `[@label](mention://type/id?table=...&design=...&idea=...)`
 *
 * We encode mentions as plain Markdown links so the source buffer stays
 * editable as ordinary text (you can cursor over them, delete them, paste
 * them around). The renderer pattern-matches the `mention://` scheme and
 * swaps the link for an interactive chip — everything else, inclusion in
 * paragraphs, tables, lists, falls out of react-markdown's normal pipeline.
 *
 * v3 mention types: `view` | `taste` | `idea` | `idea-section`.
 *  - view         → `mention://view/<viewId>?table=<tableId>`
 *  - taste        → `mention://taste/<tasteId>?design=<designId>`
 *  - idea         → `mention://idea/<ideaId>`
 *  - idea-section → `mention://idea-section/<headingSlug>?idea=<ideaId>`
 *
 * Legacy `table` / `field` / `record` mentions that may still live inside
 * existing idea content render as normal Markdown links — the parser returns
 * `null` for them so react-markdown's default `<a>` component handles them.
 */

import type { MentionHit, MentionType } from "../../types";

export interface ParsedMention {
  type: MentionType;
  id: string;
  label: string;
  tableId?: string;
  designId?: string;
  ideaId?: string;
}

const MENTION_SCHEME = "mention://";

/** Build the Markdown link string for a mention picker selection. */
export function buildMentionLink(hit: MentionHit): string {
  const params: string[] = [];
  if (hit.type === "view" && hit.tableId) {
    params.push(`table=${encodeURIComponent(hit.tableId)}`);
  }
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
 * isn't a v3 mention scheme / is malformed. The parser is lenient — anything
 * that doesn't match falls back to normal link rendering. Legacy v1 types
 * (table / field / record) are intentionally rejected here so they render as
 * plain links. */
export function parseMentionHref(href: string, label: string): ParsedMention | null {
  if (!href.startsWith(MENTION_SCHEME)) return null;
  const rest = href.slice(MENTION_SCHEME.length);
  const [path, query = ""] = rest.split("?");
  // Split on the FIRST slash only — heading slugs may theoretically contain
  // more exotic chars (though slugify strips them). Be defensive.
  const slashIdx = path.indexOf("/");
  if (slashIdx < 0) return null;
  const type = path.slice(0, slashIdx);
  const id = decodeURIComponent(path.slice(slashIdx + 1));
  if (!type || !id) return null;
  if (type !== "view" && type !== "taste" && type !== "idea" && type !== "idea-section") return null;

  const params = new URLSearchParams(query);
  const tableId = params.get("table") || undefined;
  const designId = params.get("design") || undefined;
  const ideaId = params.get("idea") || undefined;
  // Strip leading "@" from label for display — the chip prepends its own.
  const cleanLabel = label.replace(/^@/, "");
  return {
    type: type as MentionType,
    id,
    label: cleanLabel,
    tableId,
    designId,
    ideaId,
  };
}
