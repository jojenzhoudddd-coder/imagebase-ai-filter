/**
 * ChatMediaPreview — renders media (image/video/audio/pdf/text) inline in chat.
 * Auto-detects type from URL extension. Self-adapts to chat bubble width.
 */

import { useState } from "react";

const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico)(\?|$)/i;
const VIDEO_EXT = /\.(mp4|webm|mov|avi|mkv)(\?|$)/i;
const AUDIO_EXT = /\.(mp3|wav|ogg|aac|flac|m4a)(\?|$)/i;
const PDF_EXT = /\.pdf(\?|$)/i;
const TEXT_EXT = /\.(txt|md|csv|json|xml|yaml|yml|log|sh|py|js|ts|tsx|jsx|html|css|sql|toml|ini|conf|env)(\?|$)/i;

export type MediaType = "image" | "video" | "audio" | "pdf" | "text" | "file";

export function detectMediaType(url: string): MediaType {
  if (IMG_EXT.test(url)) return "image";
  if (VIDEO_EXT.test(url)) return "video";
  if (AUDIO_EXT.test(url)) return "audio";
  if (PDF_EXT.test(url)) return "pdf";
  if (TEXT_EXT.test(url)) return "text";
  return "file";
}

export function isMediaUrl(url: string | undefined): boolean {
  if (!url) return false;
  return detectMediaType(url) !== "file";
}

function getFileName(url: string): string {
  try {
    const path = new URL(url).pathname;
    return decodeURIComponent(path.split("/").pop() || url);
  } catch {
    return url.split("/").pop() || url;
  }
}

interface Props {
  src: string;
  alt?: string;
}

export default function ChatMediaPreview({ src, alt }: Props) {
  const type = detectMediaType(src);
  const [imgError, setImgError] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const fileName = getFileName(src);

  if (type === "image") {
    if (imgError) {
      return (
        <a className="chat-media-file" href={src} target="_blank" rel="noreferrer noopener">
          <span className="chat-media-file-icon">🖼</span>
          <span className="chat-media-file-name">{alt || fileName}</span>
        </a>
      );
    }
    return (
      <>
        <img
          className="chat-media-img"
          src={src}
          alt={alt || ""}
          loading="lazy"
          onClick={() => setExpanded(true)}
          onError={() => setImgError(true)}
        />
        {expanded && (
          <div className="chat-media-lightbox" onClick={() => setExpanded(false)}>
            <img src={src} alt={alt || ""} />
          </div>
        )}
      </>
    );
  }

  if (type === "video") {
    return (
      <div className="chat-media-video-wrap">
        <video className="chat-media-video" controls preload="metadata">
          <source src={src} />
        </video>
      </div>
    );
  }

  if (type === "audio") {
    return (
      <div className="chat-media-audio-wrap">
        <audio className="chat-media-audio" controls preload="metadata">
          <source src={src} />
        </audio>
      </div>
    );
  }

  if (type === "pdf") {
    return (
      <div className="chat-media-pdf-wrap">
        <iframe className="chat-media-pdf" src={src} title={fileName} />
        <a className="chat-media-file" href={src} target="_blank" rel="noreferrer noopener">
          <span className="chat-media-file-icon">📄</span>
          <span className="chat-media-file-name">{fileName}</span>
          <span className="chat-media-file-download">↓</span>
        </a>
      </div>
    );
  }

  if (type === "text") {
    return <ChatTextPreview src={src} fileName={fileName} />;
  }

  // Generic file download
  return (
    <a className="chat-media-file" href={src} target="_blank" rel="noreferrer noopener">
      <span className="chat-media-file-icon">📎</span>
      <span className="chat-media-file-name">{fileName}</span>
      <span className="chat-media-file-download">↓</span>
    </a>
  );
}

/** Fetch text content and show in a code block */
function ChatTextPreview({ src, fileName }: { src: string; fileName: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  if (loading && content === null) {
    fetch(src)
      .then((r) => r.text())
      .then((t) => setContent(t.slice(0, 5000)))
      .catch(() => setContent(null))
      .finally(() => setLoading(false));
  }

  return (
    <div className="chat-media-text-wrap">
      <div className="chat-media-text-header">
        <span className="chat-media-file-icon">📝</span>
        <span className="chat-media-file-name">{fileName}</span>
        <a className="chat-media-file-download" href={src} target="_blank" rel="noreferrer noopener">↓</a>
      </div>
      {loading ? (
        <div className="chat-media-text-loading">Loading...</div>
      ) : content ? (
        <pre className="chat-media-text-content"><code>{content}{content.length >= 5000 ? "\n…(truncated)" : ""}</code></pre>
      ) : (
        <a className="chat-media-file" href={src} target="_blank" rel="noreferrer noopener">Open file</a>
      )}
    </div>
  );
}
