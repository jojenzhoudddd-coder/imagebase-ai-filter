/**
 * AvatarCropDialog — modal for picking a square crop region out of an
 * uploaded image before it's compressed + sent to the backend.
 *
 * 行为：
 *   · 用户上传任意图片（大小由调用方把关），本组件接 dataUrl
 *   · 渲染图片到 canvas-sized 预览区（最大 360×360），保持原比例
 *   · 一个方形选框叠在图片上，用户可以拖动（只支持平移，不支持改尺寸 —
 *     尺寸固定为图片较短边，这样永远能选满；简单够用）
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

export default function AvatarCropDialog({ sourceDataUrl, onConfirm, onCancel }: Props) {
  const { t } = useTranslation();
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  /** 预览区实际渲染尺寸（保持比例，≤ PREVIEW_SIZE）。 */
  const [previewSize, setPreviewSize] = useState<{ w: number; h: number }>({ w: PREVIEW_SIZE, h: PREVIEW_SIZE });
  /** 选框左上角相对预览区的像素坐标。 */
  const [cropXY, setCropXY] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  /** 选框边长 —— = min(preview.w, preview.h)。 */
  const cropSize = Math.min(previewSize.w, previewSize.h);
  const imgRef = useRef<HTMLImageElement>(null);
  const dragStateRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
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
    setCropXY({ x: Math.round((pw - cs) / 2), y: Math.round((ph - cs) / 2) });
  }, []);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragStateRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: cropXY.x,
      origY: cropXY.y,
    };
    const onMove = (ev: MouseEvent) => {
      const ds = dragStateRef.current;
      if (!ds) return;
      const dx = ev.clientX - ds.startX;
      const dy = ev.clientY - ds.startY;
      const maxX = previewSize.w - cropSize;
      const maxY = previewSize.h - cropSize;
      setCropXY({
        x: Math.max(0, Math.min(maxX, ds.origX + dx)),
        y: Math.max(0, Math.min(maxY, ds.origY + dy)),
      });
    };
    const onUp = () => {
      dragStateRef.current = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [cropXY.x, cropXY.y, cropSize, previewSize.w, previewSize.h]);

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
      const sx = cropXY.x * scaleX;
      const sy = cropXY.y * scaleY;
      const sSize = cropSize * scaleX; // scaleX === scaleY 因为保比缩放

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
              left: cropXY.x,
              top: cropXY.y,
              width: cropSize,
              height: cropSize,
            }}
            onMouseDown={onMouseDown}
          />
          {/* 4 条 dim mask：选框外 4 块半透明黑，视觉上突出选区 */}
          <div className="avatar-crop-dim" style={{ left: 0, top: 0, width: previewSize.w, height: cropXY.y }} />
          <div className="avatar-crop-dim" style={{ left: 0, top: cropXY.y + cropSize, width: previewSize.w, height: previewSize.h - cropXY.y - cropSize }} />
          <div className="avatar-crop-dim" style={{ left: 0, top: cropXY.y, width: cropXY.x, height: cropSize }} />
          <div className="avatar-crop-dim" style={{ left: cropXY.x + cropSize, top: cropXY.y, width: previewSize.w - cropXY.x - cropSize, height: cropSize }} />
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
