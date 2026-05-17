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
import AddBlockMenu from "./MagicCanvas/AddBlockMenu";
import { useCanvas } from "../contexts/canvasContext";
import aiIconColorful from "../assets/icon_ai-common_colorful.svg?url";
import aiIconOutlined from "../assets/icon_meeting-ai_outlined.svg?url";
import "./TopBar.css";

interface Props {
  tableName: string;
  documentName: string;
  /** 当前 workspace id —— 用来拉 stats（artifact 数 / token / AI 摘要）。 */
  workspaceId: string;
  onRenameTable?: (newName: string) => void;
  onRenameDocument?: (newName: string) => void;
  onOpenChatAgent?: () => void;
  chatAgentOpen?: boolean;
  /** Phase 4 Day 3 — unread count from /api/agents/:id/inbox?unread=1. 0 or undefined hides the dot. */
  agentUnreadCount?: number;
  /** Toggle workspace dock visibility */
  onToggleDock?: () => void;
  /** Whether the workspace dock is currently open */
  dockOpen?: boolean;
}

interface WorkspaceStats {
  /** tables + ideas + designs + demos */
  artifacts: number;
  /** 已发布作品数（V1 = 已发布 demo 数量） */
  published: number;
  /** 兼容字段（细分明细） */
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

export default function TopBar({ tableName, documentName, workspaceId, onRenameTable, onRenameDocument, onOpenChatAgent, chatAgentOpen, agentUnreadCount, onToggleDock, dockOpen }: Props) {
  const { t, locale } = useTranslation();
  const { user, patchUser, logout, patchPreferences, preferences } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const { preference: themePreference, setTheme } = useTheme();
  const canvas = useCanvas();

  // ── High Agency toggle ──
  const agencyBlock = Object.values(canvas.state.blocks).find((b) => b.type === "agency");
  const agencyActive = !!agencyBlock;
  const handleToggleAgency = () => {
    if (agencyBlock) {
      // Remove agency block (collapse to background)
      canvas.removeBlock(agencyBlock.id);
      canvas.scheduleSave();
    } else {
      // Create agency block (singleton enforced in addBlock)
      canvas.addBlock("agency");
      canvas.scheduleSave();
    }
  };

  // ── Workspace stats ──
  // 触发刷新的方式（绝对不在这里再开 EventSource —— HTTP/1.1 每域名 ~6 个长
  // 连接的限制下,多开一条 SSE 会饿死 chat 的 SSE，导致对话加载慢/卡死）：
  //   1. 初始挂载 / workspaceId 切换 → 立刻拉
  //   2. window "workspace-stats-changed" 自定义事件 —— App 的 useWorkspaceSync
  //      在每个 workspace-change 事件回调里 dispatch；ChatSidebar 在 chat done
  //      时 dispatch；后续任何 artifact CRUD / token 写入都可以 dispatch 这个
  //      事件让顶栏即时刷新
  //   3. 60s 兜底轮询。
  const [stats, setStats] = useState<WorkspaceStats | null>(null);
  const lastFetchRef = useRef<number>(0);
  useEffect(() => {
    if (!workspaceId) return;
    let alive = true;

    const fetchStats = async () => {
      const now = Date.now();
      if (now - lastFetchRef.current < 200) return;
      lastFetchRef.current = now;
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
    const intervalId = window.setInterval(fetchStats, 60 * 1000);

    const onCustom = () => {
      lastFetchRef.current = 0;
      fetchStats();
    };
    window.addEventListener("workspace-stats-changed", onCustom);

    return () => {
      alive = false;
      window.clearInterval(intervalId);
      window.removeEventListener("workspace-stats-changed", onCustom);
    };
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
      // Cache-bust 防止浏览器命中旧 src 缓存 —— 即使后端返回 hash-based 文件
      // 名(同张图永远一样的 URL),query string 让 React 看到的 src 不同,
      // 强制 <img> 重新 fetch。reload 页面时 URL 不带 ?v= 后缀正常缓存。
      const cacheBusted = data.user.avatarUrl
        ? `${data.user.avatarUrl}${data.user.avatarUrl.includes("?") ? "&" : "?"}v=${Date.now()}`
        : data.user.avatarUrl;
      patchUser({ avatarUrl: cacheBusted });
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
  const [tzSubOpen, setTzSubOpen] = useState(false);
  const avatarRef = useRef<HTMLImageElement>(null);
  const avatarMenuRef = useRef<HTMLDivElement>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const [avatarMenuPos, setAvatarMenuPos] = useState<{ top: number; left: number } | null>(null);
  const langSubCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const themeSubCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tzSubCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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


  return (
    <div className="topbar">
      {/* Left: nav icons + divider + stacked basic info */}
      <div className="topbar-left">
        <div className="topbar-nav">
          <button className={`topbar-icon-btn ${dockOpen ? "topbar-icon-btn--active" : ""}`} title={t("topbar.home")} onClick={onToggleDock}>
            {dockOpen ? (
              /* Filled home icon (active state) */
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M9.5 22.0003C10.0523 22.0003 10.5 21.5526 10.5 21.0003V17.0002C10.5 16.448 10.9477 16.0002 11.5 16.0002H12.5C13.0523 16.0002 13.5 16.448 13.5 17.0002V21.0003C13.5 21.5526 13.9477 22.0003 14.5 22.0003H20C21.1046 22.0003 22 21.1048 22 20.0003V10.0002C22 9.39268 21.7238 8.81805 21.2494 8.43851L13.2494 2.49979C12.519 1.91544 11.481 1.91544 10.7506 2.49979L2.75061 8.43851C2.27618 8.81805 2 9.39268 2 10.0002V20.0003C2 21.1048 2.89543 22.0003 4 22.0003H9.5Z" fill="currentColor"/>
              </svg>
            ) : (
              /* Outlined home icon (default state) */
              <svg width="16" height="16" viewBox="56 24 16 16" fill="none">
                <path d="M69.3334 30.6665L64 26.7074L58.6667 30.6665L58.6667 37.3332H62V34.7999C62 33.9898 62.6567 33.3332 63.4667 33.3332H64.5334C65.3434 33.3332 66 33.9898 66 34.7999V37.3332H69.3334V30.6665ZM63.3334 37.9999C63.3334 38.368 63.0349 38.6665 62.6667 38.6665H58.6667C57.9303 38.6665 57.3334 38.0696 57.3334 37.3332V30.6665C57.3334 30.2615 57.5175 29.8784 57.8338 29.6253L63.1671 25.6662C63.6541 25.2766 64.346 25.2766 64.833 25.6662L70.1663 29.6253C70.4826 29.8784 70.6667 30.2615 70.6667 30.6665V37.3332C70.6667 38.0696 70.0698 38.6665 69.3334 38.6665H65.3334C64.9652 38.6665 64.6667 38.368 64.6667 37.9999V34.7999C64.6667 34.7262 64.607 34.6665 64.5334 34.6665H63.4667C63.3931 34.6665 63.3334 34.7262 63.3334 34.7999V37.9999Z" fill="currentColor"/>
              </svg>
            )}
          </button>
        </div>
        <span className="topbar-divider" />
        <div className="topbar-info">
          {/* Row 1: breadcrumb. 注意：sidebar 展开按钮 NOT 在这里 —— 它放在
              当前 artifact 自己的 topbar（table/idea/design/demo）的 title 左边,
              详见 SidebarExpandButton 组件. */}
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
          {/* Row 2 —— 工作区指标 + AI 摘要（替换原 L2 / lastModified / public-warning）
              小 icon 加在每个 stat 前，左对齐到上方 username 起点 —— info-row 的
              padding-left 与 .topbar-crumb 的 horizontal padding 对齐（4px） */}
          <div className="topbar-info-row">
            <span className="topbar-stat" title={t("topbar.statArtifactsTitle")}>
              <StackIcon />
              <span className="topbar-stat-num">{stats?.artifacts ?? 0}</span>
              <span className="topbar-stat-label">{t("topbar.statArtifacts")}</span>
            </span>
            <span className="topbar-info-sep" />
            <span className="topbar-stat" title={t("topbar.statWorkendTitle")}>
              <GlobeIcon />
              <span className="topbar-stat-num">{stats?.published ?? 0}</span>
              <span className="topbar-stat-label">{t("topbar.statWorkend")}</span>
            </span>
            <span className="topbar-info-sep" />
            <span className="topbar-stat" title={t("topbar.tokenTitle")}>
              <SparkIcon />
              <span className="topbar-stat-num">{formatTokenCount(stats?.totalTokens ?? 0)}</span>
              <span className="topbar-stat-label">tokens</span>
            </span>
            {/* V4.5: 只展示 slogan,不展示 summary */}
            {stats?.slogan && (
              <>
                <span className="topbar-info-sep" />
                <span className="topbar-summary" title={stats.slogan}>
                  <SloganIcon />
                  <span className="topbar-summary-text">{stats.slogan}</span>
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
          <button className="topbar-icon-btn" title={t("topbar.add")} ref={addBtnRef}>
            {/* Figma: Plus — line 765. Click 触发 Magic Canvas 新增 block 菜单. */}
            <svg width="20" height="20" viewBox="1298 22 20 20" fill="none">
              <path d="M1308 24.5C1307.59 24.5 1307.25 24.8358 1307.25 25.25V31.25H1301.25C1300.84 31.25 1300.5 31.5858 1300.5 32C1300.5 32.4142 1300.84 32.75 1301.25 32.75H1307.25V38.75C1307.25 39.1642 1307.59 39.5 1308 39.5C1308.41 39.5 1308.75 39.1642 1308.75 38.75V32.75H1314.75C1315.16 32.75 1315.5 32.4142 1315.5 32C1315.5 31.5858 1315.16 31.25 1314.75 31.25H1308.75V25.25C1308.75 24.8358 1308.41 24.5 1308 24.5Z" fill="#2B2F36"/>
            </svg>
          </button>
          <AddBlockMenu anchorRef={addBtnRef} />
          <button
            className={`topbar-icon-btn topbar-agent-btn${agencyActive ? " topbar-icon-btn-active" : ""}`}
            title="High Agency"
            onClick={handleToggleAgency}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" style={{ color: "var(--primary)" }}>
              {agencyActive ? (
                <path d="M12 5.74805C10.6975 8.42839 8.57106 10.627 5.94434 12C8.5708 13.3728 10.6974 15.571 12 18.251C13.3026 15.571 15.4292 13.3728 18.0557 12C15.4289 10.627 13.3025 8.42839 12 5.74805ZM23.4971 12C23.4971 12.2712 23.2903 12.4955 23.0244 12.5264L22.9004 12.542C22.0266 12.653 21.1824 12.8599 20.3789 13.1533L19.4062 13.5605C16.892 14.7474 14.8593 16.8058 13.6875 19.3525L13.2861 20.3379C12.9986 21.145 12.7948 21.993 12.6846 22.8701L12.6572 22.998C12.5674 23.2869 12.3071 23.4971 12 23.4971L11.8721 23.4844C11.6224 23.4353 11.4198 23.2458 11.3428 22.998L11.3154 22.8701C11.2052 21.993 11.0014 21.145 10.7139 20.3379L10.3125 19.3525C9.14068 16.8058 7.10796 14.7474 4.59375 13.5605L3.62109 13.1533C2.88481 12.8844 2.11439 12.6878 1.31836 12.5713L0.975586 12.5264C0.709649 12.4955 0.50293 12.2712 0.50293 12C0.50293 11.7288 0.709649 11.5045 0.975586 11.4736C1.77894 11.3803 2.55774 11.2053 3.30371 10.957L3.62109 10.8467L4.59375 10.4395C7.10796 9.25256 9.14068 7.19415 10.3125 4.64746L10.7139 3.66211C11.0014 2.85502 11.2052 2.00705 11.3154 1.12988C11.3598 0.777377 11.6492 0.502931 12 0.50293C12.3508 0.50293 12.6402 0.777377 12.6846 1.12988C12.7948 2.00705 12.9986 2.85502 13.2861 3.66211L13.6875 4.64746C14.8593 7.19415 16.892 9.25256 19.4062 10.4395L20.3789 10.8467L20.6963 10.957C21.4423 11.2053 22.2211 11.3803 23.0244 11.4736C23.2903 11.5045 23.4971 11.7288 23.4971 12Z" fill="currentColor"/>
              ) : (
                <path d="M12 0.50293C12.3508 0.50293 12.6402 0.777377 12.6846 1.12988C12.7948 2.00705 12.9986 2.85502 13.2861 3.66211L13.6875 4.64746C14.8593 7.19415 16.892 9.25256 19.4062 10.4395L20.3789 10.8467L20.6963 10.957C21.4423 11.2053 22.2211 11.3803 23.0244 11.4736C23.2903 11.5045 23.4971 11.7288 23.4971 12C23.4971 12.2712 23.2903 12.4955 23.0244 12.5264L22.9004 12.542C22.0266 12.653 21.1824 12.8599 20.3789 13.1533L19.4062 13.5605C16.892 14.7474 14.8593 16.8058 13.6875 19.3525L13.2861 20.3379C12.9986 21.145 12.7948 21.993 12.6846 22.8701L12.6572 22.998C12.5674 23.2869 12.3071 23.4971 12 23.4971L11.8721 23.4844C11.6224 23.4353 11.4198 23.2458 11.3428 22.998L11.3154 22.8701C11.2052 21.993 11.0014 21.145 10.7139 20.3379L10.3125 19.3525C9.14068 16.8058 7.10796 14.7474 4.59375 13.5605L3.62109 13.1533C2.88481 12.8844 2.11439 12.6878 1.31836 12.5713L0.975586 12.5264C0.709649 12.4955 0.50293 12.2712 0.50293 12C0.50293 11.7288 0.70965 11.5045 0.975586 11.4736C1.77894 11.3803 2.55774 11.2053 3.30371 10.957L3.62109 10.8467L4.59375 10.4395C7.10796 9.25256 9.14068 7.19415 10.3125 4.64746L10.7139 3.66211C11.0014 2.85502 11.2052 2.00705 11.3154 1.12988C11.3598 0.777377 11.6492 0.502931 12 0.50293Z" fill="currentColor"/>
              )}
            </svg>
          </button>
        </div>
        <span className="topbar-divider" />
        <img
          key={userAvatar}
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
                  key={userAvatar}
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

          {/* Header 和菜单项之间的分隔线 —— 1 px,无内外边距(全靠 section padding 撑开) */}
          <div className="topbar-menu-divider topbar-profile-divider-top" />

          {/* 外观 / 语言 / 设置 共享一个 section,section 自带 4px 全方向 padding */}
          <div className="topbar-profile-section">
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

          {/* Timezone submenu */}
          <div
            className="topbar-menu-item has-submenu"
            onMouseEnter={() => {
              if (tzSubCloseTimer.current) { clearTimeout(tzSubCloseTimer.current); tzSubCloseTimer.current = null; }
              setTzSubOpen(true);
            }}
            onMouseLeave={() => {
              tzSubCloseTimer.current = setTimeout(() => setTzSubOpen(false), 300);
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="topbar-menu-icon">
              <path d="M23 12C23 18.0751 18.0751 23 12 23C5.92487 23 1 18.0751 1 12C1 5.92487 5.92487 1 12 1C18.0751 1 23 5.92487 23 12ZM9.75897 20.7188C9.63105 20.274 9.5 19.756 9.5 19.5C9.5 19 8.5 18 8.5 18C8.5 18 6.5 17.5 6 16.5C5.5 15.5 6.5 14 6.5 14L3.10713 10.6071C3.0366 11.0611 3 11.5263 3 12C3 16.1969 5.87266 19.7228 9.75897 20.7188ZM21 12C21 7.71252 18.002 4.12528 13.9879 3.22029C13.9582 4.27269 13.8555 6.14452 13.5 6.5C13 7 10.5 7.5 10.5 7.5L9.5 9.5L6.5 10L7 12H12L16 13.5C16 13.5 16.8 13.7 16.5 14.5C16.1126 15.2748 14.8247 19.0512 14.2643 20.7128C18.1388 19.7087 21 16.1885 21 12Z" fill="currentColor"/>
            </svg>
            <span className="topbar-menu-label">{t("topbar.timezone")}</span>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="topbar-menu-arrow">
              <path d="M4.5 2.5l4 3.5-4 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            {tzSubOpen && (
              <div
                className="topbar-submenu"
                onMouseEnter={() => { if (tzSubCloseTimer.current) { clearTimeout(tzSubCloseTimer.current); tzSubCloseTimer.current = null; } }}
                onMouseLeave={() => { tzSubCloseTimer.current = setTimeout(() => setTzSubOpen(false), 300); }}
              >
                {([
                  ["Asia/Shanghai", "UTC+8 Shanghai"],
                  ["Asia/Tokyo", "UTC+9 Tokyo"],
                  ["America/New_York", "UTC-5 New York"],
                  ["America/Los_Angeles", "UTC-8 Los Angeles"],
                  ["Europe/London", "UTC+0 London"],
                  ["Europe/Berlin", "UTC+1 Berlin"],
                  ["UTC", "UTC+0"],
                ] as [string, string][]).map(([tz, label]) => {
                  const currentTz = preferences.timezone ?? "Asia/Shanghai";
                  return (
                    <div
                      key={tz}
                      className={`topbar-menu-item${currentTz === tz ? " topbar-menu-item-active" : ""}`}
                      onClick={() => {
                        if (tz !== currentTz) {
                          patchPreferences({ timezone: tz }).catch((err) => {
                            console.warn("[topbar] persist timezone failed:", err);
                          });
                        }
                      }}
                    >
                      <span className="topbar-menu-label">{label}</span>
                      {currentTz === tz && (
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="topbar-menu-check">
                          <path d="M3 7.5l3 3 5-6" stroke="#3370FF" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          </div>{/* /topbar-profile-section 1 (appearance/language/settings) */}

          {/* Logout —— 默认色,不再用 danger 红;独占一个 section,自带 4px padding */}
          <div className="topbar-menu-divider" />
          <div className="topbar-profile-section">
          <div className="topbar-menu-item" onClick={handleLogout}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="topbar-menu-icon">
              <path d="M9.5 2h-5A1.5 1.5 0 003 3.5v9A1.5 1.5 0 004.5 14h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              <path d="M7 8h7m0 0l-2.5-2.5M14 8l-2.5 2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <span className="topbar-menu-label">{t("topbar.logout")}</span>
          </div>
          </div>{/* /topbar-profile-section 2 (logout) */}
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

/* ─── Stat icons ─────────────────────────────────────────────────────────
   12px 线性 icon，跟随父级 color。三个 stat 各一个语义对应的图标。 */

function StackIcon() {
  // artifact icon
  return (
    <svg className="topbar-stat-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M20.6975 2.125C20.4804 2.04417 20.2453 2 20 2H4C2.89543 2 2 2.89543 2 4V20C2 20.2761 2.05596 20.5392 2.15717 20.7785C2.46079 21.4963 3.17157 22 4 22H9.19988L9.20133 22L20 22C21.1046 22 22 21.1046 22 20L22 4C22 3.14077 21.4582 2.40809 20.6975 2.125ZM20 10.0002L20 20H9.9999L10 10L20 10.0002ZM8 20H4V10H8V20ZM10 4H20V8L10 8V4ZM8 4V8H4V4H8Z" fill="currentColor"/>
    </svg>
  );
}

function GlobeIcon() {
  // 地球 —— 表达"已发布 / 公开作品"
  return (
    <svg className="topbar-stat-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.1"/>
      <ellipse cx="6" cy="6" rx="2" ry="4.5" stroke="currentColor" strokeWidth="1.0"/>
      <path d="M1.5 6h9" stroke="currentColor" strokeWidth="1.0" strokeLinecap="round"/>
    </svg>
  );
}

function SparkIcon() {
  // AI spark — token consumption
  return (
    <svg className="topbar-stat-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 5.74805C10.6975 8.42839 8.57106 10.627 5.94434 12C8.5708 13.3728 10.6974 15.571 12 18.251C13.3026 15.571 15.4292 13.3728 18.0557 12C15.4289 10.627 13.3025 8.42839 12 5.74805ZM23.4971 12C23.4971 12.2712 23.2903 12.4955 23.0244 12.5264L22.9004 12.542C22.0266 12.653 21.1824 12.8599 20.3789 13.1533L19.4062 13.5605C16.892 14.7474 14.8593 16.8058 13.6875 19.3525L13.2861 20.3379C12.9986 21.145 12.7948 21.993 12.6846 22.8701L12.6572 22.998C12.5674 23.2869 12.3071 23.4971 12 23.4971L11.8721 23.4844C11.6224 23.4353 11.4198 23.2458 11.3428 22.998L11.3154 22.8701C11.2052 21.993 11.0014 21.145 10.7139 20.3379L10.3125 19.3525C9.14068 16.8058 7.10796 14.7474 4.59375 13.5605L3.62109 13.1533C2.88481 12.8844 2.11439 12.6878 1.31836 12.5713L0.975586 12.5264C0.709649 12.4955 0.50293 12.2712 0.50293 12C0.50293 11.7288 0.709649 11.5045 0.975586 11.4736C1.77894 11.3803 2.55774 11.2053 3.30371 10.957L3.62109 10.8467L4.59375 10.4395C7.10796 9.25256 9.14068 7.19415 10.3125 4.64746L10.7139 3.66211C11.0014 2.85502 11.2052 2.00705 11.3154 1.12988C11.3598 0.777377 11.6492 0.502931 12 0.50293C12.3508 0.50293 12.6402 0.777377 12.6846 1.12988C12.7948 2.00705 12.9986 2.85502 13.2861 3.66211L13.6875 4.64746C14.8593 7.19415 16.892 9.25256 19.4062 10.4395L20.3789 10.8467L20.6963 10.957C21.4423 11.2053 22.2211 11.3803 23.0244 11.4736C23.2903 11.5045 23.4971 11.7288 23.4971 12Z" fill="currentColor"/>
    </svg>
  );
}

function SloganIcon() {
  // tag icon — workspace slogan
  return (
    <svg className="topbar-stat-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M14.2832 9.79136C14.999 10.5072 16.1596 10.5072 16.8755 9.79136C17.5913 9.07551 17.5913 7.91489 16.8755 7.19904C16.1596 6.48319 14.999 6.48319 14.2832 7.19904C13.5673 7.91489 13.5673 9.07551 14.2832 9.79136Z" fill="currentColor"/>
      <path d="M22.0746 4.00001C22.0746 2.89544 21.1792 2.00001 20.0746 2.00001L13.2619 2C12.4663 2 11.7032 2.31607 11.1406 2.87868L2.24691 11.7724C1.46587 12.5535 1.46587 13.8198 2.24692 14.6009L9.47376 21.8277C10.2548 22.6088 11.5211 22.6088 12.3022 21.8277L21.1959 12.934C21.7585 12.3714 22.0746 11.6083 22.0746 10.8126L22.0746 4.00001ZM20.0746 4.00001L20.0746 10.8127C20.0746 11.0779 19.9692 11.3322 19.7817 11.5198L10.8268 20.4747L3.59995 13.2478L12.5548 4.29289C12.7424 4.10536 12.9967 4 13.2619 4L20.0746 4.00001Z" fill="currentColor"/>
    </svg>
  );
}
