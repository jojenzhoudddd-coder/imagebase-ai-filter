/**
 * ActivitiesTab — conversation turns with search, date filter, pagination.
 * Cards: title=userQuery, subtitle=timestamp, KV: output/source/duration/tokens/model.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { type AgentActivity, listAgentActivities } from "../../api";
import { useTranslation } from "../../i18n";
import Tooltip from "../Tooltip";
import CardGrid from "./CardGrid";

const PAGE_SIZE = 20;

interface Props {
  agentId: string;
  initialSearch?: string;
}

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day} ${h}:${min}`;
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTokens(prompt: number | null, completion: number | null): string {
  if (prompt == null && completion == null) return "—";
  return `${prompt ?? 0} / ${completion ?? 0}`;
}

export default function ActivitiesTab({ agentId, initialSearch }: Props) {
  const { t } = useTranslation();
  const [activities, setActivities] = useState<AgentActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);

  const [search, setSearch] = useState(initialSearch ?? "");
  const [quickRange, setQuickRange] = useState<string | null>(initialSearch ? null : "24h");
  const [committed, setCommitted] = useState({
    search: initialSearch ?? "",
    dateFrom: initialSearch ? "" : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    dateTo: initialSearch ? "" : new Date().toISOString().slice(0, 10),
  });
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const load = useCallback((pageNum: number, filters: typeof committed) => {
    setLoading(true);
    listAgentActivities(agentId, {
      limit: PAGE_SIZE,
      offset: pageNum * PAGE_SIZE,
      search: filters.search || undefined,
      dateFrom: filters.dateFrom || undefined,
      dateTo: filters.dateTo || undefined,
    })
      .then((data) => {
        setActivities(data.activities);
        setTotal(data.total);
      })
      .catch(() => { setActivities([]); setTotal(0); })
      .finally(() => setLoading(false));
  }, [agentId]);

  // Load on mount and when committed filters change
  const committedKey = `${committed.search}|${committed.dateFrom}|${committed.dateTo}`;
  useEffect(() => {
    setPage(0);
    load(0, committed);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, committedKey]);

  // Debounce search input
  const handleSearchChange = (val: string) => {
    setSearch(val);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setCommitted((prev) => ({ ...prev, search: val }));
    }, 400);
  };

  const handleQuickRange = (key: string, days: number) => {
    if (quickRange === key) {
      setQuickRange(null);
      setCommitted((prev) => ({ ...prev, dateFrom: "", dateTo: "" }));
      return;
    }
    setQuickRange(key);
    const now = new Date();
    const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    setCommitted((prev) => ({ ...prev, dateFrom: from.toISOString().slice(0, 10), dateTo: now.toISOString().slice(0, 10) }));
  };

  const handlePageChange = (newPage: number) => {
    setPage(newPage);
    load(newPage, committed);
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div>
      {/* Filter toolbar + pagination */}
      <div className="ab-activities-filters">
        {/* Quick date presets */}
        <div className="ab-activities-presets">
          {([
            { key: "24h", label: "24h", days: 1 },
            { key: "7d", label: "7d", days: 7 },
            { key: "30d", label: "30d", days: 30 },
          ] as const).map((p) => (
            <button
              key={p.key}
              className={`ab-toolbar-btn${quickRange === p.key ? " ab-toolbar-btn-active" : ""}`}
              onClick={() => handleQuickRange(p.key, p.days)}
            >
              {p.label}
            </button>
          ))}
        </div>
        {/* Search */}
        <div className="ab-activities-search">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.2" />
            <path d="M9.5 9.5L12.5 12.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") setCommitted((prev) => ({ ...prev, search })); }}
            placeholder={t("agent.activities.searchPlaceholder")}
          />
        </div>
        {/* Pagination */}
        <div className="ab-pagination">
          <span className="ab-pagination-info">{total} {t("agent.activities.total")}</span>
          <button className="ab-pagination-btn" disabled={page === 0} onClick={() => handlePageChange(page - 1)}>‹</button>
          <span className="ab-pagination-info">{page + 1} / {Math.max(1, totalPages)}</span>
          <button className="ab-pagination-btn" disabled={page >= totalPages - 1} onClick={() => handlePageChange(page + 1)}>›</button>
        </div>
      </div>

      {loading && activities.length === 0 ? (
        <div className="ab-loading">{t("agent.block.loading")}</div>
      ) : activities.length === 0 ? (
        <div className="ab-empty">{t("agent.block.noActivities")}</div>
      ) : (
        <>
          <CardGrid>
            {activities.map((a) => (
              <div key={a.messageId} className="ab-card">
                <div className="ab-card-head">
                  <div className="ab-card-title-block">
                    <Tooltip title={a.userInput}>
                      <h4 className="ab-card-title">{a.userInput}</h4>
                    </Tooltip>
                    <p className="ab-card-desc">{formatTimestamp(a.timestamp)}</p>
                  </div>
                </div>
                <div className="ab-activity-output">
                  <Tooltip title={a.output}><span>{a.output}</span></Tooltip>
                </div>
                <dl className="ab-card-kv">
                  <div className="ab-card-kv-row">
                    <dt>{t("agent.activities.model")}</dt>
                    <dd>{a.modelId || "—"}</dd>
                  </div>
                  <div className="ab-card-kv-row">
                    <dt>{t("agent.activities.source")}</dt>
                    <dd>{a.source === "-" ? "-" : a.source}</dd>
                  </div>
                  <div className="ab-card-kv-row">
                    <dt>{t("agent.activities.conversation")}</dt>
                    <Tooltip title={a.conversationTitle}><dd>{a.conversationTitle}</dd></Tooltip>
                  </div>
                  <div className="ab-card-kv-row">
                    <dt>{t("agent.card.duration")}</dt>
                    <dd>{formatDuration(a.durationMs)}</dd>
                  </div>
                  <div className="ab-card-kv-row">
                    <dt>{t("agent.card.tokens")}</dt>
                    <dd>{formatTokens(a.promptTokens, a.completionTokens)}</dd>
                  </div>
                </dl>
              </div>
            ))}
          </CardGrid>

        </>
      )}
    </div>
  );
}
