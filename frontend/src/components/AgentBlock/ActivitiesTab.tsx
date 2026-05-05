/**
 * ActivitiesTab — displays all conversation turns with metadata.
 * Supports "load more" pagination.
 * Design: .ec card pattern with KV grid.
 */

import { useCallback, useEffect, useState } from "react";
import { type AgentActivity, listAgentActivities } from "../../api";
import { useTranslation } from "../../i18n";
import Tooltip from "../Tooltip";
import CardGrid from "./CardGrid";

const PAGE_SIZE = 20;

interface Props {
  agentId: string;
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

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function ActivitiesTab({ agentId }: Props) {
  const { t } = useTranslation();
  const [activities, setActivities] = useState<AgentActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);

  const load = useCallback((offset: number, append: boolean) => {
    setLoading(true);
    listAgentActivities(agentId, { limit: PAGE_SIZE, offset })
      .then((data) => {
        setActivities((prev) => append ? [...prev, ...data.activities] : data.activities);
        setHasMore(data.hasMore);
      })
      .catch(() => {
        if (!append) setActivities([]);
        setHasMore(false);
      })
      .finally(() => setLoading(false));
  }, [agentId]);

  useEffect(() => { load(0, false); }, [load]);

  if (loading && activities.length === 0) {
    return <div className="ab-loading">{t("agent.block.loading")}</div>;
  }
  if (activities.length === 0) {
    return <div className="ab-empty">{t("agent.block.noActivities")}</div>;
  }

  return (
    <>
      <CardGrid>
        {activities.map((a) => (
          <div key={a.messageId} className="ab-card">
            <div className="ab-card-head">
              <div className="ab-card-title-block">
                <Tooltip title={a.userInput}>
                  <h4 className="ab-card-title">
                    {a.userInput.length > 60 ? a.userInput.slice(0, 60) + "…" : a.userInput}
                  </h4>
                </Tooltip>
                <Tooltip title={a.conversationTitle}><p className="ab-card-desc">{a.conversationTitle}</p></Tooltip>
              </div>
              <div className="ab-card-controls">
                <button className="ab-card-more" title="More">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <circle cx="3.5" cy="8" r="1.2" fill="currentColor" />
                    <circle cx="8" cy="8" r="1.2" fill="currentColor" />
                    <circle cx="12.5" cy="8" r="1.2" fill="currentColor" />
                  </svg>
                </button>
              </div>
            </div>
            <dl className="ab-card-kv">
              <div className="ab-card-kv-row">
                <dt>{t("agent.card.time")}</dt>
                <dd>{timeAgo(a.timestamp)}</dd>
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
      {hasMore && (
        <div className="ab-load-more">
          <button
            className="ab-load-more-btn"
            disabled={loading}
            onClick={() => load(activities.length, true)}
          >
            {loading ? "..." : t("agent.block.loadMore")}
          </button>
        </div>
      )}
    </>
  );
}
