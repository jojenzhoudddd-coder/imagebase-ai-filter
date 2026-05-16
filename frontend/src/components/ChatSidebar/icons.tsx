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
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M6.5 9C5.94772 9 5.5 9.44772 5.5 10V11C5.5 11.5523 5.94772 12 6.5 12H7.5C8.05228 12 8.5 11.5523 8.5 11V10C8.5 9.44772 8.05228 9 7.5 9H6.5Z" fill="currentColor"/>
      <path d="M11.5 9C10.9477 9 10.5 9.44772 10.5 10V11C10.5 11.5523 10.9477 12 11.5 12H12.5C13.0523 12 13.5 11.5523 13.5 11V10C13.5 9.44772 13.0523 9 12.5 9H11.5Z" fill="currentColor"/>
      <path d="M15.5 10C15.5 9.44772 15.9477 9 16.5 9H17.5C18.0523 9 18.5 9.44772 18.5 10V11C18.5 11.5523 18.0523 12 17.5 12H16.5C15.9477 12 15.5 11.5523 15.5 11V10Z" fill="currentColor"/>
      <path d="M23 4C23 2.9 22.1 2 21 2H3C1.9 2 1 2.9 1 4V17.0111C1 18.0211 1.9 19.0111 3 19.0111H7.7586L10.4774 22C10.9822 22.5017 11.3166 22.6311 12 22.7009C12.414 22.707 13.0502 22.5093 13.5 22L16.2414 19.0111H21C22.1 19.0111 23 18.1111 23 17.0111V4ZM3 4H21V17.0111H15.5L12 20.6714L8.5 17.0111H3V4Z" fill="currentColor"/>
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
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M8 4C8 2.89543 8.89543 2 10 2H14C15.1046 2 16 2.89543 16 4H21C21.5523 4 22 4.44772 22 5C22 5.55228 21.5523 6 21 6H20C20 10.6667 20 15.3333 20 20C20 21.1046 19.1046 22 18 22H6C4.89543 22 4 21.1046 4 20C4 15.3333 4 10.6667 4 6H3C2.44772 6 2 5.55228 2 5C2 4.44772 2.44772 4 3 4H8ZM6 6V20H18V6H6ZM10 9C10.5523 9 11 9.44772 11 10V16C11 16.5523 10.5523 17 10 17C9.44772 17 9 16.5523 9 16V10C9 9.44772 9.44772 9 10 9ZM14 9C14.5523 9 15 9.44772 15 10V16C15 16.5523 14.5523 17 14 17C13.4477 17 13 16.5523 13 16V10C13 9.44772 13.4477 9 14 9Z" fill="currentColor"/>
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

/** Nature 性格 — like (heart) outlined */
export function NatureIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M12.8967 19.0861C13.8372 18.3323 14.7601 17.5383 15.6179 16.7239C16.6715 15.7238 17.5492 14.7647 18.1901 13.889C18.3529 13.6665 18.4989 13.4515 18.6269 13.2453C18.8127 12.9461 18.8918 12.8172 18.9901 12.6513C19.6855 11.4786 20 10.5796 20 9.4765C19.9984 6.96984 18.2443 5 16.2328 5C14.4521 5 12.0101 8.2566 12.0101 8.2566C12.0101 8.2566 9.53936 5 7.77614 5C5.74819 5 4 6.95877 4 9.47524C4 10.5796 4.31447 11.4786 5.00986 12.6513C5.10823 12.8172 5.18733 12.9461 5.37739 13.2523C5.49528 13.4439 5.62843 13.6429 5.77623 13.8483C6.41763 14.7398 7.30843 15.7186 8.38367 16.7394C9.23818 17.5507 10.1576 18.3409 11.0948 19.0906C11.3529 19.2971 11.7048 19.5702 11.9941 19.7927C12.2818 19.5728 12.5788 19.3409 12.8967 19.0861ZM12.0033 5.40561C12.0033 5.40561 12.6232 4.50035 13.4065 3.94354C14.2188 3.33931 15.1581 3 16.2328 3C19.4043 3 21.9978 5.91375 22 9.47524C22 11.6085 21.0693 13.1031 20.3261 14.3002C18.1611 17.7862 12.9653 21.556 12.7376 21.7391C12.51 21.9084 12.2578 22 11.9944 22C11.7288 22 11.4766 21.9222 11.2512 21.7391C11.0235 21.556 5.82547 17.7976 3.67392 14.3002C2.9307 13.1031 2 11.6085 2 9.47524C2 5.90001 4.59123 3 7.77614 3C8.85258 3 9.7876 3.33953 10.5985 3.94413C11.3261 4.51098 12.0033 5.40561 12.0033 5.40561Z" fill="currentColor"/>
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

/** Activities 活动 — chat bubble (reply) */
export function ActivitiesIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M6.5 9C5.94772 9 5.5 9.44772 5.5 10V11C5.5 11.5523 5.94772 12 6.5 12H7.5C8.05228 12 8.5 11.5523 8.5 11V10C8.5 9.44772 8.05228 9 7.5 9H6.5Z" fill="currentColor"/>
      <path d="M11.5 9C10.9477 9 10.5 9.44772 10.5 10V11C10.5 11.5523 10.9477 12 11.5 12H12.5C13.0523 12 13.5 11.5523 13.5 11V10C13.5 9.44772 13.0523 9 12.5 9H11.5Z" fill="currentColor"/>
      <path d="M15.5 10C15.5 9.44772 15.9477 9 16.5 9H17.5C18.0523 9 18.5 9.44772 18.5 10V11C18.5 11.5523 18.0523 12 17.5 12H16.5C15.9477 12 15.5 11.5523 15.5 11V10Z" fill="currentColor"/>
      <path d="M23 4C23 2.9 22.1 2 21 2H3C1.9 2 1 2.9 1 4V17.0111C1 18.0211 1.9 19.0111 3 19.0111H7.7586L10.4774 22C10.9822 22.5017 11.3166 22.6311 12 22.7009C12.414 22.707 13.0502 22.5093 13.5 22L16.2414 19.0111H21C22.1 19.0111 23 18.1111 23 17.0111V4ZM3 4H21V17.0111H15.5L12 20.6714L8.5 17.0111H3V4Z" fill="currentColor"/>
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

/** Acknowledge 了解我 — education (graduation cap) */
export function AcknowledgeIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M12.8653 1.9157C12.3182 1.6531 11.6815 1.6531 11.1344 1.9157L0.438907 7.04952C0.0607281 7.23105 0.0607291 7.76952 0.438908 7.95104L1.03476 8.23705C1.01194 8.32092 0.999756 8.40918 0.999756 8.50027V13.5003C0.999756 14.0526 1.44747 14.5003 1.99976 14.5003C2.55204 14.5003 2.99976 14.0526 2.99976 13.5003V9.18025L4.49976 9.90025V16.9681C4.49976 17.3031 4.65749 17.6186 4.92551 17.8196L6.89976 19.3003C8.37107 20.4038 10.1606 21.0003 11.9998 21.0003C13.8389 21.0003 15.6284 20.4038 17.0998 19.3003L19.074 17.8196C19.342 17.6186 19.4998 17.3031 19.4998 16.9681V9.90031L23.5607 7.95104C23.9389 7.76952 23.9389 7.23105 23.5607 7.04952L12.8653 1.9157ZM19.878 7.50028L11.9998 11.2818L4.12163 7.50028L11.9998 3.71875L19.878 7.50028ZM6.49976 16.5003V10.8603L11.1344 13.0849C11.6815 13.3475 12.3182 13.3475 12.8653 13.0849L17.4998 10.8603V16.5003L15.8998 17.7003C14.7746 18.5441 13.4062 19.0003 11.9998 19.0003C10.5933 19.0003 9.22488 18.5441 8.09976 17.7003L6.49976 16.5003Z" fill="currentColor"/>
    </svg>
  );
}

/** Habits 习惯 — lightning bolt (sync) */
export function HabitsIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M11.2234 12.7111C11.4843 12.7307 11.686 12.9481 11.686 13.2097L11.6861 20.6616L18.8277 11.6186L13.4496 11.2149C13.1887 11.1953 12.987 10.9779 12.987 10.7163L12.9869 3.26446L5.84531 12.3075L11.2234 12.7111ZM12.3652 0.952384C13.2813 -0.0792773 14.9869 0.568638 14.9869 1.9483L14.987 9.32467L19.9842 9.69975C21.2221 9.79266 21.8179 11.2632 20.9936 12.1915L12.3078 22.9736C11.3917 24.0053 9.68614 23.3574 9.68611 21.9777L9.68599 14.6014L4.68876 14.2263C3.45086 14.1334 2.85515 12.6628 3.67939 11.7345L12.3652 0.952384Z" fill="currentColor"/>
    </svg>
  );
}

/** Integrations 集成 — connector (two circles linked by a line) */
export function IntegrationsIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M18 2C20.2091 2 22 3.79086 22 6C22 8.20914 20.2091 10 18 10C17.258 10 16.5634 9.79741 15.9678 9.44531L9.44531 15.9678C9.79741 16.5634 10 17.258 10 18C10 20.2091 8.20914 22 6 22C3.79086 22 2 20.2091 2 18C2 15.7909 3.79086 14 6 14C6.74157 14 7.43587 14.202 8.03125 14.5537L14.5537 8.03125C14.202 7.43587 14 6.74157 14 6C14 3.79086 15.7909 2 18 2ZM6 16C4.89543 16 4 16.8954 4 18C4 19.1046 4.89543 20 6 20C7.10457 20 8 19.1046 8 18C8 16.8954 7.10457 16 6 16ZM18 4C16.8954 4 16 4.89543 16 6C16 7.10457 16.8954 8 18 8C19.1046 8 20 7.10457 20 6C20 4.89543 19.1046 4 18 4Z" fill="currentColor"/>
      <path d="M18 14C20.2091 14 22 15.7909 22 18C22 20.2091 20.2091 22 18 22C15.7909 22 14 20.2091 14 18C14 15.7909 15.7909 14 18 14ZM18 16C16.8954 16 16 16.8954 16 18C16 19.1046 16.8954 20 18 20C19.1046 20 20 19.1046 20 18C20 16.8954 19.1046 16 18 16Z" fill="currentColor"/>
      <path d="M6 2C8.20914 2 10 3.79086 10 6C10 8.20914 8.20914 10 6 10C3.79086 10 2 8.20914 2 6C2 3.79086 3.79086 2 6 2ZM6 4C4.89543 4 4 4.89543 4 6C4 7.10457 4.89543 8 6 8C7.10457 8 8 7.10457 8 6C8 4.89543 7.10457 4 6 4Z" fill="currentColor"/>
    </svg>
  );
}

/** Member outlined — head + shoulders silhouette (Figma icon_member_outlined,
 * 24×24 viewBox). Used in the chat header to open the agent meta dropdown
 * (nature / models / activities / skills / acknowledge / habits / integrations). */
export function MemberIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M9 12C9.82834 12.0001 10.5 12.6716 10.5 13.5C10.5 14.3284 9.82834 14.9999 9 15C8.17157 15 7.5 14.3284 7.5 13.5C7.5 12.6716 8.17157 12 9 12Z" fill="currentColor"/>
      <path d="M15 12C15.8283 12.0001 16.5 12.6716 16.5 13.5C16.5 14.3284 15.8283 14.9999 15 15C14.1716 15 13.5 14.3284 13.5 13.5C13.5 12.6716 14.1716 12 15 12Z" fill="currentColor"/>
      <path d="M13 0C13.8284 3.22128e-08 14.5 0.671573 14.5 1.5C14.5 2.27666 13.9097 2.91539 13.1533 2.99219L13 3V5.5H19C20.1045 5.5001 21 6.39549 21 7.5V20C21 21.1045 20.1045 21.9999 19 22H5C3.89543 22 3 21.1046 3 20V7.5C3 6.39543 3.89543 5.5 5 5.5H11V3L10.8467 2.99219C10.0903 2.91539 9.5 2.27666 9.5 1.5C9.5 0.671573 10.1716 3.22128e-08 11 0H13ZM5 20H19V7.5H5V20Z" fill="currentColor"/>
      <path d="M1 10.5C1.55228 10.5 2 10.9477 2 11.5V15.5C2 16.0523 1.55228 16.5 1 16.5C0.447715 16.5 0 16.0523 0 15.5V11.5C0 10.9477 0.447715 10.5 1 10.5Z" fill="currentColor"/>
      <path d="M23 10.5C23.5523 10.5 24 10.9477 24 11.5V15.5C24 16.0523 23.5523 16.5 23 16.5C22.4477 16.5 22 16.0523 22 15.5V11.5C22 10.9477 22.4477 10.5 23 10.5Z" fill="currentColor"/>
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
