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
import ConfirmCard from "./ChatMessage/ConfirmCard";
import { RefreshIcon } from "./icons";
import {
  type ChatConversation,
  type ChatContextSnapshot,
  type ChatMessage,
  type ChatToolCall,
  type PendingConfirm,
  createConversation,
  listConversations,
  getConversationMessages,
  fetchChatContextSnapshot,
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

interface Props {
  open: boolean;
  documentId: string;
  onClose: () => void;
}

export default function ChatSidebar({ open, documentId, onClose }: Props) {
  const [activeConv, setActiveConv] = useState<ChatConversation | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Thin document summary shown on the welcome page after a refresh, so the
  // user knows what the Agent will see before their first prompt. Kept
  // separate from the full Document Snapshot, which is rebuilt inside the
  // backend agent service on every message.
  const [contextHint, setContextHint] = useState<ChatContextSnapshot | null>(null);

  const cancelRef = useRef<(() => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // ─── Ensure a conversation exists when the sidebar opens ───────────────
  useEffect(() => {
    if (!open) return;
    if (activeConv) return;
    (async () => {
      try {
        const list = await listConversations(documentId);
        if (list.length > 0) {
          // Load the most recent conversation
          const conv = list[0];
          const { messages: msgs } = await getConversationMessages(conv.id);
          setActiveConv(conv);
          setMessages(msgs.map(serverToUi));
        } else {
          const conv = await createConversation(documentId);
          setActiveConv(conv);
          setMessages([]);
        }
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, [open, documentId, activeConv]);

  // Auto-scroll to bottom on new content
  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, pendingConfirm]);

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
        setMessages((prev) => {
          for (let i = prev.length - 1; i >= 0; i--) {
            if (prev[i].role === "assistant" && prev[i].streaming) {
              return prev.map((m, idx) =>
                idx === i ? { ...m, toolCalls: [...m.toolCalls, call] } : m
              );
            }
          }
          return prev;
        });
      },
      onToolResult: (callId, success, _result) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.role === "assistant"
              ? {
                  ...m,
                  toolCalls: m.toolCalls.map((tc) =>
                    tc.callId === callId ? { ...tc, status: success ? "success" : "error" } : tc
                  ),
                }
              : m
          )
        );
      },
      onConfirm: (pending) => {
        setPendingConfirm(pending);
      },
      onError: (code, message) => {
        setError(`${code}: ${message}`);
      },
      onDone: () => {
        setStreaming(false);
        setMessages((prev) =>
          prev.map((m) => (m.role === "assistant" && m.streaming ? { ...m, streaming: false } : m))
        );
      },
    });
  }, [activeConv, inputValue, streaming]);

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
        onToolResult: (callId, success) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.role === "assistant"
                ? {
                    ...m,
                    toolCalls: m.toolCalls.map((tc) =>
                      tc.callId === callId ? { ...tc, status: success ? "success" : "error" } : tc
                    ),
                  }
                : m
            )
          );
        },
        onError: (code, message) => setError(`${code}: ${message}`),
        onDone: () => setStreaming(false),
      });
    },
    [activeConv, pendingConfirm]
  );

  const handleStop = useCallback(() => {
    if (activeConv) stopChatTurn(activeConv.id).catch(() => undefined);
    if (cancelRef.current) cancelRef.current();
    setStreaming(false);
    setMessages((prev) =>
      prev.map((m) => (m.role === "assistant" && m.streaming ? { ...m, streaming: false } : m))
    );
  }, [activeConv]);

  const handleNewConversation = useCallback(async () => {
    if (streaming) handleStop();
    // Reset UI first so the user sees the welcome page immediately; the new
    // conversation + context snapshot fetch happen in parallel behind it.
    setMessages([]);
    setPendingConfirm(null);
    setError(null);
    setContextHint(null);
    try {
      const [conv, snapshot] = await Promise.all([
        createConversation(documentId),
        fetchChatContextSnapshot(documentId).catch(() => null),
      ]);
      setActiveConv(conv);
      if (snapshot) setContextHint(snapshot);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [documentId, streaming, handleStop]);

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
        <div className="chat-header-actions">
          <button
            type="button"
            className="chat-header-btn"
            title={messages.length === 0 ? "当前已是新对话" : "刷新对话"}
            aria-label="刷新对话"
            // Disable on the welcome page — there is nothing to reset, so the
            // button greys out to hint that it's a no-op in that state.
            disabled={messages.length === 0 && !streaming}
            onClick={() => void handleNewConversation()}
          >
            <RefreshIcon size={16} />
          </button>
        </div>
      </header>
      <div className="chat-messages" ref={scrollRef}>
        {messages.length === 0 && !error && (
          <EmptyState
            contextHint={contextHint}
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
  if (msg.role === "user") return <UserBubble content={msg.content} />;

  const hasThinking = Boolean(msg.thinking && msg.thinking.length > 0);
  const hasAnswer = msg.content.length > 0;
  // Thinking is considered "done" once the model starts producing answer
  // tokens or the message has finished streaming entirely.
  const thinkingCollapsed = hasThinking && (hasAnswer || !msg.streaming);
  const thinkingActive = msg.streaming && !hasAnswer;

  return (
    <>
      {thinkingCollapsed && <ThinkingIndicator mode="collapsed" />}
      {thinkingActive && <ThinkingIndicator mode="active" />}
      <AssistantText content={msg.content} streaming={msg.streaming} />
      {msg.toolCalls.map((tc) => (
        <ToolCallCard key={tc.callId} call={tc} />
      ))}
    </>
  );
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
const PRESET_PROMPTS: Array<{ label: string; prompt: string }> = [
  { label: "Answer questions using my bases", prompt: "请根据当前文档的表数据回答我的问题" },
  { label: "Save new messages to my base automatically", prompt: "把新消息自动保存到当前文档对应的表中" },
  { label: "Help me track task progress and write a weekly report", prompt: "帮我汇总任务进度并生成一份周报" },
];

function EmptyState({
  onPreset,
  contextHint,
}: {
  onPreset: (text: string) => void;
  contextHint: ChatContextSnapshot | null;
}) {
  // Welcome page: hero (mascot IP + title), context-hint pill, preset chips.
  // "Or use a template" section removed per product direction.
  return (
    <div className="chat-empty">
      <div className="chat-empty-hero">
        <img
          className="chat-empty-mascot"
          src="/chat-mascot.jpg"
          alt=""
          aria-hidden="true"
          draggable={false}
        />
        <div className="chat-empty-title">Hi, I'm your new chatbot</div>
      </div>

      {contextHint && (
        <div className="chat-empty-context-hint" title={`documentId: ${contextHint.documentId}`}>
          <span className="dot" aria-hidden="true" />
          已加载 {contextHint.tableCount} 张表 · {contextHint.fieldCount} 个字段 · {contextHint.recordCount} 条记录
        </div>
      )}

      <div className="chat-empty-sections">
        <div className="chat-empty-section">
          <div className="chat-empty-section-label">Start by telling me what you need</div>
          <div className="chat-empty-presets">
            {PRESET_PROMPTS.map((p) => (
              <button
                key={p.prompt}
                type="button"
                className="chat-preset-chip"
                onClick={() => onPreset(p.prompt)}
              >
                <span className="chat-preset-chip-label">{p.label}</span>
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
