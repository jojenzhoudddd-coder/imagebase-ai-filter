import { useTranslation } from "../../i18n";
import type { AdminStats } from "../../api";

function formatTokenCount(n: number): string {
  if (n < 1000) return n.toLocaleString("en-US");
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0).replace(/\.0$/, "")}M`;
}

interface Props {
  stats: AdminStats | null;
}

export default function MetricCards({ stats }: Props) {
  const { t } = useTranslation();

  const cards = [
    {
      title: t("admin.metrics.users"),
      value: stats?.userCount ?? 0,
      subtitle: t("admin.metrics.total"),
      format: (v: number) => v.toLocaleString("en-US"),
    },
    {
      title: t("admin.metrics.conversations"),
      value: stats?.conversationCount ?? 0,
      subtitle: t("admin.metrics.totalConversations"),
      format: (v: number) => v.toLocaleString("en-US"),
    },
    {
      title: t("admin.metrics.activities"),
      value: stats?.activityCount ?? 0,
      subtitle: t("admin.metrics.totalActivities"),
      format: (v: number) => v.toLocaleString("en-US"),
    },
    {
      title: t("admin.metrics.tokens"),
      value: stats?.totalTokens ?? 0,
      subtitle: t("admin.metrics.totalTokens"),
      format: formatTokenCount,
    },
  ];

  return (
    <div className="adb-metrics">
      {cards.map((card) => (
        <div key={card.title} className="adb-metric-card">
          <p className="adb-metric-title">{card.title}</p>
          <p className="adb-metric-value">{card.format(card.value)}</p>
          <p className="adb-metric-subtitle">{card.subtitle}</p>
        </div>
      ))}
    </div>
  );
}
