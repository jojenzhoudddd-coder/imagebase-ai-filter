/**
 * LanguageSwitcher — compact zh/en toggle pinned to the top-right of
 * the auth pages. Reuses the project's existing i18n plumbing
 * (setLocale persists to localStorage + reloads). Styled to float on
 * either the gray hero or white form side, so we anchor it to the
 * .auth-shell root.
 */

import { setLocale, useTranslation } from "../i18n/index";

export default function LanguageSwitcher() {
  const { locale } = useTranslation();
  const next = locale === "en" ? "zh" : "en";
  const label = locale === "en" ? "简体中文" : "English";
  return (
    <button
      type="button"
      className="auth-lang-switch"
      onClick={() => setLocale(next)}
      title={label}
      aria-label={label}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.2" />
        <ellipse cx="8" cy="8" rx="3" ry="6.5" stroke="currentColor" strokeWidth="1.2" />
        <path d="M1.5 8h13M2.5 5h11M2.5 11h11" stroke="currentColor" strokeWidth="1.0" strokeLinecap="round" />
      </svg>
      <span>{label}</span>
    </button>
  );
}
