/**
 * SkillPicker — triggered by `/` in the chat input.
 * Lists available skills (builtin + user), supports keyboard nav + search.
 * UI pattern matches MentionPicker (portal, capture-phase keyboard, auto-position).
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { listAgentSkills, type AgentSkillSummary } from "../../api";
import { useTranslation } from "../../i18n";

interface Props {
  agentId: string;
  query: string;
  atRect: { left: number; right: number; top: number; bottom: number };
  onSelect: (skill: AgentSkillSummary) => void;
  onClose: () => void;
}

export default function SkillPicker({ agentId, query, atRect, onSelect, onClose }: Props) {
  const { t } = useTranslation();
  const [skills, setSkills] = useState<AgentSkillSummary[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Load skills once
  useEffect(() => {
    listAgentSkills(agentId)
      .then((data) => setSkills(data.skills.filter((s) => s.enabled)))
      .catch(() => setSkills([]));
  }, [agentId]);

  // i18n-aware name/desc
  const localName = (s: AgentSkillSummary) => {
    const key = `skill.${s.id}.name` as any;
    const v = t(key);
    return v !== key ? v : (s.displayName || s.name);
  };
  const localDesc = (s: AgentSkillSummary) => {
    const key = `skill.${s.id}.desc` as any;
    const v = t(key);
    return v !== key ? v : s.description;
  };

  // Filter by query (search both i18n and raw values)
  const filtered = skills.filter((s) => {
    if (!query) return true;
    const q = query.toLowerCase();
    const haystack = `${s.name} ${s.displayName || ""} ${s.description} ${localName(s)} ${localDesc(s)} ${s.triggers.join(" ")}`.toLowerCase();
    return haystack.includes(q);
  });

  // Reset active index on query change
  useEffect(() => { setActiveIdx(0); }, [query]);

  // Position: above the caret (input is at bottom of chat)
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || !atRect) return;
    const rect = el.getBoundingClientRect();
    let top = atRect.top - rect.height - 6;
    let left = atRect.left;
    if (top < 4) top = atRect.bottom + 6;
    if (left + rect.width > window.innerWidth - 4) left = window.innerWidth - rect.width - 4;
    if (left < 4) left = 4;
    setPos({ top, left });
  }, [atRect, filtered.length]);

  // Keyboard navigation (capture phase, same as MentionPicker)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopImmediatePropagation();
        setActiveIdx((i) => (i + 1) % Math.max(1, filtered.length));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopImmediatePropagation();
        setActiveIdx((i) => (i - 1 + filtered.length) % Math.max(1, filtered.length));
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (filtered[activeIdx]) onSelect(filtered[activeIdx]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [filtered, activeIdx, onSelect, onClose]);

  // Scroll active item into view
  const scrollActiveIntoView = useCallback((idx: number) => {
    const container = containerRef.current;
    if (!container) return;
    const item = container.querySelector(`[data-idx="${idx}"]`) as HTMLElement;
    if (item) item.scrollIntoView({ block: "nearest" });
  }, []);
  useEffect(() => { scrollActiveIntoView(activeIdx); }, [activeIdx, scrollActiveIntoView]);

  if (filtered.length === 0 && skills.length > 0) {
    // No match — close
    return null;
  }
  if (skills.length === 0) return null;

  return createPortal(
    <div
      ref={containerRef}
      className="chat-skill-picker"
      style={pos ? { top: pos.top, left: pos.left } : { visibility: "hidden", top: 0, left: 0 }}
      onMouseDown={(e) => e.preventDefault()} // prevent blur on editor
    >
      {filtered.map((s, i) => (
        <div
          key={s.id}
          data-idx={i}
          className={`chat-skill-picker-item${i === activeIdx ? " active" : ""}`}
          onMouseEnter={() => setActiveIdx(i)}
          onClick={() => onSelect(s)}
        >
          <span className="chat-skill-picker-name" title={localDesc(s)}>
            {localName(s)}
          </span>
          {localName(s) !== s.name && (
            <span className="chat-skill-picker-id">{s.name}</span>
          )}
        </div>
      ))}
    </div>,
    document.body,
  );
}
