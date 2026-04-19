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
import { FourPointStarIcon, PlusIcon, CloseIcon } from "./icons";
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
          <div className="chat-empty">
            <div className="chat-empty-icon">
              <FourPointStarIcon size={32} />
            </div>
            <div className="chat-empty-title">你好，我是 Table Agent</div>
            <div className="chat-empty-subtitle">
              我可以帮你创建和管理数据表、字段、记录、视图。试试说"帮我创建一个项目管理表"。
            </div>
          </div>
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
