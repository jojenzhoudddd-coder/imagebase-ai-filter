/**
 * BlockMenu — popover menu shown when the user clicks a block's ⋮ handle.
 * Items: copy block link / delete / convert to {paragraph, h1-3, quote, divider, list}.
 *
 * Positioning: absolute under the trigger, clamped to viewport. Closes on
 * outside-click / Esc.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "../../../i18n/index";
import "./BlockMenu.css";

export type BlockTransformTarget =
  | "paragraph"
  | "heading-1"
  | "heading-2"
  | "heading-3"
  | "quote"
  | "list-bullet"
  | "divider";

interface Props {
  /** Anchor rect (the ⋮ button's bounding box). */
  anchor: DOMRect;
  /** Current block's type — to disable identity transforms (e.g. don't
   *  show "convert to heading-2" when already heading-2). */
  blockType: string;
  onClose: () => void;
  onCopyLink: () => void;
  onDelete: () => void;
  onTransform: (to: BlockTransformTarget) => void;
}

const TRANSFORMS: { target: BlockTransformTarget; labelKey: string }[] = [
  { target: "paragraph",  labelKey: "blockMenu.toParagraph" },
  { target: "heading-1",  labelKey: "blockMenu.toH1" },
  { target: "heading-2",  labelKey: "blockMenu.toH2" },
  { target: "heading-3",  labelKey: "blockMenu.toH3" },
  { target: "quote",      labelKey: "blockMenu.toQuote" },
  { target: "list-bullet",labelKey: "blockMenu.toList" },
  { target: "divider",    labelKey: "blockMenu.toDivider" },
];

/** Map a block.type → the matching transform target so we can hide the
 *  identity entry from the menu. */
function transformIdFromType(type: string): BlockTransformTarget | null {
  if (type === "paragraph") return "paragraph";
  if (type === "quote") return "quote";
  if (type === "list") return "list-bullet";
  if (type === "divider") return "divider";
  // Heading levels need the level prop, which we don't have here. Just
  // disable all heading entries when type === "heading" — over-cautious
  // but cheap.
  if (type === "heading") return null;
  return null;
}

const PANEL_WIDTH = 200;

export default function BlockMenu({
  anchor,
  blockType,
  onClose,
  onCopyLink,
  onDelete,
  onTransform,
}: Props) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    // Place to the right of the anchor; if not enough room, swap to left.
    const margin = 4;
    let left = anchor.right + margin;
    if (left + PANEL_WIDTH > window.innerWidth - 8) {
      left = anchor.left - PANEL_WIDTH - margin;
    }
    if (left < 8) left = 8;
    const top = Math.min(anchor.top, window.innerHeight - 320);
    setPos({ top, left });
  }, [anchor]);

  // Outside-click + Esc to close
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  if (!pos) return null;

  const identity = transformIdFromType(blockType);

  return (
    <div
      ref={ref}
      className="block-menu"
      style={{ position: "fixed", top: pos.top, left: pos.left, width: PANEL_WIDTH }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        className="block-menu-item"
        onClick={() => {
          onCopyLink();
          onClose();
        }}
      >
        <BlockMenuIcon name="link" />
        <span>{t("blockMenu.copyLink")}</span>
      </button>
      <div className="block-menu-divider" />
      {TRANSFORMS.map((tr) => {
        const isIdentity = identity === tr.target;
        return (
          <button
            key={tr.target}
            className={`block-menu-item ${isIdentity ? "is-disabled" : ""}`}
            disabled={isIdentity}
            onClick={() => {
              if (isIdentity) return;
              onTransform(tr.target);
              onClose();
            }}
          >
            <BlockMenuIcon name="transform" />
            <span>{t(tr.labelKey)}</span>
          </button>
        );
      })}
      <div className="block-menu-divider" />
      <button
        className="block-menu-item is-danger"
        onClick={() => {
          onDelete();
          onClose();
        }}
      >
        <BlockMenuIcon name="trash" />
        <span>{t("blockMenu.delete")}</span>
      </button>
    </div>
  );
}

function BlockMenuIcon({ name }: { name: "link" | "trash" | "transform" }) {
  const stroke = "currentColor";
  if (name === "link") {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
        <path d="M10 13a5 5 0 0 1 0-7l1.5-1.5a5 5 0 1 1 7 7L17 13" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M14 11a5 5 0 0 1 0 7L12.5 19.5a5 5 0 1 1-7-7L7 11" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (name === "trash") {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
        <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M4 7h16M7 12h10M10 17h4" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
