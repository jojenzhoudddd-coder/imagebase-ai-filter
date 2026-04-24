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
import "./AuthPage.css";

// Colors here mirror the character component so legend swatches match 1:1.
const ARTIFACT_COLORS = {
  table: "#1456F0",
  taste: "#7B4BDC",
  idea:  "#F5A623",
  demo:  "#34A853",
};

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
      setError(err?.message || "登录失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-shell">
      {/* ─── Left (2/3): hero with animated-character scene ─── */}
      <div className="auth-hero">
        {/* Frosted glass layer — sits on top of the colorful ripple base
            but BELOW the characters (z-index ordering in AuthPage.css). */}
        <div className="auth-hero-glass" aria-hidden="true" />

        <div className="auth-hero-stage">
          <AnimatedCharacters
            isTyping={isTyping}
            showPassword={showPassword}
            passwordLength={password.length}
          />
        </div>

        <div className="auth-hero-legend">
          <span className="auth-hero-legend-item">
            <span className="auth-hero-legend-dot" style={{ backgroundColor: ARTIFACT_COLORS.table }} />
            Table
          </span>
          <span className="auth-hero-legend-item">
            <span className="auth-hero-legend-dot" style={{ backgroundColor: ARTIFACT_COLORS.taste }} />
            Taste
          </span>
          <span className="auth-hero-legend-item">
            <span className="auth-hero-legend-dot" style={{ backgroundColor: ARTIFACT_COLORS.idea }} />
            Idea
          </span>
          <span className="auth-hero-legend-item">
            <span className="auth-hero-legend-dot" style={{ backgroundColor: ARTIFACT_COLORS.demo }} />
            Demo
          </span>
        </div>

        <div className="auth-hero-footer">
          <a href="#" onClick={(e) => e.preventDefault()}>隐私政策</a>
          <a href="#" onClick={(e) => e.preventDefault()}>服务条款</a>
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
            <h1 className="auth-form-title">欢迎回来</h1>
            <p className="auth-form-subtitle">登录进入你的工作空间</p>
          </div>

          <form className="auth-form" onSubmit={onSubmit}>
            <div className="auth-field">
              <label htmlFor="handle">用户名或邮箱</label>
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
                placeholder="quan 或 you@example.com"
                disabled={submitting}
                required
              />
            </div>
            <div className="auth-field">
              <label htmlFor="password">密码</label>
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
                  placeholder="请输入密码"
                  disabled={submitting}
                  required
                />
                <button
                  type="button"
                  className="auth-password-toggle"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "隐藏密码" : "显示密码"}
                >
                  <EyeIcon open={!showPassword} />
                </button>
              </div>
            </div>

            <div className="auth-field-row">
              <label className="auth-remember">
                <input type="checkbox" />
                <span>30 天内免登录</span>
              </label>
              <a className="auth-form-link" href="#" onClick={(e) => e.preventDefault()}>
                忘记密码
              </a>
            </div>

            {error && <div className="auth-form-error">{error}</div>}

            <button className="auth-submit" type="submit" disabled={submitting}>
              {submitting ? "登录中…" : "登录"}
            </button>
          </form>

          <div className="auth-form-switch">
            还没有账号?<Link to="/register">立即注册</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
