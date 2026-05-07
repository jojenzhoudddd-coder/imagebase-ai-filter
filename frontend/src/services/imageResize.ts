/**
 * Client-side image resize for vision capability.
 *
 * Resizes images to MAX_DIMENSION (1568px long edge, Anthropic recommended)
 * before upload. This reduces token cost for vision models and speeds up
 * upload/base64 encoding.
 *
 * Uses canvas-based downsampling — works in all modern browsers, no deps.
 */

const MAX_DIMENSION = 1568;

/**
 * Resize an image File if it exceeds MAX_DIMENSION on either side.
 * Returns a new File (possibly smaller), or the original if no resize needed.
 * Non-image files are returned as-is.
 */
export async function resizeImageIfNeeded(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) return file;
  // SVGs don't need resizing (they're vector)
  if (file.type === "image/svg+xml") return file;

  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(url);

      const { naturalWidth: w, naturalHeight: h } = img;
      if (w <= MAX_DIMENSION && h <= MAX_DIMENSION) {
        resolve(file); // No resize needed
        return;
      }

      // Compute new dimensions preserving aspect ratio
      const ratio = Math.min(MAX_DIMENSION / w, MAX_DIMENSION / h);
      const newW = Math.round(w * ratio);
      const newH = Math.round(h * ratio);

      const canvas = document.createElement("canvas");
      canvas.width = newW;
      canvas.height = newH;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0, newW, newH);

      // Output as same type if supported, else fallback to PNG
      const outputType = file.type === "image/jpeg" ? "image/jpeg" : "image/png";
      const quality = file.type === "image/jpeg" ? 0.85 : undefined;

      canvas.toBlob(
        (blob) => {
          if (!blob) {
            resolve(file); // Fallback to original on error
            return;
          }
          const resized = new File([blob], file.name, {
            type: outputType,
            lastModified: file.lastModified,
          });
          resolve(resized);
        },
        outputType,
        quality,
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(file); // Fallback to original on error
    };

    img.src = url;
  });
}
