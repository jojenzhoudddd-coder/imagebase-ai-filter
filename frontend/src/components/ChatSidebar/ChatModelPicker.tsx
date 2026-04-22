/**
 * ChatModelPicker — pill button in the chat header that displays the
 * currently-running model and lets the user switch between the whitelisted
 * models. Click toggles a DropdownMenu with a flat list of every visible
 * model (no vendor section headers — each display name already carries the
 * vendor: "Claude 4.7 Opus", "GPT-5.4", "Doubao 2.0 pro", so grouping was
 * redundant). Sort order still follows the Anthropic → OpenAI → Volcano
 * preference so the preferred default floats to the top. Availability
 * indicators are shown on unreachable entries.
 *
 * The backend is the source of truth:
 *   · `GET  /api/agents/models`          → populates the menu
 *   · `GET  /api/agents/:id/model`       → tells us the current selection
 *                                          (and its resolved form, in case
 *                                          we're on a fallback)
 *   · `PUT  /api/agents/:id/model`       → persists the new selection
 *
 * We fetch models + selection on mount and whenever `open` flips (so the
 * picker rehydrates when the sidebar is re-opened — availability may have
 * changed in the background while it was closed).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import DropdownMenu, { type MenuItem } from "../DropdownMenu";
import { useTranslation } from "../../i18n";
import {
  getAgentModel,
  listModels,
  setAgentModel,
  type AgentModelSelection,
  type ModelSummary,
} from "../../api";

interface Props {
  agentId: string;
  /** When the sidebar is visible; triggers a re-fetch of availability. */
  open: boolean;
  /** Disable interactions while the agent is actively streaming — swapping
   * mid-turn would corrupt the tool-call loop. */
  disabled?: boolean;
  /** Optional callback fired on successful selection change, so the parent
   * can surface "switched to X" / re-fetch context if it needs to. */
  onChange?: (next: AgentModelSelection) => void;
}

const GROUP_ORDER: Array<ModelSummary["group"]> = ["anthropic", "openai", "volcano"];

export default function ChatModelPicker({ agentId, open, disabled, onChange }: Props) {
  const { t } = useTranslation();
  const [models, setModels] = useState<ModelSummary[] | null>(null);
  const [selection, setSelection] = useState<AgentModelSelection | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [list, sel] = await Promise.all([listModels(), getAgentModel(agentId)]);
      setModels(list.models);
      setSelection(sel);
    } catch {
      // Non-fatal — we just leave the picker as-is. Next refresh retries.
    }
  }, [agentId]);

  useEffect(() => {
    if (!open) return;
    void refresh();
    // Periodic silent re-probe while sidebar is open so availability flips
    // (e.g. OneAPI admin enables Opus 4.7 mid-session) reach the menu
    // without the user having to close and re-open. 60s is cheap enough.
    const t = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(t);
  }, [open, refresh]);

  const handleSelect = useCallback(
    async (modelId: string) => {
      if (!selection || modelId === selection.selected) {
        setMenuOpen(false);
        return;
      }
      setPending(modelId);
      setMenuOpen(false);
      try {
        const next = await setAgentModel(agentId, modelId);
        setSelection(next);
        onChange?.(next);
      } catch (err) {
        console.warn("[model-picker] set failed", err);
      } finally {
        setPending(null);
      }
    },
    [agentId, selection, onChange]
  );

  // Display label: what the user selected. If we're on a fallback, suffix a
  // small hint so they know the real route. Pill never panics on missing
  // data — the header button just shows a dash until the fetch completes.
  const displayLabel = (() => {
    if (!selection) return "…";
    const selectedModel = models?.find((m) => m.id === selection.selected);
    const label = selectedModel?.displayName ?? selection.selected;
    if (selection.usedFallback && selection.resolved.id !== selection.selected) {
      return `${label} → ${selection.resolved.displayName}`;
    }
    return label;
  })();

  const items: MenuItem[] = (models ?? []).slice().sort((a, b) => {
    const gi = GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group);
    if (gi !== 0) return gi;
    return a.displayName.localeCompare(b.displayName);
  }).map((m) => {
    const selectedId = selection?.selected;
    const isSelected = m.id === selectedId;
    const isPending = pending === m.id;
    const suffix = isPending ? (
      <span className="chat-model-picker-suffix">…</span>
    ) : isSelected ? (
      <span className="chat-model-picker-suffix" aria-label={t("chat.model.selected")}>✓</span>
    ) : !m.available ? (
      <span className="chat-model-picker-suffix chat-model-picker-unavailable" title={t("chat.model.unavailable")}>
        {t("chat.model.unavailableShort")}
      </span>
    ) : undefined;
    return {
      key: m.id,
      label: m.displayName,
      suffix,
      // Let the user pick unavailable models — the saved preference is
      // honored on next availability flip. But we disable them if the turn
      // is in flight so a mid-turn swap can't create churn.
      disabled: disabled && !isSelected,
      // No `section` — flat list. Each model name already carries its vendor
      // ("Claude ...", "GPT-...", "Doubao ...") so the extra header level
      // was just noise.
    };
  });

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="chat-model-picker-btn"
        title={selection ? t("chat.model.current", { name: selection.resolved.displayName }) : t("chat.model.pick")}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        disabled={disabled || !models || !selection}
        onClick={() => setMenuOpen((v) => !v)}
      >
        <span className="chat-model-picker-label">{displayLabel}</span>
        <span className="chat-model-picker-chevron" aria-hidden>▾</span>
      </button>
      {menuOpen && btnRef.current && (
        <DropdownMenu
          anchorEl={btnRef.current}
          items={items}
          width={220}
          onSelect={(key) => void handleSelect(key)}
          onClose={() => setMenuOpen(false)}
        />
      )}
    </>
  );
}
