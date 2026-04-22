/**
 * AgentNamePill — top-left of the chat sidebar header. Renders the Agent's
 * display name (e.g. "Quan's Agent") as a plain title, matching the IdeaEditor
 * / SvgCanvas topbar-name pattern. Double-click to rename inline (shared
 * `InlineEdit` component).
 *
 * Two rename paths converge on the same DB row:
 *   1. Double-click → InlineEdit → blur/Enter → `PUT /api/agents/:id`.
 *   2. User tells the Agent "以后你就叫 X" in chat → the `update_agent_name`
 *      Tier 0 meta-tool writes the same row. We re-fetch on sidebar open +
 *      after each streaming turn ends (via `refreshToken`) so the title stays
 *      in sync without manual refresh.
 *
 * No other agent metadata is surfaced in the header — for soul/profile users
 * still talk to the Agent (Phase 1 "no identity modal" posture).
 */

import { useCallback, useEffect, useState } from "react";
import InlineEdit from "../InlineEdit";
import { getAgent, renameAgent } from "../../api";

interface Props {
  agentId: string;
  /** True while the sidebar is visible. Controls initial fetch. */
  open: boolean;
  /** Bumped by the parent after a streaming turn ends, so we re-fetch the
   * agent in case `update_agent_name` was invoked mid-turn. */
  refreshToken?: number;
  /** True while a turn is actively streaming. Disables rename starts to
   * avoid racing with an in-flight `update_agent_name` tool call. */
  disabled?: boolean;
}

const MAX_NAME_LEN = 40;

export default function AgentNamePill({ agentId, open, refreshToken, disabled }: Props) {
  const [name, setName] = useState<string>("");
  const [editing, setEditing] = useState(false);

  const loadName = useCallback(async () => {
    try {
      const a = await getAgent(agentId);
      setName(a.name);
    } catch {
      // Non-fatal — keep whatever we had.
    }
  }, [agentId]);

  // Initial load + refresh-on-open so cross-tab / chat-initiated renames
  // surface here too.
  useEffect(() => {
    if (!open) return;
    void loadName();
  }, [open, loadName]);

  // Re-fetch after each streaming turn ends (parent bumps refreshToken) in
  // case the model called `update_agent_name` mid-turn.
  useEffect(() => {
    if (!open || refreshToken === undefined) return;
    void loadName();
  }, [open, refreshToken, loadName]);

  const handleSave = useCallback(
    async (next: string) => {
      const trimmed = next.trim().slice(0, MAX_NAME_LEN);
      setEditing(false);
      if (!trimmed || trimmed === name) return;
      // Optimistic — mirror IdeaEditor's pattern of committing locally first
      // so the title doesn't flicker while the PUT round-trips.
      setName(trimmed);
      try {
        const updated = await renameAgent(agentId, trimmed);
        setName(updated.name);
      } catch (err) {
        console.warn("[agent-name] rename failed", err);
        // Revert to server state.
        void loadName();
      }
    },
    [agentId, loadName, name],
  );

  return (
    <span className="chat-agent-name">
      <InlineEdit
        value={name || "…"}
        isEditing={editing && !disabled}
        onStartEdit={() => {
          if (disabled) return;
          setEditing(true);
        }}
        onSave={handleSave}
        onCancelEdit={() => setEditing(false)}
        maxLength={MAX_NAME_LEN}
      />
    </span>
  );
}
