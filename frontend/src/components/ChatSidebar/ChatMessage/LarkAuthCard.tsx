import { useState } from "react";
import { useToast } from "../../Toast";
import { Chevron } from "./cardCommon";

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
  const [expanded, setExpanded] = useState(true);
  const toast = useToast();
  const title = payload.phase === "config" ? "飞书应用配置" : "飞书授权";
  const description = payload.phase === "config"
    ? "需要先完成飞书应用配置，完成后会继续进入用户授权。"
    : "需要在飞书页面完成授权，完成后回到这里继续执行。";
  const expires = formatExpiresAt(payload.expiresAt);
  const copyLabel = copied ? "已复制链接" : "复制授权链接";
  const handleCopy = async () => {
    if (!payload.verificationUrl) return;
    const ok = await copyText(payload.verificationUrl);
    if (!ok) {
      toast.error("复制失败，请手动复制链接");
      return;
    }
    setCopied(true);
    toast.success("已复制授权链接");
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="chat-confirm-card v2 chat-lark-auth-card">
      <button
        type="button"
        className="chat-confirm-card-header chat-lark-auth-header"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <span className="chat-confirm-card-icon chat-lark-auth-icon" aria-hidden="true">
          <ReconsiderationIcon />
        </span>
        <span className="chat-confirm-card-title">{title}</span>
        <Chevron expanded={expanded} />
      </button>
      {expanded && (
        <>
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
        </>
      )}
    </div>
  );
}

function ReconsiderationIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M14.4357 21.4309C14.4357 21.1547 14.6596 20.9309 14.9357 20.9309H21.9357C22.2119 20.9309 22.4357 21.1547 22.4357 21.4309V22.0309C22.4357 22.307 22.2119 22.5309 21.9357 22.5309H14.9357C14.6596 22.5309 14.4357 22.307 14.4357 22.0309V21.4309Z" fill="currentColor" />
      <path d="M3.96521 17.825C3.33166 18.7298 3.55156 19.9769 4.45637 20.6104L5.88402 21.6101C6.78883 22.2436 8.03592 22.0237 8.66947 21.1189L12.232 16.0312L7.5277 12.7372L3.96521 17.825ZM6.80174 20.2994L5.37409 19.2998C5.19312 19.1731 5.14915 18.9236 5.27586 18.7427L8.83669 13.6573L10.9197 15.1158L7.35883 20.2012C7.23212 20.3822 6.9827 20.4261 6.80174 20.2994Z" fill="currentColor" />
      <path d="M13.148 14.7229L8.44377 11.4289L7.5277 12.7372L12.232 16.0312L13.148 14.7229Z" fill="currentColor" />
      <path d="M10.7385 3.84016L5.50192 11.3187L6.31183 11.8858C6.78949 11.7842 7.23128 11.5085 7.53348 11.0769L11.205 5.83342C11.5077 5.40109 11.6156 4.89063 11.547 4.40628L10.7385 3.84016Z" fill="currentColor" />
      <path d="M14.1264 17.3577L19.363 9.87908L18.5494 9.30941C18.0708 9.41061 17.628 9.68657 17.3252 10.1189L13.6537 15.3624C13.3516 15.7939 13.2435 16.3034 13.3114 16.787L14.1264 17.3577Z" fill="currentColor" />
      <path d="M19.363 9.87908L14.1264 17.3577L13.3114 16.787C13.3858 17.3173 13.6717 17.8164 14.1449 18.1478L15.1805 18.873C16.0853 19.5065 17.3324 19.2866 17.966 18.3818L21.6375 13.1384C22.271 12.2336 22.0511 10.9865 21.1463 10.3529L20.1107 9.62775C19.6382 9.29692 19.0724 9.1988 18.5494 9.30941L19.363 9.87908ZM16.0982 17.5623L15.0626 16.8372C14.8817 16.7105 14.8377 16.461 14.9644 16.2801L18.6359 11.0366C18.7626 10.8557 19.012 10.8117 19.193 10.9384L20.2286 11.6636C20.4096 11.7903 20.4536 12.0397 20.3268 12.2206L16.6553 17.4641C16.5286 17.6451 16.2792 17.689 16.0982 17.5623Z" fill="currentColor" />
      <path d="M5.50192 11.3187L10.7385 3.84016L11.547 4.40628C11.472 3.87694 11.1863 3.3788 10.7138 3.04796L9.6782 2.3228C8.77339 1.68925 7.5263 1.90915 6.89274 2.81396L3.22124 8.0574C2.58769 8.96221 2.80758 10.2093 3.71239 10.8429L4.74802 11.568C5.22125 11.8994 5.7881 11.9973 6.31183 11.8858L5.50192 11.3187ZM8.76048 3.63345L9.79611 4.3586C9.97707 4.48531 10.021 4.73473 9.89434 4.91569L6.22284 10.1591C6.09613 10.3401 5.84671 10.3841 5.66574 10.2574L4.63012 9.53222C4.44915 9.40551 4.40517 9.15609 4.53189 8.97512L8.20339 3.73168C8.3301 3.55072 8.57952 3.50674 8.76048 3.63345Z" fill="currentColor" />
      <path d="M11.205 5.83342L7.53348 11.0769C7.23128 11.5085 6.78949 11.7842 6.31183 11.8858L7.5277 12.7372L8.44377 11.4289L13.148 14.7229L12.232 16.0312L13.3114 16.787C13.2435 16.3034 13.3516 15.7939 13.6537 15.3624L17.3252 10.1189C17.628 9.68657 18.0708 9.41061 18.5494 9.30941L11.547 4.40628C11.6156 4.89063 11.5077 5.40109 11.205 5.83342ZM17.1346 10.272L13.7335 15.1293L7.73029 10.9258L11.1314 6.06852L17.1346 10.272Z" fill="currentColor" />
    </svg>
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
  const nested = extractLarkAuthPayload(record.result);
  if (nested) return nested;
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
