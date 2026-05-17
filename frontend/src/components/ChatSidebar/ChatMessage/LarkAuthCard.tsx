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
  const title = payload.phase === "config" ? "飞书应用配置" : "飞书授权";
  const description = payload.phase === "config"
    ? "需要先完成飞书应用配置，完成后会继续进入用户授权。"
    : "需要在飞书页面完成授权，完成后回到这里继续执行。";
  const expires = formatExpiresAt(payload.expiresAt);

  return (
    <div className="chat-lark-auth-card">
      <div className="chat-lark-auth-head">
        <span className="chat-lark-auth-icon" aria-hidden="true">L</span>
        <div className="chat-lark-auth-title-wrap">
          <div className="chat-lark-auth-title">{title}</div>
          <div className="chat-lark-auth-desc">{description}</div>
        </div>
      </div>
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
      <div className="chat-lark-auth-actions">
        {payload.verificationUrl && (
          <button
            type="button"
            className="chat-lark-auth-btn secondary"
            onClick={() => window.open(payload.verificationUrl || "", "_blank", "noopener,noreferrer")}
          >
            打开授权页
          </button>
        )}
        <button
          type="button"
          className="chat-lark-auth-btn primary"
          onClick={() => onContinue?.(payload)}
          disabled={disabled}
        >
          我已完成授权
        </button>
      </div>
    </div>
  );
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
