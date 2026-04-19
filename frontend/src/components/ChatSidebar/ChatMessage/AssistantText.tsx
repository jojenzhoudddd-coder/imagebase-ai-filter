export default function AssistantText({
  content,
  streaming,
}: {
  content: string;
  streaming?: boolean;
}) {
  if (!content && !streaming) return null;
  return (
    <div className={`chat-msg-assistant${streaming ? " streaming" : ""}`}>
      {content}
    </div>
  );
}
