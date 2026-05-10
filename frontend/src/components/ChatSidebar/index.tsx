/**
 * ChatSidebar — right-side drawer where users chat with the Table Agent.
 *
 * State model (per plan Phase 4.3.1): each assistant message holds a mutable
 * `content` string that is appended to as text chunks arrive, and a list of
 * interspersed tool calls. Confirmation cards are rendered from the
 * `pendingConfirm` state slot.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./ChatSidebar.css";
import ChatInput from "./ChatInput";
import UserBubble from "./ChatMessage/UserBubble";
import AssistantText from "./ChatMessage/AssistantText";
import ThinkingIndicator from "./ChatMessage/ThinkingIndicator";
import GeneratingMeta from "./ChatMessage/GeneratingMeta";
import ToolCallCard from "./ChatMessage/ToolCallCard";
import SubagentBlock from "./ChatMessage/SubagentBlock";
import WorkflowBlock from "./ChatMessage/WorkflowBlock";
import ToolCallGroup from "./ChatMessage/ToolCallGroup";
import ConfirmCard from "./ChatMessage/ConfirmCard";
import ChatModelPicker from "./ChatModelPicker";
import BlockCloseButton from "../BlockCloseButton";
import AgentNamePill from "./AgentNamePill";
import AgentAvatarMenu from "./AgentAvatarMenu";
import {
  MoreIcon,
  RefreshIcon,
  PlusIcon,
  HistoryIcon,
  TrashIcon,
  MemberIcon,
  NatureIcon,
  ModelsIcon,
  ActivitiesIcon,
  SkillsIcon,
  AcknowledgeIcon,
  HabitsIcon,
  IntegrationsIcon,
} from "./icons";
import { useCanvas } from "../../contexts/canvasContext";
import type { SystemBlockState } from "../../canvas/types";
import DropdownMenu from "../DropdownMenu";
import ConfirmDialog from "../ConfirmDialog";
import { useTranslation } from "../../i18n";
import {
  type ChatConversation,
  type ChatContextSnapshot,
  type ChatMessage,
  type ChatSuggestion,
  type ChatToolCall,
  type PendingConfirm,
  createConversation,
  listConversations,
  deleteConversation as apiDeleteConversation,
  clearConversationMessages,
  getConversationMessages,
  fetchChatContextSnapshot,
  fetchChatSuggestions,
  streamChatMessage,
  sendChatConfirmation,
  stopChatTurn,
  getAgent,
} from "../../api";
import { useAuth } from "../../auth/AuthContext";
import { extractMentionPayloads } from "../Mention/mentionSyntax";
import { useToast } from "../Toast/index";
import { listenChatShared } from "./listenHub";
import { AnimatedCharacters } from "../../auth/AnimatedCharacters";

// Client-side message model (mutable during streaming)
interface UiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  toolCalls: ChatToolCall[];
  // PR3: subagent runs spawned from this message. Each run is rendered as
  // a SubagentBlock in chronological order alongside toolCalls. We track them
  // separately (not nested in toolCalls) because subagent UX needs its own
  // event stream + expand-the-whole-conversation pattern.
  subagentRuns?: UiSubagentRun[];
  // PR4: workflow runs spawned via execute_workflow_template. Each run
  // contains a node-tree progression and may itself reference SubagentRun
  // rows (subagent action nodes).
  workflowRuns?: UiWorkflowRun[];
  streaming?: boolean;
  error?: { code: string; message: string };
  // V3.0 multi-conv branch 标记 —— UI 用它来折叠"被 synth 取代"的 main
  // 气泡。null / "main" / undefined = 老主线;"appended" = 用户追加的 user;
  // "synthesis" = 多分支合成后的最终回复(出现后前面的 main 折叠)。
  branchTag?: "main" | "appended" | "synthesis" | null;
  parentMessageId?: string | null;
  // V3.0 UX: per-turn meta strip data. Set on the streaming assistant
  // message at handleSend time; updated during the turn from `turn_usage`
  // events; frozen on `done` payload so the strip flips from
  // "Generating · Xs · Y tokens" → "Generated · Xs · Y tokens".
  turnMeta?: {
    startedAt: number;
    /** Tokens shown next to the timer. We use `completionTokens` (本轮模型
     *  实际产出的 output 字数),不用 totalTokens —— totalTokens = prompt +
     *  completion,prompt 在多轮 tool_call 时被反复计入(每个 provider round
     *  的 prompt 都包含上一轮的 history),视觉上看起来"跨轮累加",其实是同
     *  一段 history 被多次计费。completionTokens 没有重复计数,纯粹是"本次
     *  generation 输出了多少 token",和 timer 一样是"这次对话轮次内的纯增
     *  量"。 */
    completionTokens: number;
    /** Server-reported final duration in ms. Only set after done. */
    durationMs?: number;
    /** Lifecycle marker: "generating" while in-flight, "generated" after done. */
    phase: "generating" | "generated";
  };
}

export interface UiWorkflowRun {
  runId: string;
  templateId?: string;
  status: "running" | "success" | "error" | "aborted";
  durationMs?: number;
  /** Linear log of node events for the timeline panel. */
  nodeEvents: Array<
    | { kind: "node_start"; nodeId: string; nodeKind: string; nodeType?: string; ts: number }
    | { kind: "node_end"; nodeId: string; output?: any; ts: number }
    | { kind: "loop_iter"; loopNodeId: string; iter: number; maxIter: number; ts: number }
    | { kind: "branch_start"; parentNodeId: string; branchIdx: number; totalBranches: number; ts: number }
  >;
  startedAt: number;
  error?: string;
}

export interface UiSubagentRun {
  runId: string;
  requestedModel: string;
  resolvedModel: string;
  usedFallback: boolean;
  userPrompt: string;
  systemPrompt: string;
  thinking: string;
  finalText: string;
  toolCalls: ChatToolCall[];
  status: "running" | "success" | "error";
  durationMs?: number;
  error?: string;
  startedAt: number;
  /** V2.8 C7: 由 workflow 节点派出的 subagent 携带此字段;WorkflowBlock 节点
   *  点击会查找匹配的 SubagentBlock 并滚动定位。 */
  workflowNodeId?: string | null;
}

// ─── LocalStorage cache ──────────────────────────────────────────────
// Why: every refresh used to flash the welcome page for a beat while the
// /conversations + /messages GETs resolved. We now hydrate state from
// cache synchronously, render instantly, and revalidate in the background.
const CACHE_KEY_PREFIX = "chat_cache_v1:";
const CACHE_MAX_MESSAGES = 100; // cap per-document to avoid localStorage bloat

interface CachedState {
  activeConvId: string;
  messages: UiMessage[];
  contextHint: ChatContextSnapshot | null;
}

function readCache(workspaceId: string): CachedState | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY_PREFIX + workspaceId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedState;
    if (!parsed.activeConvId || !Array.isArray(parsed.messages)) return null;
    // Drop any streaming flag left over from an interrupted session so the
    // UI doesn't show a hanging spinner after a reload. Also flip any
    // toolCall that was still `running` at snapshot time to `error` — the
    // actual invocation ended (stream closed) but we never received its
    // tool_result, so marking it as a failure is the honest reconstruction.
    // Without this, a refresh/tab-switch during a confirm pause (or any
    // interrupted turn) leaves a perpetual spinner on the card.
    parsed.messages = parsed.messages.map((m) => ({
      ...m,
      streaming: false,
      toolCalls: (m.toolCalls || []).map((tc) =>
        tc.status === "running" ? { ...tc, status: "error" as const } : tc
      ),
      // Schema migration:cache 里旧版 turnMeta 用 totalTokens,新版用
      // completionTokens。读到旧 shape 时 completionTokens = undefined,
      // GeneratingMeta 里 .toLocaleString() 会炸。这里把旧字段映射过来,
      // 同时兜底成 0,保证组件 props 类型契约。
      turnMeta: m.turnMeta
        ? {
            ...m.turnMeta,
            completionTokens:
              (m.turnMeta as any).completionTokens
              ?? (m.turnMeta as any).totalTokens
              ?? 0,
          }
        : undefined,
    }));
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(workspaceId: string, state: CachedState) {
  try {
    const trimmed: CachedState = {
      ...state,
      messages: state.messages.slice(-CACHE_MAX_MESSAGES),
    };
    localStorage.setItem(CACHE_KEY_PREFIX + workspaceId, JSON.stringify(trimmed));
  } catch {
    // Quota / disabled storage — silently skip
  }
}

function clearCache(workspaceId: string) {
  try {
    localStorage.removeItem(CACHE_KEY_PREFIX + workspaceId);
  } catch {
    // ignore
  }
}

interface Props {
  open: boolean;
  workspaceId: string;
  /**
   * Active Agent id (identity owner). Defaults to `agent_default` — the
   * seeded agent created on first boot. The Agent is intentionally
   * workspace-agnostic: a user has one long-lived Agent that spans every
   * workspace and owns the persistent soul.md / profile.md / memory.
   */
  agentId?: string;
  onClose: () => void;
  /**
   * Virtual pointer — when the Agent invokes a tool that targets a specific
   * table, surface that tableId so the parent (App.tsx) can switch the
   * artifacts panel to match. Fires on both tool_start (eager: follow the
   * AI as it works) and tool_result for create_table (since the tableId
   * only exists in the response, not the args). No-op if the extracted id
   * is already active — App.tsx's switchTable() guards against re-fetch.
   */
  onActiveTableChange?: (tableId: string) => void;

  /**
   * Fired when a tool call has just produced a NEW demo (Path A / Path C
   * conversion, plain create_demo). Parent uses this to defensively
   * refresh the sidebar's demo list — covers the case where the SSE
   * `demo:create` broadcast was missed (event loop blocked / nginx
   * hiccup / SSE reconnect during the agent turn). Idempotent on the
   * parent side: if the demo already exists in the list, no-op.
   */
  onDemoCreated?: (demoId: string) => void;

  /**
   * V3.0 PR1: per-block conversation override.
   * 当父级(App.tsx 通过 ChatBlockState)指定要打开哪个 conversation 时传入;
   * 不传则 ChatSidebar 自己挑(沿用 V2 行为:cache 或 first 或新建)。
   * 父级在用户切换 / 新建 / 删除会话后通过 onConversationChange 同步回 BlockState。
   */
  conversationId?: string | null;
  onConversationChange?: (convId: string | null) => void;
  /** Pre-fill the input box with this text (not auto-sent). Consumed once on mount. */
  prefillMessage?: string;
  onPrefillConsumed?: () => void;
}

/**
 * Derive the tableId a given tool call is targeting, if any. Used by the
 * virtual-pointer effect to auto-switch the artifacts panel. Returns
 * undefined for tools that don't touch a specific table (list_tables,
 * unrelated tools, etc.).
 */
function extractTableIdFromCall(
  tool: string,
  args: Record<string, unknown>,
  result?: unknown
): string | undefined {
  // Most mutating tools accept tableId directly in args.
  if (typeof args?.tableId === "string" && args.tableId) return args.tableId;
  // create_table: the id is only present in the response payload.
  if (tool === "create_table" && result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (typeof r.id === "string" && r.id) return r.id;
    if (typeof r.tableId === "string" && r.tableId) return r.tableId;
  }
  return undefined;
}

/**
 * Demo-creating tools all return { demoId } in their result. We surface
 * this to the parent so it can refresh the demo sidebar list — defensive
 * fallback for the case where the SSE `demo:create` event was missed
 * (e.g. the express loop was busy when the broadcast fired, or nginx
 * hiccupped during the agent turn). Without this hook a freshly-created
 * Path A / Path C demo wouldn't appear until the user refreshed.
 *
 * Tool names enumerated rather than substring-matched so we don't react
 * to unrelated tools that happen to mention "demo" in their result.
 */
const DEMO_CREATE_TOOLS = new Set([
  "create_demo_from_taste",
  "convert_taste_to_demo_faithful",
  "create_demo",
]);

function extractCreatedDemoId(tool: string, result?: unknown): string | undefined {
  if (!DEMO_CREATE_TOOLS.has(tool)) return undefined;
  if (!result || typeof result !== "object") return undefined;
  // Tool result wrapper from dataStoreClient.toolResult is either
  // `{ data: {...inner} }` or just the inner object directly. Accept both.
  const r = result as Record<string, unknown>;
  const inner = (r.data && typeof r.data === "object" ? r.data : r) as Record<string, unknown>;
  if (typeof inner.demoId === "string" && inner.demoId) return inner.demoId;
  return undefined;
}

export default function ChatSidebar({
  open,
  workspaceId,
  agentId = "agent_default",
  onClose,
  onActiveTableChange,
  onDemoCreated,
  conversationId: propConversationId,
  onConversationChange,
  prefillMessage,
  onPrefillConsumed,
}: Props) {
  const { t } = useTranslation();
  const { addBlock } = useCanvas();
  // Hydrate from localStorage synchronously so a refresh shows cached
  // messages immediately — no welcome-page flash while /conversations loads.
  const initialCache = useRef<CachedState | null>(readCache(workspaceId)).current;
  // V3.0 PR1: 优先级 propConversationId > cache > null
  const [activeConv, setActiveConv] = useState<ChatConversation | null>(() => {
    if (propConversationId) return { id: propConversationId } as ChatConversation;
    if (initialCache) return { id: initialCache.activeConvId } as ChatConversation;
    return null;
  });

  // V3.0 PR1: 父级切换 conversationId 时同步 activeConv (e.g. App.tsx 从 BlockState
  // 读到不同的 convId 后传下来)。前提:propConversationId 与当前 activeConv.id 不同
  // 才更新,避免无限循环。
  useEffect(() => {
    if (propConversationId !== undefined && propConversationId !== null) {
      if (activeConv?.id !== propConversationId) {
        setActiveConv({ id: propConversationId } as ChatConversation);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propConversationId]);

  // V3.0 PR1: activeConv 内部变化时回调父级(用户在本 block 切了 conv,父级要更新 BlockState)
  useEffect(() => {
    if (activeConv?.id && onConversationChange) {
      // 只有与父级 prop 不一致时才回调,避免无限循环
      if (activeConv.id !== propConversationId) {
        onConversationChange(activeConv.id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConv?.id]);
  const [messages, setMessages] = useState<UiMessage[]>(initialCache?.messages ?? []);
  const [inputValue, setInputValue] = useState("");
  // Attachments for current message
  const [attachments, setAttachments] = useState<Array<{ id: string; url: string; mime: string; size: number; originalName: string }>>([]);
  // Prefill input from parent (e.g. "Add by chat" flow).
  // We do NOT call onPrefillConsumed here — it's called in handleSend instead,
  // so that if this component remounts (layout tree restructure from closing a
  // sibling block), the prefillMessage is still in blockState and gets re-applied.
  const prefillAppliedRef = useRef(false);
  useEffect(() => {
    if (prefillMessage && !prefillAppliedRef.current) {
      setInputValue(prefillMessage);
      prefillAppliedRef.current = true;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillMessage]);

  // Handle file drop/paste → resize images → upload → add to attachments
  const handleFileDrop = useCallback(async (files: File[]) => {
    for (const file of files) {
      try {
        // Vision: resize images to 1568px max before upload (saves tokens)
        let fileToUpload = file;
        if (file.type.startsWith("image/")) {
          const { resizeImageIfNeeded } = await import("../../services/imageResize");
          fileToUpload = await resizeImageIfNeeded(file);
        }
        const { uploadChatAttachment } = await import("../../api");
        const att = await uploadChatAttachment(fileToUpload);
        setAttachments((prev) => [...prev, att]);
      } catch (err) {
        console.warn("[chat] file upload failed:", err);
      }
    }
  }, []);

  const sidebarRef = useRef<HTMLElement>(null);
  const [sidebarDragging, setSidebarDragging] = useState(false);
  const [streaming, setStreaming] = useState(false);
  // Live ref to `streaming` so effects that run on prop-id changes (the
  // [open, workspaceId] revalidation) can check the CURRENT value without
  // being re-keyed into their deps. Used to guard against wiping the
  // in-flight assistant message on sidebar re-open mid-turn — see the
  // useEffect at line 236 below.
  const streamingRef = useRef(streaming);
  useEffect(() => { streamingRef.current = streaming; }, [streaming]);

  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Thin document summary shown on the welcome page after a refresh, so the
  // user knows what the Agent will see before their first prompt. Kept
  // separate from the full Document Snapshot, which is rebuilt inside the
  // backend agent service on every message.
  const [contextHint, setContextHint] = useState<ChatContextSnapshot | null>(
    initialCache?.contextHint ?? null
  );
  // AI-generated prompt suggestions for the welcome page. Backend refreshes
  // every ~10 minutes via a scheduled task; we fetch once on open and after
  // handleNewConversation to keep it fresh.
  const [suggestions, setSuggestions] = useState<ChatSuggestion[]>([]);

  // Header overflow menu (... button) + its refresh-confirmation dialog.
  // The refresh action is two-step: open menu → pick "刷新会话" → confirm.
  const [menuOpen, setMenuOpen] = useState(false);
  const [refreshConfirmOpen, setRefreshConfirmOpen] = useState(false);
  const moreBtnRef = useRef<HTMLButtonElement>(null);

  // Agent meta dropdown (member icon button, left of conv-list / history)
  // —— 7 placeholder items: nature / models / activities / skills /
  // acknowledge / habits / integrations. Behaviour TBD; for now noop.
  const [agentMetaMenuOpen, setAgentMetaMenuOpen] = useState(false);
  const agentMetaBtnRef = useRef<HTMLButtonElement>(null);

  // V3.0 PR1 多对话 UI 状态
  const [convListOpen, setConvListOpen] = useState(false);
  const [convList, setConvList] = useState<ChatConversation[]>([]);
  const [convListLoading, setConvListLoading] = useState(false);
  const convListBtnRef = useRef<HTMLButtonElement>(null);
  const toast = useToast();

  // Bumped after each streamed turn finishes, so AgentNamePill can re-fetch
  // and pick up any rename performed by the `update_agent_name` tool call.
  const [agentRefreshToken, setAgentRefreshToken] = useState(0);

  // NOTE: Agent identity (soul.md / profile.md) is intentionally NOT exposed
  // as an interactive UI surface in Phase 1. Users can only inspect or modify
  // it through natural-language conversation with the Agent — the Agent reads
  // its own identity via Layer 2 prompt injection and self-edits via the
  // Tier 0 meta-tools (`update_profile`, `update_soul`, `create_memory`).
  // The backend REST endpoints stay available for those meta-tools; this
  // sidebar just doesn't render a modal for them.

  const cancelRef = useRef<(() => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Sticky-to-bottom auto-scroll. Stays `true` while the user is parked at
  // the bottom; once they scroll up (even a few px), we stop yanking them
  // back down as streaming chunks arrive. Re-enabled when they scroll back
  // to the bottom (within SCROLL_STICKY_THRESHOLD) or send a new message.
  const stickToBottomRef = useRef(true);

  // 历史分页：初次只拉 30 条。用户向上滚到接近顶时再以最早消息 id 作为
  // before 锚点拉下一页 30 条。hasMoreHistory=false 时停止 fetch。
  const [hasMoreHistory, setHasMoreHistory] = useState<boolean>(false);
  const [loadingOlder, setLoadingOlder] = useState<boolean>(false);
  const loadingOlderRef = useRef(false);

  // Fetch welcome-page suggestions when opened or document changes. We
  // intentionally fetch even when cached messages exist — suggestions are
  // only shown on the empty state so there's no flicker cost, and we want
  // them warm for the next "新对话" click. */
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchChatSuggestions(workspaceId)
      .then((r) => {
        if (!cancelled) setSuggestions(r.suggestions);
      })
      .catch(() => {
        // Fall back to hard-coded i18n presets on failure
      });
    return () => {
      cancelled = true;
    };
  }, [open, workspaceId]);

  // ─── Ensure a conversation exists when the sidebar opens ───────────────
  // With the cache primer we may already have an activeConv stub — but the
  // server record still needs to be fetched/refreshed so the agent loop has
  // the real `conversation` row. We revalidate quietly in the background.
  useEffect(() => {
    if (!open) return;
    // If cache seeded an activeConv id, revalidate it against the server.
    // Otherwise fall back to list-then-create flow.
    (async () => {
      try {
        if (activeConv?.id) {
          try {
            // 初次只拉最新 30 条; 用户向上滚到顶时再分页加载更老消息(loadOlderMessages).
            const { conversation, messages: serverMsgs, hasMore } = await getConversationMessages(activeConv.id, { limit: 20 });
            setActiveConv(conversation);
            setHasMoreHistory(hasMore);
            if (!streamingRef.current) {
              // V2.1 A5: 若本地 message 含 streaming 中累计的 subagentRuns /
              // workflowRuns 而 server 还没 join 上(刚结束 turn 的极短窗口),
              // 优先保留本地数据。否则用 server 版本(canonical)。
              setMessages((prev) => mergeServerWithLocal(serverMsgs.map(serverToUi), prev));
            }
            return;
          } catch {
            clearCache(workspaceId);
          }
        }
        const list = await listConversations(workspaceId);
        if (list.length > 0) {
          const conv = list[0];
          const { messages: msgs, hasMore } = await getConversationMessages(conv.id, { limit: 20 });
          setActiveConv(conv);
          setHasMoreHistory(hasMore);
          if (!streamingRef.current) {
            setMessages((prev) => mergeServerWithLocal(msgs.map(serverToUi), prev));
          }
        } else {
          const conv = await createConversation(workspaceId, agentId);
          setActiveConv(conv);
          setMessages([]);
          setHasMoreHistory(false);
        }
      } catch (err) {
        setError((err as Error).message);
      }
    })();
    // Only on open / workspaceId switch. Intentionally not depending on
    // activeConv — we read it once from the primer ref above, and subsequent
    // conversation changes come from handleNewConversation directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workspaceId]);

  // V3.0.2 #3:切换对话时主动拉历史
  // 老逻辑只在 [open, workspaceId] 上跑初始化,activeConv.id 通过 list popover /
  // delete 后建新等内部路径变化时,messages 不会重新拉 → 一直显示空白 / 老内容,
  // 只有 F5 刷新才能加载。
  // 修法:加一个 effect 监听 activeConv?.id,若与 lastFetchedConvIdRef 不同就拉。
  // 初始化路径(line 345)拉完后也要更新 ref,避免重复拉。
  const lastFetchedConvIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const convId = activeConv?.id;
    if (!convId) return;
    if (convId === lastFetchedConvIdRef.current) return;  // 已拉过
    if (streamingRef.current) return;  // streaming 中不打断
    lastFetchedConvIdRef.current = convId;
    (async () => {
      try {
        const { conversation, messages: serverMsgs, hasMore } = await getConversationMessages(convId, { limit: 20 });
        setActiveConv(conversation);
        setHasMoreHistory(hasMore);
        setMessages(serverMsgs.map(serverToUi));
        setPendingConfirm(null);
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, [open, activeConv?.id]);

  // ─── Persist active conversation + messages to cache ─────────────────
  // Write on every settled state change. Streaming intermediate states are
  // included (cheap JSON.stringify; capped at 100 messages by writeCache).
  useEffect(() => {
    if (!activeConv?.id) return;
    writeCache(workspaceId, {
      activeConvId: activeConv.id,
      messages,
      contextHint,
    });
  }, [workspaceId, activeConv?.id, messages, contextHint]);

  // Auto-scroll to bottom on new content — but only if the user hasn't
  // manually scrolled up. During streaming (thinking/message/tool_call
  // chunks arriving every frame), yanking the viewport back to the bottom
  // mid-read is hostile. We defer to the user's scroll position instead.
  useEffect(() => {
    if (!scrollRef.current) return;
    if (!stickToBottomRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, pendingConfirm]);

  // 向上滚动加载更老消息. 防抖 + 防并发（loadingOlderRef 守卫）。加载后保持
  // 用户视觉位置:记录加载前的 scrollHeight,加载后偏移 scrollTop 使顶部锚点
  // 不跳。
  const loadOlderMessages = useCallback(async () => {
    if (loadingOlderRef.current) return;
    if (!hasMoreHistory) return;
    if (!activeConv?.id) return;
    if (messages.length === 0) return;
    const oldest = messages[0];
    if (!oldest?.id) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    const el = scrollRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    try {
      const { messages: older, hasMore } = await getConversationMessages(activeConv.id, {
        limit: 20,
        before: oldest.id,
      });
      if (older.length > 0) {
        setMessages((prev) => [...older.map(serverToUi), ...prev]);
        // 异步等下一帧 layout 完成,再用 scrollHeight 差值偏移 scrollTop —— 用户
        // 视觉位置不变,新内容在他上方静默追加。
        requestAnimationFrame(() => {
          const el2 = scrollRef.current;
          if (el2) el2.scrollTop = el2.scrollHeight - prevHeight;
        });
      }
      setHasMoreHistory(hasMore);
    } catch { /* swallow */ }
    finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [activeConv?.id, messages, hasMoreHistory]);

  // Scroll listener → toggle stickToBottomRef based on proximity to bottom.
  // Threshold is a few px so small rendering jitter still counts as "at
  // bottom" and re-enables auto-scroll once the user returns there.
  // 同时检测"接近顶部"触发分页 fetch.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const SCROLL_STICKY_THRESHOLD = 24;
    const SCROLL_TOP_LOAD_TRIGGER = 80; // 距离顶部 80px 时预拉下一页
    const onScroll = () => {
      const distanceFromBottom = el.scrollHeight - el.clientHeight - el.scrollTop;
      stickToBottomRef.current = distanceFromBottom <= SCROLL_STICKY_THRESHOLD;
      if (el.scrollTop <= SCROLL_TOP_LOAD_TRIGGER) {
        void loadOlderMessages();
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [loadOlderMessages]);

  // ─── Streaming callbacks ──────────────────────────────────────────────
  const appendAssistantChunk = useCallback((msgId: string, chunk: string) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === msgId ? { ...m, content: m.content + chunk } : m))
    );
  }, []);

  const appendThinkingChunk = useCallback((msgId: string, chunk: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === msgId ? { ...m, thinking: (m.thinking || "") + chunk } : m
      )
    );
  }, []);

  const addToolCall = useCallback((msgId: string, call: ChatToolCall) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === msgId ? { ...m, toolCalls: [...m.toolCalls, call] } : m
      )
    );
  }, []);

  const updateToolCall = useCallback(
    (msgId: string, callId: string, patch: Partial<ChatToolCall>) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msgId
            ? {
                ...m,
                toolCalls: m.toolCalls.map((tc) =>
                  tc.callId === callId ? { ...tc, ...patch } : tc
                ),
              }
            : m
        )
      );
    },
    []
  );

  const finalizeMessage = useCallback((msgId: string) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === msgId ? { ...m, streaming: false } : m))
    );
  }, []);

  // ─── Send / confirm / stop ──────────────────────────────────────────
  // V3.0 PR4 FE 补完:handleSend 现在区分两种路径:
  //   - 首次提交(`!streaming`):走老逻辑,起新 user + streaming-assistant
  //     气泡,fetch SSE 流读取所有 main turn 事件,完成后 freeze 成 done
  //   - 追加提交(`streaming`):**只**追 user 气泡 + POST 后端,后端 ack
  //     `branch_started` 立刻关流。branch 内部事件全部走 pubsub listener,
  //     最终的合成回复(synthesis)由 listener 收到 synth 事件后通过
  //     triggerReload 拉 DB 渲染。**不创建第二个 streaming-assistant 占位**
  //     —— 否则 UI 会出两个空气泡,且和 fetch SSE 的 main 流抢 setMessages
  //     状态。
  // streaming flag 反映"当前 block 是否有正在跑的 fetch SSE 流",由 main
  // 路径独占。append 路径触发的二次 fetch 是短连接(只读到 branch_started
  // 后立刻 close),不动 streaming flag。
  const handleSend = useCallback(() => {
    if (!activeConv) return;
    const text = inputValue.trim();
    if (!text) return;  // V3.0:streaming 时也允许发(走 append 路径)

    // ── append 路径:正在 streaming + 用户继续输入 ──
    if (streaming) {
      handleAppendSend(activeConv.id, text);
      return;
    }

    // ── main 路径:idle 状态起新 turn(老行为) ──
    const userMsgId = `u_${Date.now()}`;
    const assistantMsgId = `a_${Date.now()}_pending`;

    // User just submitted a new turn — snap to the bottom and re-enable
    // sticky auto-scroll so they see their own message and the streamed
    // reply in sequence even if they'd scrolled up in a previous turn.
    stickToBottomRef.current = true;

    // V3.0 UX: 给新 streaming assistant 气泡挂上 turnMeta — GeneratingMeta
    // 组件读这个对象渲染 "Generating · 0s · 0 tokens" placeholder,turn_usage
    // 事件会更新 totalTokens,done 事件会切到 phase="generated"。
    const turnStartedAt = Date.now();
    // Build user message content: attachments as image/file markdown above text
    const attachmentLines = attachments.map((a) =>
      a.mime.startsWith("image/")
        ? `![${a.originalName}](${a.url})`
        : `[${a.originalName}](${a.url})`
    );
    const fullContent = [...attachmentLines, text].join("\n");

    setMessages((prev) => [
      ...prev,
      { id: userMsgId, role: "user", content: fullContent, toolCalls: [] },
      {
        id: assistantMsgId,
        role: "assistant",
        content: "",
        toolCalls: [],
        streaming: true,
        turnMeta: {
          startedAt: turnStartedAt,
          completionTokens: 0,
          phase: "generating",
        },
      },
    ]);
    setInputValue("");
    setAttachments([]);
    setStreaming(true);
    setError(null);
    // Clear prefillMessage from blockState now that it's been sent,
    // so it doesn't re-appear on future remounts.
    onPrefillConsumed?.();

    // PR2: extract structured mention payload (model / table / idea / ...)
    // from the raw markdown so the host agent can apply strong-typed routing.
    const mentions = extractMentionPayloads(text);

    // PR4: small helper for workflow node-event accumulation
    const appendWorkflowNodeEvent = (runId: string, evt: UiWorkflowRun["nodeEvents"][number]) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.role === "assistant" && m.workflowRuns?.some((r) => r.runId === runId)
            ? {
                ...m,
                workflowRuns: m.workflowRuns!.map((r) =>
                  r.runId === runId ? { ...r, nodeEvents: [...r.nodeEvents, evt] } : r,
                ),
              }
            : m,
        ),
      );
    };

    // Vision: build structured image attachments for the backend
    const imageAttachments = attachments
      .filter((a) => a.mime.startsWith("image/"))
      .map((a) => ({
        kind: "image" as const,
        url: a.url,
        mime: a.mime,
        fileId: a.id,
      }));

    cancelRef.current = streamChatMessage({
      conversationId: activeConv.id,
      message: fullContent,
      mentions,
      attachments: imageAttachments.length > 0 ? imageAttachments : undefined,
      onStart: (serverId) => {
        // V3.0 (queue model): a `start` event can mean two things:
        //  1) First turn — replace the local `assistantMsgId` placeholder with
        //     the server-assigned id.
        //  2) Queued turn — the current turn finished (`done` already arrived,
        //     placeholder frozen), a NEW assistant turn begins on the same SSE.
        //     Insert a fresh streaming asst bubble RIGHT AFTER its user query
        //     (the first user without an asst between it and the next user)
        //     so visual order stays Q1→A1→Q2→A2→Q3→A3, not Q1→A1→Q2→Q3→A2→A3.
        setMessages((prev) => {
          const localPlaceholderIdx = prev.findIndex((m) => m.id === assistantMsgId);
          if (localPlaceholderIdx >= 0) {
            return prev.map((m, idx) => (idx === localPlaceholderIdx ? { ...m, id: serverId } : m));
          }
          // Find the first orphan user (no asst between it and the next user).
          let insertAfterIdx = -1;
          for (let i = 0; i < prev.length; i++) {
            if (prev[i].role !== "user") continue;
            let hasAsstBeforeNextUser = false;
            for (let j = i + 1; j < prev.length; j++) {
              if (prev[j].role === "user") break;
              if (prev[j].role === "assistant") { hasAsstBeforeNextUser = true; break; }
            }
            if (!hasAsstBeforeNextUser) { insertAfterIdx = i; break; }
          }
          const newAsst: UiMessage = {
            id: serverId,
            role: "assistant",
            content: "",
            toolCalls: [],
            streaming: true,
            turnMeta: {
              startedAt: Date.now(),
              completionTokens: 0,
              phase: "generating",
            },
          };
          if (insertAfterIdx >= 0) {
            return [...prev.slice(0, insertAfterIdx + 1), newAsst, ...prev.slice(insertAfterIdx + 1)];
          }
          // Fallback (no orphan): append at end.
          return [...prev, newAsst];
        });
      },
      onMessage: (delta) => {
        setMessages((prev) => {
          // find the last assistant message and append
          for (let i = prev.length - 1; i >= 0; i--) {
            if (prev[i].role === "assistant" && prev[i].streaming) {
              return prev.map((m, idx) => (idx === i ? { ...m, content: m.content + delta } : m));
            }
          }
          return prev;
        });
      },
      onThinking: (delta) => {
        setMessages((prev) => {
          for (let i = prev.length - 1; i >= 0; i--) {
            if (prev[i].role === "assistant" && prev[i].streaming) {
              return prev.map((m, idx) =>
                idx === i ? { ...m, thinking: (m.thinking || "") + delta } : m
              );
            }
          }
          return prev;
        });
      },
      onToolStart: (call) => {
        // Virtual pointer: the moment the Agent starts acting on a table,
        // surface its id so the artifacts panel can follow along.
        const tid = extractTableIdFromCall(call.tool, call.args);
        if (tid) onActiveTableChange?.(tid);
        setMessages((prev) => {
          // Prefer the last assistant message that's still marked streaming
          // (normal case). Fallback: the last assistant message regardless
          // of streaming flag — defense in depth against any path that
          // accidentally flips streaming to false mid-turn (e.g. server
          // revalidation race). Without the fallback, late tool_start
          // events simply vanish and the FE silently loses cards.
          let streamingIdx = -1;
          let anyAssistantIdx = -1;
          for (let i = prev.length - 1; i >= 0; i--) {
            if (prev[i].role === "assistant") {
              if (anyAssistantIdx < 0) anyAssistantIdx = i;
              if (prev[i].streaming) { streamingIdx = i; break; }
            }
          }
          const targetIdx = streamingIdx >= 0 ? streamingIdx : anyAssistantIdx;
          if (targetIdx < 0) return prev;
          return prev.map((m, idx) =>
            idx === targetIdx ? { ...m, toolCalls: [...m.toolCalls, call] } : m
          );
        });
      },
      onToolProgress: (ev) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.role === "assistant"
              ? {
                  ...m,
                  toolCalls: m.toolCalls.map((tc) =>
                    tc.callId === ev.callId
                      ? {
                          ...tc,
                          progress: {
                            phase: ev.phase,
                            message: ev.message,
                            progress: ev.progress,
                            current: ev.current,
                            total: ev.total,
                            elapsedMs: ev.elapsedMs,
                          },
                          heartbeat: undefined,
                        }
                      : tc,
                  ),
                }
              : m,
          ),
        );
      },
      onToolHeartbeat: (ev) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.role === "assistant"
              ? {
                  ...m,
                  toolCalls: m.toolCalls.map((tc) =>
                    tc.callId === ev.callId
                      ? { ...tc, heartbeat: { elapsedMs: ev.elapsedMs } }
                      : tc,
                  ),
                }
              : m,
          ),
        );
      },
      onToolResult: (callId, success, result) => {
        setMessages((prev) => {
          let pointerTid: string | undefined;
          let createdDemoId: string | undefined;
          const next = prev.map((m) =>
            m.role === "assistant"
              ? {
                  ...m,
                  toolCalls: m.toolCalls.map((tc) => {
                    if (tc.callId !== callId) return tc;
                    // Virtual pointer fallback: tools like create_table carry
                    // the target tableId only in the result, not the args.
                    if (!pointerTid) {
                      pointerTid = extractTableIdFromCall(tc.tool, tc.args, result);
                    }
                    if (!createdDemoId && success) {
                      createdDemoId = extractCreatedDemoId(tc.tool, result);
                    }
                    return {
                      ...tc,
                      status: (success ? "success" : "error") as ChatToolCall["status"],
                      result,
                      progress: undefined,
                      heartbeat: undefined,
                    };
                  }),
                }
              : m
          );
          if (pointerTid) onActiveTableChange?.(pointerTid);
          if (createdDemoId) onDemoCreated?.(createdDemoId);
          return next;
        });
      },
      onConfirm: (pending) => {
        setPendingConfirm(pending);
      },
      // ── PR3 Subagent event handlers ──
      // Each subagent run is a separate UI block under the assistant message
      // that spawned it. We append/update by runId; events arrive interleaved
      // with the host's own toolCalls but never collide because runId is
      // unique (DB-generated cuid).
      onSubagentStart: (ev) => {
        setMessages((prev) => {
          for (let i = prev.length - 1; i >= 0; i--) {
            if (prev[i].role === "assistant" && prev[i].streaming) {
              const newRun: UiSubagentRun = {
                runId: ev.runId,
                requestedModel: ev.requestedModel,
                resolvedModel: ev.resolvedModel,
                usedFallback: ev.usedFallback,
                userPrompt: ev.userPrompt,
                systemPrompt: ev.systemPrompt,
                thinking: "",
                finalText: "",
                toolCalls: [],
                status: "running",
                startedAt: Date.now(),
                workflowNodeId: (ev as any).workflowNodeId ?? null,
              };
              return prev.map((m, idx) =>
                idx === i ? { ...m, subagentRuns: [...(m.subagentRuns ?? []), newRun] } : m,
              );
            }
          }
          return prev;
        });
      },
      onSubagentThinking: (runId, text) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.role === "assistant" && m.subagentRuns?.some((r) => r.runId === runId)
              ? {
                  ...m,
                  subagentRuns: m.subagentRuns!.map((r) =>
                    r.runId === runId ? { ...r, thinking: r.thinking + text } : r,
                  ),
                }
              : m,
          ),
        );
      },
      onSubagentMessage: (runId, text) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.role === "assistant" && m.subagentRuns?.some((r) => r.runId === runId)
              ? {
                  ...m,
                  subagentRuns: m.subagentRuns!.map((r) =>
                    r.runId === runId ? { ...r, finalText: r.finalText + text } : r,
                  ),
                }
              : m,
          ),
        );
      },
      onSubagentToolStart: (runId, call) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.role === "assistant" && m.subagentRuns?.some((r) => r.runId === runId)
              ? {
                  ...m,
                  subagentRuns: m.subagentRuns!.map((r) =>
                    r.runId === runId ? { ...r, toolCalls: [...r.toolCalls, call] } : r,
                  ),
                }
              : m,
          ),
        );
      },
      onSubagentToolResult: (runId, callId, success, result) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.role === "assistant" && m.subagentRuns?.some((r) => r.runId === runId)
              ? {
                  ...m,
                  subagentRuns: m.subagentRuns!.map((r) =>
                    r.runId === runId
                      ? {
                          ...r,
                          toolCalls: r.toolCalls.map((tc) =>
                            tc.callId === callId
                              ? { ...tc, status: success ? "success" : "error", result }
                              : tc,
                          ),
                        }
                      : r,
                  ),
                }
              : m,
          ),
        );
      },
      onSubagentDone: (ev) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.role === "assistant" && m.subagentRuns?.some((r) => r.runId === ev.runId)
              ? {
                  ...m,
                  subagentRuns: m.subagentRuns!.map((r) =>
                    r.runId === ev.runId
                      ? {
                          ...r,
                          status: ev.success ? "success" : "error",
                          durationMs: ev.durationMs,
                          // Replace finalText with authoritative final from server
                          // (handles cases where streaming chunks were dropped)
                          finalText: ev.finalText || r.finalText,
                        }
                      : r,
                  ),
                }
              : m,
          ),
        );
      },
      onSubagentError: (runId, error) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.role === "assistant" && m.subagentRuns?.some((r) => r.runId === runId)
              ? {
                  ...m,
                  subagentRuns: m.subagentRuns!.map((r) =>
                    r.runId === runId ? { ...r, status: "error", error } : r,
                  ),
                }
              : m,
          ),
        );
      },
      // ── PR4 Workflow event handlers ──
      onWorkflowStart: (ev) => {
        setMessages((prev) => {
          for (let i = prev.length - 1; i >= 0; i--) {
            if (prev[i].role === "assistant" && prev[i].streaming) {
              const newRun: UiWorkflowRun = {
                runId: ev.runId,
                templateId: ev.templateId,
                status: "running",
                nodeEvents: [],
                startedAt: Date.now(),
              };
              return prev.map((m, idx) =>
                idx === i ? { ...m, workflowRuns: [...(m.workflowRuns ?? []), newRun] } : m,
              );
            }
          }
          return prev;
        });
      },
      onWorkflowNodeStart: (ev) => {
        appendWorkflowNodeEvent(ev.runId, {
          kind: "node_start",
          nodeId: ev.nodeId,
          nodeKind: ev.nodeKind,
          nodeType: ev.nodeType,
          ts: Date.now(),
        });
      },
      onWorkflowNodeEnd: (runId, nodeId, output) => {
        appendWorkflowNodeEvent(runId, { kind: "node_end", nodeId, output, ts: Date.now() });
      },
      onWorkflowLoopIteration: (runId, loopNodeId, iter, maxIter) => {
        appendWorkflowNodeEvent(runId, { kind: "loop_iter", loopNodeId, iter, maxIter, ts: Date.now() });
      },
      onWorkflowBranchStart: (runId, parentNodeId, branchIdx, totalBranches) => {
        appendWorkflowNodeEvent(runId, {
          kind: "branch_start",
          parentNodeId,
          branchIdx,
          totalBranches,
          ts: Date.now(),
        });
      },
      onWorkflowEnd: (runId, durationMs) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.role === "assistant" && m.workflowRuns?.some((r) => r.runId === runId)
              ? {
                  ...m,
                  workflowRuns: m.workflowRuns!.map((r) =>
                    r.runId === runId ? { ...r, status: "success", durationMs } : r,
                  ),
                }
              : m,
          ),
        );
      },
      onWorkflowError: (runId, error) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.role === "assistant" && m.workflowRuns?.some((r) => r.runId === runId)
              ? {
                  ...m,
                  workflowRuns: m.workflowRuns!.map((r) =>
                    r.runId === runId ? { ...r, status: "error", error } : r,
                  ),
                }
              : m,
          ),
        );
      },
      onWorkflowAborted: (runId, reason) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.role === "assistant" && m.workflowRuns?.some((r) => r.runId === runId)
              ? {
                  ...m,
                  workflowRuns: m.workflowRuns!.map((r) =>
                    r.runId === runId ? { ...r, status: "aborted", error: reason } : r,
                  ),
                }
              : m,
          ),
        );
      },
      onError: (code, message) => {
        setError(friendlyError(code, message));
        // Stream-level error (e.g. backend dispatchMessage threw, provider
        // dropped) carries no callId, so we can't surface it on a specific
        // card — but every tool call that was still "running" at the moment
        // the stream died will obviously never receive its tool_result. If
        // we don't flip them now, the cards spin forever and only the
        // global error toast says anything happened. Sanitize all in-flight
        // tool calls on the streaming assistant message → status="error",
        // mirroring what readCache does on a stale-cache load.
        setMessages((prev) =>
          prev.map((m) =>
            m.role === "assistant" && m.streaming
              ? {
                  ...m,
                  toolCalls: m.toolCalls.map((tc) =>
                    tc.status === "running"
                      ? {
                          ...tc,
                          status: "error",
                          progress: undefined,
                          heartbeat: undefined,
                          result: tc.result ?? JSON.stringify({ error: `STREAM_${code}: ${message}` }),
                        }
                      : tc,
                  ),
                }
              : m,
          ),
        );
      },
      // V3.0 UX: live token tally — backend emits turn_usage after every
      // provider round. Update the streaming assistant message's turnMeta
      // so the GeneratingMeta strip refreshes "X tokens" without needing
      // any extra refresh.
      onTurnUsage: (usage) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.role === "assistant" && m.streaming && m.turnMeta
              ? { ...m, turnMeta: { ...m.turnMeta, completionTokens: usage.completionTokens } }
              : m,
          ),
        );
      },
      onDone: (summary) => {
        // V3.0 (queue model): one fetch SSE may carry multiple turns
        // (current turn + drained queue). Distinguish:
        //  - `summary` present  → a `done` SSE event for ONE turn. Freeze
        //    that turn's streaming asst (turnMeta → "generated") but keep
        //    `streaming` flag true — more turns may follow on the same SSE.
        //  - `summary` absent   → the SSE itself closed (no more turns).
        //    Set `streaming` flag false and sanitize any orphaned tools.
        if (summary) {
          setMessages((prev) =>
            prev.map((m) =>
              m.role === "assistant" && m.streaming
                ? {
                    ...m,
                    streaming: false,
                    turnMeta: m.turnMeta
                      ? {
                          ...m.turnMeta,
                          phase: "generated",
                          durationMs: summary.durationMs ?? (Date.now() - m.turnMeta.startedAt),
                          completionTokens: summary.completionTokens ?? m.turnMeta.completionTokens,
                        }
                      : undefined,
                    toolCalls: m.toolCalls.map((tc) =>
                      tc.status === "running"
                        ? { ...tc, status: "error", progress: undefined, heartbeat: undefined }
                        : tc,
                    ),
                  }
                : m,
            ),
          );
        } else {
          // SSE closed — done with all turns.
          setStreaming(false);
          setMessages((prev) =>
            prev.map((m) =>
              m.role === "assistant" && m.streaming
                ? {
                    ...m,
                    streaming: false,
                    turnMeta: m.turnMeta
                      ? {
                          ...m.turnMeta,
                          phase: "generated",
                          durationMs: m.turnMeta.durationMs ?? (Date.now() - m.turnMeta.startedAt),
                        }
                      : undefined,
                    toolCalls: m.toolCalls.map((tc) =>
                      tc.status === "running"
                        ? { ...tc, status: "error", progress: undefined, heartbeat: undefined }
                        : tc,
                    ),
                  }
                : m,
            ),
          );
          setAgentRefreshToken((n) => n + 1);
          try { window.dispatchEvent(new CustomEvent("workspace-stats-changed")); } catch { /* noop */ }
        }
      },
    });
  }, [activeConv, inputValue, streaming, onActiveTableChange, onDemoCreated]);

  // V3.0 (queue model): append 路径 —— streaming 期间用户继续输入。
  // 不打断当前回复,只 push user 气泡 + POST。后端入队,turn_pending ack 立刻
  // 关流。当前主线的 fetch SSE 跑完当前 turn 后,会在同一条流上继续 drain
  // queue,emit `start` → onStart 自动 push 新的 streaming asst 气泡。
  const handleAppendSend = useCallback(
    (convId: string, text: string) => {
      const userMsgId = `u_append_${Date.now()}`;
      stickToBottomRef.current = true;
      setMessages((prev) => [
        ...prev,
        { id: userMsgId, role: "user", content: text, toolCalls: [] },
      ]);
      setInputValue("");
      setError(null);

      const mentions = extractMentionPayloads(text);
      streamChatMessage({
        conversationId: convId,
        message: text,
        mentions,
        onError: (code, message) => {
          setError(friendlyError(code, message));
          // 排队失败 → 撤回 user 气泡,内容回填输入框。
          setMessages((prev) => prev.filter((m) => m.id !== userMsgId));
          setInputValue((v) => (v.trim() ? v : text));
        },
        // 不需要 onDone — 这条 fetch 只接 turn_pending 后立即关流,
        // 后续真正的 turn 事件走 handleSend 持有的主 fetch SSE。
      });
    },
    [setMessages, setInputValue, setError],
  );

  const handleConfirm = useCallback(
    (confirmed: boolean) => {
      if (!activeConv || !pendingConfirm) return;
      const pc = pendingConfirm;
      setPendingConfirm(null);
      setStreaming(true);

      // Mark the awaiting tool-call as running again on the UI
      setMessages((prev) =>
        prev.map((m) =>
          m.role === "assistant"
            ? {
                ...m,
                toolCalls: m.toolCalls.map((tc) =>
                  tc.callId === pc.callId ? { ...tc, status: "running" } : tc
                ),
              }
            : m
        )
      );

      cancelRef.current = sendChatConfirmation({
        conversationId: activeConv.id,
        callId: pc.callId,
        confirmed,
        onMessage: (delta) => {
          setMessages((prev) => {
            for (let i = prev.length - 1; i >= 0; i--) {
              if (prev[i].role === "assistant") {
                return prev.map((m, idx) => (idx === i ? { ...m, content: m.content + delta } : m));
              }
            }
            return prev;
          });
        },
        onToolStart: (call) => {
          const tid = extractTableIdFromCall(call.tool, call.args);
          if (tid) onActiveTableChange?.(tid);
          setMessages((prev) => {
            for (let i = prev.length - 1; i >= 0; i--) {
              if (prev[i].role === "assistant") {
                // replace the awaiting-confirmation placeholder if exists
                const exists = prev[i].toolCalls.some((tc) => tc.callId === call.callId);
                return prev.map((m, idx) =>
                  idx === i
                    ? {
                        ...m,
                        toolCalls: exists
                          ? m.toolCalls.map((tc) =>
                              tc.callId === call.callId ? { ...tc, status: "running" } : tc
                            )
                          : [...m.toolCalls, call],
                      }
                    : m
                );
              }
            }
            return prev;
          });
        },
        onToolResult: (callId, success, result) => {
          setMessages((prev) => {
            let pointerTid: string | undefined;
            let createdDemoId: string | undefined;
            const next = prev.map((m) =>
              m.role === "assistant"
                ? {
                    ...m,
                    toolCalls: m.toolCalls.map((tc) => {
                      if (tc.callId !== callId) return tc;
                      if (!pointerTid) {
                        pointerTid = extractTableIdFromCall(tc.tool, tc.args, result);
                      }
                      if (!createdDemoId && success) {
                        createdDemoId = extractCreatedDemoId(tc.tool, result);
                      }
                      return { ...tc, status: (success ? "success" : "error") as ChatToolCall["status"] };
                    }),
                  }
                : m
            );
            if (pointerTid) onActiveTableChange?.(pointerTid);
            if (createdDemoId) onDemoCreated?.(createdDemoId);
            return next;
          });
        },
        onError: (code, message) => {
          setError(friendlyError(code, message));
          // Mirror the sendMessage path: flip any tool that was still
          // running when the resume stream died into `error` so cards
          // don't spin forever. Resume only ever has one in-flight
          // toolCall (the danger tool the user just confirmed), so this
          // narrows the search but the shape is identical.
          setMessages((prev) =>
            prev.map((m) =>
              m.role === "assistant"
                ? {
                    ...m,
                    toolCalls: m.toolCalls.map((tc) =>
                      tc.status === "running"
                        ? {
                            ...tc,
                            status: "error",
                            progress: undefined,
                            heartbeat: undefined,
                            result: tc.result ?? JSON.stringify({ error: `STREAM_${code}: ${message}` }),
                          }
                        : tc,
                    ),
                  }
                : m,
            ),
          );
        },
        onDone: () => {
          setStreaming(false);
          // Belt-and-braces sanitisation; same reasoning as the main flow.
          setMessages((prev) =>
            prev.map((m) =>
              m.role === "assistant"
                ? {
                    ...m,
                    toolCalls: m.toolCalls.map((tc) =>
                      tc.status === "running"
                        ? { ...tc, status: "error", progress: undefined, heartbeat: undefined }
                        : tc,
                    ),
                  }
                : m,
            ),
          );
          try { window.dispatchEvent(new CustomEvent("workspace-stats-changed")); } catch { /* noop */ }
        },
      });
    },
    [activeConv, pendingConfirm, onActiveTableChange, onDemoCreated]
  );

  const handleStop = useCallback(() => {
    if (activeConv) stopChatTurn(activeConv.id).catch(() => undefined);
    if (cancelRef.current) cancelRef.current();
    setStreaming(false);
    // Also flip any in-flight tool call on the streaming message to `error`
    // so the spinner doesn't spin forever. The server-side handler may keep
    // running briefly (inside `await tool.handler`), but from the user's POV
    // they asked to stop — showing a completed/failed marker is honest, and
    // the next turn's state machine stays clean.
    setMessages((prev) =>
      prev.map((m) =>
        m.role === "assistant" && m.streaming
          ? {
              ...m,
              streaming: false,
              toolCalls: m.toolCalls.map((tc) =>
                tc.status === "running" ? { ...tc, status: "error" as const } : tc
              ),
            }
          : m
      )
    );
  }, [activeConv]);

  const handleNewConversation = useCallback(async () => {
    if (streaming) handleStop();
    // Reset UI first so the user sees the welcome page immediately; the new
    // conversation + context snapshot fetch happen in parallel behind it.
    stickToBottomRef.current = true;
    setMessages([]);
    setPendingConfirm(null);
    setError(null);
    setContextHint(null);
    try {
      const [conv, snapshot] = await Promise.all([
        createConversation(workspaceId, agentId),
        fetchChatContextSnapshot(workspaceId).catch(() => null),
      ]);
      setActiveConv(conv);
      if (snapshot) setContextHint(snapshot);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [workspaceId, agentId, streaming, handleStop]);

  // V3.0 PR3: passive listener — 同 conv 在多个 ChatBlock 时,非发起方通过 SSE
  // 接收对方触发的事件,延迟 200ms 后从 server 重拉 messages。
  //
  // V3.0 PR4 FE 补完:之前所有 listener 事件都被 `streamingRef.current` 一刀
  // 切了 —— 理由是"本 block 是 main 流发起方,fetch SSE 已在投递事件,避免
  // 重复"。但 V3.0 引入 append 路径后,branch_started / branch_finished /
  // synth_* / turn_pending 这几类事件 **只走 listener** 不走 fetch SSE
  // (append 的 fetch 立刻 close 后由 pubsub 接管)。因此需要把 reload 触发
  // 分两类:
  //   - "main-flow 类" 事件(message_persisted / 通用 done / tool_result / start):
  //     发起方自己已经收到,reload 多余 + 容易和正在跑的 fetch 抢 setMessages
  //     状态 → 仍然 streamingRef 守卫
  //   - "multi-conv 类" 事件(branch_*  / synth_* / turn_*):
  //     这些事件**不会**通过本 block 的 fetch SSE 投递(只有 append branch 的
  //     发起 block 看不到自己 branch 的 token 流),必须 reload 才能拿到 server
  //     的 SubagentRun 持久化数据 → 直接放行
  useEffect(() => {
    if (!open) return;
    const convId = activeConv?.id;
    if (!convId) return;
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;

    // forceReload:不看 streamingRef,无条件触发(给 V3.0 multi-conv 事件用)
    const forceReload = () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(async () => {
        try {
          const { messages: msgs, hasMore } = await getConversationMessages(convId, { limit: 20 });
          setHasMoreHistory(hasMore);
          // mergeServerWithLocal 已经会保护 streaming:true 的本地消息不被
          // server 的 placeholder 覆盖,所以这里 streaming 状态下也安全 merge
          setMessages((prev) => mergeServerWithLocal(msgs.map(serverToUi), prev));
        } catch {
          // ignore — 下次事件还会触发
        }
      }, 200);
    };

    // gatedReload:streaming 期间不拉(避免和发起方自己的 fetch 抢)
    const gatedReload = () => {
      if (streamingRef.current) return;
      forceReload();
    };

    const off = listenChatShared(convId, {
      // main-flow 类 — 自己 fetch SSE 已投递
      onMessagePersisted: gatedReload,
      // V3.0 multi-conv 队列模型:turn_pending / turn_promoted 用来同步多
      // ChatBlock 视图(其他 block 上的同 conv 看到 user 消息排队 / 升级)。
      // 发起方自己的 fetch SSE 已经处理了 user 气泡 + 流式 asst,这里
      // gatedReload 即可(streaming 期间不抢拉,turn 结束后自动 catch up)。
      onTurnPending: gatedReload,
      onTurnPromoted: gatedReload,
      // V1 backward-compat events (assistant 流式 done / tool_result):
      // 仍走 gated reload(发起方 fetch SSE 已投递了真实事件)
      onEvent: (name: string) => {
        if (name === "done" || name === "tool_result" || name === "start") gatedReload();
      },
    });
    return () => {
      off();
      if (reloadTimer) clearTimeout(reloadTimer);
    };
  }, [open, activeConv?.id]);

  // V3.0 PR1 切换到指定 conversation
  //
  // ⚠️ "后台运行"功能临时回退 ⚠️
  // 真正的"切走时不打断生成 + 切回来恢复进度"需要 per-conv 的 messages /
  // streaming 状态结构(messagesByConv: Record<convId, UiMessage[]> +
  // streamingByConv),涉及 53 个 setMessages 调用点逐一加 convId 守卫。
  // 当前用全局 messages 单数组无法区分"哪条 conv 的状态",导致:
  //   - 旧 fetch reader 的回调污染新 conv 的 UI 状态
  //   - 切回来后 server 上的旧 turn 仍在跑,FE 状态不知道,新 send 走了
  //     append branch 路径但 FE 期望 main 流式 → bubble 永远填不上内容
  //   - 死锁:button 看似可点但没反应,工具卡片永远 loading
  //
  // 为消除死锁,先恢复"切换 = 干净中止"的 V2 行为(handleStop 同步 abort
  // turn + cancel fetch + 清状态)。代价是失去后台运行(切走会终止生成),
  // 但状态机始终自洽,不会卡死。
  //
  // server 端 res.on("close") 不再 abort 的改动保留 —— 关 tab / 网络抖动
  // 仍然不会丢已生成的内容,只有 explicit /stop 才会终止 turn。"切换对话"
  // 现在显式调 /stop,符合用户意图。
  //
  // TODO(per-conv-state):做完整的 messagesByConv refactor 后再上线真后台
  // 运行。详细方案见 docs/multi-conversation-plan.md V3.1 章节(待写)。
  const handleSwitchConversation = useCallback(async (convId: string) => {
    if (convId === activeConv?.id) {
      setConvListOpen(false);
      return;
    }
    if (streaming) handleStop();
    stickToBottomRef.current = true;
    setMessages([]);
    setPendingConfirm(null);
    setError(null);
    setActiveConv({ id: convId } as ChatConversation);
    setConvListOpen(false);
  }, [activeConv?.id, streaming, handleStop]);

  // V3.0.3 删除当前 conv → 切到列表里的下一条/上一条
  // 最后一条不能删(用户改用"清空对话"重置内容)。
  const handleDeleteCurrentConversation = useCallback(async () => {
    const cur = activeConv?.id;
    if (!cur) return;
    try {
      // 拉最新 list 判断 sibling
      const list = await listConversations(workspaceId);
      if (list.length <= 1) {
        toast.error(t("chat.toast.deleteOnlyOne"));
        return;
      }
      const idx = list.findIndex((c) => c.id === cur);
      // 优先 createdAt desc 顺序的下一条 (idx+1,createdAt 更老),没有就上一条 (idx-1,更新)
      const neighbor = list[idx + 1] ?? list[idx - 1];
      await apiDeleteConversation(cur);
      toast.success(t("chat.toast.deleted"));
      if (neighbor) {
        // 切过去
        stickToBottomRef.current = true;
        setMessages([]);
        setPendingConfirm(null);
        setError(null);
        setActiveConv({ id: neighbor.id } as ChatConversation);
      }
      // 同步刷新 popover 的列表(去掉刚删的)
      setConvList(list.filter((c) => c.id !== cur));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [activeConv?.id, workspaceId, t, toast]);

  // V3.0.3 清空当前对话:删 messages + 重置 working memory + 保留 conv id
  const handleClearCurrentConversation = useCallback(async () => {
    const cur = activeConv?.id;
    if (!cur) return;
    try {
      if (streaming) handleStop();
      await clearConversationMessages(cur);
      // 本地立刻置空
      setMessages([]);
      setPendingConfirm(null);
      setError(null);
      stickToBottomRef.current = true;
      toast.success(t("chat.toast.cleared"));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [activeConv?.id, streaming, handleStop, t, toast]);

  // V3.0 PR1 打开 conversation 列表 (拉最新 list)
  // V3.0.1 修复:
  //   - 不按 agentId 过滤,workspace 已经做了 user 隔离;否则老对话
  //     (e.g. agentId="agent_default" 或 null 的) 会被错误地隐藏
  //   - openConvList 老实现读 closure 里的 convListOpen 判断是否要拉,
  //     与 setConvListOpen 的 setState 异步性叠加导致"经常加载不出来" race。
  //     改为:点开就总是 fetch,设 loading + 拿数据 + 取消 stale 响应。
  const convFetchSeqRef = useRef(0);
  const openConvList = useCallback(async () => {
    const willOpen = !convListOpen;
    setConvListOpen(willOpen);
    if (!willOpen) return;  // 只在打开时拉
    const seq = ++convFetchSeqRef.current;
    setConvListLoading(true);
    try {
      const list = await listConversations(workspaceId);
      // 如果期间又点过 → 用最新的 seq 覆盖,这次 stale 直接丢
      if (seq !== convFetchSeqRef.current) return;
      setConvList(list);
    } catch (err) {
      if (seq !== convFetchSeqRef.current) return;
      console.warn("[chat] listConversations failed:", err);
      setConvList([]); // 至少 popover 不卡 loading
    } finally {
      if (seq === convFetchSeqRef.current) setConvListLoading(false);
    }
  }, [convListOpen, workspaceId]);

  // ─── Render ─────────────────────────────────────────────────────────
  // Header row re-added per Figma node 6:5309 "AI header": no title, just a
  // right-aligned cluster with History + More icon buttons. The outer
  // .chat-part container supplies the rounded corners / border, so the
  // header itself stays flat white.
  // `onClose` is currently not wired to a close button in the header (the
  // panel is closed from the top-bar four-point-star toggle) — keep a void
  // to silence TS until we decide whether to add a close affordance back.
  void onClose;
  return (
    <>
      {/* Header lives outside <aside> so the drop zone doesn't cover it */}
      <header className="chat-header">
        {/* Left cluster: Agent name pill (double-click to rename, also kept in
            sync with chat-initiated renames via `update_agent_name` tool) then
            the model picker. Both are hidden behind `open` so we don't hit
            /api/agents/* on every mount. */}
        <div className="chat-header-left">
          <AgentAvatarMenu
            agentId={agentId}
            open={open}
            refreshToken={agentRefreshToken}
          />
          <AgentNamePill
            agentId={agentId}
            open={open}
            refreshToken={agentRefreshToken}
            disabled={streaming}
          />
          <ChatModelPicker agentId={agentId} open={open} disabled={streaming} />
        </div>
        <div className="chat-header-actions">
          {/* Agent meta dropdown trigger —— 在 history icon 左侧,8px gap
              由 .chat-header-actions 的 gap:8px 提供。 */}
          <button
            ref={agentMetaBtnRef}
            type="button"
            className="chat-header-btn"
            title={t("chat.agent.menu.title")}
            aria-label={t("chat.agent.menu.title")}
            aria-haspopup="menu"
            aria-expanded={agentMetaMenuOpen}
            onClick={() => setAgentMetaMenuOpen((v) => !v)}
          >
            <MemberIcon size={16} />
          </button>
          {/* V3.0.3: 移除 + 按钮(挪进 ≡ list popover 第一项),topbar 只剩
              ≡ 全部对话 / ⋯ 更多 / × 关闭 block。 */}
          <button
            ref={convListBtnRef}
            type="button"
            className="chat-header-btn"
            title={t("chat.menu.allConversations")}
            aria-label={t("chat.menu.allConversations")}
            aria-haspopup="menu"
            aria-expanded={convListOpen}
            onClick={() => void openConvList()}
          >
            <HistoryIcon size={16} />
          </button>
          <button
            ref={moreBtnRef}
            type="button"
            className="chat-header-btn"
            title={t("chat.menu.more")}
            aria-label={t("chat.menu.more")}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <MoreIcon size={16} />
          </button>
          <BlockCloseButton />
        </div>
      </header>
      <aside
        ref={sidebarRef}
        className={`chat-sidebar${open ? " open" : ""}`}
        aria-hidden={!open}
        onDragOver={(e) => { e.preventDefault(); if (e.dataTransfer.types.includes("Files")) setSidebarDragging(true); }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setSidebarDragging(false); }}
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setSidebarDragging(false); const files = Array.from(e.dataTransfer.files); if (files.length > 0) void handleFileDrop(files); }}
      >
      {/* Drop overlay — covers messages + input + bottom padding, NOT header */}
      {sidebarDragging && (
        <div className="chat-sidebar-drag-overlay">Drop files here</div>
      )}
      {/* Agent meta menu —— 7 个占位项,功能待接;onSelect 仅 console.info */}
      {agentMetaMenuOpen && agentMetaBtnRef.current && (
        <DropdownMenu
          anchorEl={agentMetaBtnRef.current}
          items={[
            { key: "nature", label: t("chat.agent.menu.nature"), icon: <NatureIcon size={16} /> },
            { key: "models", label: t("chat.agent.menu.models"), icon: <ModelsIcon size={16} /> },
            { key: "habits", label: t("chat.agent.menu.habits"), icon: <HabitsIcon size={16} /> },
            { key: "skills", label: t("chat.agent.menu.skills"), icon: <SkillsIcon size={16} /> },
            { key: "acknowledge", label: t("chat.agent.menu.acknowledge"), icon: <AcknowledgeIcon size={16} /> },
            { key: "integrations", label: t("chat.agent.menu.integrations"), icon: <IntegrationsIcon size={16} /> },
            { key: "activities", label: t("chat.agent.menu.activities"), icon: <ActivitiesIcon size={16} /> },
          ]}
          onSelect={(key) => {
            setAgentMetaMenuOpen(false);
            addBlock("system", { activeTab: key } as SystemBlockState);
          }}
          onClose={() => setAgentMetaMenuOpen(false)}
          width={200}
        />
      )}
      {/* ⋯ More menu — V3.0.3:含"清空当前对话" + "删除当前对话" */}
      {menuOpen && moreBtnRef.current && (
        <DropdownMenu
          anchorEl={moreBtnRef.current}
          items={[
            {
              key: "clear",
              label: t("chat.menu.clearCurrent"),
              icon: <RefreshIcon size={16} />,
              swipeDelete: true,
              onSwipeDelete: () => void handleClearCurrentConversation(),
            },
            {
              key: "delete",
              label: t("chat.menu.deleteCurrent"),
              icon: <TrashIcon size={16} />,
              swipeDelete: true,
              onSwipeDelete: () => void handleDeleteCurrentConversation(),
            },
          ]}
          onSelect={() => {
            setMenuOpen(false);
          }}
          onClose={() => setMenuOpen(false)}
          width={200}
        />
      )}
      {/* ≡ All conversations popover — V3.0.3:第一项是"+ 新对话",剩下是历史 list */}
      {convListOpen && convListBtnRef.current && (
        <DropdownMenu
          anchorEl={convListBtnRef.current}
          items={[
            // 顶部 + 新对话(总在第一,始终可点)
            {
              key: "__new",
              label: t("chat.list.newChat"),
              icon: <PlusIcon size={16} />,
            },
            // 老对话列表
            ...(convListLoading
              ? [{ key: "__loading", label: "…", disabled: true }]
              : convList.length === 0
              ? [{ key: "__empty", label: t("chat.list.empty"), disabled: true }]
              : convList.map((c) => ({
                  key: c.id,
                  label: c.title || t("chat.list.untitled"),
                  active: c.id === activeConv?.id,
                }))),
          ]}
          onSelect={(key) => {
            if (key === "__new") {
              setConvListOpen(false);
              void handleNewConversation();
              return;
            }
            if (!key.startsWith("__")) void handleSwitchConversation(key);
          }}
          onClose={() => setConvListOpen(false)}
          width={260}
          // 把 chat block 容器作为 boundary —— 弹窗最大高度被夹在 chat
          // sidebar 底边减 20px 内,内容超出竖直滚动,不会探出 block 底。
          boundaryEl={sidebarRef.current}
        />
      )}
      {/* Old refresh confirm — V3.0 不再使用,但保留兼容(防有地方还在用) */}
      <ConfirmDialog
        open={refreshConfirmOpen}
        title={t("chat.refresh.confirm.title")}
        message={t("chat.refresh.confirm.message")}
        confirmLabel={t("chat.refresh.confirm.ok")}
        cancelLabel={t("chat.refresh.confirm.cancel")}
        onConfirm={() => {
          setRefreshConfirmOpen(false);
          void handleNewConversation();
        }}
        onCancel={() => setRefreshConfirmOpen(false)}
      />
      {/* V4.3 改版:有消息走原"上滚 + 底部输入"流;无消息走"页面正中"
          的欢迎页 (hero + 横向 preset + 行内 input,整组居中,800px 宽度上限)。 */}
      {messages.length === 0 && !error ? (
        <div className="chat-welcome-centered" ref={scrollRef}>
          <div className="chat-welcome-row">
            <div className="chat-welcome-stack">
              <WelcomeHero agentId={agentId} />
              <WelcomePresets
                suggestions={suggestions}
                onPreset={(text) => setInputValue(text)}
              />
              {/* V4.7.1: 把 mascots 锚定到 ChatInput 上方,用一个 input-anchor
                  wrapper 让它们 absolute 定位到 chat-input-box 顶部右侧。 */}
              <div className="chat-welcome-input-anchor">
                <div className="chat-welcome-mascots" aria-hidden="true">
                  <AnimatedCharacters
                    isTyping={false}
                    showPassword={true}
                    passwordLength={inputValue.length}
                  />
                </div>
                <ChatInput
                  value={inputValue}
                  onChange={setInputValue}
                  onSend={handleSend}
                  onStop={handleStop}
                  streaming={streaming}
                  disabled={!activeConv}
                  workspaceId={workspaceId}
                  agentId={agentId}
                  attachments={attachments}
                  onAttachmentsChange={setAttachments}
                  onFileDrop={handleFileDrop}
                  externalDragging={sidebarDragging}
                />
              </div>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="chat-messages" ref={scrollRef}>
            {/* 历史分页 loading 指示 —— 滚到顶时 fetch 老消息,在最上方显示 spinner */}
            {loadingOlder && (
              <div className="chat-history-loading" role="status" aria-live="polite">
                <span className="chat-history-loading-dot" />
                <span className="chat-history-loading-dot" />
                <span className="chat-history-loading-dot" />
              </div>
            )}

            {/* 800px 居中:用一个 inner wrapper 限制宽度 */}
            <div className="chat-messages-inner">
              {messages.map((m) => (
                <MessageBlock key={m.id} msg={m} />
              ))}

              {pendingConfirm && (
                <ConfirmCard
                  pending={pendingConfirm}
                  onConfirm={() => handleConfirm(true)}
                  onCancel={() => handleConfirm(false)}
                  disabled={streaming}
                />
              )}

              {error && <div className="chat-error-card">{error}</div>}
            </div>
          </div>

          <ChatInput
            value={inputValue}
            onChange={setInputValue}
            onSend={handleSend}
            onStop={handleStop}
            streaming={streaming}
            disabled={!activeConv}
            workspaceId={workspaceId}
            agentId={agentId}
            attachments={attachments}
            onAttachmentsChange={setAttachments}
            onFileDrop={handleFileDrop}
            externalDragging={sidebarDragging}
          />
        </>
      )}
    </aside>
    </>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Translate a backend SSE `error` event into a user-facing message. The raw
 * payload (e.g. `OneAPI(anthropic) 500: {"error":...}`) is technically
 * accurate but impenetrable; map the known codes to something actionable.
 * Falls back to the raw message for unknown codes so we don't hide real bugs.
 */
function friendlyError(code: string, message: string): string {
  switch (code) {
    case "UPSTREAM_OVERLOAD":
      return (
        "上游模型服务暂时过载，且所有可用的同族回退模型也满了。" +
        "一般 30 秒到几分钟内就会恢复，请稍后重试。"
      );
    case "TOOL_TIMEOUT":
      return "某个工具超过 180 秒未返回，已中止。通常是单次调用数据量过大 — 试着缩小范围重试。";
    case "ABORTED":
      return "已中止生成。";
    case "PROVIDER_ERROR":
      // Show a cleaner prefix but keep the original detail so engineering
      // debugging info isn't lost.
      return `模型调用失败：${message}`;
    default:
      return `${code}: ${message}`;
  }
}

function serverToUi(m: ChatMessage): UiMessage {
  // V2.1 backend now joins subagent_runs + workflow_runs into the message
  // payload so history reload re-renders SubagentBlock + WorkflowBlock.
  const sRuns = (m as any).subagentRuns ?? [];
  const wRuns = (m as any).workflowRuns ?? [];
  // V3.0 UX:把后端持久化的 durationMs / completionTokens 还原成 turnMeta,
  // 让历史 assistant 气泡刷新后仍能渲染 "Generated · X 秒 · Y tokens"。
  // startedAt 取 timestamp - durationMs(消息 createdAt 减去 turn 时长 ≈ turn 起点)。
  const turnMeta: UiMessage["turnMeta"] =
    m.role === "assistant" && (m.durationMs != null || m.completionTokens != null)
      ? {
          phase: "generated",
          startedAt: m.timestamp - (m.durationMs ?? 0),
          durationMs: m.durationMs ?? 0,
          completionTokens: m.completionTokens ?? 0,
        }
      : undefined;
  return {
    id: m.id,
    role: m.role === "user" ? "user" : "assistant",
    content: m.content,
    thinking: m.thinking,
    toolCalls: (m.toolCalls || []).map((tc) => ({ ...tc })),
    branchTag: m.branchTag ?? null,
    parentMessageId: m.parentMessageId ?? null,
    turnMeta,
    subagentRuns: sRuns.length
      ? sRuns.map((r: any): UiSubagentRun => ({
          runId: r.id,
          requestedModel: r.requestedModel ?? r.subagentModel,
          resolvedModel: r.subagentModel,
          usedFallback: r.requestedModel && r.requestedModel !== r.subagentModel,
          userPrompt: r.userPrompt ?? "",
          systemPrompt: r.systemPrompt ?? "",
          thinking: r.thinkingText ?? "",
          finalText: r.finalText ?? "",
          toolCalls: Array.isArray(r.toolCallsJson) ? r.toolCallsJson : [],
          status: r.status === "running"
            ? "running"
            : r.status === "success"
            ? "success"
            : "error",
          durationMs: r.durationMs ?? undefined,
          error: r.errorMessage ?? undefined,
          startedAt: new Date(r.startedAt).getTime(),
          workflowNodeId: r.workflowNodeId ?? null,
        }))
      : undefined,
    workflowRuns: wRuns.length
      ? wRuns.map((r: any): UiWorkflowRun => ({
          runId: r.id,
          templateId: r.templateId,
          status: r.status === "running"
            ? "running"
            : r.status === "success"
            ? "success"
            : r.status === "aborted"
            ? "aborted"
            : "error",
          durationMs: r.durationMs ?? undefined,
          nodeEvents: Array.isArray(r.nodeEventsJson)
            ? (r.nodeEventsJson as any[]).map((e) => normalizeServerNodeEvent(e)).filter(Boolean) as UiWorkflowRun["nodeEvents"]
            : [],
          startedAt: new Date(r.startedAt).getTime(),
          error: r.errorMessage ?? undefined,
        }))
      : undefined,
    streaming: false,
  };
}

/**
 * V2.1 A5 / V3.0 PR4 修订: merge server-fetched messages with local state.
 * Server is the source of truth EXCEPT:
 *   1) Local message marked `streaming: true` → keep local (server hasn't
 *      persisted the final yet).
 *   2) Local message has subagentRuns / workflowRuns that server doesn't
 *      have yet (streaming-tail race window) → keep local for those fields.
 *   3) **Local-only streaming messages must survive the merge** — listener
 *      事件触发的 forceReload 在主流尚未结束时拉 DB,而 backend 是 turn 结束
 *      才把 assistant 消息写库 (runAgent 末尾 convStore.appendMessage)。所以
 *      server 那时根本没这条 assistant,如果 merge 只 server.map 输出,本地
 *      正在流式累积内容的 assistant 气泡会从 UI 里消失,token 继续从 SSE 流
 *      进来累加却没有可见容器,直到用户点 Stop / 自然 done 才"复活"。修复:
 *      把 local 里 streaming:true 但 server 里没有的消息 append 到结果末尾。
 *
 * Pure: takes new (server) + old (local), returns merged array preserving
 * server order, with any orphan-streaming local entries appended at the end.
 */
function mergeServerWithLocal(server: UiMessage[], local: UiMessage[]): UiMessage[] {
  const localById = new Map(local.map((m) => [m.id, m]));
  const serverIds = new Set(server.map((s) => s.id));
  const merged = server.map((s) => {
    const l = localById.get(s.id);
    if (!l) return s;
    if (l.streaming) return l; // keep streaming local intact
    // 保留 subagentRuns / workflowRuns 二者中"非空"的一方:
    //   server 已 join 到 → 用 server (canonical)
    //   server 没 → 用 local (streaming-tail race)
    return {
      ...s,
      subagentRuns: (s.subagentRuns?.length ?? 0) > 0 ? s.subagentRuns : l.subagentRuns,
      workflowRuns: (s.workflowRuns?.length ?? 0) > 0 ? s.workflowRuns : l.workflowRuns,
    };
  });
  // (3) 把 local 里 streaming:true 但 server 不认识的消息追到末尾。典型场景:
  //   - 主线 fetch SSE 还在跑,assistant 气泡 (streaming:true) 持续累积 token
  //   - 用户 append → forceReload → 拉 DB
  //   - server 那时还没 assistant (turn 结束才入库),直接 server.map 会把
  //     assistant 整条丢掉
  //   - 加这一段后,local-only streaming 消息会被 keep,UI 维持显示
  for (const l of local) {
    if (l.streaming && !serverIds.has(l.id)) {
      merged.push(l);
    }
  }
  // (4) 保住乐观渲染的 queued (append) user 气泡。handleAppendSend 在 server
  // 持久化前就先 push 一条 id=`u_append_<ts>` 的 user 消息。listener 收到
  // turn_pending / turn_promoted 立刻 forceReload 拉 DB,但 server 那时还没
  // 把这条 user 消息写库(只在被 drain 出队时才入库),merge 后不能丢失。
  // dedup:一旦 server 出现同 content 的 user 消息,视为已持久化,丢掉 local。
  for (const l of local) {
    if (l.role !== "user") continue;
    if (!l.id.startsWith("u_append_")) continue;
    if (serverIds.has(l.id)) continue;
    const serverHasMatching = server.some(
      (s) => s.role === "user" && s.content === l.content,
    );
    if (!serverHasMatching) merged.push(l);
  }
  return merged;
}

/** Backend WorkflowEvent kind names ↔ UI nodeEvent kind names. */
function normalizeServerNodeEvent(e: any): UiWorkflowRun["nodeEvents"][number] | null {
  const ts = typeof e.ts === "number" ? e.ts : Date.now();
  if (e.kind === "workflow_node_start") {
    return { kind: "node_start", nodeId: e.nodeId, nodeKind: e.nodeKind, nodeType: e.nodeType, ts };
  }
  if (e.kind === "workflow_node_end") {
    return { kind: "node_end", nodeId: e.nodeId, output: e.output, ts };
  }
  if (e.kind === "workflow_loop_iteration") {
    return { kind: "loop_iter", loopNodeId: e.loopNodeId, iter: e.iter, maxIter: e.maxIter, ts };
  }
  if (e.kind === "workflow_branch_start") {
    return { kind: "branch_start", parentNodeId: e.parentNodeId, branchIdx: e.branchIdx, totalBranches: e.totalBranches, ts };
  }
  return null;
}

/**
 * Render an assistant or user message block. Figma node 6:2989 / 6:5300
 * drive the layout:
 *
 *   - While the model is thinking and no answer text exists yet, show the
 *     ACTIVE thinking caption ("正在分析需求...") — node 6:2990.
 *   - Once the answer has begun to stream (or the message is finished) and
 *     a `thinking` transcript exists, show the COLLAPSED deepthink pill
 *     ("深度思考") above the answer text — node 6:5302.
 *   - Tool-call cards render after the answer text, in the order they
 *     arrived from the stream.
 */
function MessageBlock({ msg }: { msg: UiMessage }) {
  const { t } = useTranslation();
  if (msg.role === "user") return <UserBubble content={msg.content} />;

  const hasThinking = Boolean(msg.thinking && msg.thinking.length > 0);
  const hasAnswer = msg.content.length > 0;
  const hasAnyToolCall = msg.toolCalls.length > 0;
  // The "Analyzing your request" surface is a pure wait bridge — it covers
  // the latency between user send and the first model output, nothing more.
  // As soon as any signal arrives (thinking delta, answer text, or a tool
  // call) it disappears. Previously this stayed on for the entire thinking
  // phase, which wrongly implied "thinking" on models that never think.
  const waitingForFirstResponse =
    msg.streaming && !hasThinking && !hasAnswer && !hasAnyToolCall;
  // The collapsed thinking pill is a distinct surface: it's shown once real
  // thinking text has arrived, and persists so the user can still click to
  // expand the transcript after the answer lands. Non-thinking models
  // (empty marker only, or no thinking at all) never set hasThinking, so
  // this pill never appears for them.
  const thinkingCollapsed = hasThinking;

  // Group consecutive tool calls sharing the same MCP tool name — 2+ in a
  // run collapse into a single header with an expand chevron so the
  // transcript doesn't get buried under near-identical rows.
  const groups = groupConsecutiveTools(msg.toolCalls);

  // Wrap in a single block so the inner gap (text ↔ tool cards = 12px) is
  // tighter than the outer message gap (28px between successive messages).
  const assistantBody = (
    <div className="chat-msg-assistant-block">
      {thinkingCollapsed && (
        <ThinkingIndicator
          mode="collapsed"
          label={t("chat.thinking.collapsed")}
          thinking={msg.thinking}
        />
      )}
      {/* V3.0 UX: per-turn meta strip replaces the old "Analyzing your
       *  request · skeleton" placeholder. Always shown on a streaming
       *  assistant message, AND kept on the message after done as the
       *  frozen "Generated · Xs · Y tokens" footer. The legacy
       *  ThinkingIndicator active mode is only used as a fallback for
       *  history messages that have no turnMeta (pre-V3.0 saved rows). */}
      {msg.turnMeta ? (
        <GeneratingMeta
          phase={msg.turnMeta.phase}
          startedAt={msg.turnMeta.startedAt}
          completionTokens={msg.turnMeta.completionTokens}
          frozenDurationMs={msg.turnMeta.durationMs}
        />
      ) : waitingForFirstResponse ? (
        <ThinkingIndicator mode="active" text={t("chat.thinking.caption")} />
      ) : null}
      <AssistantText content={msg.content} streaming={msg.streaming} />
      {groups.map((g, i) =>
        g.items.length === 1 ? (
          <ToolCallCard key={g.items[0].callId} call={g.items[0]} />
        ) : (
          <ToolCallGroup key={`tg-${msg.id}-${i}`} tool={g.tool} items={g.items} />
        )
      )}
      {/* V2.3 C2: interleave WorkflowBlock + SubagentBlock by startedAt
          so the timeline reads true to execution order (subagent runs
          spawned BY a workflow appear after the workflow's own card). */}
      {interleaveOrchestration(msg).map((entry) =>
        entry.kind === "workflow"
          ? <WorkflowBlock key={`wf-${entry.run.runId}`} run={entry.run} />
          : <SubagentBlock key={`sa-${entry.run.runId}`} run={entry.run} />
      )}
    </div>
  );

  return assistantBody;
}

function interleaveOrchestration(
  msg: UiMessage,
): Array<
  | { kind: "workflow"; run: UiWorkflowRun; ts: number }
  | { kind: "subagent"; run: UiSubagentRun; ts: number }
> {
  const list: Array<
    | { kind: "workflow"; run: UiWorkflowRun; ts: number }
    | { kind: "subagent"; run: UiSubagentRun; ts: number }
  > = [];
  for (const r of msg.workflowRuns ?? []) {
    list.push({ kind: "workflow", run: r, ts: r.startedAt ?? 0 });
  }
  for (const r of msg.subagentRuns ?? []) {
    list.push({ kind: "subagent", run: r, ts: r.startedAt ?? 0 });
  }
  list.sort((a, b) => a.ts - b.ts);
  return list;
}

/** Run-length grouping by tool name — keeps ordering stable so the transcript
 * still reads top-to-bottom in the sequence the agent called them. */
function groupConsecutiveTools(
  calls: ChatToolCall[]
): Array<{ tool: string; items: ChatToolCall[] }> {
  const groups: Array<{ tool: string; items: ChatToolCall[] }> = [];
  for (const call of calls) {
    const last = groups[groups.length - 1];
    if (last && last.tool === call.tool) last.items.push(call);
    else groups.push({ tool: call.tool, items: [call] });
  }
  return groups;
}

/**
 * Empty-state welcome page.
 *
 * Layout (top → bottom):
 *   1. Hero row: mascot IP image (`/chat-mascot.jpg`) + "Hi, I'm your new chatbot" title
 *   2. Context-hint pill ("已加载 N 张表 · M 个字段 · K 条记录"), shown once the
 *      /api/chat/context-snapshot warm-up call resolves
 *   3. Section label: "Start by telling me what you need"
 *   4. Three preset chips — clicking fills the input but does NOT auto-send;
 *      the user reviews/edits and presses send themselves.
 */
/** Fallback preset keys — used when the backend suggestion service hasn't
 * populated yet (very first request before the 5 s warm-up delay) OR when
 * the fetch fails. Labels + prompts both live in the i18n table. */
const FALLBACK_PRESET_KEYS = ["answer", "save", "report"] as const;

/** Render the welcome title so that if it needs to wrap, the break happens
 * right after the first comma (ASCII "," or full-width "，"). Both halves get
 * `white-space: nowrap`, and a `<wbr>` between them marks the only allowed
 * break point — so "Hi, I'm your new chatbot" will never break between
 * "I'm your" etc., and "你好，我是你的新助手" never breaks mid-phrase. */
function renderTitleWithCommaBreak(title: string) {
  // Capture head including comma + any trailing whitespace (so the visible
  // space in "Hi, I'm..." stays with the head and disappears on wrap).
  const m = title.match(/^(.*?[,，]\s*)(.*)$/s);
  if (!m || !m[2]) {
    return <span className="chat-empty-title-part">{title}</span>;
  }
  return (
    <>
      <span className="chat-empty-title-part">{m[1]}</span>
      <wbr />
      <span className="chat-empty-title-part">{m[2]}</span>
    </>
  );
}

/** V4.3 新欢迎页 hero — 仅标题,左对齐 input。
 *  V4.8: 标题改成 "Hi {user}, I'm {agent}" 个性化形式,user 取 auth user
 *  的 name/username,agent 取 getAgent(agentId).name(同 AgentNamePill)。
 *  V4.8.1: agent name 缓存到 localStorage 按 agentId 索引,组件 mount
 *  时同步 lazy-init 一次,避免首次渲染时拿不到 agent name 闪现 generic
 *  "Hi, I'm your chatbot"。后台 getAgent 仍跑一次,拿到新值就更新缓存。
 *  既无 cache 又没 fetch 完成时(全新用户首访)用 visibility: hidden 占位
 *  保留高度,数据来了再显示 —— 不闪 fallback 文案。 */
const AGENT_NAME_CACHE_KEY = "chat_welcome_agent_name_v1";

function readAgentNameCache(agentId: string): string {
  try {
    const raw = localStorage.getItem(AGENT_NAME_CACHE_KEY);
    if (!raw) return "";
    const map = JSON.parse(raw) as Record<string, string>;
    return map[agentId] || "";
  } catch { return ""; }
}

function writeAgentNameCache(agentId: string, name: string) {
  try {
    const raw = localStorage.getItem(AGENT_NAME_CACHE_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    if (map[agentId] === name) return;
    map[agentId] = name;
    localStorage.setItem(AGENT_NAME_CACHE_KEY, JSON.stringify(map));
  } catch { /* localStorage may be disabled — non-fatal */ }
}

function WelcomeHero({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  // Lazy init from cache so first paint already has the personalized title
  // for returning users(99% of cases after first visit)。
  const [agentName, setAgentName] = useState<string>(() => readAgentNameCache(agentId));

  // Fetch agent name; refresh on `agent-name-changed` event so chat-initiated
  // rename(`update_agent_name` 工具)实时反映到欢迎页。
  // V4.8.2: 跳过 "agent_default" / 空串 / null —— 这些是 auth 还在 loading
  // 时父级传过来的 fallback,真发请求会被 requireArtifactAccess 中间件
  // 403(因为 agent_default 不属于当前用户)。
  useEffect(() => {
    if (!agentId || agentId === "agent_default") return;
    let cancelled = false;
    getAgent(agentId)
      .then((a) => {
        if (cancelled) return;
        const name = a.name || "";
        setAgentName(name);
        if (name) writeAgentNameCache(agentId, name);
      })
      .catch(() => undefined);
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.agentId === agentId && detail?.name) {
        setAgentName(detail.name);
        writeAgentNameCache(agentId, detail.name);
      }
    };
    window.addEventListener("agent-name-changed", handler);
    return () => {
      cancelled = true;
      window.removeEventListener("agent-name-changed", handler);
    };
  }, [agentId]);

  const userName = user?.name || user?.username || "";
  const ready = !!userName && !!agentName;
  const title = ready
    ? t("chat.empty.titlePersonal", { user: userName, agent: agentName })
    // 首次访问、还没有 cache + fetch 未完成时,用一个 placeholder 撑高度
    // 但 visibility: hidden 不可见 —— 比闪一下 "Hi, I'm your chatbot"
    // 再切到个性化标题体验更连贯。
    : t("chat.empty.titlePersonal", { user: "—", agent: "—" });

  return (
    <div className="chat-welcome-hero">
      <div
        className="chat-welcome-title"
        style={ready ? undefined : { visibility: "hidden" }}
      >
        {renderTitleWithCommaBreak(title)}
      </div>
    </div>
  );
}

/** V4.3 横向推荐 prompt + 分页滚动 */
function WelcomePresets({
  suggestions,
  onPreset,
}: {
  suggestions: ChatSuggestion[];
  onPreset: (text: string) => void;
}) {
  const { t } = useTranslation();
  const effective: ChatSuggestion[] =
    suggestions.length > 0
      ? suggestions
      : FALLBACK_PRESET_KEYS.map((key) => ({
          label: t(`chat.empty.preset.${key}.label`),
          prompt: t(`chat.empty.preset.${key}.prompt`),
        }));

  const scrollerRef = useRef<HTMLDivElement>(null);
  const [canPrev, setCanPrev] = useState(false);
  const [canNext, setCanNext] = useState(false);

  const updateScrollState = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setCanPrev(el.scrollLeft > 4);
    setCanNext(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  useEffect(() => {
    updateScrollState();
    const el = scrollerRef.current;
    if (!el) return;
    el.addEventListener("scroll", updateScrollState);
    window.addEventListener("resize", updateScrollState);
    return () => {
      el.removeEventListener("scroll", updateScrollState);
      window.removeEventListener("resize", updateScrollState);
    };
  }, [updateScrollState, effective.length]);

  const scrollBy = (dx: number) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollBy({ left: dx, behavior: "smooth" });
  };

  // V4.3.1: 去掉 section label,直接渲染 scroller + 内联在 wrap 内的箭头
  return (
    <div className="chat-welcome-presets-wrap">
      {canPrev && (
        <button
          type="button"
          className="chat-welcome-presets-arrow prev"
          onClick={() => scrollBy(-280)}
          aria-label={t("chat.empty.scrollLeft")}
        >
          <ArrowLeftIcon />
        </button>
      )}
      <div className="chat-welcome-presets-scroller" ref={scrollerRef}>
        {effective.map((s, idx) => (
          <button
            key={`${idx}-${s.label}`}
            type="button"
            className="chat-preset-chip chat-preset-chip-compact"
            onClick={() => onPreset(s.prompt)}
            title={s.prompt}
          >
            <span className="chat-preset-chip-label">{s.label}</span>
          </button>
        ))}
      </div>
      {canNext && (
        <button
          type="button"
          className="chat-welcome-presets-arrow next"
          onClick={() => scrollBy(280)}
          aria-label={t("chat.empty.scrollRight")}
        >
          <ArrowRightIcon />
        </button>
      )}
    </div>
  );
}

function ArrowLeftIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M9 3 5 7l4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ArrowRightIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M5 3 9 7l-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** `icon_space-right_outlined` (Figma). Small right-pointing arrow used on the
 * right edge of each preset chip. 12px default to match Figma's 12×12 slot. */
function SpaceRightIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M4.5 2.5 8 6l-3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
