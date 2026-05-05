/**
 * UserBubble — right-aligned user message.
 *
 * Renders attachment thumbnails above text, both inside the bubble.
 * Parses [@label](mention://...) and [/label](skill://...) as colored chips.
 * Image attachments rendered as ![name](url) in content are shown as thumbnails.
 */

import { Fragment } from "react";

// Matches [@label](mention://...) and [/label](skill://...)
const CHIP_RE = /\[([^\]]+)\]\(((mention|skill):\/\/[^)]+)\)/g;
// Matches ![alt](url) image attachments
const IMG_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;
// Matches [label](url) file attachments (non-mention, non-skill, non-image)
const FILE_RE = /(?<!!)\[([^\]]+)\]\(((?!mention:|skill:)[^)]+)\)/g;

interface ParsedContent {
  images: Array<{ alt: string; url: string }>;
  files: Array<{ name: string; url: string }>;
  text: string;
}

function parseContent(raw: string): ParsedContent {
  const images: ParsedContent["images"] = [];
  const files: ParsedContent["files"] = [];

  // Extract images
  let text = raw.replace(IMG_RE, (_, alt, url) => {
    images.push({ alt, url });
    return "";
  });

  // Extract file links
  text = text.replace(FILE_RE, (_, name, url) => {
    files.push({ name, url });
    return "";
  });

  return { images, files, text: text.trim() };
}

function renderTextWithChips(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  CHIP_RE.lastIndex = 0;
  while ((m = CHIP_RE.exec(text)) !== null) {
    const [full, label, href, scheme] = m;
    if (m.index > last) out.push(text.slice(last, m.index));
    const isSkill = scheme === "skill";
    out.push(
      <span
        key={`chip-${m.index}`}
        className={isSkill ? "chat-skill-chip" : "chat-mention-chip"}
        data-href={href}
      >
        {label}
      </span>,
    );
    last = m.index + full.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.length === 0 ? [text] : out;
}

function getExt(name: string): string {
  return name.split(".").pop()?.toUpperCase() || "FILE";
}

export default function UserBubble({ content }: { content: string }) {
  const { images, files, text } = parseContent(content);
  const hasAttachments = images.length > 0 || files.length > 0;
  const textNodes = renderTextWithChips(text);

  return (
    <div className="chat-msg-user-row">
      <div className="chat-msg-user">
        {hasAttachments && (
          <div className="chat-msg-user-attachments">
            {images.map((img, i) => (
              <img key={`img-${i}`} className="chat-msg-user-att-thumb" src={img.url} alt={img.alt} />
            ))}
            {files.map((f, i) => (
              <a key={`file-${i}`} className="chat-msg-user-att-file" href={f.url} target="_blank" rel="noreferrer" title={f.name}>
                {getExt(f.name)}
              </a>
            ))}
          </div>
        )}
        {text && (
          <span className="chat-msg-user-text">
            {textNodes.map((n, i) => (
              <Fragment key={i}>{n}</Fragment>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}
