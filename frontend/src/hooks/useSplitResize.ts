/**
 * Draggable horizontal splitter between two flex siblings.
 *
 * Consumer layout (simplified):
 *   <div ref={containerRef} class="split-container">
 *     <div class="left" style={{ flex: `0 0 ${(1-ratio)*100}%` }}>...</div>
 *     <div class="divider" onMouseDown={handleMouseDown}>...</div>
 *     <div class="right" style={{ flex: `0 0 ${ratio*100}%` }}>...</div>
 *   </div>
 *
 * `ratio` is the fraction occupied by the RIGHT panel (0..1). Persisted to
 * localStorage under `storageKey` on drag end, so the split preference
 * survives reloads.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface SplitResizeOptions {
  /** localStorage key to persist the ratio between sessions. */
  storageKey: string;
  /** Initial ratio on first visit (no stored value yet). Default 0.35. */
  defaultRatio?: number;
  /** Minimum width in px for the LEFT panel. Default 400. */
  minLeftPx?: number;
  /** Minimum width in px for the RIGHT panel. Default 320. */
  minRightPx?: number;
  /** Maximum ratio for the RIGHT panel. Default 0.6. */
  maxRatio?: number;
  /**
   * Which edge the "ratio" panel is anchored to. Default "right" — the ratio
   * represents the RIGHT panel's width fraction, so dragging the divider
   * LEFT grows the right panel. Set to "left" when the tracked panel lives
   * on the LEFT side (e.g. after a chat/artifact swap) so drag direction
   * matches the panel being resized.
   */
  anchorSide?: "left" | "right";
}

export interface SplitResizeResult {
  /** Fraction of the container occupied by the RIGHT panel. */
  ratio: number;
  /** Attach to the flex container (so we can read its width during drag). */
  containerRef: React.RefObject<HTMLDivElement>;
  /** Attach to the divider's mousedown handler. */
  onDividerMouseDown: (e: React.MouseEvent) => void;
  /** True while the user is actively dragging. */
  isDragging: boolean;
}

function readRatio(storageKey: string): number | null {
  try {
    const v = localStorage.getItem(storageKey);
    if (!v) return null;
    const n = parseFloat(v);
    if (Number.isFinite(n) && n > 0 && n < 1) return n;
  } catch {
    // ignore
  }
  return null;
}

function writeRatio(storageKey: string, ratio: number) {
  try {
    localStorage.setItem(storageKey, ratio.toFixed(3));
  } catch {
    // quota or disabled storage — ignore
  }
}

export function useSplitResize(opts: SplitResizeOptions): SplitResizeResult {
  const { storageKey, defaultRatio = 0.35, minLeftPx = 400, minRightPx = 320, maxRatio = 0.6, anchorSide = "right" } = opts;

  // Live ref so the mousedown closure always reads the latest anchor side
  // without re-creating the handler when the consumer flips it.
  const anchorSideRef = useRef(anchorSide);
  useEffect(() => { anchorSideRef.current = anchorSide; }, [anchorSide]);

  const containerRef = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState<number>(() => readRatio(storageKey) ?? defaultRatio);
  const [isDragging, setIsDragging] = useState(false);

  // Keep latest ratio in a ref so the mousemove listener reads fresh values
  // without needing to re-attach the listener every render.
  const ratioRef = useRef(ratio);
  useEffect(() => {
    ratioRef.current = ratio;
  }, [ratio]);

  const onDividerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const container = containerRef.current;
      if (!container) return;

      setIsDragging(true);
      // While dragging: block text selection and force col-resize cursor globally.
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";

      const rect = container.getBoundingClientRect();
      const containerWidth = rect.width;

      // Compute min/max ratio under current container width.
      const minRatioRight = Math.max(minRightPx / containerWidth, 0.05);
      const maxRatioRight = Math.min((containerWidth - minLeftPx) / containerWidth, maxRatio);

      const onMove = (ev: MouseEvent) => {
        // The tracked panel's on-screen width depends on which edge it hugs.
        // anchorSide="right" (default): ratio = (container.right - mouseX) / width
        // anchorSide="left":            ratio = (mouseX - container.left) / width
        // This keeps drag direction intuitive after a panel swap.
        const panelWidth =
          anchorSideRef.current === "left"
            ? ev.clientX - rect.left
            : rect.right - ev.clientX;
        const nextRatio = Math.min(
          maxRatioRight,
          Math.max(minRatioRight, panelWidth / containerWidth)
        );
        ratioRef.current = nextRatio;
        setRatio(nextRatio);
      };

      const onUp = () => {
        setIsDragging(false);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        writeRatio(storageKey, ratioRef.current);
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [minLeftPx, minRightPx, maxRatio, storageKey]
  );

  return { ratio, containerRef, onDividerMouseDown, isDragging };
}
