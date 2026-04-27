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
  /**
   * V2.2 (D1):picker 锚点角。
   *  - "below-right" (default):picker top-left = atRect bottom-right
   *  - "above-right" (新):picker bottom-left = atRect top-right —— ChatInput
   *    用,因为输入框在底部,picker 向上展开避免被裁
   */
  placement?: "below-right" | "above-right";
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
export default function MentionPicker({ workspaceId, query, atRect, onSelect, onClose, types, placement: placementMode = "below-right" }: Props) {
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
          // V2.9.3: 拿 20 个 hit 才能塞下 5 model + tables + tastes + ideas + demos
          limit: 20,
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
      : hit.type === "demo" ? t("idea.mentionDemo")
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
          // V2.9.5: 走到底部时 wrap 回 0,而不是 clamp 卡在末尾
          setActiveIdx(i => (i + 1) % visualHits.length);
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (visualHits.length > 0) {
          // V2.9.5: 走到顶部时 wrap 到末尾
          setActiveIdx(i => (i - 1 + visualHits.length) % visualHits.length);
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

    // V2.2 D1: 两种基础锚:
    //   - below-right (idea editor 默认):picker top-left = atRect bottom-right
    //   - above-right (chat input):picker bottom-left = atRect top-right
    let left: number;
    let top: number;
    if (placementMode === "above-right") {
      left = atRect.right;
      top = atRect.top - height; // picker bottom = atRect.top
    } else {
      left = atRect.right;
      top = atRect.bottom;
    }

    // 横向溢出 → 翻到 atRect 左侧
    if (left + width > window.innerWidth - MARGIN) {
      const flipped = atRect.left - width;
      left = flipped >= MARGIN ? flipped : MARGIN;
    }
    // 纵向溢出补救:
    //   above-right 模式下 top<MARGIN,再翻回下方
    //   below-right 模式下 top+height>vh,翻到上方
    if (placementMode === "above-right") {
      if (top < MARGIN) {
        const fallbackBelow = atRect.bottom;
        top = fallbackBelow + height < window.innerHeight - MARGIN ? fallbackBelow : MARGIN;
      }
    } else {
      if (top + height > window.innerHeight - MARGIN) {
        const flipped = atRect.top - height;
        top = flipped >= MARGIN ? flipped : Math.max(MARGIN, window.innerHeight - height - MARGIN);
      }
    }

    // Skip the setState if the result is unchanged — otherwise we'd churn
    // one extra render per keystroke (atRect reference changes even when
    // the pixel values don't).
    setPlacement(prev => (prev.left === left && prev.top === top ? prev : { left, top }));
  }, [atRect.left, atRect.right, atRect.top, atRect.bottom, visualHits.length, loading, placementMode]);

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
        // V2.9.13: preventDefault 阻止 mousedown 把 contentEditable 编辑器
        // blur 掉 —— 否则用户点选 item 时编辑器先失焦,handleMentionSelect
        // 在编辑器无焦点状态下插入 chip,Chrome contentEditable 重新获得焦点
        // 时 IME state 没初始化好,下一个键盘按键直接被 commit 成 literal
        // (拼音首字母被吞 bug)。stopPropagation 仍保留:不让 outside-click
        // handler 触发 picker close。
        e.preventDefault();
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
