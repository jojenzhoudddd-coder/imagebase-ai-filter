/**
 * RegisterPage — 顺序：email → password → password 二次 → username。
 *
 * username 同时作为 display name（面包屑 / workspace 名 / chatbot 名）。
 * 所有校验错误和服务端反馈均以 toast 形式弹出，不再有行内 error 区。
 */

import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth, type AuthError } from "./AuthContext";
import { AnimatedCharacters } from "./AnimatedCharacters";
import LanguageSwitcher from "./LanguageSwitcher";
import { useTranslation } from "../i18n/index";
import { useToast } from "../components/Toast/index";
import { codeToToastKey } from "./authErrorToToast";
import { isValidUsername } from "./usernameValidator";
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

const EMAIL_RE = /^\S+@\S+\.\S+$/;
const PASSWORD_MIN = 6;

export default function RegisterPage() {
  const { t } = useTranslation();
  const { register } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [username, setUsername] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmedEmail = email.trim();
    const trimmedUsername = username.trim();

    // 客户端校验（按注册 UI 从上到下的顺序）
    if (!trimmedEmail) { toast.error(t("auth.toast.emailRequired")); return; }
    if (!EMAIL_RE.test(trimmedEmail)) { toast.error(t("auth.toast.emailInvalid")); return; }
    if (!password) { toast.error(t("auth.toast.passwordRequired")); return; }
    if (password.length < PASSWORD_MIN) { toast.error(t("auth.toast.passwordTooShort")); return; }
    if (!passwordConfirm) { toast.error(t("auth.toast.passwordConfirmRequired")); return; }
    if (password !== passwordConfirm) { toast.error(t("auth.toast.passwordMismatch")); return; }
    if (!trimmedUsername) { toast.error(t("auth.toast.usernameRequired")); return; }
    if (!isValidUsername(trimmedUsername)) { toast.error(t("auth.toast.usernameInvalid")); return; }

    setSubmitting(true);
    try {
      await register({
        email: trimmedEmail,
        password,
        username: trimmedUsername,
      });
      toast.success(`${t("auth.toast.registerSuccess")}${trimmedUsername ? `, ${trimmedUsername}` : ""}`);
      navigate("/", { replace: true });
    } catch (err) {
      const authErr = err as AuthError;
      const key = codeToToastKey(authErr.code);
      toast.error(t(key));
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

          <form className="auth-form" onSubmit={onSubmit} noValidate>
            {/* 1. Email */}
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
              />
            </div>

            {/* 2. Password */}
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
                  disabled={submitting}
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

            {/* 3. Password confirm */}
            <div className="auth-field">
              <label htmlFor="passwordConfirm">{t("auth.register.passwordConfirmLabel")}</label>
              <input
                id="passwordConfirm"
                className="auth-input"
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                value={passwordConfirm}
                onChange={(e) => setPasswordConfirm(e.target.value)}
                placeholder={t("auth.register.passwordConfirmPlaceholder")}
                disabled={submitting}
              />
            </div>

            {/* 4. Username — 必填，作为 display name */}
            <div className="auth-field">
              <label htmlFor="username">{t("auth.register.usernameLabel")}</label>
              <input
                id="username"
                className="auth-input"
                type="text"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={t("auth.register.usernamePlaceholder")}
                disabled={submitting}
              />
              <span className="auth-field-hint">{t("auth.register.usernameHint")}</span>
            </div>

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
