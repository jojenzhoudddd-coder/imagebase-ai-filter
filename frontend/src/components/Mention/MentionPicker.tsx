import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "../../i18n/index";
import { searchMentions } from "../../api";
import type { MentionHit } from "../../types";

interface Props {
  workspaceId: string;
  query: string;
  /** Viewport-pixel rect of the `@` glyph. Picker docks its top-left to the
   * glyph's bottom-right by default, and flips to docking its top-right to
   * the glyph's bottom-left when the default placement would overflow the
   * right edge of the viewport (the primary → submenu pattern). */
  atRect: { left: number; right: number; top: number; bottom: number };
  onSelect: (hit: MentionHit) => void;
  onClose: () => void;
  /**
   * Optional whitelist of mention types to surface. ChatInput passes
   * `["model","table","design","taste","idea","idea-section"]` to opt into
   * model mentions; IdeaEditor uses the default (no models) by omitting it.
   */
  types?: Array<MentionHit["type"]>;
}

/**
 * Compact @mention picker: fires on every keystroke after `@`, debounces by
 * 150ms, groups hits by type.
 *
 * Keyboard nav (↑↓ + Enter) is captured on the document at capture phase so
 * it runs before the editor's own handlers — the textarea / contentEditable
 * keeps focus and caret undisturbed. `activeIdx` is a position in the
 * *visual* order (post-group, post-sort), not the raw backend hits array,
 * so ArrowDown always moves to the next row the user sees.
 */
export default function MentionPicker({ workspaceId, query, atRect, onSelect, onClose, types }: Props) {
  const { t } = useTranslation();
  const [hits, setHits] = useState<MentionHit[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const lastQueryRef = useRef(query);
  // Adjusted pixel position after viewport-edge detection. Starts glued to
  // `@`'s bottom-right (picker top-left at that corner); a useLayoutEffect
  // below flips it to `@`'s bottom-left when the default would overflow the
  // viewport — the primary → submenu flip pattern.
  const [placement, setPlacement] = useState<{ left: number; top: number }>(() => ({
    left: atRect.right,
    top: atRect.bottom,
  }));

  // Debounced fetch. A fresh query invalidates older in-flight responses via
  // the ref check, so we never paint stale hits.
  // Stabilise types array in deps with a stringified key so a new array
  // identity each render doesn't refire the effect.
  const typesKey = types ? types.slice().sort().join(",") : "";
  useEffect(() => {
    lastQueryRef.current = query;
    setLoading(true);
    const id = window.setTimeout(async () => {
      try {
        const results = await searchMentions(workspaceId, query, {
          limit: 10,
          types: types && types.length > 0 ? types : undefined,
        });
        if (lastQueryRef.current === query) {
          setHits(results);
          setActiveIdx(0);
          setLoading(false);
        }
      } catch {
        setHits([]);
        setLoading(false);
      }
    }, 150);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, query, typesKey]);

  // Group hits into three buckets — 数据表 (view) / 创意 (taste) / 灵感
  // (idea + idea-section). Both idea types fold into the same "灵感" label,
  // so whole-idea hits and section-level hits appear under one header.
  // Within the 灵感 group we stabilise so whole ideas come before the sections
  // of any given idea — the raw backend ordering interleaves them which
  // reads oddly when the group is rendered vertically.
  //
  // We also flatten the post-sort groups into `visualHits` — the single
  // source of truth for keyboard navigation. Indexing ArrowUp/Down against
  // this array (rather than the raw `hits`) is what makes ↑↓ follow the
  // order the user actually sees on screen.
  const { groups, visualHits } = useMemo(() => {
    const groupLabelOf = (hit: MentionHit) =>
      hit.type === "table" ? t("idea.mentionTable")
      : hit.type === "design" ? t("idea.mentionDesign")
      : hit.type === "taste" ? t("idea.mentionTaste")
      : hit.type === "idea-section" ? t("idea.mentionSection")
      : hit.type === "model" ? t("idea.mentionModel")
      : t("idea.mentionIdea");

    const groupsList: Array<{ label: string; items: MentionHit[] }> = [];
    const idxByLabel = new Map<string, number>();
    for (const hit of hits) {
      const label = groupLabelOf(hit);
      let gi = idxByLabel.get(label);
      if (gi === undefined) {
        gi = groupsList.length;
        idxByLabel.set(label, gi);
        groupsList.push({ label, items: [] });
      }
      groupsList[gi].items.push(hit);
    }
    // Within the merged 灵感 bucket, whole-idea hits come before their sections.
    // Array#sort is stable in modern JS engines, so items with the same rank
    // keep their backend order as tiebreak.
    for (const g of groupsList) {
      g.items.sort((a, b) => {
        const ra = a.type === "idea-section" ? 1 : 0;
        const rb = b.type === "idea-section" ? 1 : 0;
        return ra - rb;
      });
    }
    const visual: MentionHit[] = groupsList.flatMap(g => g.items);
    return { groups: groupsList, visualHits: visual };
  }, [hits, t]);

  // Clamp activeIdx whenever the visual list shrinks (e.g. query narrowed).
  useEffect(() => {
    if (activeIdx >= visualHits.length) setActiveIdx(Math.max(0, visualHits.length - 1));
  }, [visualHits.length, activeIdx]);

  // Keyboard nav — listen on document at capture phase so it runs before the
  // editor's own keydown handlers. `stopImmediatePropagation` keeps the
  // textarea / contentEditable from also reacting to the same key (which
  // would move the caret and close the picker via the detect-mention pass).
  // Arrow keys are swallowed even during the 150ms loading window so caret
  // drift can't race the picker.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (visualHits.length > 0) {
          setActiveIdx(i => Math.min(i + 1, visualHits.length - 1));
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (visualHits.length > 0) {
          setActiveIdx(i => Math.max(i - 1, 0));
        }
      } else if (e.key === "Enter" || e.key === "Tab") {
        const pick = visualHits[activeIdx];
        if (pick) {
          e.preventDefault();
          e.stopImmediatePropagation();
          onSelect(pick);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [visualHits, activeIdx, onSelect, onClose]);

  // Keep the active row visible. Scrollbar is hidden via CSS but content can
  // still scroll — without scrollIntoView the highlighted row can drift off
  // the bottom edge on long lists.
  useEffect(() => {
    if (!rootRef.current) return;
    const activeEl = rootRef.current.querySelector<HTMLDivElement>(".idea-mention-item.active");
    if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
  }, [activeIdx, visualHits]);

  // Close on outside click. The picker itself swallows its own events.
  useEffect(() => {
    const onDocDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, [onClose]);

  // Edge-flipping placement. Measure the picker after each layout pass and,
  // if the default (top-left glued to `@`'s bottom-right) would overflow
  // the right viewport edge, flip so the top-right is glued to `@`'s
  // bottom-left instead. Vertical flip is a safety net for overflow below
  // the fold.
  //
  // Runs in useLayoutEffect so the flipped coords are committed before
  // paint — no visible jump from the initial position.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const MARGIN = 8;    // keep-away from the viewport edge
    const width = el.offsetWidth;
    const height = el.offsetHeight;

    // Default: picker top-left at `@`'s bottom-right — glued to the glyph.
    let left = atRect.right;
    let top = atRect.bottom;

    if (left + width > window.innerWidth - MARGIN) {
      // Flip: picker top-right at `@`'s bottom-left — also glued, just on
      // the other side. Fall back to pinning to the left viewport edge if
      // even the flip wouldn't fit.
      const flipped = atRect.left - width;
      left = flipped >= MARGIN ? flipped : MARGIN;
    }

    if (top + height > window.innerHeight - MARGIN) {
      // Flip up: picker bottom at `@`'s top edge.
      const flipped = atRect.top - height;
      top = flipped >= MARGIN ? flipped : Math.max(MARGIN, window.innerHeight - height - MARGIN);
    }

    // Skip the setState if the result is unchanged — otherwise we'd churn
    // one extra render per keystroke (atRect reference changes even when
    // the pixel values don't).
    setPlacement(prev => (prev.left === left && prev.top === top ? prev : { left, top }));
  }, [atRect.left, atRect.right, atRect.top, atRect.bottom, visualHits.length, loading]);

  // Visual-order counter used to compute activeIdx during render. We walk
  // groups → items in order so `visualIdx` matches the flat `visualHits`
  // index produced above.
  let visualIdx = -1;

  return (
    <div
      ref={rootRef}
      className="idea-mention-picker"
      style={{ left: placement.left, top: placement.top }}
      onMouseDown={(e) => {
        // Stop propagation so clicks inside the picker don't register as
        // outside clicks in the editor's own handlers / close the picker.
        e.stopPropagation();
      }}
    >
      {loading && hits.length === 0 ? (
        <div className="idea-mention-empty">…</div>
      ) : visualHits.length === 0 ? (
        <div className="idea-mention-empty">{t("idea.mentionEmpty")}</div>
      ) : (
        groups.map(group => (
          <div key={group.label} className="idea-mention-group">
            <div className="idea-mention-group-label">{group.label}</div>
            {group.items.map(hit => {
              visualIdx += 1;
              const myIdx = visualIdx;
              return (
                <div
                  key={`${hit.type}-${hit.id}`}
                  className={`idea-mention-item${myIdx === activeIdx ? " active" : ""}`}
                  onMouseEnter={() => setActiveIdx(myIdx)}
                  onClick={() => onSelect(hit)}
                >
                  <span className="idea-mention-label">{hit.label}</span>
                </div>
              );
            })}
          </div>
        ))
      )}
    </div>
  );
}
