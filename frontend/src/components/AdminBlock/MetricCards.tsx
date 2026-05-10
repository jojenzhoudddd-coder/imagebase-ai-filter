import { useTranslation } from "../../i18n";
import type { AdminStats, DailySnapshot } from "../../api";

function formatTokenCount(n: number): string {
  if (n < 1000) return n.toLocaleString("en-US");
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0).replace(/\.0$/, "")}M`;
}

function Sparkline({ data, width = 80, height = 36 }: { data: number[]; width?: number; height?: number }) {
  if (data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((v - min) / range) * (height - 4) - 2;
    return `${x},${y}`;
  }).join(" ");
  return (
    <svg width={width} height={height} className="adb-sparkline">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface Props {
  stats: AdminStats | null;
  history: DailySnapshot[];
}

export default function MetricCards({ stats, history }: Props) {
  const { t } = useTranslation();

  const cards: Array<{
    title: string;
    value: number;
    subtitle: string;
    format: (v: number) => string;
    historyKey: keyof DailySnapshot;
  }> = [
    {
      title: t("admin.metrics.users"),
      value: stats?.userCount ?? 0,
      subtitle: t("admin.metrics.total"),
      format: (v: number) => v.toLocaleString("en-US"),
      historyKey: "userCount",
    },
    {
      title: t("admin.metrics.conversations"),
      value: stats?.conversationCount ?? 0,
      subtitle: t("admin.metrics.totalConversations"),
      format: (v: number) => v.toLocaleString("en-US"),
      historyKey: "conversationCount",
    },
    {
      title: t("admin.metrics.activities"),
      value: stats?.activityCount ?? 0,
      subtitle: t("admin.metrics.totalActivities"),
      format: (v: number) => v.toLocaleString("en-US"),
      historyKey: "activityCount",
    },
    {
      title: t("admin.metrics.tokens"),
      value: stats?.totalTokens ?? 0,
      subtitle: t("admin.metrics.totalTokens"),
      format: formatTokenCount,
      historyKey: "totalTokens",
    },
  ];

  return (
    <div className="adb-metrics">
      {cards.map((card) => (
        <div key={card.title} className="adb-metric-card">
          <div className="adb-metric-content">
            <p className="adb-metric-title">{card.title}</p>
            <p className="adb-metric-value">{card.format(card.value)}</p>
            <p className="adb-metric-subtitle">{card.subtitle}</p>
          </div>
          <Sparkline data={history.map((h) => h[card.historyKey] as number)} />
        </div>
      ))}
    </div>
  );
}
