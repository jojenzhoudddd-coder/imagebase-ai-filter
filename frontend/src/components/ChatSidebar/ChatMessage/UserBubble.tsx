/**
 * UserBubble — right-aligned user message.
 *
 * Figma nodes 6:2986 "用户" (row) + 6:2987 "Desktop / Chat cell" (bubble).
 * The row gives the bubble a 40px left gutter + justify-end; the bubble is
 * flex-1 inside that row so long messages wrap within the available width
 * (see .chat-msg-user-row / .chat-msg-user in ChatSidebar.css).
 *
 * V2.9.1 #4: 把 [@label](mention://...) 解析成蓝字 chip,与 AssistantText
 * 一致(用户在 ChatInput 选 @ 时实际写入的就是这个 markdown link 语法)。
 */

import { Fragment } from "react";

const MENTION_RE = /\[([^\]]+)\]\((mention:\/\/[^)]+)\)/g;

function renderUserContentWithMentions(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(text)) !== null) {
    const [full, label, href] = m;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <span key={`mn-${m.index}`} className="chat-mention-chip" data-href={href}>
        {label}
      </span>,
    );
    last = m.index + full.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.length === 0 ? [text] : out;
}

export default function UserBubble({ content }: { content: string }) {
  const nodes = renderUserContentWithMentions(content);
  return (
    <div className="chat-msg-user-row">
      <div className="chat-msg-user">
        <span className="chat-msg-user-text">
          {nodes.map((n, i) => (
            <Fragment key={i}>{n}</Fragment>
          ))}
        </span>
      </div>
    </div>
  );
}
