/**
 * UserBubble — right-aligned user message.
 *
 * Figma nodes 6:2986 "用户" (row) + 6:2987 "Desktop / Chat cell" (bubble).
 * The row gives the bubble a 40px left gutter + justify-end; the bubble is
 * flex-1 inside that row so long messages wrap within the available width
 * (see .chat-msg-user-row / .chat-msg-user in ChatSidebar.css).
 */
export default function UserBubble({ content }: { content: string }) {
  return (
    <div className="chat-msg-user-row">
      <div className="chat-msg-user">
        <span className="chat-msg-user-text">{content}</span>
      </div>
    </div>
  );
}
