/**
 * AvatarCropDialog — modal for picking a square crop region out of an
 * uploaded image before it's compressed + sent to the backend.
 *
 * 行为：
 *   · 用户上传任意图片（大小由调用方把关），本组件接 dataUrl
 *   · 渲染图片到 canvas-sized 预览区（最大 360×360），保持原比例
 *   · 一个方形选框叠在图片上：
 *       - 选框内部拖动 → 平移
 *       - 4 个角 (12×12 把手) 拖动 → 改尺寸（保持正方形,头像渲染是圆的)
 *     选框可以缩到 32px 最小,大可以撑满图片较短边。
 *   · "确定"按钮 → 从原图按视觉选框对应的真实坐标切出来、缩到 256 JPEG，
 *     交给 onConfirm(croppedDataUrl)
 *   · "取消" → onCancel()
 *
 * 挂在 document.body 下 (createPortal)，overlay z-index 高于一切。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "../i18n/index";
import "./AvatarCropDialog.css";

interface Props {
  /** 原图 data URL —— 调用方已经走过 FileReader。 */
  sourceDataUrl: string;
  /** 用户点"确定"并完成裁剪+压缩后调用，带上 cropped JPEG data URL。 */
  onConfirm: (croppedDataUrl: string) => void;
  onCancel: () => void;
}

const PREVIEW_SIZE = 360; // 预览区最大边长
const OUTPUT_SIZE = 256;  // 最终输出正方形边长
const OUTPUT_QUALITY = 0.85;
const MIN_CROP_SIZE = 32; // 选框最小边长

type Corner = "nw" | "ne" | "sw" | "se";
type DragKind = { kind: "move" } | { kind: "resize"; corner: Corner };

export default function AvatarCropDialog({ sourceDataUrl, onConfirm, onCancel }: Props) {
  const { t } = useTranslation();
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  /** 预览区实际渲染尺寸（保持比例，≤ PREVIEW_SIZE）。 */
  const [previewSize, setPreviewSize] = useState<{ w: number; h: number }>({ w: PREVIEW_SIZE, h: PREVIEW_SIZE });
  /** 选框 left/top/size —— 全部相对预览区像素坐标,size 是边长(始终正方形)。 */
  const [crop, setCrop] = useState<{ x: number; y: number; size: number }>({ x: 0, y: 0, size: 0 });
  const imgRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{
    kind: DragKind;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    origSize: number;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // 图片加载后：计算预览尺寸 + 把裁剪框居中到图像中间
  const onImgLoad = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    setNaturalSize({ w, h });
    // 等比缩放进 PREVIEW_SIZE × PREVIEW_SIZE 方格
    const scale = Math.min(PREVIEW_SIZE / w, PREVIEW_SIZE / h);
    const pw = Math.round(w * scale);
    const ph = Math.round(h * scale);
    setPreviewSize({ w: pw, h: ph });
    const cs = Math.min(pw, ph);
    setCrop({
      x: Math.round((pw - cs) / 2),
      y: Math.round((ph - cs) / 2),
      size: cs,
    });
  }, []);

  /** 通用 pointerdown 处理 —— 接受 DragKind 决定是平移还是改尺寸。 */
  const startDrag = useCallback((kind: DragKind, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = {
      kind,
      startX: e.clientX,
      startY: e.clientY,
      origX: crop.x,
      origY: crop.y,
      origSize: crop.size,
    };
    const onMove = (ev: MouseEvent) => {
      const ds = dragRef.current;
      if (!ds) return;
      const dx = ev.clientX - ds.startX;
      const dy = ev.clientY - ds.startY;

      if (ds.kind.kind === "move") {
        const maxX = previewSize.w - ds.origSize;
        const maxY = previewSize.h - ds.origSize;
        setCrop({
          x: Math.max(0, Math.min(maxX, ds.origX + dx)),
          y: Math.max(0, Math.min(maxY, ds.origY + dy)),
          size: ds.origSize,
        });
        return;
      }

      // resize:保持正方形 —— 取 dx/dy 中"扩张"的一方为主导(用户感知更顺)。
      // 用 max(|dx|,|dy|) 决定 size 增量,根据 corner 方向决定符号 + 锚点。
      const corner = ds.kind.corner;
      // 锚点 = 选框对角(不动那个角的预览坐标)
      const anchorX = corner === "nw" || corner === "sw" ? ds.origX + ds.origSize : ds.origX;
      const anchorY = corner === "nw" || corner === "ne" ? ds.origY + ds.origSize : ds.origY;
      // 主导方向上的拖动距离(向"远离锚点"为正,放大;向"靠近锚点"为负,缩小)
      const signX = corner === "ne" || corner === "se" ? 1 : -1;
      const signY = corner === "sw" || corner === "se" ? 1 : -1;
      const dragX = signX * dx;
      const dragY = signY * dy;
      // 取主导(用户拖得更远的那个轴)作为 size delta —— 视觉跟手
      const delta = Math.abs(dragX) > Math.abs(dragY) ? dragX : dragY;
      let newSize = ds.origSize + delta;
      // 边界:不能小于 MIN,不能让选框越出图像
      const maxSize = Math.min(
        signX > 0 ? previewSize.w - anchorX : anchorX,
        signY > 0 ? previewSize.h - anchorY : anchorY,
      );
      newSize = Math.max(MIN_CROP_SIZE, Math.min(maxSize, newSize));
      // 由 anchor + size + 方向反推新的 left/top
      const newX = signX > 0 ? anchorX : anchorX - newSize;
      const newY = signY > 0 ? anchorY : anchorY - newSize;
      setCrop({ x: newX, y: newY, size: newSize });
    };
    const onUp = () => {
      dragRef.current = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [crop.x, crop.y, crop.size, previewSize.w, previewSize.h]);

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  async function handleConfirm() {
    if (!naturalSize) return;
    setSubmitting(true);
    try {
      // 视觉坐标 → 原图真实像素坐标（按缩放比反推）
      const scaleX = naturalSize.w / previewSize.w;
      const scaleY = naturalSize.h / previewSize.h;
      const sx = crop.x * scaleX;
      const sy = crop.y * scaleY;
      const sSize = crop.size * scaleX; // scaleX === scaleY 因为保比缩放

      const canvas = document.createElement("canvas");
      canvas.width = OUTPUT_SIZE;
      canvas.height = OUTPUT_SIZE;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas context unavailable");
      ctx.fillStyle = "#FFFFFF"; // JPEG 不支持透明，预填白底
      ctx.fillRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
      const img = imgRef.current;
      if (!img) throw new Error("image not loaded");
      ctx.drawImage(img, sx, sy, sSize, sSize, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
      const dataUrl = canvas.toDataURL("image/jpeg", OUTPUT_QUALITY);
      onConfirm(dataUrl);
    } catch (err) {
      console.error("[avatar-crop]", err);
      setSubmitting(false);
    }
  }

  const corners: Array<{ corner: Corner; style: React.CSSProperties; cursor: string }> = [
    { corner: "nw", style: { left: -6, top: -6 }, cursor: "nwse-resize" },
    { corner: "ne", style: { right: -6, top: -6 }, cursor: "nesw-resize" },
    { corner: "sw", style: { left: -6, bottom: -6 }, cursor: "nesw-resize" },
    { corner: "se", style: { right: -6, bottom: -6 }, cursor: "nwse-resize" },
  ];

  return createPortal(
    <div className="avatar-crop-overlay" onMouseDown={onCancel}>
      <div className="avatar-crop-card" onMouseDown={(e) => e.stopPropagation()}>
        <div className="avatar-crop-title">{t("topbar.cropTitle")}</div>
        <div className="avatar-crop-hint">{t("topbar.cropHint")}</div>
        <div
          className="avatar-crop-stage"
          style={{ width: previewSize.w, height: previewSize.h }}
        >
          <img
            ref={imgRef}
            src={sourceDataUrl}
            alt=""
            className="avatar-crop-image"
            onLoad={onImgLoad}
            draggable={false}
          />
          <div
            className="avatar-crop-box"
            style={{
              left: crop.x,
              top: crop.y,
              width: crop.size,
              height: crop.size,
            }}
            onMouseDown={(e) => startDrag({ kind: "move" }, e)}
          >
            {corners.map((c) => (
              <div
                key={c.corner}
                className={`avatar-crop-handle handle-${c.corner}`}
                style={{ ...c.style, cursor: c.cursor }}
                onMouseDown={(e) => startDrag({ kind: "resize", corner: c.corner }, e)}
              />
            ))}
          </div>
          {/* 4 条 dim mask：选框外 4 块半透明黑，视觉上突出选区 */}
          <div className="avatar-crop-dim" style={{ left: 0, top: 0, width: previewSize.w, height: crop.y }} />
          <div className="avatar-crop-dim" style={{ left: 0, top: crop.y + crop.size, width: previewSize.w, height: previewSize.h - crop.y - crop.size }} />
          <div className="avatar-crop-dim" style={{ left: 0, top: crop.y, width: crop.x, height: crop.size }} />
          <div className="avatar-crop-dim" style={{ left: crop.x + crop.size, top: crop.y, width: previewSize.w - crop.x - crop.size, height: crop.size }} />
        </div>
        <div className="avatar-crop-actions">
          <button type="button" className="avatar-crop-btn avatar-crop-btn-cancel" onClick={onCancel} disabled={submitting}>
            {t("topbar.cancelAvatar")}
          </button>
          <button type="button" className="avatar-crop-btn avatar-crop-btn-ok" onClick={handleConfirm} disabled={submitting || !naturalSize}>
            {t("topbar.saveAvatar")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
