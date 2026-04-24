/**
 * RegisterPage — mirrors LoginPage: same 2:1 split, AnimatedCharacters
 * scene, legend, design-token form. Adds username / name fields.
 */

import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "./AuthContext";
import { AnimatedCharacters } from "./AnimatedCharacters";
import "./AuthPage.css";

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

export default function RegisterPage() {
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
      setError(err?.message || "注册失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-hero">
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

      <div className="auth-form-pane">
        <div className="auth-form-inner">
          <div className="auth-mobile-brand">
            <span className="auth-mobile-logo">IB</span>
            <span>ImageBase</span>
          </div>

          <div className="auth-form-header">
            <h1 className="auth-form-title">创建账号</h1>
            <p className="auth-form-subtitle">几秒钟开始使用</p>
          </div>

          <form className="auth-form" onSubmit={onSubmit}>
            <div className="auth-field">
              <label htmlFor="email">邮箱</label>
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
                placeholder="you@example.com"
                disabled={submitting}
                required
              />
            </div>
            <div className="auth-field">
              <label htmlFor="username">用户名（可选）</label>
              <input
                id="username"
                className="auth-input"
                type="text"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                onFocus={() => setIsTyping(true)}
                onBlur={() => setIsTyping(false)}
                placeholder="2-32 字符 a-z A-Z 0-9 _ -"
                disabled={submitting}
              />
              <span className="auth-field-hint">登录时可输入用户名或邮箱</span>
            </div>
            <div className="auth-field">
              <label htmlFor="name">显示名</label>
              <input
                id="name"
                className="auth-input"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="你希望别人怎么称呼你"
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
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="至少 6 位"
                  minLength={6}
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

            {error && <div className="auth-form-error">{error}</div>}

            <button className="auth-submit" type="submit" disabled={submitting}>
              {submitting ? "创建中…" : "创建账号"}
            </button>
          </form>

          <div className="auth-form-switch">
            已有账号?<Link to="/login">登录</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
