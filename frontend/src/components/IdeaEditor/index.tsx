import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "../../i18n/index";
import { useToast } from "../Toast/index";
import InlineEdit from "../InlineEdit";
import { fetchIdea, saveIdeaContent } from "../../api";
import { useIdeaSync } from "../../hooks/useIdeaSync";
import MentionPicker from "./MentionPicker";
import MarkdownPreview from "./MarkdownPreview";
import type { MarkdownPreviewHandle, MentionQueryState } from "./MarkdownPreview";
import { buildMentionLink } from "./mentionSyntax";
import type { ParsedMention } from "./mentionSyntax";
import type { MentionHit } from "../../types";
import "./IdeaEditor.css";

interface Props {
  ideaId: string;
  ideaName: string;
  workspaceId: string;
  clientId: string;
  onRename: (name: string) => void;
  onNavigate: (target:
    | { type: "view";  tableId: string; viewId: string }
    | { type: "taste"; designId: string; tasteId: string }
    | { type: "idea";  id: string }
    | { type: "idea-section"; ideaId: string; headingSlug: string }
  ) => void;
}

// ─── Icons ───
const SOURCE_ICON = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const PREVIEW_ICON = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <path d="M1.5 8s2.5-5 6.5-5 6.5 5 6.5 5-2.5 5-6.5 5-6.5-5-6.5-5z" stroke="currentColor" strokeWidth="1.3" fill="none"/>
    <circle cx="8" cy="8" r="2" fill="currentColor"/>
  </svg>
);

const AUTOSAVE_DEBOUNCE_MS = 600;

type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "offline";

/** Module-level cache keyed by ideaId. Persists across IdeaEditor remounts
 * within a session so that switching sidebar artifacts and coming back feels
 * instant and drops the user at the exact scroll / caret position they left.
 *
 * Not a replacement for server persistence — the server remains the source
 * of truth (Prisma-backed Idea rows with version-based optimistic concurrency).
 * On cache hit we still fire a background fetch to reconcile with any SSE
 * updates we may have missed while unmounted.
 *
 * The `mode` + `scrollTop` (+ `caretPos` when source) portions also shadow
 * into localStorage via a secondary key. That half of the cache survives a
 * page reload; `content` / `version` don't (stale content across reloads
 * would be worse than a 200 ms re-fetch), so the in-memory map stays the
 * authoritative source within a single tab session and the localStorage
 * store only seeds `mode` + `scrollTop` + `caretPos` on cold start. */
interface IdeaCacheEntry {
  content: string;
  version: number;
  mode: "source" | "preview";
  scrollTop: number;
  /** Caret offset in source mode. Preview-mode caret restoration is
   * intentionally deferred — Range serialization across re-renders is brittle
   * and MarkdownPreview already places a caret at end on mount. */
  caretPos?: number;
}
const ideaCache = new Map<string, IdeaCacheEntry>();

/** Minimal serialisable view of an idea's view state that survives reloads. */
interface IdeaViewState {
  mode: "source" | "preview";
  scrollTop: number;
  caretPos?: number;
}

/* localStorage shape: `{ [ideaId]: IdeaViewState }`.
 * A single key keeps the API surface small and makes pruning easy. Kept
 * small enough to never approach localStorage's ~5 MB budget even for
 * thousands of ideas. */
const IDEA_VIEW_STATE_KEY = "idea_view_state_v1";

function readViewState(ideaId: string): IdeaViewState | null {
  try {
    const raw = localStorage.getItem(IDEA_VIEW_STATE_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw) as Record<string, IdeaViewState>;
    const entry = map[ideaId];
    if (!entry) return null;
    // Defensive — ignore corrupted shapes rather than crashing.
    if (entry.mode !== "source" && entry.mode !== "preview") return null;
    if (typeof entry.scrollTop !== "number") return null;
    return entry;
  } catch {
    return null;
  }
}

/** Return the viewport-pixel rect of the character at `index` inside the
 * textarea. Uses the "mirror div" trick: clone the textarea's box-model and
 * text content into a hidden div, wrap the single character in a `<span>`,
 * then map the span's rect back into the textarea's coord space, accounting
 * for scroll.
 *
 * Used by the @-mention picker to anchor itself tight to the rendered `@`
 * glyph regardless of caret column / line-wrap / scroll. Called at most
 * once per keystroke in an @-active state, so the cost of one layout read
 * on a detached mirror is acceptable. */
function measureTextareaCharRect(
  ta: HTMLTextAreaElement,
  index: number,
): { left: number; right: number; top: number; bottom: number } | null {
  if (index < 0 || index >= ta.value.length) return null;
  const style = window.getComputedStyle(ta);
  const mirror = document.createElement("div");
  // Copy every property that affects line-breaking + glyph metrics. Missing
  // any of these yields drift of 1–several px per line.
  const props: Array<keyof CSSStyleDeclaration> = [
    "boxSizing", "width", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
    "borderTopStyle", "borderRightStyle", "borderBottomStyle", "borderLeftStyle",
    "fontStyle", "fontVariant", "fontWeight", "fontStretch", "fontSize",
    "fontSizeAdjust", "lineHeight", "fontFamily",
    "textAlign", "textTransform", "textIndent", "textDecoration",
    "letterSpacing", "wordSpacing", "tabSize",
  ];
  for (const p of props) {
    (mirror.style as unknown as Record<string, string>)[p as string] =
      (style as unknown as Record<string, string>)[p as string];
  }
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.wordWrap = "break-word";
  mirror.style.overflow = "hidden";

  // Text up to (but not including) the character of interest, then a span
  // wrapping just that one character. Using Text nodes avoids any
  // HTML-parsing interpretation of the content.
  const pre = document.createTextNode(ta.value.substring(0, index));
  const span = document.createElement("span");
  span.textContent = ta.value[index] || "@";
  const post = document.createTextNode(ta.value.substring(index + 1));
  mirror.appendChild(pre);
  mirror.appendChild(span);
  mirror.appendChild(post);

  document.body.appendChild(mirror);
  try {
    const taRect = ta.getBoundingClientRect();
    const mirrorRect = mirror.getBoundingClientRect();
    const spanRect = span.getBoundingClientRect();
    // span position relative to mirror's top-left, minus textarea scroll.
    const relLeft = spanRect.left - mirrorRect.left - ta.scrollLeft;
    const relTop = spanRect.top - mirrorRect.top - ta.scrollTop;
    const left = taRect.left + relLeft;
    const top = taRect.top + relTop;
    return {
      left,
      right: left + spanRect.width,
      top,
      bottom: top + spanRect.height,
    };
  } finally {
    mirror.remove();
  }
}

function writeViewState(ideaId: string, v: IdeaViewState): void {
  try {
    const raw = localStorage.getItem(IDEA_VIEW_STATE_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, IdeaViewState>) : {};
    map[ideaId] = v;
    localStorage.setItem(IDEA_VIEW_STATE_KEY, JSON.stringify(map));
  } catch {
    // Quota / private mode — best-effort, ignore.
  }
}

export default function IdeaEditor({ ideaId, ideaName, workspaceId, clientId, onRename, onNavigate }: Props) {
  const { t } = useTranslation();
  const toast = useToast();

  // Seed initial state from the in-session cache when available so switching
  // back to an idea we've seen is instant (no loading flash, no scroll reset).
  // When the in-session cache is cold (fresh tab, first time viewing this
  // idea this session), fall back to the localStorage-persisted view state
  // so the user's last-seen mode + scroll survives reloads.
  const initialCache = ideaCache.get(ideaId);
  const initialView = initialCache ?? readViewState(ideaId);
  const [mode, setMode] = useState<"source" | "preview">(initialView?.mode ?? "source");
  const [content, setContent] = useState<string>(initialCache?.content ?? "");
  const [loaded, setLoaded] = useState<boolean>(!!initialCache);
  const [isEditingName, setIsEditingName] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>(initialCache ? "saved" : "idle");

  // Refs for scroll / caret capture on unmount → cache write.
  const bodyRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef(content);
  const modeRef = useRef(mode);
  useEffect(() => { contentRef.current = content; }, [content]);
  useEffect(() => { modeRef.current = mode; }, [mode]);

  // Server-confirmed version. Every PUT sends the last-known version and the
  // server bumps it atomically. Updated either by our save ACK or by an
  // incoming SSE content-change from another client.
  const versionRef = useRef<number>(0);
  const saveTimerRef = useRef<number | null>(null);

  // Textarea ref + caret state for @mention anchor computation. The state
  // shape is shared between source-mode (textarea-driven) and preview-mode
  // (MarkdownPreview-driven via onMentionQuery) — the picker doesn't care
  // which surface triggered it.
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<MarkdownPreviewHandle>(null);
  const [mentionState, setMentionState] = useState<
    | null
    | {
        /** Source of the trigger — determines which surface gets the
         * inserted link on pick. */
        origin: "source" | "preview";
        /** Position in `content` where the `@` character lives, so we can
         * replace `@query` on selection. */
        atIndex: number;
        query: string;
        /** Pixel rect of the `@` glyph. Picker anchors to bottom-right by
         * default, bottom-left when the default would overflow the viewport. */
        atRect: { left: number; right: number; top: number; bottom: number };
      }
  >(null);

  // ── Load on mount / when ideaId changes ──
  // Cache-first: if the idea is in the in-session cache, we already seeded
  // state above; just reconcile with the server in the background so any
  // changes made while we were unmounted surface. Otherwise do a normal
  // fetch and show the loading state.
  useEffect(() => {
    const cached = ideaCache.get(ideaId);
    setMentionState(null);

    // View state (mode + scroll + caret) lives in two tiers: the in-session
    // Map (instant, full fidelity) and localStorage (survives reloads, view
    // state only — no content). Prefer the in-session entry; fall back to
    // the persisted one so a fresh tab still opens the idea in whatever
    // mode + scroll the user left it in.
    const persistedView = cached ? null : readViewState(ideaId);

    if (cached) {
      // Seed already applied via useState initializers. Version lives on a
      // ref — seed it here.
      versionRef.current = cached.version;
      // Restore scroll + caret after the first paint.
      requestAnimationFrame(() => {
        if (bodyRef.current) bodyRef.current.scrollTop = cached.scrollTop;
        if (cached.mode === "source" && typeof cached.caretPos === "number") {
          const ta = textareaRef.current;
          if (ta) {
            ta.focus();
            ta.setSelectionRange(cached.caretPos, cached.caretPos);
          }
        }
      });
    } else {
      setLoaded(false);
      setContent("");
      // Cold mount: the useState initializer already read `persistedView.mode`
      // if present. Reset to "source" only when there's nothing to restore.
      if (!persistedView) setMode("source");
      setSaveStatus("idle");
      versionRef.current = 0;

      // Scroll needs to wait until after the server content paints — a cold
      // mount renders with content="", then re-renders when fetchIdea resolves.
      // We restore scroll after the next fetch-driven paint via an additional
      // rAF inside the fetch `.then` below.
    }

    let alive = true;
    fetchIdea(ideaId)
      .then(idea => {
        if (!alive) return;
        const serverVersion = idea.version ?? 0;
        // Only overwrite the editor if the server is ahead of what we have
        // cached / last saved — avoids clobbering in-flight local edits.
        if (serverVersion >= versionRef.current) {
          setContent(idea.content || "");
          versionRef.current = serverVersion;
        }
        setLoaded(true);
        // Cold-mount scroll restore: now that content paints, nudge scroll
        // back to where the user left it last session.
        if (persistedView) {
          requestAnimationFrame(() => {
            if (bodyRef.current) bodyRef.current.scrollTop = persistedView.scrollTop;
            if (persistedView.mode === "source" && typeof persistedView.caretPos === "number") {
              const ta = textareaRef.current;
              if (ta) {
                ta.focus();
                ta.setSelectionRange(persistedView.caretPos, persistedView.caretPos);
              }
            }
          });
        }
      })
      .catch(err => {
        if (!alive) return;
        console.warn("[IdeaEditor] failed to load:", err);
        setLoaded(true);
      });

    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ideaId]);

  // ── Snapshot state into the in-session cache on unmount / ideaId switch ──
  // Placed after the loader so it runs on the ideaId-change cleanup pass and
  // when the editor unmounts (user navigates away to a table / design).
  // We also mirror the view-state slice (mode + scrollTop + caretPos) into
  // localStorage so the user's last-selected mode and scroll position
  // survive a page reload.
  useEffect(() => {
    return () => {
      const scrollTop = bodyRef.current?.scrollTop ?? 0;
      const caretPos = modeRef.current === "source"
        ? textareaRef.current?.selectionStart ?? undefined
        : undefined;
      ideaCache.set(ideaId, {
        content: contentRef.current,
        version: versionRef.current,
        mode: modeRef.current,
        scrollTop,
        caretPos,
      });
      writeViewState(ideaId, { mode: modeRef.current, scrollTop, caretPos });
    };
  }, [ideaId]);

  // ── Debounced view-state write — keeps localStorage fresh without the
  // unmount path being the only persistence point. That matters for the
  // reload case: if the user changes mode and then hard-reloads without
  // switching artifacts first, the unmount snapshot runs too late (the tab
  // is already gone). Writing on mode change + scroll debounced gives us a
  // durable snapshot even in that scenario. ──
  useEffect(() => {
    writeViewState(ideaId, {
      mode,
      scrollTop: bodyRef.current?.scrollTop ?? 0,
      caretPos: mode === "source" ? textareaRef.current?.selectionStart ?? undefined : undefined,
    });
  }, [ideaId, mode]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    let timer: number | null = null;
    const onScroll = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        writeViewState(ideaId, {
          mode: modeRef.current,
          scrollTop: body.scrollTop,
          caretPos: modeRef.current === "source"
            ? textareaRef.current?.selectionStart ?? undefined
            : undefined,
        });
      }, 250);
    };
    body.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      body.removeEventListener("scroll", onScroll);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [ideaId]);

  // ── Autosave: debounce-per-keystroke, last-writer-wins ──
  // `dirtyRef` tracks whether there are unsaved edits since the last ACKed
  // save. Used by the unmount path to decide whether a flush is needed —
  // without it we'd either skip legitimate flushes (if keying off saveStatus
  // alone, which is stale across closure boundaries) or fire spurious
  // empty-content saves (the bug that was wiping ideas on switch).
  const dirtyRef = useRef(false);

  const flushSave = useCallback(async (text: string) => {
    setSaveStatus("saving");
    try {
      const res = await saveIdeaContent(ideaId, text, versionRef.current);
      if ("conflict" in res && res.conflict) {
        // Another client saved while we were typing. Accept server state;
        // toast the user so they notice the switcheroo. Follow-up save will
        // carry the new version.
        versionRef.current = res.latest.version;
        setContent(res.latest.content);
        // Server state is now in hand — no local dirt remaining.
        dirtyRef.current = false;
        setSaveStatus("saved");
        toast.info(t("toast.ideaConflict"));
      } else if ("ok" in res) {
        versionRef.current = res.version;
        // Only clear the dirty flag if no keystroke snuck in between when
        // we started this save and now — otherwise the next save cycle must
        // still fire. We detect that by comparing against contentRef.
        if (contentRef.current === text) dirtyRef.current = false;
        setSaveStatus("saved");
      }
    } catch (err) {
      console.warn("[IdeaEditor] save failed:", err);
      setSaveStatus("offline");
    }
  }, [ideaId, toast, t]);

  const scheduleSave = useCallback((text: string) => {
    dirtyRef.current = true;
    setSaveStatus("dirty");
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      // Clear the timer handle the moment we fire — so the unmount cleanup
      // below keys off the actual pending-timer state, not a stale handle
      // left over from an already-completed debounce.
      saveTimerRef.current = null;
      void flushSave(text);
    }, AUTOSAVE_DEBOUNCE_MS);
  }, [flushSave]);

  // Flush any pending edits on unmount / idea switch. With `key={ideaId}` in
  // the parent, this effect runs exactly once per mount and its cleanup
  // captures a *closure over the initial render* — meaning the old
  // `saveIdeaContent(ideaId, content, …)` wrote the INITIAL content (empty
  // for fresh mounts) to the server on every switch, wiping user edits. Fix
  // is twofold:
  //   1) Read the live content from `contentRef.current` (updated on every
  //      content change) instead of the stale closure value.
  //   2) Guard on `dirtyRef.current` so we only flush when there are actual
  //      unsaved edits — a dangling `saveTimerRef` isn't reliable because
  //      the debounced timeout could have already fired and completed the
  //      save, yet an un-nulled handle would still trick the cleanup into
  //      re-saving.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (dirtyRef.current) {
        // Fire-and-forget; no state updates possible after unmount.
        void saveIdeaContent(ideaId, contentRef.current, versionRef.current).catch(() => {});
        dirtyRef.current = false;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ideaId]);

  // ── SSE: apply remote content changes when we're not actively editing ──
  useIdeaSync(ideaId, clientId, {
    onContentChange: useCallback((remoteContent: string, remoteVersion: number) => {
      // If we have unsaved local edits, skip overwriting — the user is
      // mid-stroke (or mid-save). Their next save will surface a conflict,
      // handled via the 409 path in flushSave. Keying off `dirtyRef` (not
      // `saveTimerRef`) is correct because the debounce handle is cleared
      // when the timeout fires, but the in-flight save still counts as
      // "typing" from the remote-sync perspective.
      if (dirtyRef.current) return;
      setContent(remoteContent);
      versionRef.current = remoteVersion;
    }, []),
    onRename: useCallback((name: string) => {
      // Parent handles the sidebar + header label via workspace SSE — this
      // handler exists so we could show a "renamed by X" toast later if
      // desired. For now, keep it a no-op.
      void name;
    }, []),
  });

  // ── Keyboard: Cmd/Ctrl+/ toggles mode ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        setMode(m => (m === "source" ? "preview" : "source"));
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // ── @mention detection ──
  // On every change, if the caret sits right after an `@<query>` with no
  // whitespace between, we open the picker. The picker lives in document
  // coords positioned at the `@` glyph's pixel rect.
  //
  // Boundary rule: `@` ALWAYS triggers (no email guard). The old guard
  // (`[A-Za-z0-9_]@` = email pattern, suppress) wrongly blocked the common
  // case of typing `Heading@` — the user wants to mention directly after
  // existing text without a leading space. Notion / Slack / Linear all do
  // the same: any `@` opens the picker, and a genuine email keystroke like
  // `a@b.com` just surfaces a no-hit picker that Esc / click-away closes.
  //
  // The walk-back stops at the FIRST `@` it sees, valid or not. Previously
  // it would fall through past an invalid `@` and hunt for an earlier one,
  // which occasionally surfaced stale matches and made triggering feel
  // unreliable.
  const detectMention = useCallback((text: string, caret: number) => {
    let i = caret - 1;
    while (i >= 0) {
      const ch = text[i];
      if (ch === "@") {
        const query = text.slice(i + 1, caret);
        if (/[\n\r]/.test(query)) {
          setMentionState(null);
          return;
        }
        const ta = textareaRef.current;
        if (!ta) return;
        const atRect = measureTextareaCharRect(ta, i);
        if (!atRect) return;
        setMentionState({
          origin: "source",
          atIndex: i,
          query,
          atRect,
        });
        return;
      }
      // Whitespace / newline closes the @-context.
      if (/\s/.test(ch)) break;
      i--;
    }
    setMentionState(null);
  }, []);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value;
    const caret = e.target.selectionStart ?? text.length;
    setContent(text);
    detectMention(text, caret);
    scheduleSave(text);
  }, [detectMention, scheduleSave]);

  /** Preview-mode mention trigger. MarkdownPreview fires this whenever the
   * caret sits after an `@<query>` sequence (or null when that's no longer
   * true). Coords arrive in viewport pixels. */
  const handlePreviewMentionQuery = useCallback((state: MentionQueryState | null) => {
    if (!state) {
      setMentionState(cur => (cur?.origin === "preview" ? null : cur));
      return;
    }
    setMentionState({
      origin: "preview",
      atIndex: state.atIndex,
      query: state.query,
      atRect: state.atRect,
    });
  }, []);

  // Preview mode (contentEditable) edits — innerText round-trips into the
  // source buffer. Rich markdown structure (headings, lists, etc.) degrades
  // to plain text on edit; users who need precise edits switch to Source.
  // Mention chips survive because they're `contentEditable={false}`.
  const handlePreviewInput = useCallback((text: string) => {
    setContent(text);
    scheduleSave(text);
  }, [scheduleSave]);

  // Auto-grow textarea so the outer body scrolls instead of an inner
  // scrollbar — matches the user's request "高度应该是全局滚动".
  useEffect(() => {
    if (mode !== "source") return;
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, [content, mode, loaded]);

  const handleMentionSelect = useCallback((hit: MentionHit) => {
    if (!mentionState) return;
    const link = buildMentionLink(hit);

    if (mentionState.origin === "preview") {
      // Preview mode — MarkdownPreview splices the link into the source at
      // the reported offset; the resulting re-render turns it into a chip.
      previewRef.current?.insertMention(link, mentionState.atIndex, mentionState.query.length);
      setMentionState(null);
      return;
    }

    // Source mode — plain-text textarea edit.
    if (!textareaRef.current) return;
    const ta = textareaRef.current;
    const before = content.slice(0, mentionState.atIndex);
    const after = content.slice(mentionState.atIndex + 1 + mentionState.query.length);
    const next = `${before}${link} ${after}`;
    const caret = before.length + link.length + 1; // +1 for the trailing space
    setContent(next);
    setMentionState(null);
    scheduleSave(next);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(caret, caret);
    });
  }, [content, mentionState, scheduleSave]);

  const handleMentionChipClick = useCallback((m: ParsedMention) => {
    if (m.type === "view" && m.tableId) {
      onNavigate({ type: "view", tableId: m.tableId, viewId: m.id });
    } else if (m.type === "taste" && m.designId) {
      onNavigate({ type: "taste", designId: m.designId, tasteId: m.id });
    } else if (m.type === "idea") {
      onNavigate({ type: "idea", id: m.id });
    } else if (m.type === "idea-section" && m.ideaId) {
      // id of an idea-section chip is the heading slug.
      onNavigate({ type: "idea-section", ideaId: m.ideaId, headingSlug: m.id });
    }
  }, [onNavigate]);

  // ── Scroll to heading when navigated via an idea-section mention ──
  // Handles two cases:
  //   (a) the same IdeaEditor is already mounted for the target idea — we
  //       get a `idea-anchor` window event and scroll immediately;
  //   (b) the IdeaEditor is mounting fresh for the idea — we read the
  //       `__pendingIdeaAnchor` sentinel (set just before the activeTableId
  //       state change) once content has loaded.
  const scrollToHeading = useCallback((slug: string) => {
    // Preview mode is required to find the heading by id. If we're in source
    // mode, auto-switch so the anchor can resolve. This matches user intent:
    // clicking a section chip implies "show me that section".
    setMode("preview");
    // Allow one render + double-rAF so MarkdownPreview has painted.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const root = bodyRef.current;
        if (!root) return;
        const el = root.querySelector<HTMLElement>(`#${CSS.escape(slug)}`);
        if (!el) return;
        // Offset scroll so the heading sits ~60px from the top — matches the
        // body's natural top padding so the heading lines up with "normal"
        // reading position after a jump.
        const bodyRect = root.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        root.scrollTop += (elRect.top - bodyRect.top) - 60;
        // Subtle highlight via a CSS flash class (defined in IdeaEditor.css).
        el.classList.remove("idea-heading-flash");
        // Force reflow so the re-added class re-triggers the animation.
        void el.offsetWidth;
        el.classList.add("idea-heading-flash");
      });
    });
  }, []);

  useEffect(() => {
    // Case (a): live event for the currently-mounted editor.
    const onAnchor = (e: Event) => {
      const detail = (e as CustomEvent<{ ideaId: string; slug: string }>).detail;
      if (!detail || detail.ideaId !== ideaId) return;
      scrollToHeading(detail.slug);
    };
    window.addEventListener("idea-anchor", onAnchor);
    return () => window.removeEventListener("idea-anchor", onAnchor);
  }, [ideaId, scrollToHeading]);

  useEffect(() => {
    // Case (b): cold-mount pickup — once content is loaded, check the
    // window-scoped sentinel. Consume it (delete) so we don't re-scroll on
    // subsequent re-renders.
    if (!loaded) return;
    const w = window as unknown as { __pendingIdeaAnchor?: { ideaId: string; slug: string } };
    const pending = w.__pendingIdeaAnchor;
    if (!pending || pending.ideaId !== ideaId) return;
    delete w.__pendingIdeaAnchor;
    scrollToHeading(pending.slug);
  }, [loaded, ideaId, scrollToHeading]);

  // ── Status label ──
  const statusLabel = (() => {
    if (!loaded) return t("idea.loading");
    if (saveStatus === "saving") return t("idea.saving");
    if (saveStatus === "saved") return t("idea.saved");
    if (saveStatus === "dirty") return t("idea.unsaved");
    if (saveStatus === "offline") return t("idea.offline");
    return "";
  })();

  return (
    <div className="idea-editor-panel">
      {/* ─── Top Bar (mirrors SvgCanvas: name left, actions right) ─── */}
      <div className="idea-editor-topbar">
        <span className="idea-editor-topbar-name">
          <InlineEdit
            value={ideaName}
            isEditing={isEditingName}
            onStartEdit={() => setIsEditingName(true)}
            onSave={(name) => {
              setIsEditingName(false);
              onRename(name);
            }}
            onCancelEdit={() => setIsEditingName(false)}
          />
        </span>
        <div className="idea-editor-topbar-actions">
          {statusLabel && <span className="idea-editor-status">{statusLabel}</span>}
          {/* Single view-bar toggle — shows only the destination mode.
           * In Source view, the button reads "Preview"; click to switch. */}
          <button
            className="idea-editor-topbar-btn"
            onClick={() => setMode(m => (m === "source" ? "preview" : "source"))}
            title={t("idea.toggleHint")}
          >
            {mode === "source" ? PREVIEW_ICON : SOURCE_ICON}
            {mode === "source" ? t("idea.preview") : t("idea.source")}
          </button>
        </div>
      </div>

      {/* ─── Body — single scroll container for both modes ─── */}
      <div className="idea-editor-body" ref={bodyRef}>
        {!loaded ? (
          <div className="idea-editor-loading">{t("idea.loading")}</div>
        ) : mode === "source" ? (
          <div className="idea-editor-source">
            <textarea
              ref={textareaRef}
              className="idea-editor-textarea"
              value={content}
              onChange={handleChange}
              onKeyUp={(e) => {
                // Arrow keys / clicks move the caret without firing change —
                // recompute mention detection so the picker closes when the
                // caret leaves an `@…` span.
                const caret = (e.target as HTMLTextAreaElement).selectionStart ?? 0;
                detectMention(content, caret);
              }}
              onMouseUp={(e) => {
                const caret = (e.target as HTMLTextAreaElement).selectionStart ?? 0;
                detectMention(content, caret);
              }}
              onCopy={() => {
                // Defensive: after a native Cmd/Ctrl+C, ensure the textarea
                // keeps focus + selection so the caret stays visible for
                // continued copying or typing. A concurrent `setSaveStatus`
                // re-render (from an in-flight autosave debounce) can race
                // the copy on some browsers and drop focus; restoring in
                // rAF covers that.
                const ta = textareaRef.current;
                if (!ta) return;
                const start = ta.selectionStart;
                const end = ta.selectionEnd;
                requestAnimationFrame(() => {
                  if (!textareaRef.current) return;
                  if (document.activeElement !== textareaRef.current) {
                    textareaRef.current.focus({ preventScroll: true });
                  }
                  // Restoring selection range is idempotent when already set.
                  if (
                    textareaRef.current.selectionStart !== start ||
                    textareaRef.current.selectionEnd !== end
                  ) {
                    textareaRef.current.setSelectionRange(start, end);
                  }
                });
              }}
              placeholder={t("idea.empty")}
              spellCheck={false}
            />
          </div>
        ) : (
          <MarkdownPreview
            ref={previewRef}
            source={content}
            onMentionClick={handleMentionChipClick}
            editable
            onEditableInput={handlePreviewInput}
            placeholder={t("idea.empty")}
            onMentionQuery={handlePreviewMentionQuery}
          />
        )}
      </div>

      {/* ─── Mention picker — works for both source and preview modes.
       * The picker itself is origin-agnostic; `handleMentionSelect` routes
       * the completion to the right surface based on `mentionState.origin`. */}
      {mentionState && (
        <MentionPicker
          workspaceId={workspaceId}
          query={mentionState.query}
          atRect={mentionState.atRect}
          onSelect={handleMentionSelect}
          onClose={() => setMentionState(null)}
        />
      )}
    </div>
  );
}
