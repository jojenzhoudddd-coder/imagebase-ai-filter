/**
 * Theme manager —— 外观 light / dark / system。
 *
 * · 偏好持久化到 localStorage('theme_preference_v1')
 * · 应用时在 `<html>` 上写 data-theme="light|dark"，CSS 根据这个属性切换 tokens
 * · system 模式监听 prefers-color-scheme 变化并自动跟随
 *
 * Usage:
 *   const { theme, setTheme } = useTheme();
 *   setTheme("dark");
 */

import { useCallback, useEffect, useState } from "react";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "theme_preference_v1";

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
 * Eager first-apply on module load —— 避免首屏闪烁（先渲染浅色再切到深色）。
 * 在 main.tsx 之前这个模块先执行到这里就是 import 副作用。
 */
applyToDocument(resolveEffective(readStoredPreference()));

export function useTheme(): {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setTheme: (pref: ThemePreference) => void;
} {
  const [preference, setPreference] = useState<ThemePreference>(() => readStoredPreference());
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveEffective(preference));

  // 切换偏好：持久化 + apply 到 <html>
  const setTheme = useCallback((pref: ThemePreference) => {
    writeStoredPreference(pref);
    setPreference(pref);
    const eff = resolveEffective(pref);
    setResolved(eff);
    applyToDocument(eff);
  }, []);

  // 如果当前 pref 是 system，监听系统偏好变化
  useEffect(() => {
    if (preference !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const eff: ResolvedTheme = mq.matches ? "dark" : "light";
      setResolved(eff);
      applyToDocument(eff);
    };
    // 兼容老 Safari
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", onChange);
      else mq.removeListener(onChange);
    };
  }, [preference]);

  return { preference, resolved, setTheme };
}
