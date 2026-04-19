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
import { PlusIcon, CloseIcon } from "./icons";
import {
  type ChatConversation,
  type ChatMessage,
  type ChatToolCall,
  type PendingConfirm,
  createConversation,
  listConversations,
  getConversationMessages,
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
    try {
      const conv = await createConversation(documentId);
      setActiveConv(conv);
      setMessages([]);
      setPendingConfirm(null);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [documentId, streaming, handleStop]);

  // ─── Render ─────────────────────────────────────────────────────────
  return (
    <aside className={`chat-sidebar${open ? " open" : ""}`} aria-hidden={!open}>
      <header className="chat-header">
        <div className="chat-header-title">Table Agent</div>
        <div className="chat-header-actions">
          <button
            className="chat-header-btn"
            title="新对话"
            onClick={handleNewConversation}
          >
            <PlusIcon size={14} />
          </button>
          <button className="chat-header-btn" title="关闭" onClick={onClose}>
            <CloseIcon size={14} />
          </button>
        </div>
      </header>

      <div className="chat-messages" ref={scrollRef}>
        {messages.length === 0 && !error && (
          <EmptyState
            onPreset={(text) => {
              setInputValue(text);
              // kick off send on next tick once state is committed
              setTimeout(() => handleSend(), 0);
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

function MessageBlock({ msg }: { msg: UiMessage }) {
  if (msg.role === "user") return <UserBubble content={msg.content} />;

  return (
    <>
      {msg.thinking && <ThinkingIndicator text={msg.thinking.slice(-60)} />}
      <AssistantText content={msg.content} streaming={msg.streaming} />
      {msg.toolCalls.map((tc) => (
        <ToolCallCard key={tc.callId} call={tc} />
      ))}
    </>
  );
}

/**
 * Empty-state welcome page — pixel-aligned to the Figma export
 * (/Users/bytedance/Desktop/用户发送 prompt.svg).
 *
 * Layout (top → bottom):
 *   1. Hero row: 3D bot avatar + "Hi, I'm your new chatbot" title
 *   2. Section label: "Start by telling me what you need"
 *   3. Three preset chips (label + trailing chevron)
 *   4. Section label: "Or use a template"
 *   5. Two-column grid of template cards (small avatar + title)
 *
 * Chips/cards dispatch Chinese prompts so the Table Agent backend can
 * actually execute them against the MCP tools.
 */
const PRESET_PROMPTS: Array<{ label: string; prompt: string }> = [
  { label: "Answer questions using my bases", prompt: "请根据当前文档的表数据回答我的问题" },
  { label: "Save new messages to my base automatically", prompt: "把新消息自动保存到当前文档对应的表中" },
  { label: "Help me track task progress and write a weekly report", prompt: "帮我汇总任务进度并生成一份周报" },
];

const TEMPLATE_CARDS: Array<{ title: string; prompt: string; accent: string }> = [
  { title: "Base Q&A assistant", prompt: "我想要一个基于当前 base 的问答助手", accent: "#8B63F3" },
  { title: "Intelligent Data Analyst", prompt: "我想要一个智能数据分析助手，帮我分析表中的数据", accent: "#F3B845" },
  { title: "Base Work Assistant", prompt: "我想要一个工作助手，帮我处理表格相关的日常任务", accent: "#4D83F5" },
];

function EmptyState({ onPreset }: { onPreset: (text: string) => void }) {
  return (
    <div className="chat-empty">
      <div className="chat-empty-hero">
        <BotAvatar size={64} accent="#8B63F3" />
        <div className="chat-empty-title">Hi, I'm your new chatbot</div>
      </div>

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
            <ChevronRightIcon size={14} />
          </button>
        ))}
      </div>

      <div className="chat-empty-section-label">Or use a template</div>
      <div className="chat-empty-templates">
        {TEMPLATE_CARDS.map((t) => (
          <button
            key={t.title}
            type="button"
            className="chat-template-card"
            onClick={() => onPreset(t.prompt)}
          >
            <BotAvatar size={26} accent={t.accent} />
            <span className="chat-template-title">{t.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Soft 3D-ish rounded-square avatar used in hero + template cards. */
function BotAvatar({ size = 64, accent = "#8B63F3" }: { size?: number; accent?: string }) {
  const radius = size * 0.28;
  const gid = `bot_grad_${accent.replace("#", "")}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      className="chat-bot-avatar"
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="64" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={accent} stopOpacity="0.22" />
          <stop offset="1" stopColor={accent} stopOpacity="0.12" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="64" height="64" rx={radius} ry={radius} fill={`url(#${gid})`} />
      <path
        d="M32 14c.9 0 1.7.6 2 1.5l2.4 7.4c.5 1.5 1.7 2.7 3.2 3.2l7.4 2.4c1.8.6 1.8 3.1 0 3.7l-7.4 2.4c-1.5.5-2.7 1.7-3.2 3.2L34 45c-.6 1.8-3.1 1.8-3.7 0l-2.4-7.4c-.5-1.5-1.7-2.7-3.2-3.2L17.3 32c-1.8-.6-1.8-3.1 0-3.7l7.4-2.4c1.5-.5 2.7-1.7 3.2-3.2L30.3 15.5C30.5 14.6 31.1 14 32 14z"
        fill={accent}
      />
      <circle cx="28" cy="26" r="2" fill="#FFFFFF" opacity="0.8" />
    </svg>
  );
}

function ChevronRightIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M5.25 3.5l3.5 3.5-3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
