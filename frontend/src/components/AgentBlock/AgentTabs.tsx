/**
 * AgentTabs — 7-tab horizontal bar for the agent block.
 * Reuses the existing i18n keys from chat.agent.menu.*.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentTabKey } from "../../canvas/types";
import { useTranslation } from "../../i18n";

const TABS: ReadonlyArray<{ key: AgentTabKey; i18nKey: string }> = [
  { key: "nature", i18nKey: "chat.agent.menu.nature" },
  { key: "models", i18nKey: "chat.agent.menu.models" },
  { key: "habits", i18nKey: "chat.agent.menu.habits" },
  { key: "skills", i18nKey: "chat.agent.menu.skills" },
  { key: "integrations", i18nKey: "chat.agent.menu.integrations" },
  { key: "acknowledge", i18nKey: "chat.agent.menu.acknowledge" },
  { key: "activities", i18nKey: "chat.agent.menu.activities" },
];

interface Props {
  activeTab: AgentTabKey;
  onTabChange: (tab: AgentTabKey) => void;
}

export default function AgentTabs({ activeTab, onTabChange }: Props) {
  const { t } = useTranslation();
  const wrapRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [canPrev, setCanPrev] = useState(false);
  const [canNext, setCanNext] = useState(false);

  const updateScrollState = useCallback(() => {
    const el = scrollerRef.current;
    const wrap = wrapRef.current;
    if (!el || !wrap) return;
    const wrapStyle = window.getComputedStyle(wrap);
    const wrapPadding =
      parseFloat(wrapStyle.paddingLeft || "0") + parseFloat(wrapStyle.paddingRight || "0");
    const availableWidth = wrap.clientWidth - wrapPadding;
    const hasOverflow = el.scrollWidth > availableWidth + 4;
    if (!hasOverflow && el.scrollLeft !== 0) el.scrollLeft = 0;
    setCanPrev(hasOverflow && el.scrollLeft > 4);
    setCanNext(hasOverflow && el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  useEffect(() => {
    updateScrollState();
    const el = scrollerRef.current;
    const wrap = wrapRef.current;
    if (!el) return;
    let frame = 0;
    const scheduleUpdate = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(updateScrollState);
    };
    const resizeObserver = new ResizeObserver(scheduleUpdate);
    if (wrap) resizeObserver.observe(wrap);
    resizeObserver.observe(el);
    el.addEventListener("scroll", updateScrollState);
    window.addEventListener("resize", updateScrollState);
    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      el.removeEventListener("scroll", updateScrollState);
      window.removeEventListener("resize", updateScrollState);
    };
  }, [updateScrollState]);

  useEffect(() => {
    const el = scrollerRef.current;
    const active = el?.querySelector<HTMLButtonElement>(".ab-tab.active");
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
    requestAnimationFrame(updateScrollState);
  }, [activeTab, updateScrollState]);

  const scrollBy = (dx: number) => {
    scrollerRef.current?.scrollBy({ left: dx, behavior: "smooth" });
  };

  return (
    <div className="ab-tabs-wrap" ref={wrapRef}>
      {canPrev && (
        <button
          type="button"
          className="ab-tabs-arrow prev"
          onClick={() => scrollBy(-240)}
          aria-label={t("chat.empty.scrollLeft")}
        >
          <ArrowLeftIcon />
        </button>
      )}
      <div className="ab-tabs" ref={scrollerRef}>
        {TABS.map((tab) => (
          <button
            key={tab.key}
            className={`ab-tab${tab.key === activeTab ? " active" : ""}`}
            onClick={() => onTabChange(tab.key)}
          >
            {t(tab.i18nKey)}
          </button>
        ))}
      </div>
      {canNext && (
        <button
          type="button"
          className="ab-tabs-arrow next"
          onClick={() => scrollBy(240)}
          aria-label={t("chat.empty.scrollRight")}
        >
          <ArrowRightIcon />
        </button>
      )}
    </div>
  );
}

function ArrowLeftIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M9 3 5 7l4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ArrowRightIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M5 3 9 7l-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
