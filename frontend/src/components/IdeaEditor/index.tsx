import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "../../i18n/index";
import { useToast } from "../Toast/index";
import InlineEdit from "../InlineEdit";
import SidebarExpandButton from "../SidebarExpandButton";
import BlockCloseButton from "../BlockCloseButton";
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

/** Return the viewport-pixel rect of the caret itself inside the textarea at
 * the given source offset. Unlike `measureTextareaCharRect`, this works when
 * the caret sits at end-of-text (offset === length) because we insert a
 * zero-width marker rather than wrapping an existing character.
 *
 * Used by the caret-follow autoscroll: when the textarea auto-grows, the
 * outer `.idea-editor-body` is the scroll container, so the browser's native
 * "keep caret in view" behavior doesn't kick in on its own — we need to
 * nudge the body's scrollTop ourselves. */
function measureTextareaCaretRect(
  ta: HTMLTextAreaElement,
  caret: number,
): { left: number; top: number; bottom: number; height: number } | null {
  const style = window.getComputedStyle(ta);
  const mirror = document.createElement("div");
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

  const safeCaret = Math.max(0, Math.min(caret, ta.value.length));
  const pre = document.createTextNode(ta.value.substring(0, safeCaret));
  const marker = document.createElement("span");
  // ZWSP gives the span a rect with the current line's height without
  // affecting visible text shaping.
  marker.textContent = "\u200b";
  const post = document.createTextNode(ta.value.substring(safeCaret));
  mirror.appendChild(pre);
  mirror.appendChild(marker);
  mirror.appendChild(post);

  document.body.appendChild(mirror);
  try {
    const taRect = ta.getBoundingClientRect();
    const mirrorRect = mirror.getBoundingClientRect();
    const markerRect = marker.getBoundingClientRect();
    const relLeft = markerRect.left - mirrorRect.left - ta.scrollLeft;
    const relTop = markerRect.top - mirrorRect.top - ta.scrollTop;
    const top = taRect.top + relTop;
    // Fall back to computed line-height if the ZWSP's own height collapses
    // on some browsers.
    const height = markerRect.height || parseFloat(style.lineHeight) || 20;
    return {
      left: taRect.left + relLeft,
      top,
      bottom: top + height,
      height,
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

  // ── V2 streaming write state ────────────────────────────────────────────
  // When the Agent opens a stream-write session against this idea, we enter
  // soft-lock mode: autosave is suspended (the server rejects concurrent user
  // saves with 423 anyway, but we suppress them locally to avoid spurious
  // save-status flicker), the editor renders read-only, and every delta is
  // spliced into `content` so the user sees the write unfold live. On
  // finalize we swap to the authoritative server content.
  //
  // We keep three refs instead of state because splicing happens faster than
  // React's commit cycle — accumulating through a ref + a single `setContent`
  // per delta avoids batched-render stalls on fast chunk streams.
  const [streaming, setStreaming] = useState<boolean>(false);
  const streamBaseRef = useRef<string>("");           // snapshot of content at begin
  const streamStartOffsetRef = useRef<number>(0);     // where in streamBase to splice
  const streamBufferRef = useRef<string>("");         // accumulated deltas so far
  const streamSessionIdRef = useRef<string | null>(null);
  // Stream-follow state: when true, every delta nudges bodyRef.scrollTop so the
  // tail of the written text stays in view. Reset to true on each new session
  // (stream-begin); flipped to false when the user manually scrolls anywhere
  // other than the exact bottom. Flipped back to true when they scroll all the
  // way to the bottom (≤ 4 px epsilon for sub-pixel tolerance).
  const streamFollowRef = useRef<boolean>(true);
  // Tracks the scrollTop value we last set programmatically (post-clamp). The
  // detach-detection scroll handler compares body.scrollTop against this to
  // decide whether a fired scroll event was our own programmatic scroll or a
  // real user gesture. Robust to event coalescing — if the user scrolls in
  // the same frame as our auto-scroll, scrollTop !== lastAutoScrollTop and we
  // correctly classify as user intent. A time-based flag (as in the previous
  // version) would drop the user's scroll entirely in that same-frame case.
  const lastAutoScrollTopRef = useRef<number | null>(null);

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
    // Suspend autosave while the Agent is mid-stream. The deltas are written
    // server-side atomically on finalize, and PUT /:id/content would 423 anyway
    // while locked; suppressing the attempt locally keeps the status bar clean.
    if (streamSessionIdRef.current) return;
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

    // ── V2 streaming write handlers ─────────────────────────────────────
    onStreamBegin: useCallback((p: { sessionId: string; startOffset: number }) => {
      // Cancel any pending autosave — we don't want a stale timer firing
      // while the server is locked for the Agent's stream.
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      dirtyRef.current = false;
      streamSessionIdRef.current = p.sessionId;
      streamBaseRef.current = contentRef.current;
      // Clamp offset defensively — a stale offset could over-run the buffer
      // after a local edit that the server hasn't yet acknowledged.
      streamStartOffsetRef.current = Math.min(p.startOffset, contentRef.current.length);
      streamBufferRef.current = "";
      // Fresh session → re-arm auto-follow regardless of how the previous
      // session ended. If the user scrolled up last time, this new session
      // deserves a clean slate.
      streamFollowRef.current = true;
      lastAutoScrollTopRef.current = null;
      setStreaming(true);
      setSaveStatus("saved"); // hide "dirty" indicator during stream
    }, []),

    onStreamDelta: useCallback((p: { sessionId: string; delta: string }) => {
      // Defensive: ignore deltas that don't match the currently-tracked
      // session. Can happen if a stale in-flight SSE message arrives after
      // a new session was opened + closed.
      if (streamSessionIdRef.current !== p.sessionId) return;
      streamBufferRef.current += p.delta;
      const base = streamBaseRef.current;
      const off = streamStartOffsetRef.current;
      const next = base.slice(0, off) + streamBufferRef.current + base.slice(off);
      setContent(next);
    }, []),

    onStreamFinalize: useCallback(
      (p: { sessionId: string; discarded: boolean; finalContent: string; newVersion: number }) => {
        if (streamSessionIdRef.current !== p.sessionId) return;
        // On commit we take the authoritative server content (which may have
        // surrounding newlines added by applyIdeaWrite that the naive splice
        // didn't); on discard we roll back to the pre-stream snapshot.
        setContent(p.finalContent);
        versionRef.current = p.newVersion;
        streamSessionIdRef.current = null;
        streamBaseRef.current = "";
        streamBufferRef.current = "";
        streamStartOffsetRef.current = 0;
        setStreaming(false);
        // Force the saved badge — the content is in sync with the server.
        dirtyRef.current = false;
        setSaveStatus("saved");
      },
      []
    ),
  });

  // ── Mode toggle with caret + scroll preservation ──
  // When the user flips between Source (textarea) and Preview
  // (contentEditable), we carry the caret over to roughly the same byte in
  // the markdown source so they land where they left off. The two surfaces
  // use different caret models:
  //   • Source: textarea.selectionStart — already a source-buffer offset.
  //   • Preview: MarkdownPreview.getCaretSourceOffset() walks the DOM to
  //     recover the offset from the rendered tree.
  //
  // Scroll preservation is just as important. The body is a single scroll
  // container shared by both modes, but its content HEIGHT changes on
  // toggle: preview mode renders rich markdown (can be tall), source mode
  // starts at the textarea's min-height=200px and only reaches full height
  // AFTER the auto-grow useEffect fires. Between React's mode commit and
  // the auto-grow, the scrollable area temporarily shrinks and the browser
  // clamps scrollTop toward 0. We snapshot bodyRef.scrollTop pre-toggle and
  // restore it after the double-rAF (which lets React commit + the
  // auto-grow effect run), so the user stays anchored.
  //
  // `preventScroll: true` on focus is belt-and-suspenders: without it
  // focusing a just-mounted textarea (or a now-taller contentEditable)
  // would scroll the textarea into view, undoing the scrollTop restore.
  const toggleMode = useCallback(() => {
    const fromMode = modeRef.current;
    let capturedOffset: number | null = null;
    if (fromMode === "source") {
      capturedOffset = textareaRef.current?.selectionStart ?? null;
    } else {
      capturedOffset = previewRef.current?.getCaretSourceOffset() ?? null;
    }
    const savedScrollTop = bodyRef.current?.scrollTop ?? 0;
    const nextMode = fromMode === "source" ? "preview" : "source";
    setMode(nextMode);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        // Restore scroll first — if content height shrunk it may have
        // clamped, so setting again after layout has settled pins it.
        if (bodyRef.current) bodyRef.current.scrollTop = savedScrollTop;
        if (capturedOffset === null) return;
        if (nextMode === "source") {
          const ta = textareaRef.current;
          if (!ta) return;
          const pos = Math.max(0, Math.min(capturedOffset, ta.value.length));
          try {
            ta.focus({ preventScroll: true });
            ta.setSelectionRange(pos, pos);
          } catch { /* ignore */ }
          // Re-pin scroll — setSelectionRange on some browsers nudges the
          // textarea into view. A second assignment after is cheap insurance.
          if (bodyRef.current) bodyRef.current.scrollTop = savedScrollTop;
        } else {
          previewRef.current?.setCaretFromSourceOffset(capturedOffset);
          if (bodyRef.current) bodyRef.current.scrollTop = savedScrollTop;
        }
      });
    });
  }, []);

  // ── Keyboard: Cmd/Ctrl+/ toggles mode ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        toggleMode();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [toggleMode]);

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

  // ── Caret-follow autoscroll ──
  // The textarea auto-grows to fit its content, so it has no internal scroll
  // — the outer `.idea-editor-body` is what scrolls. That means the browser's
  // native "keep the caret in view while typing" behavior doesn't fire: the
  // caret is always inside the textarea's own box, there's nothing to scroll
  // from the browser's POV. As a result, typing past the bottom of the
  // viewport visually left the caret behind (it kept moving down the ever-
  // taller textarea while the page stayed pinned at the top).
  //
  // Fix: after every content change + after arrow-key / click navigation,
  // measure the caret's viewport rect (via the mirror-div trick in
  // `measureTextareaCaretRect`) and nudge `bodyRef.scrollTop` just enough to
  // keep the caret inside a comfortable band — away from the very top/bottom
  // of the scroll container.
  //
  // Only runs when the textarea is actually focused, so SSE-driven remote
  // content updates (which call `setContent` without user focus) don't yank
  // the reader's scroll position.
  const ensureCaretVisible = useCallback(() => {
    const body = bodyRef.current;
    const ta = textareaRef.current;
    if (!body || !ta) return;
    if (document.activeElement !== ta) return;
    const caret = ta.selectionStart ?? ta.value.length;
    const rect = measureTextareaCaretRect(ta, caret);
    if (!rect) return;
    const bodyRect = body.getBoundingClientRect();
    // Leave ~1 line of breathing room above and below so the caret never
    // hugs the edge. 48px is roughly two line-heights at our 14px body font.
    const MARGIN = 48;
    if (rect.bottom > bodyRect.bottom - MARGIN) {
      body.scrollTop += rect.bottom - (bodyRect.bottom - MARGIN);
    } else if (rect.top < bodyRect.top + MARGIN) {
      body.scrollTop -= (bodyRect.top + MARGIN) - rect.top;
    }
  }, []);

  // Auto-grow textarea so the outer body scrolls instead of an inner
  // scrollbar — matches the user's request "高度应该是全局滚动".
  // The caret-follow has to run *after* the height assignment so the
  // mirror-div measurement sees the final textarea width (unchanged here,
  // but we also want layout to have settled before reading getBoundingClientRect).
  useEffect(() => {
    if (mode !== "source") return;
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
    // rAF so the assignment above is reflected in layout before we measure.
    requestAnimationFrame(() => ensureCaretVisible());
  }, [content, mode, loaded, ensureCaretVisible]);

  // ── Stream-follow autoscroll ──
  // While the Agent is writing into this idea, the textarea is readOnly (so
  // `ensureCaretVisible` no-ops because it requires focus) and the body is
  // the scroll container. Without an explicit follow, new deltas just push
  // the tail off the bottom of the viewport and the user can't see what's
  // being written. After every `content` change during a stream we locate
  // the tail of the written region (`startOffset + buffer.length`), measure
  // its pixel rect, and nudge `bodyRef.scrollTop` down if the tail has
  // slipped past the bottom margin. Works in both modes:
  //   • Source: mirror-div-based caret rect via `measureTextareaCaretRect`.
  //   • Preview: walk `[data-md-start]` blocks to find the one containing
  //     the tail, then use its DOM rect.
  //
  // We only ever scroll DOWN — auto-scrolling UP during a stream would feel
  // like we're yanking the user away from earlier content they want to
  // read. If the user manually scrolls up enough to leave the "near-tail"
  // band, we set `streamFollowRef = false` and stop nudging until they
  // scroll back near the tail.
  useEffect(() => {
    if (!streaming) return;
    if (!streamFollowRef.current) return;
    const body = bodyRef.current;
    if (!body) return;
    const tail = streamStartOffsetRef.current + streamBufferRef.current.length;
    const MARGIN = 80;

    // Double rAF so we measure AFTER the auto-grow effect above has written
    // the new height (source mode) or after MarkdownPreview has re-rendered
    // (preview mode).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        // RE-CHECK follow INSIDE the double-rAF. The user may have scrolled
        // during the wait between the effect firing and this callback — the
        // sync check at the top of the effect is stale by the time we reach
        // here. Without this, a user scroll-up mid-stream would be fought
        // back down by our own auto-scroll on the same frame.
        if (!streamFollowRef.current) return;
        const bodyRect = body.getBoundingClientRect();
        let tailBottom: number | null = null;

        if (mode === "source") {
          const ta = textareaRef.current;
          if (!ta) return;
          const rect = measureTextareaCaretRect(ta, tail);
          if (!rect) return;
          tailBottom = rect.bottom;
        } else {
          // Find the block that contains the tail offset; fall back to the
          // last block before the tail if none contains it exactly.
          const blocks = body.querySelectorAll<HTMLElement>("[data-md-start]");
          let target: HTMLElement | null = null;
          for (let i = 0; i < blocks.length; i++) {
            const b = blocks[i];
            const s = Number(b.getAttribute("data-md-start"));
            const e = Number(b.getAttribute("data-md-end"));
            if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
            if (tail >= s && tail <= e) { target = b; break; }
            if (tail >= s) target = b;
          }
          if (!target && blocks.length > 0) target = blocks[blocks.length - 1];
          if (!target) return;
          tailBottom = target.getBoundingClientRect().bottom;
        }

        if (tailBottom == null) return;
        const delta = tailBottom - (bodyRect.bottom - MARGIN);
        if (delta <= 0) return; // tail already in view — no nudge needed
        // Final re-check just before the mutation — paranoia-cheap, closes
        // the narrow window where a user scroll event could have fired
        // between our measurement and the scrollTop assignment.
        if (!streamFollowRef.current) return;
        body.scrollTop += delta;
        // Record the actual post-clamp scrollTop so the detach handler can
        // tell "this scroll event was me" from "this was the user".
        lastAutoScrollTopRef.current = body.scrollTop;
      });
    });
  }, [content, streaming, mode]);

  // Detach detection — user-scroll priority. Rules:
  //   1. User's manual scroll always wins. Any manual scroll that doesn't
  //      land at the very bottom detaches follow immediately, regardless of
  //      direction (up or down-but-not-to-bottom both count).
  //   2. If the user hasn't scrolled at all this session, follow remains on
  //      (default from onStreamBegin).
  //   3. If the user scrolls all the way to the bottom, follow re-engages —
  //      reaching the bottom is the explicit "I want to keep up" gesture.
  //
  // To separate our own scrolls from user scrolls we compare body.scrollTop
  // against the value we last programmatically assigned. This is robust to
  // browser scroll-event coalescing — if the user wheels in the same frame
  // as our auto-scroll, the single coalesced event arrives with a scrollTop
  // that doesn't match our recorded target, so we correctly classify it as
  // user intent. The previous time-gated flag approach would have dropped
  // the user's scroll in that case.
  useEffect(() => {
    if (!streaming) return;
    const body = bodyRef.current;
    if (!body) return;
    const onScroll = () => {
      // "Ours" when the current scrollTop matches what we set (within 1 px to
      // tolerate sub-pixel rendering). Consume the marker so the NEXT scroll
      // event — necessarily user-driven — is classified correctly.
      if (
        lastAutoScrollTopRef.current !== null &&
        Math.abs(body.scrollTop - lastAutoScrollTopRef.current) < 1
      ) {
        lastAutoScrollTopRef.current = null;
        return;
      }
      // User-driven scroll (or a coalesced event where the user also acted).
      // Invalidate the programmatic-scroll marker so a later coincidence
      // can't silently treat a user scroll as ours.
      lastAutoScrollTopRef.current = null;
      // A small epsilon handles sub-pixel fractional scrollHeight on Retina /
      // zoomed viewports; 4 px is below a line-height so it can't be
      // mistaken for a deliberate mid-scroll pause.
      const distFromBottom = body.scrollHeight - body.scrollTop - body.clientHeight;
      streamFollowRef.current = distFromBottom <= 4;
    };
    body.addEventListener("scroll", onScroll, { passive: true });
    return () => body.removeEventListener("scroll", onScroll);
  }, [streaming]);

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
    // Snapshot body scrollTop — inserting the mention link grows the content
    // by dozens of chars (e.g. `[@Foo](mention://view/abc?table=xyz)`), the
    // auto-grow effect re-computes textarea.scrollHeight on the next paint,
    // and `ta.focus()` without preventScroll would then scroll the textarea
    // into view — typically snapping the body near the bottom because the
    // newly-grown textarea becomes the tallest thing in the scroll container.
    // Capturing + restoring pins the user at the visual position they picked
    // the mention from.
    const savedScrollTop = bodyRef.current?.scrollTop ?? 0;
    setContent(next);
    setMentionState(null);
    scheduleSave(next);
    requestAnimationFrame(() => {
      try {
        ta.focus({ preventScroll: true });
        ta.setSelectionRange(caret, caret);
      } catch { /* ignore */ }
      if (bodyRef.current) bodyRef.current.scrollTop = savedScrollTop;
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
    // Streaming label takes precedence — the save-status is stable ("saved")
    // but the live presentation should tell the user AI is writing.
    if (streaming) return t("idea.streaming");
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
        <SidebarExpandButton />
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
            onClick={toggleMode}
            title={t("idea.toggleHint")}
          >
            {mode === "source" ? PREVIEW_ICON : SOURCE_ICON}
            {mode === "source" ? t("idea.preview") : t("idea.source")}
          </button>
          <BlockCloseButton />
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
              className={`idea-editor-textarea${streaming ? " idea-editor-textarea-streaming" : ""}`}
              value={content}
              readOnly={streaming}
              onChange={handleChange}
              onKeyDown={(e) => {
                // Tab / Shift+Tab → indent / outdent. Uses 2-space units, matches
                // Prettier defaults and renders consistently in markdown list
                // contexts where tabs vs spaces change how list nesting parses.
                //
                //   Tab (no selection)        → insert "  " at caret
                //   Tab (selection)           → prepend "  " to each line in selection
                //   Shift+Tab (no selection)  → remove up to 2 leading spaces on current line
                //   Shift+Tab (selection)     → remove up to 2 leading spaces from each line
                //
                // IME composition gate: Tab on a preedit popup (e.g. pinyin
                // candidate selection) should stay native so the user can
                // accept a candidate without us stealing the key.
                if (e.key !== "Tab") return;
                if (e.nativeEvent.isComposing) return;
                if (streaming) return;
                e.preventDefault();

                const ta = e.currentTarget;
                const value = ta.value;
                const selStart = ta.selectionStart ?? 0;
                const selEnd = ta.selectionEnd ?? 0;
                const INDENT = "  "; // 2 spaces per level
                const INDENT_LEN = INDENT.length;

                // Expand the selection to whole-line boundaries so we can
                // prefix/strip each line uniformly regardless of where the
                // caret actually sits inside the first/last lines.
                const lineStart = value.lastIndexOf("\n", selStart - 1) + 1;
                const nextNewline = value.indexOf("\n", selEnd);
                const lineEnd = nextNewline === -1 ? value.length : nextNewline;
                const selectedBlock = value.slice(lineStart, lineEnd);
                const hasMultiLineSelection =
                  selStart !== selEnd && selectedBlock.includes("\n");

                if (e.shiftKey) {
                  // ── Outdent ──
                  const lines = selectedBlock.split("\n");
                  let firstLineRemoved = 0;
                  let totalRemoved = 0;
                  const newLines = lines.map((line, i) => {
                    const leading = /^ {1,2}/.exec(line)?.[0] ?? "";
                    const removeLen = leading.length;
                    if (i === 0) firstLineRemoved = removeLen;
                    totalRemoved += removeLen;
                    return line.slice(removeLen);
                  });
                  if (totalRemoved === 0) return;
                  const newBlock = newLines.join("\n");
                  const newValue =
                    value.slice(0, lineStart) + newBlock + value.slice(lineEnd);
                  const newSelStart = Math.max(lineStart, selStart - firstLineRemoved);
                  const newSelEnd = Math.max(newSelStart, selEnd - totalRemoved);
                  setContent(newValue);
                  scheduleSave(newValue);
                  // Restore selection after React commits the new value.
                  requestAnimationFrame(() => {
                    const cur = textareaRef.current;
                    if (!cur) return;
                    cur.setSelectionRange(newSelStart, newSelEnd);
                  });
                  return;
                }

                // ── Indent ──
                if (hasMultiLineSelection) {
                  // Multi-line selection: prepend INDENT to each line.
                  const lines = selectedBlock.split("\n");
                  const newBlock = lines.map(line => INDENT + line).join("\n");
                  const added = INDENT_LEN * lines.length;
                  const newValue =
                    value.slice(0, lineStart) + newBlock + value.slice(lineEnd);
                  setContent(newValue);
                  scheduleSave(newValue);
                  const newSelStart = selStart + INDENT_LEN;
                  const newSelEnd = selEnd + added;
                  requestAnimationFrame(() => {
                    const cur = textareaRef.current;
                    if (!cur) return;
                    cur.setSelectionRange(newSelStart, newSelEnd);
                  });
                } else {
                  // No selection (or single-line selection): insert INDENT
                  // at caret, replacing any selected range.
                  const newValue =
                    value.slice(0, selStart) + INDENT + value.slice(selEnd);
                  setContent(newValue);
                  scheduleSave(newValue);
                  const newCaret = selStart + INDENT_LEN;
                  requestAnimationFrame(() => {
                    const cur = textareaRef.current;
                    if (!cur) return;
                    cur.setSelectionRange(newCaret, newCaret);
                  });
                }
              }}
              onKeyUp={(e) => {
                // Arrow keys / clicks move the caret without firing change —
                // recompute mention detection so the picker closes when the
                // caret leaves an `@…` span, AND re-run caret-follow so
                // arrow-down past the viewport edge scrolls the body.
                const caret = (e.target as HTMLTextAreaElement).selectionStart ?? 0;
                detectMention(content, caret);
                ensureCaretVisible();
              }}
              onMouseUp={(e) => {
                const caret = (e.target as HTMLTextAreaElement).selectionStart ?? 0;
                detectMention(content, caret);
                ensureCaretVisible();
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
