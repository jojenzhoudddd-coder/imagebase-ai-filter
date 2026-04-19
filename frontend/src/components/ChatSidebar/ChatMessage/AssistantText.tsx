export default function AssistantText({
  content,
  streaming,
}: {
  content: string;
  streaming?: boolean;
}) {
  // Render nothing when we have neither streamed text nor an in-flight
  // placeholder slot — the parent MessageBlock still shows the thinking
  // indicator in that window, so the transcript isn't silent.
  if (!content && !streaming) return null;
  // No cursor-blink class here: the previous ".streaming" marker added a
  // trailing ▌ block via CSS which the product team asked to drop —
  // generation feedback now lives solely on the "生成中" hint in the input
  // toolbar and the thinking indicator above the answer.
  return <div className="chat-msg-assistant">{content}</div>;
}
