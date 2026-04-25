import { useState, useRef, useEffect, type ChangeEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation, setLocale } from "../i18n/index";
import type { Locale } from "../i18n/index";
import InlineEdit from "./InlineEdit";
import { useAuth } from "../auth/AuthContext";
import { useToast } from "./Toast/index";
import AvatarCropDialog from "../auth/AvatarCropDialog";
import { useTheme, type ThemePreference } from "../theme";
import { isValidUsername } from "../auth/usernameValidator";
import "./TopBar.css";

interface Props {
  tableName: string;
  documentName: string;
  /** 当前 workspace id —— 用来拉 stats（artifact 数 / token / AI 摘要）。 */
  workspaceId: string;
  deleteProtection?: boolean;
  onDeleteProtectionChange?: (on: boolean) => void;
  onRenameTable?: (newName: string) => void;
  onRenameDocument?: (newName: string) => void;
  onOpenChatAgent?: () => void;
  chatAgentOpen?: boolean;
  /** Phase 4 Day 3 — unread count from /api/agents/:id/inbox?unread=1. 0 or undefined hides the dot. */
  agentUnreadCount?: number;
}

interface WorkspaceStats {
  tables: number;
  ideas: number;
  designs: number;
  demos: number;
  totalTokens: number;
  summary: string | null;
  slogan: string | null;
  summaryAt: string | null;
}

/**
 * 把数字压缩成 "1,234" / "12.3k" / "1.2M"。
 * 小于 1000 用千分位逗号；≥ 1000 用 k；≥ 1000000 用 M。
 */
function formatTokenCount(n: number): string {
  if (n < 1000) return n.toLocaleString("en-US");
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0).replace(/\.0$/, "")}M`;
}

export default function TopBar({ tableName, documentName, workspaceId, deleteProtection = true, onDeleteProtectionChange, onRenameTable, onRenameDocument, onOpenChatAgent, chatAgentOpen, agentUnreadCount }: Props) {
  const { t, locale } = useTranslation();
  const { user, patchUser, logout, patchPreferences } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const { preference: themePreference, setTheme } = useTheme();

  // ── Workspace stats ──
  // /me 完成后或 workspaceId 切换时拉 stats，用于顶栏右栏显示
  // artifact 数 / token 总量 / AI 摘要 + slogan。
  // SSE 同步事件能让本地 ±1，但简单起见这里暂不接 SSE，5 分钟自动 refetch。
  const [stats, setStats] = useState<WorkspaceStats | null>(null);
  useEffect(() => {
    if (!workspaceId) return;
    let alive = true;
    const fetchStats = async () => {
      try {
        const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/stats`, {
          credentials: "same-origin",
        });
        if (!res.ok) return;
        const data = (await res.json()) as WorkspaceStats;
        if (alive) setStats(data);
      } catch { /* ignore */ }
    };
    fetchStats();
    const id = window.setInterval(fetchStats, 5 * 60 * 1000);
    return () => { alive = false; window.clearInterval(id); };
  }, [workspaceId]);

  // 主题切换：先调本地 setTheme（更新 localStorage / data-theme / 广播），
  // 再异步写后端 preferences（登录时才写）。失败 toast 提示但不回滚视觉。
  const handleThemeChange = (pref: ThemePreference) => {
    setTheme(pref);
    if (user) {
      patchPreferences({ theme: pref }).catch((err) => {
        console.warn("[topbar] persist theme failed:", err);
      });
    }
  };
  const [editingDocName, setEditingDocName] = useState(false);

  // 头像默认值：后端 register 时已随机分配 /avatars/avatar_N.png，兜底
  // 走 avatar_1。以前这里写的是 /avatars/me.jpg（作者本人头像），任何没
  // avatarUrl 的新用户都会错误地显示成那张脸，已修掉。
  const userAvatar = user?.avatarUrl || "/avatars/avatar_1.png";
  const handleLogout = async () => {
    setAvatarMenuOpen(false);
    await logout();
    navigate("/login", { replace: true });
  };

  // ── Avatar upload + crop ──
  const avatarFileRef = useRef<HTMLInputElement>(null);
  const [cropSource, setCropSource] = useState<string | null>(null); // 选好图后放进这里 → 打开 crop dialog
  const [avatarUploading, setAvatarUploading] = useState(false);

  const onAvatarFilePicked = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // 清空 input value，否则重复选同一张不会触发 change
    e.target.value = "";
    if (!file) return;
    if (!/^image\/(png|jpe?g|gif|webp)$/.test(file.type)) {
      toast.error("仅支持 PNG / JPG / GIF / WebP");
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      toast.error("源图过大（超过 20MB）");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setCropSource(reader.result as string);
    reader.readAsDataURL(file);
  };

  const handleCroppedAvatar = async (croppedDataUrl: string) => {
    setCropSource(null);
    setAvatarUploading(true);
    try {
      const res = await fetch("/api/auth/avatar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ dataUrl: croppedDataUrl }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "upload failed");
      }
      const data = await res.json();
      patchUser({ avatarUrl: data.user.avatarUrl });
      toast.success(t("topbar.avatarSaved"));
    } catch (err: any) {
      toast.error(err?.message || "upload failed");
    } finally {
      setAvatarUploading(false);
    }
  };

  // ── Inline username edit in popover ──
  // 双击 username → 进入编辑态（InlineEdit 组件负责 UI），失焦 / Enter 提交，
  // Esc 取消。与 documentName 的编辑 UX 一致，不再有额外的 √ × 按钮。
  const [editingUsername, setEditingUsername] = useState(false);

  const commitUsername = async (trimmed: string) => {
    if (!trimmed) { toast.error(t("auth.toast.usernameRequired")); setEditingUsername(false); return; }
    if (!isValidUsername(trimmed)) { toast.error(t("auth.toast.usernameInvalid")); setEditingUsername(false); return; }
    if (trimmed === user?.username) { setEditingUsername(false); return; }
    try {
      const res = await fetch("/api/auth/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ name: trimmed, username: trimmed }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "save failed");
      }
      const data = await res.json();
      // 只更新 user 自身的 name/username —— 不触动 workspace / agent 名。
      patchUser({ name: data.user.name, username: data.user.username });
      toast.success(t("topbar.nameSaved"));
    } catch (err: any) {
      toast.error(err?.message || "save failed");
    } finally {
      setEditingUsername(false);
    }
  };

  // ── Avatar dropdown menu ──
  const [avatarMenuOpen, setAvatarMenuOpen] = useState(false);
  const [langSubOpen, setLangSubOpen] = useState(false);
  const [themeSubOpen, setThemeSubOpen] = useState(false);
  const [settingsSubOpen, setSettingsSubOpen] = useState(false);
  const avatarRef = useRef<HTMLImageElement>(null);
  const avatarMenuRef = useRef<HTMLDivElement>(null);
  const [avatarMenuPos, setAvatarMenuPos] = useState<{ top: number; left: number } | null>(null);
  const langSubCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const themeSubCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settingsSubCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Close avatar menu on outside click
  useEffect(() => {
    if (!avatarMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (avatarMenuRef.current && !avatarMenuRef.current.contains(e.target as Node) &&
          avatarRef.current && !avatarRef.current.contains(e.target as Node)) {
        setAvatarMenuOpen(false);
        setLangSubOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [avatarMenuOpen]);

  const handleAvatarClick = () => {
    if (!avatarMenuOpen && avatarRef.current) {
      const rect = avatarRef.current.getBoundingClientRect();
      // 用显式 left 计算保证 popover.right === avatar.right —— 之前用
      // `right: window.innerWidth - rect.right` 在某些浏览器会因滚动条宽度
      // 出现 1-17px 偏差。280 是 .topbar-profile-popover 的固定宽度。
      const POPOVER_WIDTH = 280;
      const left = Math.max(8, rect.right - POPOVER_WIDTH);
      setAvatarMenuPos({ top: rect.bottom + 4, left });
    }
    setAvatarMenuOpen(!avatarMenuOpen);
    if (avatarMenuOpen) {
      setLangSubOpen(false);
      if (langSubCloseTimer.current) { clearTimeout(langSubCloseTimer.current); langSubCloseTimer.current = null; }
    }
  };

  const handleLangSwitch = (lang: Locale) => {
    if (lang !== locale) {
      // 先持久化到后端再 reload —— setLocale 内部会 reload 整页
      if (user) {
        patchPreferences({ locale: lang }).finally(() => setLocale(lang));
      } else {
        setLocale(lang);
      }
    }
  };

  // safe-delete 开关：透传给父级 + 持久化到后端 preferences
  const handleSafeDeleteChange = (val: boolean) => {
    onDeleteProtectionChange?.(val);
    if (user) {
      patchPreferences({ deleteProtection: val }).catch((err) => {
        console.warn("[topbar] persist safe-delete failed:", err);
      });
    }
  };

  return (
    <div className="topbar">
      {/* Left: nav icons + divider + stacked basic info */}
      <div className="topbar-left">
        <div className="topbar-nav">
          <button className="topbar-icon-btn" title={t("topbar.menu")}>
            {/* Figma: Sidebar toggle — lines 708-711 */}
            <svg width="16" height="16" viewBox="24 24 16 16" fill="none">
              <path d="M38.6669 26.6667C38.6669 26.2985 38.3684 26 38.0002 26H26.0002C25.632 26 25.3335 26.2985 25.3335 26.6667C25.3335 27.0349 25.632 27.3333 26.0002 27.3333H38.0002C38.3684 27.3333 38.6669 27.0349 38.6669 26.6667Z" fill="#646A73"/>
              <path d="M37.926 31.3333C38.3351 31.3333 38.6667 31.6318 38.6667 32C38.6667 32.3682 38.3351 32.6667 37.926 32.6667H32.7408C32.3317 32.6667 32 32.3682 32 32C32 31.6318 32.3317 31.3333 32.7408 31.3333H37.926Z" fill="#646A73"/>
              <path d="M38.6667 37.3333C38.6667 36.9651 38.3351 36.6667 37.926 36.6667H32.7408C32.3317 36.6667 32 36.9651 32 37.3333C32 37.7015 32.3317 38 32.7408 38H37.926C38.3351 38 38.6667 37.7015 38.6667 37.3333Z" fill="#646A73"/>
              <path d="M29.7269 35.243C30.0911 34.9548 30.0911 34.3785 29.7269 34.0903L26.4261 31.4787C25.9758 31.1225 25.3334 31.4614 25.3334 32.0551V37.2783C25.3334 37.8719 25.9758 38.2108 26.4261 37.8546L29.7269 35.243Z" fill="#646A73"/>
            </svg>
          </button>
          <button className="topbar-icon-btn" title={t("topbar.home")}>
            {/* Figma: Home — line 712 */}
            <svg width="16" height="16" viewBox="56 24 16 16" fill="none">
              <path d="M69.3334 30.6665L64 26.7074L58.6667 30.6665L58.6667 37.3332H62V34.7999C62 33.9898 62.6567 33.3332 63.4667 33.3332H64.5334C65.3434 33.3332 66 33.9898 66 34.7999V37.3332H69.3334V30.6665ZM63.3334 37.9999C63.3334 38.368 63.0349 38.6665 62.6667 38.6665H58.6667C57.9303 38.6665 57.3334 38.0696 57.3334 37.3332V30.6665C57.3334 30.2615 57.5175 29.8784 57.8338 29.6253L63.1671 25.6662C63.6541 25.2766 64.346 25.2766 64.833 25.6662L70.1663 29.6253C70.4826 29.8784 70.6667 30.2615 70.6667 30.6665V37.3332C70.6667 38.0696 70.0698 38.6665 69.3334 38.6665H65.3334C64.9652 38.6665 64.6667 38.368 64.6667 37.9999V34.7999C64.6667 34.7262 64.607 34.6665 64.5334 34.6665H63.4667C63.3931 34.6665 63.3334 34.7262 63.3334 34.7999V37.9999Z" fill="#646A73"/>
            </svg>
          </button>
        </div>
        <span className="topbar-divider" />
        <div className="topbar-info">
          {/* Row 1: breadcrumb */}
          <div className="topbar-breadcrumb">
            {/* 面包屑首项 = 当前登录用户的 username（name 同步为 username） */}
            <span className="topbar-crumb">{user?.name || user?.username || ""}</span>
            {/* Figma: Chevron right — line 716 */}
            <svg className="topbar-sep-arrow" width="8" height="12" viewBox="143 15.5 6.5 10" fill="none">
              <path d="M144.146 16.6464C143.951 16.8417 143.951 17.1583 144.146 17.3536L147.293 20.5L144.146 23.6464C143.951 23.8417 143.951 24.1583 144.146 24.3536C144.342 24.5488 144.658 24.5488 144.854 24.3536L148.354 20.8536C148.447 20.7598 148.5 20.6326 148.5 20.5C148.5 20.3674 148.447 20.2402 148.354 20.1464L144.854 16.6464C144.658 16.4512 144.342 16.4512 144.146 16.6464Z" fill="#8F959E"/>
            </svg>
            <span className="topbar-crumb-current">
              {/* workspace 蓝色 base icon 已删除 —— 视觉精简 */}
              <InlineEdit
                value={documentName}
                isEditing={editingDocName}
                onStartEdit={() => setEditingDocName(true)}
                onSave={(name) => {
                  setEditingDocName(false);
                  onRenameDocument?.(name);
                }}
                onCancelEdit={() => setEditingDocName(false)}
              />
            </span>
            {/* pin 按钮已删除 */}
          </div>
          {/* Row 2 —— 工作区指标 + AI 摘要（替换原 L2 / lastModified / public-warning） */}
          <div className="topbar-info-row">
            <span className="topbar-stat" title={t("topbar.statsTitle")}>
              <span className="topbar-stat-num">{stats?.tables ?? 0}</span>
              <span className="topbar-stat-label">{t("topbar.statTable")}</span>
              <span className="topbar-stat-dot">·</span>
              <span className="topbar-stat-num">{stats?.ideas ?? 0}</span>
              <span className="topbar-stat-label">{t("topbar.statIdea")}</span>
              <span className="topbar-stat-dot">·</span>
              <span className="topbar-stat-num">{stats?.designs ?? 0}</span>
              <span className="topbar-stat-label">{t("topbar.statTaste")}</span>
              <span className="topbar-stat-dot">·</span>
              <span className="topbar-stat-num">{stats?.demos ?? 0}</span>
              <span className="topbar-stat-label">{t("topbar.statDemo")}</span>
            </span>
            <span className="topbar-info-sep" />
            <span className="topbar-stat" title={t("topbar.tokenTitle")}>
              <span className="topbar-stat-num">{formatTokenCount(stats?.totalTokens ?? 0)}</span>
              <span className="topbar-stat-label">tokens</span>
            </span>
            {(stats?.summary || stats?.slogan) && (
              <>
                <span className="topbar-info-sep" />
                <span className="topbar-summary">
                  {stats.summary ? `${stats.summary}` : ""}
                  {stats.summary && stats.slogan ? " · " : ""}
                  {stats.slogan ? stats.slogan : ""}
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Right: 只保留搜索 / 新建 / AI 三个图标 + 头像 */}
      <div className="topbar-right">
        {/* share / robot / permissions / extensions / notifications 全部移除 */}
        <div className="topbar-icon-group" style={{ display: "none" }}>
          <button className="topbar-icon-btn" title={t("topbar.robot")}>
            {/* Figma: Robot — lines 749-753 */}
            <svg width="20" height="20" viewBox="1069 21.5 20 20" fill="none">
              <path d="M1076.75 32C1077.37 32.0001 1077.88 32.5037 1077.88 33.125C1077.88 33.7463 1077.37 34.2499 1076.75 34.25C1076.13 34.25 1075.62 33.7463 1075.62 33.125C1075.62 32.5037 1076.13 32 1076.75 32Z" fill="#2B2F36"/>
              <path d="M1081.25 32C1081.87 32.0001 1082.38 32.5037 1082.38 33.125C1082.38 33.7463 1081.87 34.2499 1081.25 34.25C1080.63 34.25 1080.12 33.7463 1080.12 33.125C1080.12 32.5037 1080.63 32 1081.25 32Z" fill="#2B2F36"/>
              <path d="M1079.75 23C1080.37 23 1080.88 23.5037 1080.88 24.125C1080.88 24.7075 1080.43 25.1865 1079.86 25.2441L1079.75 25.25V27.125H1084.25C1085.08 27.1251 1085.75 27.7966 1085.75 28.625V38C1085.75 38.8284 1085.08 39.4999 1084.25 39.5H1073.75C1072.92 39.5 1072.25 38.8284 1072.25 38V28.625C1072.25 27.7966 1072.92 27.125 1073.75 27.125H1078.25V25.25L1078.14 25.2441C1077.57 25.1865 1077.12 24.7075 1077.12 24.125C1077.12 23.5037 1077.63 23 1078.25 23H1079.75ZM1073.75 38H1084.25V28.625H1073.75V38Z" fill="#2B2F36"/>
              <path d="M1070.75 30.875C1071.16 30.875 1071.5 31.2108 1071.5 31.625V34.625C1071.5 35.0392 1071.16 35.375 1070.75 35.375C1070.34 35.375 1070 35.0392 1070 34.625V31.625C1070 31.2108 1070.34 30.875 1070.75 30.875Z" fill="#2B2F36"/>
              <path d="M1087.25 30.875C1087.66 30.875 1088 31.2108 1088 31.625V34.625C1088 35.0392 1087.66 35.375 1087.25 35.375C1086.84 35.375 1086.5 35.0392 1086.5 34.625V31.625C1086.5 31.2108 1086.84 30.875 1087.25 30.875Z" fill="#2B2F36"/>
            </svg>
          </button>
          <button className="topbar-icon-btn" title={t("topbar.permissions")}>
            {/* Figma: Doc + lock — lines 754-757 */}
            <svg width="20" height="20" viewBox="1104 21.5 20 20" fill="none">
              <path d="M1118.25 25.25H1107.75L1107.75 38.3762L1110.75 38.3768V39.8768L1107.75 39.8762C1106.92 39.8762 1106.25 39.2046 1106.25 38.3762L1106.25 25.25C1106.25 24.4216 1106.92 23.75 1107.75 23.75H1118.25C1119.08 23.75 1119.75 24.4216 1119.75 25.25L1119.75 29.3762H1118.25L1118.25 25.25Z" fill="#2B2F36"/>
              <path d="M1110 27.4937C1109.59 27.4937 1109.25 27.8295 1109.25 28.2437C1109.25 28.6579 1109.59 28.9937 1110 28.9937H1116C1116.41 28.9937 1116.75 28.6579 1116.75 28.2437C1116.75 27.8295 1116.41 27.4937 1116 27.4937H1110Z" fill="#2B2F36"/>
              <path d="M1110 30.4984C1109.59 30.4984 1109.25 30.8341 1109.25 31.2484C1109.25 31.6626 1109.59 31.9984 1110 31.9984L1111.87 31.9987C1112.28 31.9987 1112.62 31.6629 1112.62 31.2487C1112.62 30.8344 1112.28 30.4987 1111.87 30.4987L1110 30.4984Z" fill="#2B2F36"/>
              <path d="M1113.74 33.1239C1113.74 31.467 1115.08 30.1228 1116.74 30.1215C1118.4 30.1202 1119.74 31.4623 1119.74 33.1192L1119.74 33.4942C1120.57 33.4936 1121.24 34.1646 1121.25 34.993L1121.25 38.368C1121.25 39.1965 1120.58 39.8686 1119.75 39.8692L1113.75 39.8739C1112.92 39.8745 1112.25 39.2035 1112.25 38.3751L1112.25 35.0001C1112.24 34.1716 1112.92 33.4995 1113.74 33.4989L1113.74 33.1239ZM1118.24 33.1204C1118.24 32.2919 1117.57 31.6209 1116.74 31.6215C1115.91 31.6222 1115.24 32.2943 1115.24 33.1227L1115.24 33.4977L1118.24 33.4954L1118.24 33.1204ZM1119.75 34.9942L1113.75 34.9989L1113.75 38.3739L1119.75 38.3692L1119.75 34.9942Z" fill="#2B2F36"/>
            </svg>
          </button>
          <button className="topbar-icon-btn" title={t("topbar.extensions")}>
            {/* Figma: Ticket/coupon — line 758 */}
            <svg width="20" height="20" viewBox="1137 21.5 20 20" fill="none">
              <path d="M1148 28.25H1152.62V29.6677C1152.04 29.7811 1151.46 30.006 1150.96 30.383C1150.12 31.0138 1149.62 31.9757 1149.62 33.125C1149.62 34.2743 1150.12 35.2362 1150.96 35.867C1151.46 36.244 1152.04 36.4689 1152.62 36.5823V38H1141.38V28.25H1145V26.75C1145 25.9216 1145.67 25.25 1146.5 25.25C1147.33 25.25 1148 25.9216 1148 26.75V28.25ZM1149.5 26.75C1149.5 25.0931 1148.16 23.75 1146.5 23.75C1144.84 23.75 1143.5 25.0931 1143.5 26.75H1140.88C1140.32 26.75 1139.88 27.1977 1139.88 27.75V38.5C1139.88 39.0523 1140.32 39.5 1140.88 39.5H1153.12C1153.68 39.5 1154.12 39.0523 1154.12 38.5V35.6283C1154.12 35.3682 1153.89 35.175 1153.62 35.175C1152.24 35.175 1151.12 34.5057 1151.12 33.125C1151.12 31.7443 1152.24 31.075 1153.62 31.075C1153.89 31.075 1154.12 30.8818 1154.12 30.6217V27.75C1154.12 27.1977 1153.68 26.75 1153.12 26.75H1149.5Z" fill="#2B2F36"/>
            </svg>
          </button>
          <button className="topbar-icon-btn" title={t("topbar.notifications")}>
            {/* Figma: Bell — line 759 */}
            <svg width="20" height="20" viewBox="1171 22 20 20" fill="none">
              <path d="M1179.5 25.3821V25.187C1179.5 24.7745 1179.84 24.437 1180.25 24.437H1181.75C1182.16 24.437 1182.5 24.7745 1182.5 25.187V25.3821C1185.09 26.0697 1187 28.4946 1187 31.3806L1187 36.1532H1187.75C1188.16 36.1532 1188.5 36.4889 1188.5 36.9032C1188.5 37.3174 1188.16 37.6532 1187.75 37.6532H1174.25C1173.84 37.6532 1173.5 37.3174 1173.5 36.9032C1173.5 36.4889 1173.84 36.1532 1174.25 36.1532H1175L1175 31.3806C1175 28.4946 1176.91 26.0697 1179.5 25.3821ZM1176.5 36.1532H1185.5L1185.5 31.3827C1185.5 28.7893 1183.49 26.687 1181 26.687C1178.51 26.687 1176.5 28.7893 1176.5 31.3827L1176.5 36.1532ZM1178.56 39.5282C1178.56 39.1139 1178.9 38.7782 1179.31 38.7782H1182.69C1183.1 38.7782 1183.44 39.1139 1183.44 39.5282C1183.44 39.9424 1183.1 40.2782 1182.69 40.2782H1179.31C1178.9 40.2782 1178.56 39.9424 1178.56 39.5282Z" fill="#2B2F36"/>
            </svg>
          </button>
        </div>
        {/* 老的 group-1 / group-2 之间的 divider 删除，因为 group-1 已经隐藏 */}
        <div className="topbar-icon-group">
          <button className="topbar-icon-btn" title={t("topbar.search")}>
            {/* Figma: Search — line 764 */}
            <svg width="20" height="20" viewBox="1263.5 21.5 20 20" fill="none">
              <path d="M1277.35 36.4156C1276.13 37.4065 1274.57 38 1272.88 38C1268.94 38 1265.75 34.81 1265.75 30.875C1265.75 26.94 1268.94 23.75 1272.88 23.75C1276.81 23.75 1280 26.94 1280 30.875C1280 32.5724 1279.41 34.1311 1278.42 35.355L1281.25 38.1844C1281.54 38.4755 1281.53 38.9485 1281.24 39.2396C1280.95 39.5307 1280.48 39.5362 1280.18 39.2451L1277.35 36.4156ZM1278.5 30.875C1278.5 27.7684 1275.98 25.25 1272.88 25.25C1269.77 25.25 1267.25 27.7684 1267.25 30.875C1267.25 33.9816 1269.77 36.5 1272.88 36.5C1275.98 36.5 1278.5 33.9816 1278.5 30.875Z" fill="#2B2F36"/>
            </svg>
          </button>
          <button className="topbar-icon-btn" title={t("topbar.add")}>
            {/* Figma: Plus — line 765 */}
            <svg width="20" height="20" viewBox="1298 22 20 20" fill="none">
              <path d="M1308 24.5C1307.59 24.5 1307.25 24.8358 1307.25 25.25V31.25H1301.25C1300.84 31.25 1300.5 31.5858 1300.5 32C1300.5 32.4142 1300.84 32.75 1301.25 32.75H1307.25V38.75C1307.25 39.1642 1307.59 39.5 1308 39.5C1308.41 39.5 1308.75 39.1642 1308.75 38.75V32.75H1314.75C1315.16 32.75 1315.5 32.4142 1315.5 32C1315.5 31.5858 1315.16 31.25 1314.75 31.25H1308.75V25.25C1308.75 24.8358 1308.41 24.5 1308 24.5Z" fill="#2B2F36"/>
            </svg>
          </button>
          <button
            className={`topbar-icon-btn topbar-agent-btn${chatAgentOpen ? " topbar-icon-btn-active" : ""}`}
            title={agentUnreadCount && agentUnreadCount > 0 ? `${t("topbar.ai")} · ${agentUnreadCount}` : t("topbar.ai")}
            onClick={() => onOpenChatAgent?.()}
          >
            {/* Figma sparkle outline — same path for both states. The active
             * state simply flips the fill to primary blue via CSS `color`
             * (inherited through `fill="currentColor"`). */}
            <svg width="20" height="20" viewBox="1332 22 20 20" fill="none">
              <path d="M1342 27.3108C1341.02 29.321 1339.43 30.97 1337.46 31.9998C1339.43 33.0294 1341.02 34.678 1342 36.688C1342.98 34.678 1344.57 33.0294 1346.54 31.9998C1344.57 30.97 1342.98 29.321 1342 27.3108ZM1350.62 31.9998C1350.62 32.2031 1350.47 32.3714 1350.27 32.3945L1350.18 32.4062C1349.52 32.4895 1348.89 32.6447 1348.28 32.8647L1347.55 33.1702C1345.67 34.0603 1344.14 35.6041 1343.27 37.5142L1342.96 38.2532C1342.75 38.8585 1342.6 39.4945 1342.51 40.1523L1342.49 40.2483C1342.43 40.4649 1342.23 40.6226 1342 40.6226L1341.9 40.613C1341.72 40.5762 1341.56 40.4341 1341.51 40.2483L1341.49 40.1523C1341.4 39.4945 1341.25 38.8585 1341.04 38.2532L1340.73 37.5142C1339.86 35.6041 1338.33 34.0603 1336.45 33.1702L1335.72 32.8647C1335.16 32.6631 1334.59 32.5156 1333.99 32.4282L1333.73 32.3945C1333.53 32.3714 1333.38 32.2031 1333.38 31.9998C1333.38 31.7964 1333.53 31.6281 1333.73 31.605C1334.33 31.535 1334.92 31.4037 1335.48 31.2175L1335.72 31.1348L1336.45 30.8293C1338.33 29.9392 1339.86 28.3954 1340.73 26.4854L1341.04 25.7463C1341.25 25.141 1341.4 24.505 1341.49 23.8472C1341.52 23.5828 1341.74 23.377 1342 23.377C1342.26 23.377 1342.48 23.5828 1342.51 23.8472C1342.6 24.505 1342.75 25.141 1342.96 25.7463L1343.27 26.4854C1344.14 28.3954 1345.67 29.9392 1347.55 30.8293L1348.28 31.1348L1348.52 31.2175C1349.08 31.4037 1349.67 31.535 1350.27 31.605C1350.47 31.6281 1350.62 31.7964 1350.62 31.9998Z" fill="currentColor"/>
            </svg>
            {agentUnreadCount && agentUnreadCount > 0 ? (
              <span className="topbar-agent-badge" aria-label={`${agentUnreadCount} unread`}>
                {agentUnreadCount > 9 ? "9+" : agentUnreadCount}
              </span>
            ) : null}
          </button>
        </div>
        <span className="topbar-divider" />
        <img
          className="topbar-avatar"
          src={userAvatar}
          alt={user?.name || "avatar"}
          ref={avatarRef}
          onClick={handleAvatarClick}
          onError={(e) => { (e.currentTarget as HTMLImageElement).src = "/avatars/avatar_1.png"; }}
        />
      </div>

      {/* Avatar dropdown menu —— 把个人信息编辑整合进来，不再弹二次对话框 */}
      {avatarMenuOpen && avatarMenuPos && (
        <div className="topbar-menu topbar-profile-popover" ref={avatarMenuRef} style={{ position: "fixed", top: avatarMenuPos.top, left: avatarMenuPos.left }}>
          {/* 头像区结构对齐 Lark _pp-panel-header：
               · avatar-selector 内部 = img + hover overlay + 直接覆盖的 file input
               · panel-information = name 行 (overflow ellipsis) + 底部行 (text + tag slot)
               file input 用绝对定位铺满 avatar，点头像直接触发 picker，无需 JS click()。 */}
          {user && (
            <div className="topbar-profile-header">
              <div className="topbar-profile-avatar-wrap" title={t("topbar.changeAvatar")}>
                <img
                  className="topbar-profile-avatar"
                  src={userAvatar}
                  alt=""
                  onError={(e) => { (e.currentTarget as HTMLImageElement).src = "/avatars/avatar_1.png"; }}
                />
                <div className="topbar-profile-avatar-overlay">
                  {avatarUploading ? (
                    <span className="topbar-profile-uploading-dot">…</span>
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path d="M4 7h3l1.5-2h7L17 7h3a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V8a1 1 0 011-1z" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                      <circle cx="12" cy="13" r="3.5" stroke="#fff" strokeWidth="1.6"/>
                    </svg>
                  )}
                </div>
                <input
                  ref={avatarFileRef}
                  type="file"
                  title=""
                  accept="image/png,image/jpeg,image/gif,image/webp"
                  className="topbar-profile-avatar-input"
                  onChange={onAvatarFilePicked}
                />
              </div>
              <div className="topbar-profile-info">
                <div className="topbar-profile-name-wrap">
                  <span className="topbar-profile-username">
                    <InlineEdit
                      value={user.username || user.name || ""}
                      isEditing={editingUsername}
                      onStartEdit={() => setEditingUsername(true)}
                      onSave={commitUsername}
                      onCancelEdit={() => setEditingUsername(false)}
                      maxLength={32}
                    />
                  </span>
                </div>
                <div className="topbar-profile-tenant">
                  <span className="topbar-profile-email">{user.email}</span>
                  {/* tag slot —— 当前没有验证 / plan 概念，留空。后续可加 chip
                      <span className="topbar-profile-tags">…</span> */}
                </div>
              </div>
            </div>
          )}

          {/* Header 和菜单项之间的分隔线（顶部分割线，拉近距离用 -margin） */}
          <div className="topbar-menu-divider topbar-profile-divider-top" />

          {/* 外观 submenu（浅色 / 深色 / 跟随系统） */}
          <div
            className="topbar-menu-item has-submenu"
            onMouseEnter={() => {
              if (themeSubCloseTimer.current) { clearTimeout(themeSubCloseTimer.current); themeSubCloseTimer.current = null; }
              setThemeSubOpen(true);
            }}
            onMouseLeave={() => {
              themeSubCloseTimer.current = setTimeout(() => setThemeSubOpen(false), 300);
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="topbar-menu-icon" aria-hidden="true">
              <path d="M8 1.5A6.5 6.5 0 001.5 8 6.5 6.5 0 008 14.5V1.5z" fill="currentColor"/>
              <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.2" fill="none"/>
            </svg>
            <span className="topbar-menu-label">{t("topbar.appearance")}</span>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="topbar-menu-arrow">
              <path d="M4.5 2.5l4 3.5-4 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            {themeSubOpen && (
              <div
                className="topbar-submenu"
                onMouseEnter={() => { if (themeSubCloseTimer.current) { clearTimeout(themeSubCloseTimer.current); themeSubCloseTimer.current = null; } }}
                onMouseLeave={() => { themeSubCloseTimer.current = setTimeout(() => setThemeSubOpen(false), 300); }}
              >
                {([
                  ["light", t("topbar.themeLight")],
                  ["dark", t("topbar.themeDark")],
                  ["system", t("topbar.themeSystem")],
                ] as [ThemePreference, string][]).map(([pref, label]) => (
                  <div
                    key={pref}
                    className={`topbar-menu-item${themePreference === pref ? " topbar-menu-item-active" : ""}`}
                    onClick={() => handleThemeChange(pref)}
                  >
                    <span className="topbar-menu-label">{label}</span>
                    {themePreference === pref && (
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="topbar-menu-check">
                        <path d="M3 7.5l3 3 5-6" stroke="#3370FF" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          {/* Language submenu */}
          <div
            className="topbar-menu-item has-submenu"
            onMouseEnter={() => {
              if (langSubCloseTimer.current) { clearTimeout(langSubCloseTimer.current); langSubCloseTimer.current = null; }
              setLangSubOpen(true);
            }}
            onMouseLeave={() => {
              langSubCloseTimer.current = setTimeout(() => setLangSubOpen(false), 300);
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="topbar-menu-icon">
              <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.2"/>
              <ellipse cx="8" cy="8" rx="3" ry="6.5" stroke="currentColor" strokeWidth="1.2"/>
              <path d="M1.5 8h13M2.5 5h11M2.5 11h11" stroke="currentColor" strokeWidth="1.0" strokeLinecap="round"/>
            </svg>
            <span className="topbar-menu-label">{t("topbar.language")}</span>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="topbar-menu-arrow">
              <path d="M4.5 2.5l4 3.5-4 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>

            {langSubOpen && (
              <div
                className="topbar-submenu"
                onMouseEnter={() => { if (langSubCloseTimer.current) { clearTimeout(langSubCloseTimer.current); langSubCloseTimer.current = null; } }}
                onMouseLeave={() => { langSubCloseTimer.current = setTimeout(() => setLangSubOpen(false), 300); }}
              >
                <div
                  className={`topbar-menu-item${locale === "en" ? " topbar-menu-item-active" : ""}`}
                  onClick={() => handleLangSwitch("en")}
                >
                  <span className="topbar-menu-label">English</span>
                  {locale === "en" && (
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="topbar-menu-check">
                      <path d="M3 7.5l3 3 5-6" stroke="#3370FF" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  )}
                </div>
                <div
                  className={`topbar-menu-item${locale === "zh" ? " topbar-menu-item-active" : ""}`}
                  onClick={() => handleLangSwitch("zh")}
                >
                  <span className="topbar-menu-label">{t("topbar.langChinese")}</span>
                  {locale === "zh" && (
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="topbar-menu-check">
                      <path d="M3 7.5l3 3 5-6" stroke="#3370FF" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  )}
                </div>
              </div>
            )}
          </div>
          {/* 设置 submenu（含安全删除，从 More 菜单迁移而来） */}
          <div
            className="topbar-menu-item has-submenu"
            onMouseEnter={() => {
              if (settingsSubCloseTimer.current) { clearTimeout(settingsSubCloseTimer.current); settingsSubCloseTimer.current = null; }
              setSettingsSubOpen(true);
            }}
            onMouseLeave={() => {
              settingsSubCloseTimer.current = setTimeout(() => setSettingsSubOpen(false), 300);
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="topbar-menu-icon" aria-hidden="true">
              <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.2"/>
              <path d="M13 8a5 5 0 01-.1 1l1.3 1-1 1.7-1.5-.4a5 5 0 01-1.8 1L9.5 14h-3l-.4-1.7a5 5 0 01-1.8-1L2.8 11.7 1.8 10l1.3-1a5 5 0 01-.1-1 5 5 0 01.1-1L1.8 6 2.8 4.3l1.5.4a5 5 0 011.8-1L6.5 2h3l.4 1.7a5 5 0 011.8 1l1.5-.4 1 1.7-1.3 1a5 5 0 01.1 1z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" fill="none"/>
            </svg>
            <span className="topbar-menu-label">{t("topbar.settings")}</span>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="topbar-menu-arrow">
              <path d="M4.5 2.5l4 3.5-4 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            {settingsSubOpen && (
              <div
                className="topbar-submenu"
                onMouseEnter={() => { if (settingsSubCloseTimer.current) { clearTimeout(settingsSubCloseTimer.current); settingsSubCloseTimer.current = null; } }}
                onMouseLeave={() => { settingsSubCloseTimer.current = setTimeout(() => setSettingsSubOpen(false), 300); }}
              >
                <div
                  className="topbar-menu-item"
                  onClick={(e) => { e.stopPropagation(); handleSafeDeleteChange(!deleteProtection); }}
                >
                  <span className="topbar-menu-label">{t("topbar.safeDelete")}</span>
                  <label className="tb-switch" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={deleteProtection}
                      onChange={(e) => handleSafeDeleteChange(e.target.checked)}
                    />
                    <span className="tb-switch-track" />
                  </label>
                </div>
              </div>
            )}
          </div>

          {/* Logout —— 默认色，不再用 danger 红 */}
          <div className="topbar-menu-divider" />
          <div className="topbar-menu-item" onClick={handleLogout}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="topbar-menu-icon">
              <path d="M9.5 2h-5A1.5 1.5 0 003 3.5v9A1.5 1.5 0 004.5 14h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              <path d="M7 8h7m0 0l-2.5-2.5M14 8l-2.5 2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <span className="topbar-menu-label">{t("topbar.logout")}</span>
          </div>
        </div>
      )}

      {cropSource && (
        <AvatarCropDialog
          sourceDataUrl={cropSource}
          onConfirm={handleCroppedAvatar}
          onCancel={() => setCropSource(null)}
        />
      )}
    </div>
  );
}
