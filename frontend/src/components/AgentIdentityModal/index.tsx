/**
 * AgentIdentityModal — reads the Agent's soul.md + profile.md from the
 * backend (GET /api/agents/:id/identity) and lets the user edit them inline.
 *
 * Phase 1 scope: markdown textareas only, no richer editor. The Agent itself
 * can also self-edit these files via the `update_soul` / `update_profile`
 * meta-tools — this modal exists so the user can audit or seed that content
 * without going through a chat turn.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "../../i18n/index";
import {
  getAgent,
  getAgentIdentity,
  putAgentProfile,
  putAgentSoul,
  type AgentMeta,
} from "../../api";
import "./AgentIdentityModal.css";

interface Props {
  open: boolean;
  agentId: string;
  onClose: () => void;
}

export default function AgentIdentityModal({ open, agentId, onClose }: Props) {
  const { t } = useTranslation();
  const [agent, setAgent] = useState<AgentMeta | null>(null);
  const [soul, setSoul] = useState<string>("");
  const [profile, setProfile] = useState<string>("");
  const [initialSoul, setInitialSoul] = useState<string>("");
  const [initialProfile, setInitialProfile] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  // ─── Load identity when modal opens ────────────────────────────────
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setStatus(null);
    (async () => {
      try {
        const [a, id] = await Promise.all([
          getAgent(agentId),
          getAgentIdentity(agentId),
        ]);
        if (cancelled) return;
        setAgent(a);
        setSoul(id.soul);
        setProfile(id.profile);
        setInitialSoul(id.soul);
        setInitialProfile(id.profile);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, agentId]);

  // ─── Escape to close ──────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, saving, onClose]);

  const dirty = soul !== initialSoul || profile !== initialProfile;

  const handleSave = useCallback(async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const tasks: Promise<void>[] = [];
      if (soul !== initialSoul) tasks.push(putAgentSoul(agentId, soul));
      if (profile !== initialProfile) tasks.push(putAgentProfile(agentId, profile));
      await Promise.all(tasks);
      setInitialSoul(soul);
      setInitialProfile(profile);
      setStatus(t("chat.agent.saved"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [agentId, dirty, initialProfile, initialSoul, profile, saving, soul, t]);

  if (!open) return null;

  return (
    <div
      className="agent-id-overlay"
      ref={overlayRef}
      onMouseDown={(e) => {
        if (e.target === overlayRef.current && !saving) onClose();
      }}
    >
      <div className="agent-id-card" onMouseDown={(e) => e.stopPropagation()}>
        <header className="agent-id-header">
          <div>
            <div className="agent-id-title">{t("chat.agent.title")}</div>
            <div className="agent-id-subtitle">
              {agent ? `${agent.name} · ${agent.id}` : agentId}
            </div>
          </div>
          <button
            type="button"
            className="agent-id-close"
            aria-label={t("chat.agent.close")}
            onClick={onClose}
            disabled={saving}
          >
            ×
          </button>
        </header>

        <div className="agent-id-body">
          {loading ? (
            <div className="agent-id-status">{t("chat.agent.loading")}</div>
          ) : (
            <>
              <section>
                <div className="agent-id-section-label">
                  {t("chat.agent.soul.label")}
                </div>
                <div className="agent-id-section-hint">
                  {t("chat.agent.soul.hint")}
                </div>
                <textarea
                  className="agent-id-textarea"
                  value={soul}
                  onChange={(e) => setSoul(e.target.value)}
                  spellCheck={false}
                  disabled={saving}
                />
              </section>

              <section>
                <div className="agent-id-section-label">
                  {t("chat.agent.profile.label")}
                </div>
                <div className="agent-id-section-hint">
                  {t("chat.agent.profile.hint")}
                </div>
                <textarea
                  className="agent-id-textarea"
                  value={profile}
                  onChange={(e) => setProfile(e.target.value)}
                  spellCheck={false}
                  disabled={saving}
                />
              </section>
            </>
          )}
        </div>

        <footer className="agent-id-footer">
          <div className={`agent-id-status${error ? " error" : ""}`}>
            {error || status || (dirty ? t("chat.agent.dirty") : "")}
          </div>
          <div className="agent-id-actions">
            <button
              type="button"
              className="agent-id-btn agent-id-btn-cancel"
              onClick={onClose}
              disabled={saving}
            >
              {t("chat.agent.close")}
            </button>
            <button
              type="button"
              className="agent-id-btn agent-id-btn-save"
              onClick={handleSave}
              disabled={!dirty || saving || loading}
            >
              {saving ? t("chat.agent.saving") : t("chat.agent.save")}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
