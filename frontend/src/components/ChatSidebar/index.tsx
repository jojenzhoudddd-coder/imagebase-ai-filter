/**
 * ChatSidebar — right-side drawer where users chat with the Table Agent.
 *
 * State model (per plan Phase 4.3.1): each assistant message holds a mutable
 * `content` string that is appended to as text chunks arrive, and a list of
 * interspersed tool calls. Confirmation cards are rendered from the
 * `pendingConfirm` state slot.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import "./ChatSidebar.css";
import ChatInput from "./ChatInput";
import UserBubble from "./ChatMessage/UserBubble";
import AssistantText from "./ChatMessage/AssistantText";
import ThinkingIndicator from "./ChatMessage/ThinkingIndicator";
import ToolCallCard from "./ChatMessage/ToolCallCard";
import ToolCallGroup from "./ChatMessage/ToolCallGroup";
import ConfirmCard from "./ChatMessage/ConfirmCard";
import ChatModelPicker from "./ChatModelPicker";
import AgentNamePill from "./AgentNamePill";
import { MoreIcon, RefreshIcon } from "./icons";
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
  getConversationMessages,
  fetchChatContextSnapshot,
  fetchChatSuggestions,
  streamChatMessage,
  sendChatConfirmation,
  stopChatTurn,
} from "../../api";

// Client-side message model (mutable during streaming)
interface UiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  toolCalls: ChatToolCall[];
  streaming?: boolean;
  error?: { code: string; message: string };
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

export default function ChatSidebar({
  open,
  workspaceId,
  agentId = "agent_default",
  onClose,
  onActiveTableChange,
}: Props) {
  const { t } = useTranslation();
  // Hydrate from localStorage synchronously so a refresh shows cached
  // messages immediately — no welcome-page flash while /conversations loads.
  const initialCache = useRef<CachedState | null>(readCache(workspaceId)).current;
  const [activeConv, setActiveConv] = useState<ChatConversation | null>(
    initialCache ? ({ id: initialCache.activeConvId } as ChatConversation) : null
  );
  const [messages, setMessages] = useState<UiMessage[]>(initialCache?.messages ?? []);
  const [inputValue, setInputValue] = useState("");
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
            const { conversation, messages: serverMsgs, hasMore } = await getConversationMessages(activeConv.id, { limit: 30 });
            setActiveConv(conversation);
            setHasMoreHistory(hasMore);
            if (!streamingRef.current) {
              setMessages(serverMsgs.map(serverToUi));
            }
            return;
          } catch {
            clearCache(workspaceId);
          }
        }
        const list = await listConversations(workspaceId);
        if (list.length > 0) {
          const conv = list[0];
          const { messages: msgs, hasMore } = await getConversationMessages(conv.id, { limit: 30 });
          setActiveConv(conv);
          setHasMoreHistory(hasMore);
          if (!streamingRef.current) {
            setMessages(msgs.map(serverToUi));
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
        limit: 30,
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
  const handleSend = useCallback(() => {
    if (!activeConv) return;
    const text = inputValue.trim();
    if (!text || streaming) return;

    const userMsgId = `u_${Date.now()}`;
    const assistantMsgId = `a_${Date.now()}_pending`;

    // User just submitted a new turn — snap to the bottom and re-enable
    // sticky auto-scroll so they see their own message and the streamed
    // reply in sequence even if they'd scrolled up in a previous turn.
    stickToBottomRef.current = true;

    setMessages((prev) => [
      ...prev,
      { id: userMsgId, role: "user", content: text, toolCalls: [] },
      { id: assistantMsgId, role: "assistant", content: "", toolCalls: [], streaming: true },
    ]);
    setInputValue("");
    setStreaming(true);
    setError(null);

    cancelRef.current = streamChatMessage({
      conversationId: activeConv.id,
      message: text,
      onStart: (serverId) => {
        // Replace pending id with the server-assigned one so subsequent
        // events can correlate.
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantMsgId ? { ...m, id: serverId } : m))
        );
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
          return next;
        });
      },
      onConfirm: (pending) => {
        setPendingConfirm(pending);
      },
      onError: (code, message) => {
        setError(friendlyError(code, message));
      },
      onDone: () => {
        setStreaming(false);
        setMessages((prev) =>
          prev.map((m) => (m.role === "assistant" && m.streaming ? { ...m, streaming: false } : m))
        );
        // Turn just ended — the model may have called update_agent_name. Poke
        // the pill to re-fetch so the header label catches up.
        setAgentRefreshToken((n) => n + 1);
        // 通知 TopBar 刷新 token / artifacts 统计（chat 刚消耗 token，artifact
        // 也可能被改了；TopBar 监听这个 window 事件做即时 refetch）
        try { window.dispatchEvent(new CustomEvent("workspace-stats-changed")); } catch { /* noop */ }
      },
    });
  }, [activeConv, inputValue, streaming, onActiveTableChange]);

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
            const next = prev.map((m) =>
              m.role === "assistant"
                ? {
                    ...m,
                    toolCalls: m.toolCalls.map((tc) => {
                      if (tc.callId !== callId) return tc;
                      if (!pointerTid) {
                        pointerTid = extractTableIdFromCall(tc.tool, tc.args, result);
                      }
                      return { ...tc, status: (success ? "success" : "error") as ChatToolCall["status"] };
                    }),
                  }
                : m
            );
            if (pointerTid) onActiveTableChange?.(pointerTid);
            return next;
          });
        },
        onError: (code, message) => setError(friendlyError(code, message)),
        onDone: () => {
          setStreaming(false);
          try { window.dispatchEvent(new CustomEvent("workspace-stats-changed")); } catch { /* noop */ }
        },
      });
    },
    [activeConv, pendingConfirm, onActiveTableChange]
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
    <aside className={`chat-sidebar${open ? " open" : ""}`} aria-hidden={!open}>
      <header className="chat-header">
        {/* Left cluster: Agent name pill (double-click to rename, also kept in
            sync with chat-initiated renames via `update_agent_name` tool) then
            the model picker. Both are hidden behind `open` so we don't hit
            /api/agents/* on every mount. */}
        <div className="chat-header-left">
          <AgentNamePill
            agentId={agentId}
            open={open}
            refreshToken={agentRefreshToken}
            disabled={streaming}
          />
          <ChatModelPicker agentId={agentId} open={open} disabled={streaming} />
        </div>
        <div className="chat-header-actions">
          {/* Phase 1 decision: the Agent's soul.md / profile.md are NOT
              exposed as an interactive UI surface. Users read/write them
              only through chat (the Agent self-edits via Tier 0 meta-tools).
              The "..." overflow is still available for refresh-conversation. */}
          {(messages.length > 0 || streaming) && (
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
          )}
        </div>
      </header>
      {menuOpen && moreBtnRef.current && (
        <DropdownMenu
          anchorEl={moreBtnRef.current}
          items={[
            {
              key: "refresh",
              label: t("chat.menu.refresh"),
              icon: <RefreshIcon size={16} />,
            },
          ]}
          onSelect={(key) => {
            setMenuOpen(false);
            if (key === "refresh") setRefreshConfirmOpen(true);
          }}
          onClose={() => setMenuOpen(false)}
          width={180}
        />
      )}
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
      <div className="chat-messages" ref={scrollRef}>
        {messages.length === 0 && !error && (
          <EmptyState
            contextHint={contextHint}
            suggestions={suggestions}
            onPreset={(text) => {
              // Fill the input only — do NOT auto-send. User reviews/edits
              // and presses send themselves.
              setInputValue(text);
            }}
          />
        )}

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

      <ChatInput
        value={inputValue}
        onChange={setInputValue}
        onSend={handleSend}
        onStop={handleStop}
        streaming={streaming}
        disabled={!activeConv}
      />
    </aside>
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
  return {
    id: m.id,
    role: m.role === "user" ? "user" : "assistant",
    content: m.content,
    thinking: m.thinking,
    toolCalls: (m.toolCalls || []).map((tc) => ({ ...tc })),
    streaming: false,
  };
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
  return (
    <div className="chat-msg-assistant-block">
      {thinkingCollapsed && (
        <ThinkingIndicator
          mode="collapsed"
          label={t("chat.thinking.collapsed")}
          thinking={msg.thinking}
        />
      )}
      {waitingForFirstResponse && <ThinkingIndicator mode="active" text={t("chat.thinking.caption")} />}
      <AssistantText content={msg.content} streaming={msg.streaming} />
      {groups.map((g, i) =>
        g.items.length === 1 ? (
          <ToolCallCard key={g.items[0].callId} call={g.items[0]} />
        ) : (
          <ToolCallGroup key={`tg-${msg.id}-${i}`} tool={g.tool} items={g.items} />
        )
      )}
    </div>
  );
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

function EmptyState({
  onPreset,
  contextHint,
  suggestions,
}: {
  onPreset: (text: string) => void;
  contextHint: ChatContextSnapshot | null;
  suggestions: ChatSuggestion[];
}) {
  const { t } = useTranslation();

  // Prefer dynamic, AI-generated suggestions; fall back to static presets.
  const effective: ChatSuggestion[] =
    suggestions.length > 0
      ? suggestions
      : FALLBACK_PRESET_KEYS.map((key) => ({
          label: t(`chat.empty.preset.${key}.label`),
          prompt: t(`chat.empty.preset.${key}.prompt`),
        }));

  // Welcome page: hero (mascot IP + title), context-hint pill, preset chips.
  // "Or use a template" section removed per product direction.
  return (
    <div className="chat-empty">
      <div className="chat-empty-hero">
        {/* 头像 IP 图已移除（产品方向） —— 仅保留标题 */}
        <div className="chat-empty-title">{renderTitleWithCommaBreak(t("chat.empty.title"))}</div>
      </div>

      {contextHint && (
        <div className="chat-empty-context-hint" title={`workspaceId: ${contextHint.workspaceId}`}>
          <span className="dot" aria-hidden="true" />
          {t("chat.empty.contextHint", {
            tables: contextHint.tableCount,
            fields: contextHint.fieldCount,
            records: contextHint.recordCount,
          })}
        </div>
      )}

      <div className="chat-empty-sections">
        <div className="chat-empty-section">
          <div className="chat-empty-section-label">{t("chat.empty.sectionLabel")}</div>
          <div className="chat-empty-presets">
            {effective.map((s, idx) => (
              <button
                key={`${idx}-${s.label}`}
                type="button"
                className="chat-preset-chip"
                onClick={() => onPreset(s.prompt)}
                title={s.prompt}
              >
                <span className="chat-preset-chip-label">{s.label}</span>
                <SpaceRightIcon size={12} />
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
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
