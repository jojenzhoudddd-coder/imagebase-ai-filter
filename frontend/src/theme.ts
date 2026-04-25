/**
 * Theme manager —— 外观 light / dark / system。
 *
 * · 偏好持久化到 localStorage('theme_preference_v1')
 * · 应用时在 `<html>` 上写 data-theme="light|dark"，CSS 根据这个属性切换 tokens
 * · system 模式监听 prefers-color-scheme 变化并自动跟随
 * · 提供模块级 setTheme()（不依赖 React hook），便于 AuthContext 在
 *   /me 拿到 preferences 后直接同步主题。变更通过 CustomEvent 广播，
 *   useTheme()/useResolvedTheme() 都会自动重渲染。
 *
 * Usage:
 *   const { theme, setTheme } = useTheme();
 *   setTheme("dark");
 *
 *   // 或非 hook 场景（AuthContext / 程序化调用）：
 *   import { setThemeGlobal } from "./theme";
 *   setThemeGlobal("dark");
 */

import { useCallback, useEffect, useState } from "react";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "theme_preference_v1";
const CHANGE_EVENT = "ai-filter-theme-change";

function readStoredPreference(): ThemePreference {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch { /* ignore */ }
  return "system";
}

function writeStoredPreference(pref: ThemePreference) {
  try { localStorage.setItem(STORAGE_KEY, pref); } catch { /* ignore */ }
}

function resolveSystem(): ResolvedTheme {
  if (typeof window === "undefined" || !window.matchMedia) return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function resolveEffective(pref: ThemePreference): ResolvedTheme {
  return pref === "system" ? resolveSystem() : pref;
}

function applyToDocument(resolved: ResolvedTheme) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", resolved);
}

/**
 * Eager first-apply on module load —— 避免首屏闪烁。
 */
applyToDocument(resolveEffective(readStoredPreference()));

/**
 * 模块级 setter，任何代码都能调（不只是 React 组件）。会广播 change 事件
 * 让所有 useTheme()/useResolvedTheme() 消费者重渲染。
 */
export function setThemeGlobal(pref: ThemePreference): void {
  writeStoredPreference(pref);
  const eff = resolveEffective(pref);
  applyToDocument(eff);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { preference: pref } }));
  }
}

/**
 * useResolvedTheme —— 当前 resolved theme（"light" | "dark"）。
 * 通过 MutationObserver 监听 `<html data-theme>` 变化自动重渲染。
 */
export function useResolvedTheme(): ResolvedTheme {
  const [theme, setThemeState] = useState<ResolvedTheme>(() =>
    typeof document !== "undefined" && document.documentElement.dataset.theme === "dark"
      ? "dark"
      : "light"
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    const html = document.documentElement;
    const update = () => {
      setThemeState(html.dataset.theme === "dark" ? "dark" : "light");
    };
    const observer = new MutationObserver(update);
    observer.observe(html, { attributes: true, attributeFilter: ["data-theme"] });
    update();
    return () => observer.disconnect();
  }, []);
  return theme;
}

export function useTheme(): {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setTheme: (pref: ThemePreference) => void;
} {
  const [preference, setPreference] = useState<ThemePreference>(() => readStoredPreference());
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveEffective(preference));

  // 本组件触发的切换 —— 仍走广播，保证全应用一致
  const setTheme = useCallback((pref: ThemePreference) => {
    setThemeGlobal(pref);
  }, []);

  // 监听全局 change 事件 —— 包括 AuthContext 在 /me 后调用 setThemeGlobal
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent).detail as { preference: ThemePreference };
      setPreference(detail.preference);
      setResolved(resolveEffective(detail.preference));
    };
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, []);

  // 当前 pref 是 system 时监听系统偏好变化
  useEffect(() => {
    if (preference !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const eff: ResolvedTheme = mq.matches ? "dark" : "light";
      setResolved(eff);
      applyToDocument(eff);
    };
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", onChange);
      else mq.removeListener(onChange);
    };
  }, [preference]);

  return { preference, resolved, setTheme };
}
