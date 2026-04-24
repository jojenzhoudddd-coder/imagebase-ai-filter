/**
 * RegisterPage — mirrors LoginPage layout (same animated-characters left
 * pane, IHB submit) with the additional name/username fields.
 */

import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "./AuthContext";
import { AnimatedCharacters } from "./AnimatedCharacters";
import { InteractiveHoverButton } from "./InteractiveHoverButton";
import "./AuthPage.css";

function EyeIcon({ open }: { open: boolean }) {
  return open ? (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M1.5 10S4.5 4 10 4s8.5 6 8.5 6-3 6-8.5 6S1.5 10 1.5 10z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="10" cy="10" r="3" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ) : (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M2 2l16 16M7.5 7.5a3 3 0 004.24 4.24M4.2 4.2C2.67 5.5 1.5 7.5 1.5 10s3 6 8.5 6c1.62 0 3.05-.37 4.24-.98M8.2 4.2A8.6 8.6 0 0110 4c5.5 0 8.5 6 8.5 6-.46.92-1.1 1.82-1.9 2.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
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
      setError(err?.message || "Register failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-hero">
        <div className="auth-hero-orb auth-hero-orb-a" aria-hidden="true" />
        <div className="auth-hero-orb auth-hero-orb-b" aria-hidden="true" />

        <div className="auth-hero-brand">
          <span className="auth-hero-logo">IB</span>
          <span>ImageBase</span>
        </div>

        <div className="auth-hero-stage">
          <AnimatedCharacters
            isTyping={isTyping}
            showPassword={showPassword}
            passwordLength={password.length}
          />
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
            <h1 className="auth-form-title">Create your account</h1>
            <p className="auth-form-subtitle">几秒钟内开始使用</p>
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

            <InteractiveHoverButton
              type="submit"
              text={submitting ? "创建中…" : "创建账号"}
              disabled={submitting}
            />
          </form>

          <div className="auth-form-switch">
            已有账号?<Link to="/login">登录</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
