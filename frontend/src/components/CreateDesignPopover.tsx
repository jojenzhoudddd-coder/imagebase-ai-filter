import { useState, useRef, useLayoutEffect, forwardRef, useImperativeHandle } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "../i18n/index";
import "./CreateDesignPopover.css";

interface Props {
  anchorItemEl: HTMLElement;
  menuEl: HTMLElement;
  onClose: () => void;
  onCreateDesign: (name: string, figmaUrl: string) => Promise<string>;
}

export type DesignPopoverState = "input" | "creating" | "error";

export interface CreateDesignPopoverHandle {
  getState: () => DesignPopoverState;
}

const FIGMA_URL_REGEX = /figma\.com\/(design|file)\/([a-zA-Z0-9]+)/;

function extractNameFromUrl(url: string): string {
  try {
    const seg = new URL(url).pathname.split("/").filter(Boolean);
    const raw = seg[seg.length - 1] || "";
    const decoded = decodeURIComponent(raw).replace(/-/g, " ");
    return decoded || "Untitled Design";
  } catch {
    return "Untitled Design";
  }
}

const CreateDesignPopover = forwardRef<CreateDesignPopoverHandle, Props>(
  function CreateDesignPopover({ anchorItemEl, menuEl, onClose, onCreateDesign }, ref) {
  const { t } = useTranslation();
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [state, setState] = useState<DesignPopoverState>("input");
  const [figmaUrl, setFigmaUrl] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: -9999, left: -9999 });

  useImperativeHandle(ref, () => ({
    getState: () => state,
  }), [state]);

  // Position to the right of menu, Y-aligned with anchorItemEl (same as CreateTablePopover)
  useLayoutEffect(() => {
    const menuRect = menuEl.getBoundingClientRect();
    const itemRect = anchorItemEl.getBoundingClientRect();
    setPos({
      top: itemRect.top,
      left: menuRect.right + 4,
    });
  }, [menuEl, anchorItemEl, state]);

  // Auto focus
  useLayoutEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, []);

  const isValidUrl = FIGMA_URL_REGEX.test(figmaUrl.trim());

  const handleCreate = async () => {
    if (!isValidUrl) {
      setErrorMsg(t("design.invalidUrl"));
      return;
    }
    setState("creating");
    setErrorMsg("");
    try {
      const name = extractNameFromUrl(figmaUrl);
      await onCreateDesign(name, figmaUrl.trim());
      onClose();
    } catch (err) {
      setState("error");
      setErrorMsg((err as Error).message || "Failed to create design");
    }
  };

  return createPortal(
    <div
      ref={popoverRef}
      className="create-design-popover"
      style={{ top: pos.top, left: pos.left }}
    >
      <button className="create-design-popover-close" onClick={onClose}>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M9.354 3.354a.5.5 0 00-.708-.708L6 5.293 3.354 2.646a.5.5 0 10-.708.708L5.293 6 2.646 8.646a.5.5 0 00.708.708L6 6.707l2.646 2.647a.5.5 0 00.708-.708L6.707 6l2.647-2.646z" fill="currentColor"/>
        </svg>
      </button>

      <div className="create-design-popover-title">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M10.141 17.9883L5.86567 17.978C5.69999 17.9776 5.56599 17.843 5.56639 17.6773C5.56658 17.598 5.59818 17.522 5.65426 17.4659L9.78706 13.3331C9.94327 13.1769 10.1965 13.1769 10.3527 13.3331L12.2598 15.2402L17.3172 10.1829C17.4734 10.0266 17.7266 10.0266 17.8828 10.1829C17.9579 10.2579 18 10.3596 18 10.4657V17.7C18 17.8657 17.8657 18 17.7 18H10.2243C10.1954 18 10.1674 17.9959 10.141 17.9883ZM4 22C2.9 22 2 21.1 2 20V4C2 2.9 2.9 2 4 2H20C21.1 2 22 2.9 22 4V20C22 21.1 21.1 22 20 22H4ZM4 20H20V4H4V20ZM6 6H9V9H6V6Z" fill="#336DF4"/></svg>
        {t("createMenu.design")}
      </div>

      <input
        ref={inputRef}
        className="create-design-popover-input"
        placeholder={t("design.urlPlaceholder")}
        value={figmaUrl}
        onChange={(e) => { setFigmaUrl(e.target.value); setErrorMsg(""); }}
        onKeyDown={(e) => { if (e.key === "Enter" && isValidUrl) handleCreate(); }}
        disabled={state === "creating"}
      />

      <p className="create-design-popover-hint">{t("design.sharingHint")}</p>

      {errorMsg && <p className="create-design-popover-error">{errorMsg}</p>}

      <div className="create-design-popover-actions">
        <button
          className="create-design-popover-btn primary"
          onClick={handleCreate}
          disabled={!isValidUrl || state === "creating"}
        >
          {state === "creating" ? t("design.loading") : t("design.create")}
        </button>
      </div>
    </div>,
    document.body
  );
});

export default CreateDesignPopover;
