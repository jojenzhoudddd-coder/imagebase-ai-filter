/**
 * RegisterPage — mirrors LoginPage: same 2:1 split, AnimatedCharacters
 * scene, legend, design-token form. Adds username / name fields.
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

export default function RegisterPage() {
  const { t } = useTranslation();
  const { register } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
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
      await register({
        email: email.trim(),
        username: username.trim() || undefined,
        name: name.trim(),
        password,
      });
      navigate("/", { replace: true });
    } catch (err: any) {
      setError(err?.message || t("auth.register.failed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-shell">
      <LanguageSwitcher />

      <div className="auth-card">
      <div className="auth-hero">
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

      <div className="auth-form-pane">
        <div className="auth-form-inner">
          <div className="auth-mobile-brand">
            <span className="auth-mobile-logo">IB</span>
            <span>ImageBase</span>
          </div>

          <div className="auth-form-header">
            <h1 className="auth-form-title">{t("auth.register.title")}</h1>
            <p className="auth-form-subtitle">{t("auth.register.subtitle")}</p>
          </div>

          <form className="auth-form" onSubmit={onSubmit}>
            <div className="auth-field">
              <label htmlFor="email">{t("auth.register.emailLabel")}</label>
              <input
                id="email"
                className="auth-input"
                type="email"
                autoComplete="email"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onFocus={() => setIsTyping(true)}
                onBlur={() => setIsTyping(false)}
                placeholder={t("auth.register.emailPlaceholder")}
                disabled={submitting}
                required
              />
            </div>
            <div className="auth-field">
              <label htmlFor="username">{t("auth.register.usernameLabel")}</label>
              <input
                id="username"
                className="auth-input"
                type="text"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                onFocus={() => setIsTyping(true)}
                onBlur={() => setIsTyping(false)}
                placeholder={t("auth.register.usernamePlaceholder")}
                disabled={submitting}
              />
              <span className="auth-field-hint">{t("auth.register.usernameHint")}</span>
            </div>
            <div className="auth-field">
              <label htmlFor="name">{t("auth.register.nameLabel")}</label>
              <input
                id="name"
                className="auth-input"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("auth.register.namePlaceholder")}
                disabled={submitting}
                required
              />
            </div>
            <div className="auth-field">
              <label htmlFor="password">{t("auth.register.passwordLabel")}</label>
              <div className="auth-input-wrap">
                <input
                  id="password"
                  className="auth-input"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t("auth.register.passwordPlaceholder")}
                  minLength={6}
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

            {error && <div className="auth-form-error">{error}</div>}

            <button className="auth-submit" type="submit" disabled={submitting}>
              {submitting ? t("auth.register.submitting") : t("auth.register.submit")}
            </button>
          </form>

          <div className="auth-form-switch">
            {t("auth.register.haveAccount")}<Link to="/login">{t("auth.register.toLogin")}</Link>
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}
