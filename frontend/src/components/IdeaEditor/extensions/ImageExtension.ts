/**
 * ImageExtension — Extends @tiptap/extension-image with paste/drop upload.
 *
 * When files are pasted or dropped, calls the provided `onUpload` callback
 * which should upload the file and return `{ url, mime, originalName }`.
 * The extension then inserts an image node at the current selection.
 */

import Image from "@tiptap/extension-image";
import { Plugin } from "@tiptap/pm/state";

export interface ImageUploadResult {
  url: string;
  mime: string;
  originalName?: string | null;
}

export function createImageExtension(
  onUpload?: (file: File) => Promise<ImageUploadResult>,
) {
  return Image.extend({
    addProseMirrorPlugins() {
      const uploadFn = onUpload;
      if (!uploadFn) return [];

      return [
        new Plugin({
          props: {
            handlePaste(view, event) {
              const items = Array.from(event.clipboardData?.items ?? []);
              const files = items
                .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
                .map((it) => it.getAsFile())
                .filter((f): f is File => !!f);
              if (files.length === 0) return false;

              event.preventDefault();
              for (const file of files) {
                uploadFn(file).then((result) => {
                  const node = view.state.schema.nodes.image.create({
                    src: result.url,
                    alt: result.originalName || "image",
                  });
                  const tr = view.state.tr.replaceSelectionWith(node);
                  view.dispatch(tr);
                }).catch((err) => {
                  console.warn("[ImageExtension] upload failed:", err);
                });
              }
              return true;
            },
            handleDrop(view, event) {
              const files = Array.from(event.dataTransfer?.files ?? []).filter(
                (f) => f.type.startsWith("image/"),
              );
              if (files.length === 0) return false;

              event.preventDefault();
              const coords = view.posAtCoords({
                left: event.clientX,
                top: event.clientY,
              });
              for (const file of files) {
                uploadFn(file).then((result) => {
                  const node = view.state.schema.nodes.image.create({
                    src: result.url,
                    alt: result.originalName || "image",
                  });
                  const pos = coords?.pos ?? view.state.selection.from;
                  const tr = view.state.tr.insert(pos, node);
                  view.dispatch(tr);
                }).catch((err) => {
                  console.warn("[ImageExtension] drop upload failed:", err);
                });
              }
              return true;
            },
          },
        }),
      ];
    },
  });
}
