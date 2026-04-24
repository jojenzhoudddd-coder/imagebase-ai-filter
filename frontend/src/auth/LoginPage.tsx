/**
 * LoginPage — careercompass's animated-character hero + interaction model,
 * re-laid-out to AI Filter's design language:
 *   · 2:1 split (hero wider than form — characters are the star)
 *   · PingFang SC / 14px base / 22px line-height
 *   · Form uses 32px inputs, 4px radius, #1456F0 primary, #1F2329 text
 *   · Characters recolored to map to Table / Taste / Idea / Demo
 *
 * Kept intact from upstream:
 *   · `isTyping` binds focus → characters look at each other
 *   · `showPassword` + `passwordLength` → Taste peeks, others turn away
 */

import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "./AuthContext";
import { AnimatedCharacters } from "./AnimatedCharacters";
import LanguageSwitcher from "./LanguageSwitcher";
import { useTranslation } from "../i18n/index";
import "./AuthPage.css";

function EyeIcon({ open }: { open: boolean }) {
  return open ? (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M1.2 8S3.6 3.2 8 3.2s6.8 4.8 6.8 4.8S12.4 12.8 8 12.8 1.2 8 1.2 8z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="8" cy="8" r="2.4" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M1.6 1.6l12.8 12.8M6 6a2.4 2.4 0 003.4 3.4M3.4 3.4C2.1 4.4 1.2 6 1.2 8s3 4.8 6.8 4.8c1.3 0 2.4-.3 3.4-.8M6.6 3.4A6.9 6.9 0 018 3.2c4.4 0 6.8 4.8 6.8 4.8-.4.7-.9 1.5-1.6 2.1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function LoginPage() {
  const { t } = useTranslation();
  const { login } = useAuth();
  const navigate = useNavigate();
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(handle.trim(), password);
      navigate("/", { replace: true });
    } catch (err: any) {
      setError(err?.message || t("auth.login.failed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-shell">
      {/* Top-right language toggle — floats over the whole shell */}
      <LanguageSwitcher />

      {/* Centered fixed-size card containing both the hero (illustration)
          and the credential form. When the viewport resizes, the backdrop
          stretches and the card stays centered via flex on .auth-shell. */}
      <div className="auth-card">
      {/* ─── Left (3/5): hero with animated-character scene ─── */}
      <div className="auth-hero">
        {/* Frosted glass layer — sits on top of the colorful ripple base
            but BELOW the characters (z-index ordering in AuthPage.css). */}
        <div className="auth-hero-glass" aria-hidden="true" />

        {/* Top-left artifact-four headline + tagline */}
        <div className="auth-hero-headline">
          <h2 className="auth-hero-headline-title">{t("auth.heroTitle")}</h2>
          <p className="auth-hero-headline-sub">{t("auth.heroSubtitle")}</p>
        </div>

        <div className="auth-hero-stage">
          <AnimatedCharacters
            isTyping={isTyping}
            showPassword={showPassword}
            passwordLength={password.length}
          />
        </div>

        <div className="auth-hero-footer">
          <a href="#" onClick={(e) => e.preventDefault()}>{t("auth.privacy")}</a>
          <a href="#" onClick={(e) => e.preventDefault()}>{t("auth.terms")}</a>
        </div>
      </div>

      {/* ─── Right (1/3): compact form ─── */}
      <div className="auth-form-pane">
        <div className="auth-form-inner">
          <div className="auth-mobile-brand">
            <span className="auth-mobile-logo">IB</span>
            <span>ImageBase</span>
          </div>

          <div className="auth-form-header">
            <h1 className="auth-form-title">{t("auth.login.title")}</h1>
            <p className="auth-form-subtitle">{t("auth.login.subtitle")}</p>
          </div>

          <form className="auth-form" onSubmit={onSubmit}>
            <div className="auth-field">
              <label htmlFor="handle">{t("auth.login.handleLabel")}</label>
              <input
                id="handle"
                className="auth-input"
                type="text"
                autoComplete="username"
                autoFocus
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                onFocus={() => setIsTyping(true)}
                onBlur={() => setIsTyping(false)}
                placeholder={t("auth.login.handlePlaceholder")}
                disabled={submitting}
                required
              />
            </div>
            <div className="auth-field">
              <label htmlFor="password">{t("auth.login.passwordLabel")}</label>
              <div className="auth-input-wrap">
                <input
                  id="password"
                  className="auth-input"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onFocus={() => setIsTyping(true)}
                  onBlur={() => setIsTyping(false)}
                  placeholder={t("auth.login.passwordPlaceholder")}
                  disabled={submitting}
                  required
                />
                <button
                  type="button"
                  className="auth-password-toggle"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? t("auth.hidePassword") : t("auth.showPassword")}
                >
                  <EyeIcon open={!showPassword} />
                </button>
              </div>
            </div>

            <div className="auth-field-row">
              <label className="auth-remember">
                <input type="checkbox" />
                <span>{t("auth.login.remember")}</span>
              </label>
              <a className="auth-form-link" href="#" onClick={(e) => e.preventDefault()}>
                {t("auth.login.forgot")}
              </a>
            </div>

            {error && <div className="auth-form-error">{error}</div>}

            <button className="auth-submit" type="submit" disabled={submitting}>
              {submitting ? t("auth.login.submitting") : t("auth.login.submit")}
            </button>
          </form>

          <div className="auth-form-switch">
            {t("auth.login.noAccount")}<Link to="/register">{t("auth.login.toRegister")}</Link>
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}
