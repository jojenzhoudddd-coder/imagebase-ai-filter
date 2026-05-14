/**
 * ChatInput — V2.2 重写。
 *
 * 关键变化(对比 V1):
 *   - textarea → contenteditable div。mention 渲染为内联 chip(蓝字、
 *     contentEditable=false 原子化),用户看到的是 `@GPT-5.5`,不是
 *     `[@GPT-5.5](mention://model/gpt-5.5)` 的原始 markdown
 *   - 输入 `@` 触发 picker → 在 caret 像素位置上方右侧弹出
 *   - 父组件依然给 `value: string` 拿到 markdown 原文(发送时序列化用)
 *
 * 序列化策略:
 *   - 内部状态 `htmlValue`:contenteditable 当前 HTML
 *   - 公开 `value`:把 HTML 转成 markdown(文本节点保留,mention chip 转
 *     `[@label](mention://...)`),通过 onChange 通知父组件
 *   - 这样 ChatSidebar.handleSend 仍然走老的 `extractMentionPayloads(text)`
 *     路径,无需改动业务侧
 *
 * Voice / Send / Stop 行为对齐 V1。
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { AtIcon, MicIcon, SendIcon, StopIcon } from "./icons";

/** Append-icon: numbered-list-continued (Figma icon_numbered-list-continued_outlined)。
 *  视觉上是"列表追加"的隐喻 — 在已有 list 后面加一项,正好契合"追加到当前
 *  turn 的 branch"。fill 用 currentColor 让它继承 .chat-input-send 的白色
 *  字色,与 SendIcon / StopIcon 的着色机制一致。 */
function AppendIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3.59975 8.50012V3.58969L2.46279 4.27186C2.03657 4.5276 1.48374 4.38939 1.228 3.96317C0.972268 3.53695 1.11048 2.98411 1.5367 2.72838L3.58235 1.50099C4.38218 1.02109 5.39975 1.59722 5.39975 2.52998V8.50012C5.39975 8.99718 4.9968 9.40012 4.49975 9.40012C4.00269 9.40012 3.59975 8.99718 3.59975 8.50012Z" fill="currentColor"/>
      <path d="M8.73976 4.56812C8.40901 4.76106 8.40901 5.23896 8.73976 5.4319L13.2474 8.06139C13.5808 8.25583 13.9994 8.01539 13.9994 7.6295V6.00012H18.9995C20.1041 6.00012 20.9995 6.89555 20.9995 8.00012V18.0001C20.9995 19.1047 20.1041 20.0001 18.9995 20.0001H10.9995C10.4472 20.0001 9.99951 20.4478 9.99951 21.0001C9.99951 21.5524 10.4472 22.0001 10.9995 22.0001H18.9995C21.2087 22.0001 22.9995 20.2093 22.9995 18.0001V8.00012C22.9995 5.79098 21.2087 4.00012 18.9995 4.00012H13.9994V2.37053C13.9994 1.98464 13.5808 1.7442 13.2474 1.93864L8.73976 4.56812Z" fill="currentColor"/>
      <path d="M2.17656 15.4939C4.11134 13.2367 7.75657 15.2155 6.9177 18.0677C6.83366 18.3534 6.66999 18.6093 6.44583 18.8054L4.39474 20.6002H6.49944C6.99649 20.6002 7.39944 21.0031 7.39944 21.5002C7.39944 21.9972 6.99649 22.4002 6.49944 22.4002H2.19213C1.29425 22.4002 0.876069 21.2872 1.5518 20.6959L5.20724 17.4974C5.42918 16.5402 4.2014 15.8975 3.54322 16.6653L3.18277 17.0859C2.85929 17.4633 2.29112 17.507 1.91372 17.1835C1.53633 16.86 1.49263 16.2918 1.81611 15.9144L2.17656 15.4939Z" fill="currentColor"/>
    </svg>
  );
}
import { useSpeechRecognition } from "../../hooks/useSpeechRecognition";
import { useTranslation } from "../../i18n";
import MentionPicker from "../Mention/MentionPicker";
import SkillPicker from "./SkillPicker";
import type { MentionHit } from "../../types";
import type { AgentSkillSummary } from "../../api";

export interface ChatAttachment {
  id: string;
  url: string;
  mime: string;
  size: number;
  originalName: string;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  disabled?: boolean;
  streaming: boolean;
  placeholder?: string;
  workspaceId: string;
  agentId?: string;
  /** Managed externally: list of uploaded attachments shown in preview bar */
  attachments?: ChatAttachment[];
  onAttachmentsChange?: (attachments: ChatAttachment[]) => void;
  onFileDrop?: (files: File[]) => void;
  /** External drag state (sidebar-level drag detected) */
  externalDragging?: boolean;
}

interface MentionQueryState {
  triggerAnchor: { left: number; right: number; top: number; bottom: number };
  query: string;
}

// ─── Markdown ↔ HTML 互转 ───
//
// `mention://...` 链接 → `<span class="chat-mention-chip" data-href="..."
// data-label="..." contenteditable="false">@Label</span>`
// 反向:walk DOM,文本节点取 textContent,chip 节点取 data-href + data-label
// 拼回 markdown 链接。

const MENTION_LINK_RE = /\[(@[^\]]*)\]\((mention:\/\/[^)]+)\)/g;
const SKILL_LINK_RE = /\[(\/[^\]]*)\]\((skill:\/\/[^)]+)\)/g;

function markdownToHtml(markdown: string): string {
  const tokens: Array<{ token: string; html: string }> = [];
  let counter = 0;
  const placeholder = (label: string, href: string) => {
    const tok = `MENTION_${counter++}`;
    const safeLabel = label.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const safeHref = href.replace(/"/g, "&quot;");
    const isSkill = href.startsWith("skill://");
    tokens.push({
      token: tok,
      html: isSkill
        ? `<span class="chat-skill-chip" data-skill="${safeHref}" data-label="${safeLabel}" contenteditable="false">${safeLabel}</span>`
        : `<span class="chat-mention-chip" data-href="${safeHref}" data-label="${safeLabel}" contenteditable="false">${safeLabel}</span>`,
    });
    return tok;
  };
  let withTokens = markdown.replace(MENTION_LINK_RE, (_, label, href) => placeholder(label, href));
  withTokens = withTokens.replace(SKILL_LINK_RE, (_, label, href) => placeholder(label, href));
  // Escape HTML
  withTokens = withTokens
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  // Insert tokens
  for (const { token, html } of tokens) {
    withTokens = withTokens.replace(token, html);
  }
  // Convert newlines to <br>
  return withTokens.replace(/\n/g, "<br>");
}

function htmlToMarkdown(root: HTMLElement): string {
  let out = "";
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) {
      out += n.textContent ?? "";
      return;
    }
    if (n instanceof HTMLElement) {
      if (n.classList.contains("chat-mention-chip")) {
        const href = n.getAttribute("data-href") ?? "";
        const label = n.getAttribute("data-label") ?? n.textContent ?? "@";
        out += `[${label}](${href})`;
        return;
      }
      if (n.classList.contains("chat-skill-chip")) {
        const skill = n.getAttribute("data-skill") ?? "";
        const label = n.getAttribute("data-label") ?? n.textContent ?? "/";
        out += `[${label}](${skill})`;
        return;
      }
      if (n.tagName === "BR") {
        out += "\n";
        return;
      }
      // div = paragraph break (browsers wrap each line in <div> on Enter)
      if (n.tagName === "DIV" && n.previousSibling) {
        out += "\n";
      }
      for (const c of Array.from(n.childNodes)) walk(c);
      return;
    }
  };
  for (const c of Array.from(root.childNodes)) walk(c);
  return out;
}

/**
 * 测量 caret 在 contenteditable 内的像素位置。
 * 用 Range.getBoundingClientRect() —— 当 selection collapsed 时返回 caret 矩形。
 * 边界:textarea 空 / caret 在末尾时 rect 可能 zero-width;我们用 root 的
 * 末尾位置兜底。
 */
function measureCaretRect(root: HTMLElement): { left: number; right: number; top: number; bottom: number } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0).cloneRange();
  if (!root.contains(range.startContainer)) return null;
  // 把 range 缩到一个 zero-width 起点
  range.collapse(true);
  let rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    // Caret 在空行 / 节点边界时 rect 可能为 0 —— fallback 到 root 末尾
    const r2 = document.createRange();
    r2.selectNodeContents(root);
    r2.collapse(false);
    rect = r2.getBoundingClientRect();
  }
  return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
}

export default function ChatInput({
  value,
  onChange,
  onSend,
  onStop,
  disabled,
  streaming,
  placeholder,
  workspaceId,
  agentId,
  attachments,
  onAttachmentsChange,
  onFileDrop,
  externalDragging,
}: Props) {
  const { t } = useTranslation();
  const editorRef = useRef<HTMLDivElement>(null);
  const [mentionState, setMentionState] = useState<MentionQueryState | null>(null);
  const [skillState, setSkillState] = useState<{ query: string; rect: { left: number; right: number; top: number; bottom: number } } | null>(null);
  const [dragging, setDragging] = useState(false);

  // Voice (与 V1 一致)
  const queryBeforeVoiceRef = useRef("");
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);
  const {
    isSupported: speechSupported,
    isListening,
    isStopping,
    start: startSpeech,
    stop: stopSpeech,
  } = useSpeechRecognition({
    lang: "zh-CN",
    onResult: (text) => onChange(queryBeforeVoiceRef.current + text),
  });
  const toggleVoice = useCallback(() => {
    if (isListening) stopSpeech();
    else {
      queryBeforeVoiceRef.current = value;
      startSpeech();
    }
  }, [isListening, value, startSpeech, stopSpeech]);

  // ── 同步 props.value → contenteditable HTML ──
  // 仅在 props.value 与从 DOM 抽出的 markdown 不一致时重设(避免每次输入
  // 都重设 → 光标重置)。
  useLayoutEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    const currentMd = htmlToMarkdown(el);
    if (currentMd !== value) {
      const newHtml = markdownToHtml(value);
      // 保留光标位置:value 是父级强制改(e.g. 清空 / voice 注入),光标置末
      el.innerHTML = newHtml;
      // 移光标到末尾
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
  }, [value]);

  // ── IME composition 跟踪:V2.9.12 修复 @ 后第一个拼音字母被吞 ──
  // 现象:用户按下 @ 后立刻打"wo",拼音只识别到 o,w 被当成普通字母直接写入。
  // 根因:handleInput 在 composition 进行中也会调 onChange → 父级 setState →
  //   ChatInput 的 useLayoutEffect([value]) 跑 htmlToMarkdown 读 DOM。React 18
  //   batching + 重渲染期间 contentEditable 的 selection / composition 状态
  //   会被微妙打断,Mac IME 把首个 keystroke 当成 commit (literal "w") 而不是
  //   composition start。
  // 解法:compositionstart/end 维护一个 ref,handleInput 在 composing 期间
  //   只跑 detectMentionState (picker query 实时刷新),不调 onChange。
  //   compositionend 触发时再统一 flush onChange,保证父级 value 与 DOM 同步。
  const isComposingRef = useRef(false);

  const handleCompositionStart = useCallback(() => {
    isComposingRef.current = true;
  }, []);

  const handleCompositionEnd = useCallback(() => {
    isComposingRef.current = false;
    // composition 结束后立即同步 markdown + 重检 mention,等同 handleInput 的尾部
    const el = editorRef.current;
    if (!el) return;
    const md = htmlToMarkdown(el);
    onChange(md);
    detectMentionState(el);
  }, [onChange]);

  // ── 输入事件:重新抽取 markdown,通知父组件 ──
  const handleInput = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    if (isComposingRef.current) {
      // composition 期间只更新 picker query,不动 parent value (避免重渲染
      // 把 IME 状态打断)
      detectMentionState(el);
      return;
    }
    const md = htmlToMarkdown(el);
    onChange(md);
    detectMentionState(el);
  }, [onChange]);

  const detectMentionState = useCallback((root: HTMLElement) => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
      setMentionState(null);
      setSkillState(null);
      return;
    }
    const range = sel.getRangeAt(0);
    if (!root.contains(range.startContainer)) {
      setMentionState(null);
      setSkillState(null);
      return;
    }
    const before = textBeforeCaret(root, range);
    let i = before.length - 1;
    while (i >= 0) {
      const ch = before[i];
      // @ mention trigger
      if (ch === "@") {
        const query = before.slice(i + 1);
        if (/\s/.test(query)) break;
        const rect = measureCaretRect(root);
        if (!rect) break;
        setMentionState({ triggerAnchor: rect, query });
        setSkillState(null);
        return;
      }
      // / skill trigger — only at start of line or after whitespace
      if (ch === "/") {
        const charBefore = i > 0 ? before[i - 1] : "\n";
        if (charBefore === "\n" || charBefore === " " || charBefore === "\t" || i === 0) {
          const query = before.slice(i + 1);
          if (/\s/.test(query)) break;
          const rect = measureCaretRect(root);
          if (!rect) break;
          setSkillState({ query, rect });
          setMentionState(null);
          return;
        }
      }
      if (ch === "\n" || ch === " " || ch === "\t" || ch === "]") break;
      i--;
    }
    setMentionState(null);
    setSkillState(null);
  }, []);

  const handleSelect = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    detectMentionState(el);
  }, [detectMentionState]);

  // ── Mention 选中:在 caret 处把 `@query` 替换成 chip span ──
  const handleMentionSelect = useCallback((hit: MentionHit) => {
    const el = editorRef.current;
    if (!el) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);

    // 1) 找到最近的 `@` 并选中 `@query` 范围
    const before = textBeforeCaret(el, range);
    const atIdx = before.lastIndexOf("@");
    if (atIdx < 0) return;
    const queryLen = before.length - atIdx;

    // 2) 从 caret 往后 queryLen 字符删掉(包含 @)
    deleteCharsBeforeCaret(el, queryLen);

    // 3) 插入 chip span + 一个空格
    const mentionUri = buildMentionUriFromHit(hit);
    const chip = document.createElement("span");
    chip.className = "chat-mention-chip";
    chip.contentEditable = "false";
    chip.setAttribute("data-href", mentionUri);
    chip.setAttribute("data-label", `@${hit.label}`);
    chip.textContent = `@${hit.label}`;

    const sel2 = window.getSelection();
    if (sel2 && sel2.rangeCount > 0) {
      const r = sel2.getRangeAt(0);
      r.insertNode(chip);
      // V2.9.14: caret 必须落在 text node 里面,不能落在 DIV 子节点边界。
      // 旧实现 setStartAfter(space) 让 range 落在 editor DIV 的 child-position
      // (e.g. DIV @ offset 3),Chrome IME 拿不到稳定的 composition target,
      // 导致 mention 插入后第一个字母被直接 commit 成 literal。
      // 改成:把 caret 放进 space text node 末尾(text node @ offset=1),
      // 保证下一次按键的 IME composition 有明确插入点。
      // 同时给空格 text node 后面再加一个零宽空格的 text node 做 anchor,
      // 避免 trailing space 被某些浏览器的 normalize 合并掉。
      const space = document.createTextNode(" ");
      chip.after(space);
      r.setStart(space, space.textContent!.length);
      r.setEnd(space, space.textContent!.length);
      sel2.removeAllRanges();
      sel2.addRange(r);
    }
    setMentionState(null);
    // V2.9.13: defensive — picker root 已经 preventDefault 阻止 blur,但保险
    // 起见显式 focus 回 editor,确保后续 IME composition 能正常启动。
    el.focus({ preventScroll: true } as any);
    // Notify parent
    const md = htmlToMarkdown(el);
    onChange(md);
  }, [onChange]);

  const handleMentionClose = useCallback(() => setMentionState(null), []);

  // Skill select: insert /SkillName chip
  const handleSkillSelect = useCallback((skill: AgentSkillSummary) => {
    const el = editorRef.current;
    if (!el) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const before = textBeforeCaret(el, range);
    const slashIdx = before.lastIndexOf("/");
    if (slashIdx < 0) return;
    const queryLen = before.length - slashIdx;
    deleteCharsBeforeCaret(el, queryLen);

    const chip = document.createElement("span");
    chip.className = "chat-skill-chip";
    chip.contentEditable = "false";
    chip.setAttribute("data-skill", `skill://${skill.name}`);
    chip.setAttribute("data-label", `/${skill.displayName || skill.name}`);
    chip.textContent = `/${skill.displayName || skill.name}`;

    const sel2 = window.getSelection();
    if (sel2 && sel2.rangeCount > 0) {
      const r = sel2.getRangeAt(0);
      r.insertNode(chip);
      const space = document.createTextNode(" ");
      chip.after(space);
      r.setStart(space, space.textContent!.length);
      r.setEnd(space, space.textContent!.length);
      sel2.removeAllRanges();
      sel2.addRange(r);
    }
    setSkillState(null);
    el.focus({ preventScroll: true } as any);
    const md = htmlToMarkdown(el);
    onChange(md);
  }, [onChange]);

  const handleSkillClose = useCallback(() => setSkillState(null), []);

  // Strip pasted content of all formatting — plain text only, no colors/bg.
  // Also handle pasted images → forward to onFileDrop.
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
    // Check for pasted files (images)
    const files = Array.from(e.clipboardData.files);
    if (files.length > 0 && onFileDrop) {
      e.preventDefault();
      onFileDrop(files);
      return;
    }
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    document.execCommand("insertText", false, text);
    const el = editorRef.current;
    if (el) {
      for (const node of Array.from(el.querySelectorAll("[style]"))) {
        if (!node.classList.contains("chat-mention-chip") && !node.classList.contains("chat-skill-chip")) {
          node.removeAttribute("style");
        }
      }
      for (const span of Array.from(el.querySelectorAll("span:not(.chat-mention-chip):not(.chat-skill-chip)"))) {
        const parent = span.parentNode;
        if (parent) {
          while (span.firstChild) parent.insertBefore(span.firstChild, span);
          parent.removeChild(span);
        }
      }
    }
  }, [onFileDrop]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Picker 打开时让 picker 自己处理 Up/Down/Enter/Tab/Esc(它在 capture
    // phase 监听,会先于这个 handler 触发 + stopImmediatePropagation,所以
    // 这里不会进入)。
    // Enter 发送(无 Shift)
    if (
      e.key === "Enter" &&
      !e.shiftKey &&
      !e.nativeEvent.isComposing &&
      !mentionState // picker 已经吞了
    ) {
      e.preventDefault();
      const md = htmlToMarkdown(editorRef.current!);
      // V3.0 PR4: streaming 时也允许发送 (走 branch / queue 路径)
      if (md.trim() && !disabled) onSend();
      return;
    }
    // Backspace 删除 chip 时浏览器默认行为已经原子删除(因为 contentEditable=false)
  };

  // V3.0 PR4: 任何时刻都允许发,只要内容非空。streaming 不再 disable input 或 voice。
  // 后端 turnOrchestrator 会处理:idle 起新主线 / inflight 起 branch / synth 中入队列。
  const hasText = value.trim().length > 0;
  const canSend = !disabled && hasText;
  // 4-state submit button (对齐 AI filter 的 send/stop 切换 + V3.0 append 路径):
  //   ┌──────────────┬──────┬────────────────────┐
  //   │ idle + empty │ disabled "Send"          │
  //   │ idle + text  │ active "Send" (primary)  │
  //   │ gen  + empty │ "Stop" (red, fires onStop) │
  //   │ gen  + text  │ "Append" (primary)       │
  //   └──────────────┴────────────────────────────┘
  // gen + empty → Stop 让用户能即时打断;gen + text → Append 走 V3.0 branch
  // 路径(同一个 onSend,父级 handleSend 自己分派 main vs append)。
  type SubmitMode = "send-disabled" | "send" | "stop" | "append";
  const submitMode: SubmitMode = streaming
    ? hasText ? "append" : "stop"
    : canSend ? "send" : "send-disabled";

  const onSubmitClick = () => {
    if (submitMode === "stop") onStop();
    else if (submitMode === "send" || submitMode === "append") onSend();
    // send-disabled = no-op
  };

  const submitTitle =
    submitMode === "stop"   ? t("chat.input.stop")
  : submitMode === "append" ? t("chat.input.append")
  :                           t("chat.input.send");

  // Drag and drop files
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes("Files")) setDragging(true);
  }, []);
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
  }, []);
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0 && onFileDrop) onFileDrop(files);
  }, [onFileDrop]);

  return (
    <div className="chat-input-wrap">
      <div className="chat-input-box">
        <div className="chat-input-content">
          {/* Attachment thumbnails inside editor area, above text */}
          {attachments && attachments.length > 0 && (
            <div className="chat-attachments-inline">
              {attachments.map((att) => (
                <div key={att.id} className="chat-attachment-thumb-wrap">
                  {att.mime.startsWith("image/") ? (
                    <img className="chat-attachment-thumb-img" src={att.url} alt={att.originalName} />
                  ) : (
                    <div className="chat-attachment-thumb-file">
                      <span className="chat-attachment-thumb-ext">{att.originalName.split(".").pop()}</span>
                    </div>
                  )}
                  <button
                    className="chat-attachment-thumb-remove"
                    onClick={() => onAttachmentsChange?.(attachments.filter((a) => a.id !== att.id))}
                  >
                    <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                      <path d="M1 1l6 6M7 1l-6 6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
          <div
            ref={editorRef}
            className={`chat-input-editor${value.length === 0 ? " is-empty" : ""}`}
            contentEditable={!disabled}
            suppressContentEditableWarning
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onKeyUp={handleSelect}
            onMouseUp={handleSelect}
            onPaste={handlePaste}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
            data-placeholder={
              placeholder ??
              (streaming
                ? t("chat.input.placeholder.streaming")
                : t("chat.input.placeholder"))
            }
          />
          {mentionState && (
            <MentionPicker
              workspaceId={workspaceId}
              query={mentionState.query}
              atRect={mentionState.triggerAnchor}
              types={["model", "table", "design", "taste", "idea", "demo"]}
              placement="above-right"
              onSelect={handleMentionSelect}
              onClose={handleMentionClose}
            />
          )}
          {skillState && agentId && (
            <SkillPicker
              agentId={agentId}
              query={skillState.query}
              atRect={skillState.rect}
              onSelect={handleSkillSelect}
              onClose={handleSkillClose}
            />
          )}
        </div>
        <div className="chat-input-toolbar">
          <div className="chat-input-tools-left">
            {/* @ mention button removed — replaced by drag-to-upload */}
          </div>
          <div className="chat-input-tools-right">
            {/* V3.0 PR4: generating 提示移到对话流中,不再占输入框右侧空间 */}
            {speechSupported && (
              <button
                type="button"
                className={`chat-input-voice-btn${
                  isListening ? (isStopping ? " stopping" : " listening") : ""
                }`}
                onClick={toggleVoice}
                disabled={isStopping || disabled}
                title={
                  isStopping
                    ? t("chat.input.voice.stopping")
                    : isListening
                      ? t("chat.input.voice.listening")
                      : t("chat.input.voice.idle")
                }
                aria-label={t("chat.input.voice.idle")}
              >
                <MicIcon size={14} />
                {isListening && !isStopping && <span className="chat-input-voice-pulse" />}
                {isStopping && <span className="chat-input-voice-stopping" />}
              </button>
            )}
            {/* V3.0 PR4 + UX-2026-05: 4-state submit 按钮
             *   - send-disabled: 灰色,不响应
             *   - send: 主色,Send 图标,起新 turn
             *   - stop:   红色, Stop 图标,中断当前 turn (空输入时)
             *   - append: 主色,Append 图标,追加为 branch (有输入 + streaming) */}
            <button
              type="button"
              className={`chat-input-send mode-${submitMode}`}
              onClick={onSubmitClick}
              disabled={submitMode === "send-disabled"}
              title={submitTitle}
              aria-label={submitTitle}
            >
              {submitMode === "stop" ? <StopIcon size={14} />
              : submitMode === "append" ? <AppendIcon size={14} />
              : <SendIcon size={14} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Helpers ───

/**
 * Walk root from start to caret and accumulate "logical text" — text nodes
 * pass through verbatim;mention chips contribute their `data-label`(以 @ 开头).
 * 这样我们能正确识别 caret 所在的 `@query`(即使前面有 chip 也不会把 chip
 * 的 `@Foo` 当作"@开头" -— chip 是 atomic,在这个文本流里它就是单个 token,
 * lastIndexOf('@') 只会查 plain text 里的 @)。
 *
 * 简化:把 chip 视为一个空格(分隔符),这样 lastIndexOf 不会跨过它。
 */
function textBeforeCaret(root: HTMLElement, range: Range): string {
  const r = document.createRange();
  r.setStart(root, 0);
  r.setEnd(range.startContainer, range.startOffset);
  // Create a temporary fragment, replace chip nodes with spaces, then read text
  const frag = r.cloneContents();
  const tmp = document.createElement("div");
  tmp.appendChild(frag);
  // 把 chip 替成单空格
  for (const chip of Array.from(tmp.querySelectorAll(".chat-mention-chip"))) {
    chip.replaceWith(document.createTextNode(" "));
  }
  return tmp.textContent ?? "";
}

/**
 * 从 caret 往前删 N 个字符。chip 算 1 个原子;穿过 chip 时整块删除。
 * 实现:用 Selection.modify 单步左移 N 次;Selection 自动跳过 contentEditable=false 的节点。
 */
function deleteCharsBeforeCaret(root: HTMLElement, n: number): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  // Selection.modify 是 webkit + firefox 都支持的 backwardChar 扩展选区
  for (let i = 0; i < n; i++) {
    (sel as any).modify("extend", "backward", "character");
  }
  if (sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    range.deleteContents();
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

/** Re-derive mention URI from a hit. Should match what mentionSyntax.buildMentionLink does. */
function buildMentionUriFromHit(hit: MentionHit): string {
  const params: string[] = [];
  if (hit.type === "taste" && hit.designId) params.push(`design=${encodeURIComponent(hit.designId)}`);
  if (hit.type === "idea-section" && hit.ideaId) params.push(`idea=${encodeURIComponent(hit.ideaId)}`);
  const q = params.length ? `?${params.join("&")}` : "";
  return `mention://${hit.type}/${encodeURIComponent(hit.id)}${q}`;
}
