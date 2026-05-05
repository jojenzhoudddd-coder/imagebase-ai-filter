/**
 * Chat sidebar icons (inline SVG, 16x16 viewBox convention).
 * The four-pointed star serves as the entry-point button.
 */

interface IconProps {
  size?: number;
  className?: string;
}

export function FourPointStarIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <defs>
        <linearGradient id="chat_star_grad" x1="2" y1="2" x2="14" y2="14" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#4D83F5" />
          <stop offset="0.5" stopColor="#B463F2" />
          <stop offset="1" stopColor="#F5406B" />
        </linearGradient>
      </defs>
      <path
        d="M8 1c.2 0 .4.15.45.35l.9 3.16c.2.7.75 1.25 1.45 1.45l3.16.9c.35.1.35.6 0 .7l-3.16.9c-.7.2-1.25.75-1.45 1.45l-.9 3.16c-.1.35-.6.35-.7 0l-.9-3.16c-.2-.7-.75-1.25-1.45-1.45l-3.16-.9c-.35-.1-.35-.6 0-.7l3.16-.9c.7-.2 1.25-.75 1.45-1.45l.9-3.16c.05-.2.25-.35.45-.35z"
        fill="url(#chat_star_grad)"
      />
    </svg>
  );
}

export function PlusIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function HistoryIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path d="M8 4v4l2.5 1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/** `icon_more_outlined` — three horizontal dots (Figma node 1:43).
 * 16×16 viewBox, currentColor so the parent button can tint it #646A73.
 * Used in the Chat panel header's right-side icon cluster. */
export function MoreIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <circle cx="3.5" cy="8" r="1.2" fill="currentColor" />
      <circle cx="8" cy="8" r="1.2" fill="currentColor" />
      <circle cx="12.5" cy="8" r="1.2" fill="currentColor" />
    </svg>
  );
}

export function CloseIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** Send-button glyph used inside the .chat-input-send 28×28 dark circle.
 * Figma references the raster `_senter-icon` (node 4504:8112) — an upward
 * arrow centred in the circle. We reproduce it as a 14×14 stroke arrow:
 * vertical shaft + chevron head, currentColor so the parent supplies white. */
export function SendIcon({ size = 14, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" className={className}>
      <path
        d="M7 11V3.5M3.5 7 7 3.5 10.5 7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** `icon_at_outlined` — stylised @ glyph used inside the input bar's left pill
 * (Figma node 1:8025). Keeps strokes around 1.2 to match the project's thin-line
 * icon family. */
export function AtIcon({ size = 14, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" className={className}>
      <circle cx="7" cy="7" r="2.5" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M9.5 7v1.2c0 .8.7 1.5 1.5 1.5s1.5-.7 1.5-1.5V7a5.5 5.5 0 10-2.1 4.3"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Stop-generation glyph — Figma renders an 8.235×8.235 rounded square
 * centred inside the 28×28 button (at 9.88,9.88). We approximate with an
 * 8×8 rect in a 12-viewBox, rx 1.5, filled in currentColor (white on the
 * dark stop button). */
export function StopIcon({ size = 12, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" className={className}>
      <rect x="2" y="2" width="8" height="8" rx="1.5" fill="currentColor" />
    </svg>
  );
}

/** Refresh glyph — circular arrow pointing back to a "/new" (reset) state.
 * Two half-arcs + arrow heads so it reads as refresh, not as history/sync. */
export function RefreshIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path
        d="M13.5 3.5v2.7h-2.7"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M2.5 12.5v-2.7h2.7"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M13 6.2A5.5 5.5 0 003.1 6.7M3 9.8a5.5 5.5 0 009.9.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Trash icon — used by the chat header more-menu "Delete current chat" item. */
export function TrashIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path
        d="M6 2a1 1 0 00-1 1h6a1 1 0 00-1-1H6zM4 4h8v9a1 1 0 01-1 1H5a1 1 0 01-1-1V4zM3 4h10V3H3v1zM6.5 6v5M9.5 6v5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Settings cog — 8-tooth outline gear used in the chat header. Placeholder
 * for a future settings drawer; currently wired to a no-op onClick. */
export function SettingsIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.13 1.13M4.73 11.27L3.6 12.4M12.4 12.4l-1.13-1.13M4.73 4.73L3.6 3.6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Microphone — reused for the voice input button in ChatInput. Matches
 * the visual weight of FilterPanel's MicIcon but drawn in 14×14 so it sits
 * nicely inside the 28px pill next to @ mention. */
export function MicIcon({ size = 14, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="currentColor" className={className}>
      <path d="M7 1.2a2 2 0 00-2 2v3.2a2 2 0 004 0V3.2a2 2 0 00-2-2z" />
      <path d="M11 6.2a4 4 0 01-8 0H2a5 5 0 004.5 4.97V12.5h1V11.17A5 5 0 0012 6.2h-1z" />
    </svg>
  );
}

// ── Agent meta dropdown icons (16×16, 1.4 stroke, currentColor) ─────────
// 占位图标,后续接各自页面时可换成 Figma 标准图标库版本.

/** Nature 性格 — heart outline */
export function NatureIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path
        d="M8 13.5C8 13.5 2 10.5 2 6.3C2 4.5 3.4 3 5.2 3C6.5 3 7.5 3.7 8 4.7C8.5 3.7 9.5 3 10.8 3C12.6 3 14 4.5 14 6.3C14 10.5 8 13.5 8 13.5Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Models 模型 — 3D cube outline */
export function ModelsIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path
        d="M8 2L13.5 4.7V11.3L8 14L2.5 11.3V4.7L8 2Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M8 8V14M8 8L13.5 4.7M8 8L2.5 4.7"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Activities 活动 — lightning bolt */
export function ActivitiesIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path
        d="M9 2L3.2 9H7.5L7 14L12.8 7H8.5L9 2Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Skills 技能 — star outline */
export function SkillsIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path
        d="M8 2L9.85 5.7L14 6.3L11 9.2L11.7 13.3L8 11.4L4.3 13.3L5 9.2L2 6.3L6.15 5.7L8 2Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Acknowledge 了解我 — info circle */
export function AcknowledgeIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M8 7.2V11.2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle cx="8" cy="5" r="0.8" fill="currentColor" />
    </svg>
  );
}

/** Habits 习惯 — circular repeat arrow */
export function HabitsIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path
        d="M13 7C12.7 4.7 10.6 3 8.2 3C5.4 3 3 5.3 3 8.2C3 9.6 3.6 10.9 4.5 11.8"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3 9C3.3 11.3 5.4 13 7.8 13C10.6 13 13 10.7 13 7.8C13 6.4 12.4 5.1 11.5 4.2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M11 4.5L11.7 3L13.2 3.7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 11.5L4.3 13L2.8 12.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Integrations 集成 — 2×2 grid (apps / modules) */
export function IntegrationsIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <rect x="2.2" y="2.2" width="4.6" height="4.6" rx="0.8" stroke="currentColor" strokeWidth="1.4" />
      <rect x="9.2" y="2.2" width="4.6" height="4.6" rx="0.8" stroke="currentColor" strokeWidth="1.4" />
      <rect x="2.2" y="9.2" width="4.6" height="4.6" rx="0.8" stroke="currentColor" strokeWidth="1.4" />
      <rect x="9.2" y="9.2" width="4.6" height="4.6" rx="0.8" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

/** Member outlined — head + shoulders silhouette (Figma icon_member_outlined,
 * 24×24 viewBox). Used in the chat header to open the agent meta dropdown
 * (nature / models / activities / skills / acknowledge / habits / integrations). */
export function MemberIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
      <path
        d="M15 6.5C15 4.84315 13.6569 3.5 12 3.5C10.3431 3.5 9 4.84315 9 6.5C9 8.15685 10.3431 9.5 12 9.5C13.6569 9.5 15 8.15685 15 6.5ZM17 6.5C17 9.26142 14.7614 11.5 12 11.5C9.23858 11.5 7 9.26142 7 6.5C7 3.73858 9.23858 1.5 12 1.5C14.7614 1.5 17 3.73858 17 6.5ZM4 19V21H20V19C20 16.7909 18.2091 15 16 15H8C5.79086 15 4 16.7909 4 19ZM2 19C2 15.6863 4.68629 13 8 13H16C19.3137 13 22 15.6863 22 19V21C22 22.1046 21.1046 23 20 23H4C2.89543 23 2 22.1046 2 21V19Z"
        fill="currentColor"
      />
    </svg>
  );
}

/** Identity / persona glyph — circular head + shoulder silhouette.
 * Used in the chat header to open the Agent identity modal. */
export function IdentityIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <circle cx="8" cy="5.5" r="2.6" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M2.8 13.5c.7-2.4 2.7-3.7 5.2-3.7s4.5 1.3 5.2 3.7"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function ToolCogIcon({ size = 14, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" className={className}>
      <path
        d="M7 5a2 2 0 100 4 2 2 0 000-4z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path
        d="M7 1.5v1.2M7 11.3v1.2M2.5 7H1.3M12.7 7h-1.2M3.5 3.5l.9.9M9.6 9.6l.9.9M3.5 10.5l.9-.9M9.6 4.4l.9-.9"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}
