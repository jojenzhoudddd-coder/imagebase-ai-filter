/**
 * downscaleImage — 把任意 data URL 缩到指定最大边长，输出为 JPEG data URL。
 * 用于头像上传：不管用户原图多大（手机 8MB 照片、拍立得 full-size scan），
 * 上传前统一缩到 ~256px、JPEG quality 0.85，实际字节数通常 < 50KB。
 *
 * 为什么输出 JPEG：
 * - 头像渲染尺寸最大 80px × 80px，256 源图已经超采样够用
 * - JPEG 0.85 在"肉眼难辨"和"体积友好"之间是甜蜜点
 * - PNG 的透明通道对头像几乎没用；JPEG 的几十 KB 体积显著好于同尺寸 PNG
 *
 * 如果源图小于目标边长，不放大，直接重新编码一次（依然能压掉 PNG 的体积）。
 *
 * @param dataUrl  `data:image/...;base64,...`
 * @param maxSize  最大边长（宽或高取较大者），默认 256
 * @param quality  JPEG 质量 0..1，默认 0.85
 * @returns        缩放后的 data URL（`data:image/jpeg;base64,...`）
 */
export function downscaleImage(
  dataUrl: string,
  maxSize = 256,
  quality = 0.85,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const { width, height } = img;
      const longest = Math.max(width, height);
      const scale = longest > maxSize ? maxSize / longest : 1;
      const targetW = Math.round(width * scale);
      const targetH = Math.round(height * scale);

      const canvas = document.createElement("canvas");
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("canvas 2d context 不可用"));
        return;
      }
      // 透明背景的 PNG 转 JPEG 时默认会变成黑色，先填白底
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, targetW, targetH);
      ctx.drawImage(img, 0, 0, targetW, targetH);

      try {
        resolve(canvas.toDataURL("image/jpeg", quality));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    img.onerror = () => reject(new Error("图片加载失败"));
    img.src = dataUrl;
  });
}
