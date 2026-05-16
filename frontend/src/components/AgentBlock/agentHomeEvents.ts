import { useEffect } from "react";

export const AGENT_HOME_REFRESH_EVENT = "agent-home-refresh";

export interface AgentHomeRefreshDetail {
  agentId?: string | null;
  reason?: string;
}

export function dispatchAgentHomeRefresh(agentId?: string | null, reason?: string) {
  window.dispatchEvent(
    new CustomEvent<AgentHomeRefreshDetail>(AGENT_HOME_REFRESH_EVENT, {
      detail: { agentId, reason },
    }),
  );
}

export function useAgentHomeRefresh(
  agentId: string | null | undefined,
  onRefresh: () => void,
) {
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<AgentHomeRefreshDetail>).detail;
      if (detail?.agentId && agentId && detail.agentId !== agentId) return;
      onRefresh();
    };

    window.addEventListener(AGENT_HOME_REFRESH_EVENT, handler);
    return () => window.removeEventListener(AGENT_HOME_REFRESH_EVENT, handler);
  }, [agentId, onRefresh]);
}
