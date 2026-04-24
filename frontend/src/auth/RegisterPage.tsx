/**
 * RegisterPage — mirrors LoginPage layout. On success the auth context
 * flips to logged-in state and we redirect to the main app root.
 */

import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "./AuthContext";
import "./AuthPage.css";

export default function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [showPwd, setShowPwd] = useState(false);
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
        <div className="auth-hero-orb auth-hero-orb-c" aria-hidden="true" />

        <div className="auth-hero-brand">
          <span className="auth-hero-logo">IB</span>
          <span>ImageBase · AI Work</span>
        </div>
        <div className="auth-hero-body">
          <h1 className="auth-hero-title">开始你的第一个工作空间。</h1>
          <p className="auth-hero-subtitle">
            注册后自动获得一个属于你的工作空间。随后 Agent Claw 会帮你搭建数据表 / 文档 /
            画布 / Vibe Demo，全都在这一个界面里完成。
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
          <h2 className="auth-form-title">创建账号</h2>
          <p className="auth-form-subtitle">只要几秒</p>
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
              placeholder="2-32 字符，a-z A-Z 0-9 _ -"
              disabled={submitting}
            />
            <span className="auth-field-hint">登录时可输入用户名或邮箱之一</span>
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
                type={showPwd ? "text" : "password"}
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
            {submitting ? "创建中…" : "创建账号"}
          </button>
        </form>
        <div className="auth-form-switch">
          已有账号？<Link to="/login">去登录</Link>
        </div>
      </div>
    </div>
  );
}
