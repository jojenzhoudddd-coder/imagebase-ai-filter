/**
 * AgentBlock — Agent homepage block in Magic Canvas.
 *
 * Layout: topbar (breadcrumb + close) → hero → tabs → content
 */

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { useCanvas } from "../../contexts/canvasContext";
import { useAuth } from "../../auth/AuthContext";
import { useWorkspace } from "../../contexts/workspaceContext";
import { useBlockShell } from "../../contexts/blockShellContext";
import {
  type AgentMeta,
  getAgent,
  renameAgent,
  uploadAgentAvatar,
} from "../../api";
import type { AgentTabKey, SystemBlockState } from "../../canvas/types";
import { useTranslation } from "../../i18n";
import InlineEdit from "../InlineEdit";
import AvatarCropDialog from "../../auth/AvatarCropDialog";
import ChatModelPicker from "../ChatSidebar/ChatModelPicker";
import AgentTabs from "./AgentTabs";
import NatureTab from "./NatureTab";
import ModelsTab from "./ModelsTab";
import ActivitiesTab from "./ActivitiesTab";
import SkillsTab from "./SkillsTab";
import HabitsTab from "./HabitsTab";
import IntegrationsTab from "./IntegrationsTab";
import AcknowledgeTab from "./AcknowledgeTab";
import PlaceholderTab from "./PlaceholderTab";
import "./AgentBlock.css";

const FALLBACK_AVATAR = "/avatars/avatar_1.png";

interface Props {
  blockId: string;
}

export default function AgentBlock({ blockId }: Props) {
  const { state, patchBlockState } = useCanvas();
  const { agentId } = useAuth();
  const { workspaceId } = useWorkspace();
  const shell = useBlockShell();
  const { t } = useTranslation();

  const blockState = (state.blockStates[blockId] ?? {}) as SystemBlockState;
  const activeTab: AgentTabKey = blockState.activeTab ?? "nature";

  const [agent, setAgent] = useState<AgentMeta | null>(null);
  const [editing, setEditing] = useState(false);
  const [cropSource, setCropSource] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!agentId) return;
    getAgent(agentId).then(setAgent).catch(() => {});
  }, [agentId]);

  // Listen for avatar changes from other blocks
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (
        detail?.agentId === agentId &&
        Object.prototype.hasOwnProperty.call(detail, "avatarUrl")
      ) {
        setAgent((prev) => prev ? { ...prev, avatarUrl: detail.avatarUrl ?? null } : prev);
      }
    };
    window.addEventListener("agent-avatar-changed", handler);
    return () => window.removeEventListener("agent-avatar-changed", handler);
  }, [agentId]);

  // Listen for name changes from other blocks
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.agentId === agentId && detail?.name) {
        setAgent((prev) => prev ? { ...prev, name: detail.name } : prev);
      }
    };
    window.addEventListener("agent-name-changed", handler);
    return () => window.removeEventListener("agent-name-changed", handler);
  }, [agentId]);

  const onFilePicked = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !/^image\/(png|jpe?g|gif|webp)$/.test(file.type)) return;
    if (file.size > 20 * 1024 * 1024) return;
    const reader = new FileReader();
    reader.onload = () => setCropSource(reader.result as string);
    reader.readAsDataURL(file);
  }, []);

  const handleCropped = useCallback(async (croppedDataUrl: string) => {
    setCropSource(null);
    if (!agentId) return;
    setUploading(true);
    try {
      const updated = await uploadAgentAvatar(agentId, croppedDataUrl);
      const newUrl = `${updated.avatarUrl}?v=${Date.now()}`;
      setAgent((prev) => prev ? { ...prev, avatarUrl: newUrl } : prev);
      // Notify all other blocks
      window.dispatchEvent(new CustomEvent("agent-avatar-changed", { detail: { agentId, avatarUrl: newUrl } }));
    } catch { /* ignore */ }
    finally { setUploading(false); }
  }, [agentId]);

  const handleTabChange = (tab: AgentTabKey) => {
    patchBlockState(blockId, { activeTab: tab, activitiesSearch: undefined } as SystemBlockState);
  };

  const handleNameSave = useCallback(async (next: string) => {
    setEditing(false);
    const trimmed = next.trim().slice(0, 40);
    if (!trimmed || !agentId || trimmed === agent?.name) return;
    setAgent((prev) => prev ? { ...prev, name: trimmed } : prev);
    try {
      const updated = await renameAgent(agentId, trimmed);
      setAgent((prev) => prev ? { ...prev, name: updated.name } : prev);
      // Broadcast name change to all blocks
      window.dispatchEvent(new CustomEvent("agent-name-changed", { detail: { agentId, name: updated.name } }));
    } catch {
      if (agentId) getAgent(agentId).then(setAgent).catch(() => {});
    }
  }, [agentId, agent?.name]);

  const resolvedAgentId = agentId || "agent_default";
  const agentName = agent?.name || "Agent";
  const tabLabel = t(`chat.agent.menu.${activeTab}` as any);

  const renderTab = () => {
    switch (activeTab) {
      case "nature":
        return <NatureTab agentId={resolvedAgentId} />;
      case "models":
        return <ModelsTab blockId={blockId} />;
      case "activities":
        return <ActivitiesTab agentId={resolvedAgentId} initialSearch={blockState.activitiesSearch} />;
      case "skills":
        return <SkillsTab agentId={resolvedAgentId} blockId={blockId} />;
      case "habits":
        return <HabitsTab agentId={resolvedAgentId} blockId={blockId} />;
      case "integrations":
        return <IntegrationsTab agentId={resolvedAgentId} blockId={blockId} />;
      case "acknowledge":
        return <AcknowledgeTab agentId={resolvedAgentId} />;
      default:
        return <PlaceholderTab />;
    }
  };

  return (
    <div className="ab-root">
      {/* Topbar: breadcrumb + close */}
      <div className="ab-topbar">
        <div className="topbar-breadcrumb">
          <span className="topbar-crumb">{agentName}</span>
          <svg className="topbar-sep-arrow" width="8" height="12" viewBox="143 15.5 6.5 10" fill="none">
            <path d="M144.146 16.6464C143.951 16.8417 143.951 17.1583 144.146 17.3536L147.293 20.5L144.146 23.6464C143.951 23.8417 143.951 24.1583 144.146 24.3536C144.342 24.5488 144.658 24.5488 144.854 24.3536L148.354 20.8536C148.447 20.7598 148.5 20.6326 148.5 20.5C148.5 20.3674 148.447 20.2402 148.354 20.1464L144.854 16.6464C144.658 16.4512 144.342 16.4512 144.146 16.6464Z" fill="currentColor"/>
          </svg>
          <span className="topbar-crumb-current">{tabLabel}</span>
        </div>
        <div className="ab-topbar-spacer" />
        {shell?.canClose && (
          <button className="ab-topbar-close" onClick={shell.onClose} title="Close">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>

      {/* Hero */}
      <div className="ab-hero">
        <div className="ab-hero-avatar-wrap" title={t("topbar.changeAvatar") as string}>
          {agent ? (
            <img
              key={agent.avatarUrl}
              className="ab-hero-avatar"
              src={agent.avatarUrl || FALLBACK_AVATAR}
              alt=""
              onError={(e) => { (e.currentTarget as HTMLImageElement).src = FALLBACK_AVATAR; }}
            />
          ) : (
            <div className="ab-hero-avatar ab-hero-avatar-skeleton" />
          )}
          <div className="ab-hero-avatar-overlay">
            {uploading ? (
              <span>…</span>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M4 7h3l1.5-2h7L17 7h3a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V8a1 1 0 011-1z" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                <circle cx="12" cy="13" r="3.5" stroke="#fff" strokeWidth="1.6" />
              </svg>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            className="ab-hero-avatar-input"
            onChange={onFilePicked}
          />
        </div>
        <div className="ab-hero-meta">
          <div className="ab-hero-line">
            <span className="ab-hero-name">
              <InlineEdit
                value={agentName}
                isEditing={editing}
                onStartEdit={() => setEditing(true)}
                onSave={handleNameSave}
                onCancelEdit={() => setEditing(false)}
                maxLength={40}
              />
            </span>
          </div>
          <div className="ab-hero-chips">
            {resolvedAgentId && (
              <ChatModelPicker agentId={resolvedAgentId} workspaceId={workspaceId} open={true} />
            )}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <AgentTabs activeTab={activeTab} onTabChange={handleTabChange} />

      {/* Content */}
      <div className="ab-content">
        {renderTab()}
      </div>

      {cropSource && (
        <AvatarCropDialog
          sourceDataUrl={cropSource}
          onConfirm={handleCropped}
          onCancel={() => setCropSource(null)}
        />
      )}
    </div>
  );
}
