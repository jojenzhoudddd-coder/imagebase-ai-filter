export default function ThinkingIndicator({
  text = "深度思考中",
}: {
  text?: string;
}) {
  return (
    <div className="chat-thinking">
      <span>{text}</span>
      <span className="chat-thinking-dots">
        <span />
        <span />
        <span />
      </span>
    </div>
  );
}
