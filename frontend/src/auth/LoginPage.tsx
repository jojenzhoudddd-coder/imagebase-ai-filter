/**
 * LoginPage — split layout, animated gradient + orbs on the left,
 * credential form on the right. Mirrors careercompass's auth design.
 */

import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "./AuthContext";
import "./AuthPage.css";

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [showPwd, setShowPwd] = useState(false);
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
      setError(err?.message || "Login failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-hero">
        <div className="auth-hero-orb auth-hero-orb-a" aria-hidden="true" />
        <div className="auth-hero-orb auth-hero-orb-b" aria-hidden="true" />
        <div className="auth-hero-orb auth-hero-orb-c" aria-hidden="true" />

        <div className="auth-hero-brand">
          <span className="auth-hero-logo">IB</span>
          <span>ImageBase · AI Work</span>
        </div>
        <div className="auth-hero-body">
          <h1 className="auth-hero-title">欢迎回来。</h1>
          <p className="auth-hero-subtitle">
            登录进入你的工作空间 —— 多维表格、灵感文档、可视化画布、Vibe Demo，
            以及在这一切之上长期协作的 Agent Claw。
          </p>
        </div>
        <div className="auth-hero-footer">
          <span>© ImageBase</span>
          <span>·</span>
          <span>v1</span>
        </div>
      </div>

      <div className="auth-form-pane">
        <div className="auth-form-header">
          <h2 className="auth-form-title">登录</h2>
          <p className="auth-form-subtitle">输入用户名或邮箱继续</p>
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
                type={showPwd ? "text" : "password"}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                disabled={submitting}
                required
              />
              <button
                type="button"
                className="auth-toggle"
                onClick={() => setShowPwd((v) => !v)}
                aria-label={showPwd ? "隐藏密码" : "显示密码"}
              >
                {showPwd ? "隐藏" : "显示"}
              </button>
            </div>
          </div>
          {error && <div className="auth-form-error">{error}</div>}
          <button className="auth-submit" type="submit" disabled={submitting}>
            {submitting ? "登录中…" : "登录"}
          </button>
        </form>
        <div className="auth-form-switch">
          没有账号？<Link to="/register">去注册</Link>
        </div>
      </div>
    </div>
  );
}
