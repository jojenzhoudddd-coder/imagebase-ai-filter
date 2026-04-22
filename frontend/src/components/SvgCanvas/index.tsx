import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "../../i18n/index";
import { useToast } from "../Toast/index";
import InlineEdit from "../InlineEdit";
import ConfirmDialog from "../ConfirmDialog/index";
import {
  fetchTastes,
  uploadTastes,
  importFigmaSvg,
  createTasteFromSvg,
  batchUpdateTastes,
  deleteTaste,
  updateTaste,
  CLIENT_ID,
} from "../../api";
import type { TasteBrief } from "../../api";
import { useDesignSync } from "../../hooks/useDesignSync";
import "./SvgCanvas.css";

// ─── Icons ───

const UPLOAD_ICON = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <path d="M8 2v8M4.5 5.5L8 2l3.5 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M2 10v2.5A1.5 1.5 0 003.5 14h9a1.5 1.5 0 001.5-1.5V10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);

const FIGMA_ICON = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <path d="M5.5 14A2.5 2.5 0 008 11.5V9H5.5a2.5 2.5 0 000 5z" fill="currentColor" opacity="0.7" />
    <path d="M3 6.5A2.5 2.5 0 015.5 4H8v5H5.5A2.5 2.5 0 013 6.5z" fill="currentColor" opacity="0.5" />
    <path d="M3 1.5A2.5 2.5 0 015.5 4H8V-1H5.5A2.5 2.5 0 013 1.5z" fill="currentColor" opacity="0.3" />
    <path d="M8-1h2.5A2.5 2.5 0 0113 1.5 2.5 2.5 0 0110.5 4H8V-1z" fill="currentColor" opacity="0.4" />
    <circle cx="10.5" cy="6.5" r="2.5" fill="currentColor" opacity="0.6" />
  </svg>
);

const PASTE_ICON = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <rect x="3.5" y="3" width="9" height="11" rx="1.2" stroke="currentColor" strokeWidth="1.2" />
    <path d="M6 3V2.5A1 1 0 017 1.5h2a1 1 0 011 1V3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    <path d="M5.75 7.5h4.5M5.75 10h4.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
);

const LAYOUT_ICON = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <rect x="1" y="1" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
    <rect x="10" y="1" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
    <rect x="1" y="10" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
    <rect x="10" y="10" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
  </svg>
);

const CLOSE_ICON = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);

const EMPTY_ICON = (
  <svg className="svg-canvas-empty-icon" width="48" height="48" viewBox="0 0 48 48" fill="none">
    <rect x="6" y="10" width="36" height="28" rx="4" stroke="currentColor" strokeWidth="2" />
    <path d="M18 24l-4 4h8L18 24zM30 20l-6 8h12l-6-8z" fill="currentColor" opacity="0.3" />
    <circle cx="16" cy="18" r="2" fill="currentColor" opacity="0.3" />
  </svg>
);

const RENAME_ICON = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <path d="M11.5 2.5l2 2L5 13H3v-2l8.5-8.5z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const DELETE_ICON = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <path d="M6 2a1 1 0 00-1 1h6a1 1 0 00-1-1H6zM4 4h8v9a1 1 0 01-1 1H5a1 1 0 01-1-1V4zM3 4h10V3H3v1zM6.5 6v5M9.5 6v5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
  </svg>
);

// ─── Auto-layout algorithm ───
// Arranges items in a grid starting at (0,0). Returns new positions + the
// bounding rect of the entire laid-out content.

interface LayoutResult {
  updates: Array<{ id: string; x: number; y: number }>;
  bounds: { width: number; height: number };
}

// "Tidy up" layout: infer the user's row structure from current positions,
// then align items within each row and equalize spacing — minimal rearrangement.
function computeGridLayout(tastes: TasteBrief[]): LayoutResult {
  if (tastes.length === 0) return { updates: [], bounds: { width: 0, height: 0 } };

  // 1. Cluster items into rows by Y proximity.
  //    Two items are in the same row if their vertical centers are within
  //    half the smaller item's height of each other.
  const items = [...tastes].sort((a, b) => {
    const dy = a.y - b.y;
    return Math.abs(dy) > 20 ? dy : a.x - b.x; // primary: top-to-bottom, secondary: left-to-right
  });

  const rows: TasteBrief[][] = [];
  for (const t of items) {
    const cy = t.y + t.height / 2;
    // Try to find an existing row whose vertical center is close
    let placed = false;
    for (const row of rows) {
      const rowCy = row.reduce((s, r) => s + r.y + r.height / 2, 0) / row.length;
      const threshold = Math.min(...row.map((r) => r.height), t.height) * 0.6;
      if (Math.abs(cy - rowCy) < Math.max(threshold, 40)) {
        row.push(t);
        placed = true;
        break;
      }
    }
    if (!placed) rows.push([t]);
  }

  // Sort rows by average Y, and items within each row by X
  rows.sort((a, b) => {
    const ay = a.reduce((s, t) => s + t.y, 0) / a.length;
    const by = b.reduce((s, t) => s + t.y, 0) / b.length;
    return ay - by;
  });
  for (const row of rows) row.sort((a, b) => a.x - b.x);

  // 2. Compute adaptive gap from average item size
  const avgSize = items.reduce((s, t) => s + Math.max(t.width, t.height), 0) / items.length;
  const gap = Math.round(Math.min(80, Math.max(16, avgSize * 0.06)));

  // 3. Lay out: equalize horizontal spacing within each row, stack rows vertically
  const updates: Array<{ id: string; x: number; y: number }> = [];
  let currentY = 0;
  let totalWidth = 0;

  for (const row of rows) {
    // Horizontal: distribute items left-to-right with uniform gap
    let x = 0;
    const rowH = Math.max(...row.map((t) => t.height));
    for (const t of row) {
      // Vertically center within the row
      const y = currentY + (rowH - t.height) / 2;
      updates.push({ id: t.id, x, y });
      x += t.width + gap;
    }
    totalWidth = Math.max(totalWidth, x - gap);
    currentY += rowH + gap;
  }

  const totalHeight = Math.max(0, currentY - gap);
  return { updates, bounds: { width: totalWidth, height: totalHeight } };
}

// Compute bounding rect of a set of tastes at their current positions.
function computeBounds(tastes: TasteBrief[]): { x: number; y: number; width: number; height: number } {
  if (tastes.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const t of tastes) {
    minX = Math.min(minX, t.x);
    minY = Math.min(minY, t.y);
    maxX = Math.max(maxX, t.x + t.width);
    maxY = Math.max(maxY, t.y + t.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// ─── Snap guide computation ───

interface SnapGuide {
  axis: "x" | "y";
  pos: number; // canvas coordinate of the guide line
}

interface AltDistance {
  axis: "x" | "y";
  from: number;
  to: number;
  at: number; // cross-axis position for label
}

const SNAP_THRESHOLD = 5; // px in canvas space

function computeSnap(
  dragged: { x: number; y: number; width: number; height: number },
  others: TasteBrief[],
): { snapX: number | null; snapY: number | null; guides: SnapGuide[] } {
  let snapX: number | null = null;
  let snapY: number | null = null;
  const guideSet = new Set<string>(); // dedup by "axis:pos"
  const guides: SnapGuide[] = [];

  const addGuide = (axis: "x" | "y", pos: number) => {
    const key = `${axis}:${pos}`;
    if (!guideSet.has(key)) { guideSet.add(key); guides.push({ axis, pos }); }
  };

  const dL = dragged.x, dR = dragged.x + dragged.width, dCx = dragged.x + dragged.width / 2;
  const dT = dragged.y, dB = dragged.y + dragged.height, dCy = dragged.y + dragged.height / 2;

  for (const o of others) {
    const oL = o.x, oR = o.x + o.width, oCx = o.x + o.width / 2;
    const oT = o.y, oB = o.y + o.height, oCy = o.y + o.height / 2;

    // Vertical guides (X-axis edge alignment)
    // Check every dragged-edge vs every other-edge pair independently
    const xPairs: [number, number][] = [
      [dL, oL], [dL, oR], [dL, oCx],
      [dR, oL], [dR, oR], [dR, oCx],
      [dCx, oL], [dCx, oR], [dCx, oCx],
    ];
    for (const [dv, ov] of xPairs) {
      if (Math.abs(dv - ov) < SNAP_THRESHOLD) {
        // Snap position: only set once (first match determines snap)
        if (snapX === null) snapX = dragged.x + (ov - dv);
        // Always add guide line — multiple lines can appear simultaneously
        addGuide("x", ov);
      }
    }

    // Horizontal guides (Y-axis edge alignment)
    const yPairs: [number, number][] = [
      [dT, oT], [dT, oB], [dT, oCy],
      [dB, oT], [dB, oB], [dB, oCy],
      [dCy, oT], [dCy, oB], [dCy, oCy],
    ];
    for (const [dv, ov] of yPairs) {
      if (Math.abs(dv - ov) < SNAP_THRESHOLD) {
        if (snapY === null) snapY = dragged.y + (ov - dv);
        addGuide("y", ov);
      }
    }
  }
  return { snapX, snapY, guides };
}

// Alt distances: only show to nearest item in each direction (left/right/up/down)
function computeAltDistances(
  selected: TasteBrief,
  others: TasteBrief[],
): AltDistance[] {
  const sR = selected.x + selected.width;
  const sB = selected.y + selected.height;
  const sCy = selected.y + selected.height / 2;
  const sCx = selected.x + selected.width / 2;

  let nearestRight: AltDistance | null = null;
  let nearestLeft: AltDistance | null = null;
  let nearestDown: AltDistance | null = null;
  let nearestUp: AltDistance | null = null;

  for (const o of others) {
    const oR = o.x + o.width;
    const oB = o.y + o.height;

    // Horizontal: items roughly on same row
    if (Math.abs(sCy - (o.y + o.height / 2)) < Math.max(selected.height, o.height)) {
      if (o.x > sR) {
        const gap = o.x - sR;
        if (!nearestRight || gap < (nearestRight.to - nearestRight.from))
          nearestRight = { axis: "x", from: sR, to: o.x, at: sCy };
      }
      if (selected.x > oR) {
        const gap = selected.x - oR;
        if (!nearestLeft || gap < (nearestLeft.to - nearestLeft.from))
          nearestLeft = { axis: "x", from: oR, to: selected.x, at: sCy };
      }
    }

    // Vertical: items roughly on same column
    if (Math.abs(sCx - (o.x + o.width / 2)) < Math.max(selected.width, o.width)) {
      if (o.y > sB) {
        const gap = o.y - sB;
        if (!nearestDown || gap < (nearestDown.to - nearestDown.from))
          nearestDown = { axis: "y", from: sB, to: o.y, at: sCx };
      }
      if (selected.y > oB) {
        const gap = selected.y - oB;
        if (!nearestUp || gap < (nearestUp.to - nearestUp.from))
          nearestUp = { axis: "y", from: oB, to: selected.y, at: sCx };
      }
    }
  }

  return [nearestRight, nearestLeft, nearestDown, nearestUp].filter(Boolean) as AltDistance[];
}

// ─── SVG sanitizer (strip scripts & event handlers for safe inline rendering) ───
function sanitizeSvg(raw: string): string {
  return raw
    // Remove <script> blocks
    .replace(/<script[\s\S]*?<\/script\s*>/gi, "")
    // Remove on* event attributes
    .replace(/\s+on\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\s+on\w+\s*=\s*'[^']*'/gi, "")
    // Remove javascript: URLs
    .replace(/href\s*=\s*"javascript:[^"]*"/gi, 'href="#"')
    .replace(/href\s*=\s*'javascript:[^']*'/gi, "href='#'");
}

// ─── Figma URL validation ───
const FIGMA_URL_RE = /figma\.com\/(design|file)\/([a-zA-Z0-9]+)/;

// ─── Constants ───
const MIN_SCALE = 0.02;
const MAX_SCALE = 256;
const SCROLL_SPEED = 0.6;
const ZOOM_SPEED = 0.002;

// ─── Canvas transform hook ───
// Pure direct-DOM approach: all pan/zoom updates go straight to el.style.transform
// via rAF. React never re-renders during interaction. Only a debounced zoom-label
// update touches React state, and it doesn't affect the canvas DOM at all.

function useCanvasTransform() {
  const panRef = useRef({ x: 0, y: 0 });
  const scaleRef = useRef(1);

  // Only used for the zoom % label in the toolbar — debounced, not on hot path
  const [zoomPercent, setZoomPercent] = useState(100);

  const spaceHeldRef = useRef(false);
  const [spaceHeld, setSpaceHeld] = useState(false);

  const isPanDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const lastTouchDist = useRef(0);
  const lastTouchCenter = useRef({ x: 0, y: 0 });
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const rafId = useRef(0);
  const labelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Direct DOM update — no React
  const applyTransform = () => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const { x, y } = panRef.current;
    const s = scaleRef.current;
    surface.style.transform = `translate(${x}px,${y}px) scale(${s})`;
    // Set CSS var for inverse scale (used by item names to stay at fixed screen size)
    surface.style.setProperty("--inv-scale", String(1 / s));
  };

  // rAF-throttled DOM update
  const scheduleApply = () => {
    if (rafId.current) return;
    rafId.current = requestAnimationFrame(() => {
      rafId.current = 0;
      applyTransform();
    });
  };

  // Debounced zoom label update (only React state that changes)
  const scheduleLabel = () => {
    if (labelTimer.current) clearTimeout(labelTimer.current);
    labelTimer.current = setTimeout(() => {
      setZoomPercent(Math.round(scaleRef.current * 100));
    }, 80);
  };

  // ── Keyboard: space for pan mode ──
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.code === "Space" &&
        !e.repeat &&
        !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        spaceHeldRef.current = true;
        setSpaceHeld(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        spaceHeldRef.current = false;
        setSpaceHeld(false);
        isPanDragging.current = false;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (labelTimer.current) clearTimeout(labelTimer.current);
      if (rafId.current) cancelAnimationFrame(rafId.current);
    };
  }, []);

  // ── Attach listeners ──
  const attachListeners = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;

    const findSurface = () => el.querySelector<HTMLDivElement>(".svg-canvas-surface");
    const ensureSurface = () => {
      if (!surfaceRef.current) surfaceRef.current = findSurface();
    };

    const ac = new AbortController();
    const opts = { signal: ac.signal };
    const optsNP = { signal: ac.signal, passive: false } as AddEventListenerOptions;

    // Mouse drag (space held)
    el.addEventListener("mousedown", (e: MouseEvent) => {
      if (!spaceHeldRef.current) return;
      e.preventDefault();
      ensureSurface();
      isPanDragging.current = true;
      dragStart.current = {
        x: e.clientX, y: e.clientY,
        panX: panRef.current.x, panY: panRef.current.y,
      };
    }, opts);

    window.addEventListener("mousemove", (e: MouseEvent) => {
      if (!isPanDragging.current) return;
      panRef.current = {
        x: dragStart.current.panX + (e.clientX - dragStart.current.x),
        y: dragStart.current.panY + (e.clientY - dragStart.current.y),
      };
      scheduleApply();
    }, opts);

    window.addEventListener("mouseup", () => { isPanDragging.current = false; }, opts);

    // Wheel
    el.addEventListener("wheel", (e: WheelEvent) => {
      e.preventDefault();
      ensureSurface();
      const s = scaleRef.current;

      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const delta = -e.deltaY * ZOOM_SPEED;
        const ns = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s * (1 + delta)));
        const ratio = ns / s;
        panRef.current = {
          x: cx - ratio * (cx - panRef.current.x),
          y: cy - ratio * (cy - panRef.current.y),
        };
        scaleRef.current = ns;
        scheduleLabel();
      } else if (e.shiftKey) {
        const amount = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        panRef.current = { ...panRef.current, x: panRef.current.x - amount * SCROLL_SPEED };
      } else {
        panRef.current = {
          x: panRef.current.x - e.deltaX * SCROLL_SPEED,
          y: panRef.current.y - e.deltaY * SCROLL_SPEED,
        };
      }
      scheduleApply();
    }, optsNP);

    // Touch pinch/pan
    const dist = (a: Touch, b: Touch) => Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
    const ctr = (a: Touch, b: Touch) => ({
      x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2,
    });

    el.addEventListener("touchstart", (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        ensureSurface();
        lastTouchDist.current = dist(e.touches[0], e.touches[1]);
        lastTouchCenter.current = ctr(e.touches[0], e.touches[1]);
      }
    }, optsNP);

    el.addEventListener("touchmove", (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const d = dist(e.touches[0], e.touches[1]);
        const c = ctr(e.touches[0], e.touches[1]);
        const rect = el.getBoundingClientRect();
        const cx = c.x - rect.left, cy = c.y - rect.top;
        const s = scaleRef.current;
        const zr = d / lastTouchDist.current;
        const ns = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s * zr));
        const sr = ns / s;
        panRef.current = {
          x: cx - sr * (cx - panRef.current.x) + (c.x - lastTouchCenter.current.x),
          y: cy - sr * (cy - panRef.current.y) + (c.y - lastTouchCenter.current.y),
        };
        scaleRef.current = ns;
        lastTouchDist.current = d;
        lastTouchCenter.current = c;
        scheduleApply();
        scheduleLabel();
      }
    }, optsNP);

    return () => ac.abort();
  }, []);

  // ── fitToView: set scale & pan so contentBounds is centered-top in viewport ──
  const fitToView = useCallback(
    (contentBounds: { x: number; y: number; width: number; height: number }) => {
      const el = elRef.current;
      if (!el || contentBounds.width <= 0 || contentBounds.height <= 0) return;
      if (!surfaceRef.current) surfaceRef.current = el.querySelector<HTMLDivElement>(".svg-canvas-surface");

      const vw = el.clientWidth;
      const vh = el.clientHeight;
      const pad = 40; // padding around content
      const topPad = Math.max(32, vh * 0.06); // top margin: 6% of viewport, min 32px

      // Scale to fit content within viewport (with padding)
      const scaleX = (vw - pad * 2) / contentBounds.width;
      const scaleY = (vh - topPad - pad) / contentBounds.height;
      const s = Math.min(scaleX, scaleY, 2); // cap at 200% to avoid over-enlarging small content

      // Center horizontally, align top with topPad
      const scaledW = contentBounds.width * s;
      const panX = (vw - scaledW) / 2 - contentBounds.x * s;
      const panY = topPad - contentBounds.y * s;

      panRef.current = { x: panX, y: panY };
      scaleRef.current = Math.max(MIN_SCALE, s);
      applyTransform();
      setZoomPercent(Math.round(scaleRef.current * 100));
    },
    [],
  );

  // Store el for fitToView
  const elRef = useRef<HTMLDivElement | null>(null);

  const wrappedAttach = useCallback(
    (el: HTMLDivElement | null) => {
      elRef.current = el;
      attachListeners(el);
    },
    [attachListeners],
  );

  return { zoomPercent, spaceHeld, canvasRef: wrappedAttach, fitToView, panRef, scaleRef, elRef };
}

// ─── Props ───

interface Props {
  designId: string;
  designName: string;
  onRename: (name: string) => void;
  hidden?: boolean;
  /** Workspace this canvas lives under; required for SSE subscription. */
  workspaceId?: string;
}

export default function SvgCanvas({ designId, designName, onRename, hidden = false, workspaceId = "doc_default" }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [tastes, setTastes] = useState<TasteBrief[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [isEditing, setIsEditing] = useState(false);

  // Figma import popover
  const [figmaPopoverOpen, setFigmaPopoverOpen] = useState(false);
  const [figmaUrl, setFigmaUrl] = useState("");
  const [figmaImporting, setFigmaImporting] = useState(false);
  const [figmaError, setFigmaError] = useState("");

  // Inline SVG content map: tasteId → sanitized SVG string
  const [svgContents, setSvgContents] = useState<Record<string, string>>({});

  // Item drag state
  const [itemDragging, setItemDragging] = useState(false);
  const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([]);
  const itemDragRef = useRef<{
    id: string; startMouseX: number; startMouseY: number;
    startX: number; startY: number;
  } | null>(null);

  // Alt key for distance measurement
  const [altHeld, setAltHeld] = useState(false);
  const [altDistances, setAltDistances] = useState<AltDistance[]>([]);

  // Context menu
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; tasteId: string } | null>(null);

  // Delete confirmation
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; name: string } | null>(null);

  // Inline rename for taste items
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // Keep a ref to latest tastes for use in event-handler closures
  const tastesRef = useRef(tastes);
  tastesRef.current = tastes;

  // Canvas transform — all DOM-direct, React only gets zoom label
  const { zoomPercent, spaceHeld, canvasRef, fitToView, panRef, scaleRef, elRef } = useCanvasTransform();

  // Load tastes on mount / designId change, then fetch SVG contents
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSelectedId(null);
    setSvgContents({});
    fetchTastes(designId)
      .then(async (data) => {
        if (cancelled) return;
        setTastes(data);
        setLoading(false);

        // Fit content into viewport on initial load
        if (data.length > 0) {
          // Allow one frame for canvas body to render so clientWidth/Height are available
          requestAnimationFrame(() => {
            if (cancelled) return;
            fitToView(computeBounds(data));
          });
        }

        // Fetch SVG content for each taste in parallel
        const entries = await Promise.all(
          data
            .filter((t) => t.filePath)
            .map(async (t) => {
              try {
                const res = await fetch(`/${t.filePath}`);
                const text = await res.text();
                return [t.id, sanitizeSvg(text)] as const;
              } catch {
                return null;
              }
            }),
        );
        if (cancelled) return;
        const map: Record<string, string> = {};
        for (const e of entries) {
          if (e) map[e[0]] = e[1];
        }
        setSvgContents(map);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [designId]);

  // ─── SSE: remote changes (Chat Agent, other clients) ───
  // Fetch SVG content for a taste that arrived through SSE (agent-created) so
  // it renders immediately instead of waiting for a full reload.
  const fetchSvgContentFor = useCallback(async (taste: TasteBrief) => {
    if (!taste.filePath) return;
    try {
      const res = await fetch(`/${taste.filePath}`);
      const text = await res.text();
      const sanitized = sanitizeSvg(text);
      setSvgContents((prev) => ({ ...prev, [taste.id]: sanitized }));
    } catch {
      /* best-effort */
    }
  }, []);

  useDesignSync(workspaceId, CLIENT_ID, designId, {
    onTasteCreate: (taste) => {
      // Cast: SSE payload source may include "paste" (backend type) — wider
      // than TasteBrief's "upload"|"figma" today. Treat as opaque string for
      // display; the canvas only reads it for icon selection.
      setTastes((prev) => (prev.some((t) => t.id === taste.id) ? prev : [...prev, taste as unknown as TasteBrief]));
      fetchSvgContentFor(taste as unknown as TasteBrief);
    },
    onTasteUpdate: ({ taste, updates, batch }) => {
      if (batch && Array.isArray(updates)) {
        setTastes((prev) => {
          const map = new Map(prev.map((t) => [t.id, t]));
          for (const u of updates) {
            const cur = map.get(u.id);
            if (!cur) continue;
            map.set(u.id, {
              ...cur,
              x: typeof u.x === "number" ? u.x : cur.x,
              y: typeof u.y === "number" ? u.y : cur.y,
              width: typeof u.width === "number" ? u.width : cur.width,
              height: typeof u.height === "number" ? u.height : cur.height,
              name: typeof u.name === "string" ? u.name : cur.name,
            });
          }
          return Array.from(map.values());
        });
      } else if (taste) {
        setTastes((prev) => prev.map((t) => (t.id === taste.id ? { ...t, ...taste } : t)));
      }
    },
    onTasteDelete: (tasteId) => {
      setTastes((prev) => prev.filter((t) => t.id !== tasteId));
      setSvgContents((prev) => {
        if (!(tasteId in prev)) return prev;
        const next = { ...prev };
        delete next[tasteId];
        return next;
      });
      setSelectedId((cur) => (cur === tasteId ? null : cur));
    },
    onTasteMetaUpdated: () => {
      // Meta is Agent-readable only in Phase 1 (no FE rendering). Leave as a
      // no-op subscription point — when the FE surfaces meta it will slot in
      // here (e.g. set a "meta ready" badge on the card).
    },
    onAutoLayout: ({ updates }) => {
      setTastes((prev) => {
        const map = new Map(prev.map((t) => [t.id, t]));
        for (const u of updates) {
          const cur = map.get(u.id);
          if (cur) map.set(u.id, { ...cur, x: u.x, y: u.y });
        }
        return Array.from(map.values());
      });
    },
    onDesignRename: (name) => {
      // Bubble up to parent so the sidebar + canvas header stay in sync.
      onRename(name);
    },
    // design:delete is handled at the workspace level (sidebar removes it);
    // this canvas instance will unmount when the active item changes, so we
    // don't need to do anything here.
  });

  // ─── Upload handlers ───

  const handleFiles = useCallback(
    async (files: File[]) => {
      const svgFiles = files.filter(
        (f) => f.type === "image/svg+xml" || f.name.toLowerCase().endsWith(".svg"),
      );
      if (svgFiles.length === 0) return;
      try {
        const created = await uploadTastes(designId, svgFiles);
        setTastes((prev) => [...prev, ...created]);
        // Read uploaded file contents for inline rendering
        const newContents: Record<string, string> = {};
        await Promise.all(
          created.map(async (t, i) => {
            if (svgFiles[i]) {
              const text = await svgFiles[i].text();
              newContents[t.id] = sanitizeSvg(text);
            }
          }),
        );
        setSvgContents((prev) => ({ ...prev, ...newContents }));
      } catch {
        toast.error(t("design.uploadFailed"));
      }
    },
    [designId, toast, t],
  );

  // Create a taste from pasted SVG source. Shared by the clipboard paste event
  // handler and the toolbar "Paste SVG" button (which reads via navigator.clipboard).
  const handleSvgPaste = useCallback(
    async (rawSvg: string): Promise<boolean> => {
      const svg = rawSvg.trim();
      // Cheap early-reject so we don't round-trip random clipboard text
      if (!/<svg[\s>]/i.test(svg)) return false;
      try {
        const created = await createTasteFromSvg(designId, svg);
        setTastes((prev) => [...prev, created]);
        setSvgContents((prev) => ({ ...prev, [created.id]: sanitizeSvg(svg) }));
        toast.success(t("design.pasteSvgSuccess"));
        return true;
      } catch (err) {
        // Surface server-supplied error (e.g. "SVG content too large") — much
        // more useful than a generic "Failed to paste SVG".
        const msg = err instanceof Error && err.message ? err.message : t("design.pasteSvgFailed");
        toast.error(msg);
        return false;
      }
    },
    [designId, toast, t],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const files = Array.from(e.dataTransfer.files);
      handleFiles(files);
    },
    [handleFiles],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  }, []);

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) {
        handleFiles(Array.from(e.target.files));
        e.target.value = "";
      }
    },
    [handleFiles],
  );

  // ─── Clipboard paste → create taste from pasted SVG source ───
  //
  // Listens at document-level so the user can paste anywhere on the canvas
  // (the canvas itself isn't a focusable element). We skip the handler whenever
  // focus is inside an editable surface — Figma URL input, rename input,
  // chat sidebar, idea editor, etc. — so those keep their native paste behavior.
  useEffect(() => {
    if (hidden) return;
    const onPaste = (e: ClipboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (tgt) {
        const tag = tgt.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tgt.isContentEditable
        ) {
          return;
        }
      }
      const text = e.clipboardData?.getData("text/plain") || "";
      if (!text || !/<svg[\s>]/i.test(text)) return;
      e.preventDefault();
      void handleSvgPaste(text);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [hidden, handleSvgPaste]);

  // ─── Alt key for distance measurement ───
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const held = e.type === "keydown" && e.key === "Alt";
      setAltHeld(e.key === "Alt" ? e.type === "keydown" : altHeld);
    };
    const down = (e: KeyboardEvent) => { if (e.key === "Alt") { e.preventDefault(); setAltHeld(true); } };
    const up = (e: KeyboardEvent) => { if (e.key === "Alt") setAltHeld(false); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, []);

  // Compute alt distances when alt held + item selected
  useEffect(() => {
    if (!altHeld || !selectedId) { setAltDistances([]); return; }
    const sel = tastes.find((t) => t.id === selectedId);
    if (!sel) { setAltDistances([]); return; }
    setAltDistances(computeAltDistances(sel, tastes.filter((t) => t.id !== selectedId)));
  }, [altHeld, selectedId, tastes]);

  // ─── Item drag handlers ───

  const handleItemMouseDown = useCallback(
    (e: React.MouseEvent, tasteId: string) => {
      if (spaceHeld || e.button !== 0) return;
      e.stopPropagation();
      const taste = tastes.find((t) => t.id === tasteId);
      if (!taste) return;
      setSelectedId(tasteId);
      itemDragRef.current = {
        id: tasteId,
        startMouseX: e.clientX,
        startMouseY: e.clientY,
        startX: taste.x,
        startY: taste.y,
      };
      // We'll detect actual drag on mousemove (to distinguish click from drag)
    },
    [spaceHeld, tastes],
  );

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      const drag = itemDragRef.current;
      if (!drag) return;
      const dx = e.clientX - drag.startMouseX;
      const dy = e.clientY - drag.startMouseY;
      // Start drag after 3px movement threshold
      if (!itemDragging && Math.hypot(dx, dy) < 3) return;
      if (!itemDragging) setItemDragging(true);

      const scale = scaleRef.current;
      const newX = drag.startX + dx / scale;
      const newY = drag.startY + dy / scale;

      // Snap computation — read from ref for latest positions
      const others = tastesRef.current.filter((t) => t.id !== drag.id);
      const draggedTaste = tastesRef.current.find((t) => t.id === drag.id)!;
      const candidate = { x: newX, y: newY, width: draggedTaste.width, height: draggedTaste.height };
      const { snapX, snapY, guides } = computeSnap(candidate, others);

      const finalX = snapX !== null ? snapX : newX;
      const finalY = snapY !== null ? snapY : newY;

      setSnapGuides(guides);
      setTastes((prev) =>
        prev.map((t) => (t.id === drag.id ? { ...t, x: finalX, y: finalY } : t)),
      );
    };

    const onMouseUp = () => {
      const drag = itemDragRef.current;
      if (!drag) return;
      itemDragRef.current = null;
      setSnapGuides([]);
      if (itemDragging) {
        setItemDragging(false);
        // Persist position — read from ref to get latest state
        const taste = tastesRef.current.find((t) => t.id === drag.id);
        if (taste) {
          updateTaste(designId, drag.id, { x: taste.x, y: taste.y }).catch(() => {});
        }
      }
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [itemDragging, tastes, designId, scaleRef]);

  // ─── Context menu ───

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, tasteId: string) => {
      e.preventDefault();
      e.stopPropagation();
      setSelectedId(tasteId);
      setCtxMenu({ x: e.clientX, y: e.clientY, tasteId });
    },
    [],
  );

  // Close context menu on any click
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [ctxMenu]);

  const handleCtxRename = useCallback(() => {
    if (!ctxMenu) return;
    const taste = tastes.find((t) => t.id === ctxMenu.tasteId);
    setCtxMenu(null);
    if (taste) {
      setRenamingId(taste.id);
      setRenameValue(taste.name);
    }
  }, [ctxMenu, tastes]);

  const startRename = useCallback((tasteId: string) => {
    const taste = tastes.find((t) => t.id === tasteId);
    if (taste) {
      setRenamingId(tasteId);
      setRenameValue(taste.name);
    }
  }, [tastes]);

  const commitRename = useCallback(async () => {
    if (!renamingId || !renameValue.trim()) { setRenamingId(null); return; }
    let name = renameValue.trim();
    // Deduplicate: if another taste already has this name, append " 1", " 2", etc.
    const others = tastesRef.current.filter((t) => t.id !== renamingId);
    const names = new Set(others.map((t) => t.name));
    if (names.has(name)) {
      let i = 1;
      while (names.has(`${name} ${i}`)) i++;
      name = `${name} ${i}`;
    }
    setTastes((prev) => prev.map((t) => (t.id === renamingId ? { ...t, name } : t)));
    setRenamingId(null);
    try {
      await updateTaste(designId, renamingId, { name });
    } catch { /* silent */ }
  }, [renamingId, renameValue, designId]);

  const handleCtxDelete = useCallback(() => {
    if (!ctxMenu) return;
    const taste = tastes.find((t) => t.id === ctxMenu.tasteId);
    setCtxMenu(null);
    if (taste) setDeleteConfirm({ id: taste.id, name: taste.name });
  }, [ctxMenu, tastes]);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteConfirm) return;
    const id = deleteConfirm.id;
    setDeleteConfirm(null);
    try {
      await deleteTaste(designId, id);
      setTastes((prev) => prev.filter((t) => t.id !== id));
      if (selectedId === id) setSelectedId(null);
    } catch {
      toast.error("Failed to delete");
    }
  }, [deleteConfirm, designId, selectedId, toast]);

  // ─── Auto-layout ───

  const handleAutoLayout = useCallback(async () => {
    if (tastes.length === 0) return;
    const { updates, bounds } = computeGridLayout(tastes);

    // Check if any position actually changed
    const changed = updates.some((u) => {
      const t = tastes.find((t) => t.id === u.id);
      return t && (Math.round(t.x) !== Math.round(u.x) || Math.round(t.y) !== Math.round(u.y));
    });

    if (changed) {
      // Apply new positions
      setTastes((prev) => {
        const map = new Map(updates.map((u) => [u.id, u]));
        return prev.map((t) => {
          const u = map.get(t.id);
          return u ? { ...t, x: u.x, y: u.y } : t;
        });
      });
      try {
        await batchUpdateTastes(designId, updates);
      } catch {
        const fresh = await fetchTastes(designId);
        setTastes(fresh);
      }
    }

    // Always fit to view (re-center + auto-zoom), even if positions didn't change
    requestAnimationFrame(() => {
      fitToView({ x: 0, y: 0, ...bounds });
    });
  }, [tastes, designId, fitToView]);

  // ─── Figma import ───

  const handleFigmaImport = useCallback(async () => {
    if (!FIGMA_URL_RE.test(figmaUrl)) {
      setFigmaError(t("design.invalidUrl"));
      return;
    }
    setFigmaImporting(true);
    setFigmaError("");
    try {
      const created = await importFigmaSvg(designId, figmaUrl);
      setTastes((prev) => [...prev, created]);
      // Fetch SVG content for inline rendering
      if (created.filePath) {
        fetch(`/${created.filePath}`)
          .then((r) => r.text())
          .then((text) => setSvgContents((prev) => ({ ...prev, [created.id]: sanitizeSvg(text) })))
          .catch(() => {});
      }
      setFigmaPopoverOpen(false);
      setFigmaUrl("");
    } catch (err: any) {
      setFigmaError(err.message || t("design.figmaImportFailed"));
    } finally {
      setFigmaImporting(false);
    }
  }, [figmaUrl, designId, t]);

  // ─── Click on canvas background → deselect ───
  //
  // Deselect policy: any click that doesn't land on an item, the context
  // menu, the Figma popover, or the rename input clears the selection.
  // We attach at the body level (not the surface) so clicks in empty regions
  // outside the transformed surface's bounds also deselect — the surface is
  // `position:absolute` and shrinks/expands with zoom, so a large part of
  // the user-visible empty canvas is technically outside it.
  const isEmptyCanvasTarget = useCallback((target: EventTarget | null): boolean => {
    if (!(target instanceof HTMLElement)) return false;
    // Preserve behavior for interactive surfaces that would otherwise
    // unexpectedly deselect on their clicks.
    if (target.closest(".svg-canvas-item")) return false;
    if (target.closest(".taste-context-menu")) return false;
    if (target.closest(".figma-import-popover")) return false;
    if (target.closest(".svg-canvas-item-name-input")) return false;
    return true;
  }, []);

  const handleCanvasClick = useCallback(
    (e: React.MouseEvent) => {
      if (spaceHeld) return;
      if (!isEmptyCanvasTarget(e.target)) return;
      setSelectedId(null);
      setCtxMenu(null);
    },
    [spaceHeld, isEmptyCanvasTarget],
  );

  const hideStyle = hidden ? ({ display: "none" } as const) : undefined;

  return (
    <div
      className="svg-canvas-panel"
      style={hideStyle}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* ─── Top Bar ─── */}
      <div className="svg-canvas-topbar">
        <span className="svg-canvas-topbar-name">
          <InlineEdit
            value={designName}
            isEditing={isEditing}
            onStartEdit={() => setIsEditing(true)}
            onSave={(name) => {
              setIsEditing(false);
              onRename(name);
            }}
            onCancelEdit={() => setIsEditing(false)}
          />
        </span>
        <div className="svg-canvas-topbar-actions">
          {/* ── Add content ── */}
          <button
            className="svg-canvas-topbar-btn"
            onClick={() => fileInputRef.current?.click()}
          >
            {UPLOAD_ICON}
            {t("design.uploadSvg")}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".svg"
            multiple
            style={{ display: "none" }}
            onChange={handleFileInput}
          />
          <button
            className="svg-canvas-topbar-btn"
            onClick={() => {
              setFigmaPopoverOpen(!figmaPopoverOpen);
              setFigmaError("");
            }}
          >
            {FIGMA_ICON}
            {t("design.importFigma")}
          </button>
          <button
            className="svg-canvas-topbar-btn"
            title={t("design.pasteSvgHint")}
            onClick={async () => {
              try {
                const text = await navigator.clipboard.readText();
                if (!text) {
                  toast.error(t("design.pasteSvgEmpty"));
                  return;
                }
                const ok = await handleSvgPaste(text);
                if (!ok) toast.error(t("design.pasteSvgInvalid"));
              } catch {
                // Clipboard API blocked (Safari / insecure context / no permission) —
                // fall back to hinting the user to use ⌘V / Ctrl+V directly.
                toast.error(t("design.pasteSvgClipboardBlocked"));
              }
            }}
          >
            {PASTE_ICON}
            {t("design.pasteSvg")}
          </button>

          <span className="svg-canvas-topbar-sep" />

          {/* ── Canvas actions ── */}
          <button
            className="svg-canvas-topbar-btn"
            onClick={handleAutoLayout}
            disabled={tastes.length === 0}
          >
            {LAYOUT_ICON}
            {t("design.autoLayout")}
          </button>

          <span className="svg-canvas-topbar-sep" />

          {/* ── Zoom indicator ── */}
          <span className="svg-canvas-zoom-label">{zoomPercent}%</span>
        </div>
      </div>

      {/* ─── Canvas Body — always mounted so ref is stable ─── */}
      <div
        ref={canvasRef}
        className={`svg-canvas-body${spaceHeld ? " panning" : ""}`}
        onClick={handleCanvasClick}
      >
        {loading ? (
          <div className="svg-canvas-empty">
            <p>{t("design.loading")}</p>
          </div>
        ) : (
          <>
            {/* Surface — transform managed entirely by DOM (useCanvasTransform hook).
              * Items at base size; CSS transform: scale() on surface handles zoom. */}
            <div
              className="svg-canvas-surface"
              onClick={handleCanvasClick}
            >
              {tastes.map((taste) => (
                <div
                  key={taste.id}
                  className={`svg-canvas-item${taste.id === selectedId ? " selected" : ""}${itemDragging && itemDragRef.current?.id === taste.id ? " dragging" : ""}`}
                  style={{
                    left: taste.x,
                    top: taste.y,
                    width: taste.width,
                    height: taste.height,
                  }}
                  onMouseDown={(e) => handleItemMouseDown(e, taste.id)}
                  onContextMenu={(e) => handleContextMenu(e, taste.id)}
                >
                  {/* File name — above item, counter-scaled to stay at 12px */}
                  <div className="svg-canvas-item-name">
                    {renamingId === taste.id ? (
                      <input
                        className="svg-canvas-item-name-input"
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={commitRename}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename();
                          if (e.key === "Escape") setRenamingId(null);
                        }}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                        autoFocus
                      />
                    ) : (
                      <span
                        className="svg-canvas-item-name-text"
                        onDoubleClick={(e) => { e.stopPropagation(); startRename(taste.id); }}
                      >
                        {taste.name}
                      </span>
                    )}
                  </div>
                  {svgContents[taste.id] ? (
                    <div
                      className="svg-canvas-item-inner"
                      dangerouslySetInnerHTML={{ __html: svgContents[taste.id] }}
                    />
                  ) : taste.filePath ? (
                    <img
                      src={`/${taste.filePath}`}
                      alt={taste.name}
                      draggable={false}
                    />
                  ) : null}
                </div>
              ))}
            </div>

            {/* Empty state */}
            {tastes.length === 0 && (
              <div className="svg-canvas-empty">
                {EMPTY_ICON}
                <span className="svg-canvas-empty-text">{t("design.emptyCanvas")}</span>
              </div>
            )}
          </>
        )}

        {/* Drop overlay */}
        {dragOver && (
          <div className="svg-canvas-dropzone">
            <span className="svg-canvas-dropzone-text">{t("design.dropHint")}</span>
          </div>
        )}

        {/* Figma import popover */}
        {figmaPopoverOpen && (
          <div className="figma-import-popover">
            <input
              type="text"
              placeholder={t("design.figmaUrlPlaceholder")}
              value={figmaUrl}
              onChange={(e) => setFigmaUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleFigmaImport();
                if (e.key === "Escape") setFigmaPopoverOpen(false);
              }}
              autoFocus
            />
            <div className="figma-import-row">
              <button
                className="svg-canvas-topbar-btn primary"
                onClick={handleFigmaImport}
                disabled={figmaImporting || !figmaUrl.trim()}
                style={{ flex: 1 }}
              >
                {figmaImporting ? t("design.importingFigma") : t("design.import")}
              </button>
              <button
                className="svg-canvas-topbar-btn"
                onClick={() => setFigmaPopoverOpen(false)}
              >
                {CLOSE_ICON}
              </button>
            </div>
            {figmaError && <span className="figma-import-error">{figmaError}</span>}
          </div>
        )}

        {/* Snap guide lines (screen-space overlay) */}
        {snapGuides.map((g, i) =>
          g.axis === "x" ? (
            <div key={`sg${i}`} className="snap-guide snap-guide-v" style={{ left: g.pos * scaleRef.current + panRef.current.x }} />
          ) : (
            <div key={`sg${i}`} className="snap-guide snap-guide-h" style={{ top: g.pos * scaleRef.current + panRef.current.y }} />
          ),
        )}

        {/* Alt distance labels */}
        {altDistances.map((d, i) =>
          d.axis === "x" ? (
            <div
              key={`ad${i}`}
              className="alt-distance alt-distance-h"
              style={{
                left: d.from * scaleRef.current + panRef.current.x,
                width: (d.to - d.from) * scaleRef.current,
                top: d.at * scaleRef.current + panRef.current.y - 10,
              }}
            >
              <span className="alt-distance-label">{Math.round(d.to - d.from)}</span>
            </div>
          ) : (
            <div
              key={`ad${i}`}
              className="alt-distance alt-distance-v"
              style={{
                top: d.from * scaleRef.current + panRef.current.y,
                height: (d.to - d.from) * scaleRef.current,
                left: d.at * scaleRef.current + panRef.current.x - 10,
              }}
            >
              <span className="alt-distance-label">{Math.round(d.to - d.from)}</span>
            </div>
          ),
        )}

        {/* Context menu */}
        {ctxMenu && (
          <div
            className="taste-context-menu"
            style={{ top: ctxMenu.y, left: ctxMenu.x }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button className="taste-context-menu-item" onClick={handleCtxRename}>
              {RENAME_ICON}
              <span>{t("contextMenu.rename")}</span>
            </button>
            <div className="taste-context-menu-sep" />
            <button className="taste-context-menu-item" onClick={handleCtxDelete}>
              {DELETE_ICON}
              <span>{t("design.deleteItem")}</span>
            </button>
          </div>
        )}

      </div>

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={!!deleteConfirm}
        title={t("design.deleteItem")}
        message={deleteConfirm ? `Delete "${deleteConfirm.name}"?` : ""}
        variant="danger"
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteConfirm(null)}
      />
    </div>
  );
}
