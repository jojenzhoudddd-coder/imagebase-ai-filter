import { useState } from "react";

export interface LarkAuthPayload {
  phase: "auth" | "config";
  authSessionId: string;
  integrationId?: string;
  verificationUrl?: string | null;
  userCode?: string | null;
  expiresAt?: string | null;
}

interface Props {
  payload: LarkAuthPayload;
  onContinue?: (payload: LarkAuthPayload) => void;
  disabled?: boolean;
}

export default function LarkAuthCard({ payload, onContinue, disabled }: Props) {
  const [copied, setCopied] = useState(false);
  const title = payload.phase === "config" ? "飞书应用配置" : "飞书授权";
  const description = payload.phase === "config"
    ? "需要先完成飞书应用配置，完成后会继续进入用户授权。"
    : "需要在飞书页面完成授权，完成后回到这里继续执行。";
  const expires = formatExpiresAt(payload.expiresAt);
  const copyLabel = copied ? "已复制链接" : "复制授权链接";
  const handleCopy = async () => {
    if (!payload.verificationUrl) return;
    const ok = await copyText(payload.verificationUrl);
    if (!ok) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="chat-confirm-card v2 chat-lark-auth-card">
      <div className="chat-confirm-card-header">
        <span className="chat-confirm-card-icon chat-lark-auth-icon" aria-hidden="true">
          L
        </span>
        <span className="chat-confirm-card-title">{title}</span>
      </div>
      <div className="chat-confirm-card-body chat-lark-auth-body">
        <div>{description}</div>
        {(payload.userCode || expires) && (
          <div className="chat-lark-auth-meta">
            {payload.userCode && (
              <div className="chat-lark-auth-row">
                <span className="chat-lark-auth-label">验证码</span>
                <code className="chat-lark-auth-code">{payload.userCode}</code>
              </div>
            )}
            {expires && (
              <div className="chat-lark-auth-row">
                <span className="chat-lark-auth-label">有效期</span>
                <span className="chat-lark-auth-value">{expires}</span>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="chat-confirm-actions chat-lark-auth-actions">
        {payload.verificationUrl && (
          <button
            type="button"
            className="chat-lark-auth-copy-btn"
            onClick={handleCopy}
            title={copyLabel}
            aria-label={copyLabel}
          >
            <CopyIcon />
          </button>
        )}
        {payload.verificationUrl && (
          <a
            className="chat-confirm-btn secondary chat-lark-auth-open"
            href={payload.verificationUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            打开授权页
          </a>
        )}
        <button
          type="button"
          className="chat-confirm-btn primary"
          onClick={() => onContinue?.(payload)}
          disabled={disabled}
        >
          我已完成授权
        </button>
      </div>
    </div>
  );
}

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M9 3C9 2.44772 9.44772 2 10 2H20C20.5523 2 21 2.44772 21 3V15C21 15.5523 20.5523 16 20 16C19.4477 16 19 15.5523 19 15V4H10C9.44771 4 9 3.55228 9 3Z" fill="currentColor"/>
      <path d="M5 6C3.89543 6 3 6.89543 3 8V20C3 21.1046 3.89543 22 5 22H15C16.1046 22 17 21.1046 17 20V8C17 6.89543 16.1046 6 15 6H5ZM5 8H15V20H5L5 8Z" fill="currentColor"/>
    </svg>
  );
}

async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy path below.
    }
  }
  const el = document.createElement("textarea");
  el.value = text;
  el.setAttribute("readonly", "");
  el.style.position = "fixed";
  el.style.left = "-9999px";
  document.body.appendChild(el);
  el.select();
  try {
    return document.execCommand("copy");
  } finally {
    document.body.removeChild(el);
  }
}

export function extractLarkAuthPayload(result: unknown): LarkAuthPayload | null {
  const parsed = parseJsonLike(result);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.ok !== true || record.status !== "pending") return null;
  if (record.phase !== "auth" && record.phase !== "config") return null;
  if (typeof record.authSessionId !== "string" || !record.authSessionId.trim()) return null;
  const verificationUrl = typeof record.verificationUrl === "string" && record.verificationUrl.trim()
    ? record.verificationUrl.trim()
    : null;
  const qrCodeText = typeof record.qrCodeText === "string" && record.qrCodeText.trim()
    ? record.qrCodeText.trim()
    : null;
  if (!verificationUrl && !qrCodeText) return null;
  return {
    phase: record.phase,
    authSessionId: record.authSessionId.trim(),
    integrationId: typeof record.integrationId === "string" ? record.integrationId : undefined,
    verificationUrl,
    userCode: typeof record.userCode === "string" ? record.userCode : null,
    expiresAt: typeof record.expiresAt === "string" ? record.expiresAt : null,
  };
}

function parseJsonLike(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

function formatExpiresAt(value?: string | null): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
}
