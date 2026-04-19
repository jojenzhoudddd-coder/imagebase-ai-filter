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

export function CloseIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function SendIcon({ size = 14, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" className={className}>
      <path d="M5 7l5-3-2 6-3-3z" fill="currentColor" />
    </svg>
  );
}

export function StopIcon({ size = 10, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" fill="none" className={className}>
      <rect x="2" y="2" width="6" height="6" rx="1" fill="currentColor" />
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
