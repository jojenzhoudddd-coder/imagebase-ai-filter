/**
 * /api/chat/attachments — file upload for chat messages.
 * Files stored at ~/.imagebase/uploads/chat/<fileId>.<ext>
 * Served statically at /uploads/chat/...
 */

import express, { type Request, type Response } from "express";
import multer from "multer";
import path from "path";
import os from "os";
import fsp from "fs/promises";
import crypto from "crypto";

const UPLOAD_ROOT = path.join(os.homedir(), ".imagebase", "uploads", "chat");
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
});

const router = express.Router();

/** POST /api/chat/attachments — upload a file */
router.post("/", upload.single("file"), async (req: Request, res: Response) => {
  try {
    const file = (req as any).file;
    if (!file) {
      res.status(400).json({ error: "No file provided" });
      return;
    }

    const fileId = crypto.randomUUID();
    const ext = path.extname(file.originalname) || "";
    const fileName = `${fileId}${ext}`;
    const filePath = path.join(UPLOAD_ROOT, fileName);

    await fsp.mkdir(UPLOAD_ROOT, { recursive: true });
    await fsp.writeFile(filePath, file.buffer);

    res.status(201).json({
      id: fileId,
      url: `/uploads/chat/${fileName}`,
      mime: file.mimetype,
      size: file.size,
      originalName: file.originalname,
    });
  } catch (err: any) {
    console.error("[chat-attachment] upload error:", err);
    res.status(500).json({ error: err.message ?? "upload failed" });
  }
});

export default router;

/** Static file serving middleware for /uploads/chat/* */
export function serveChatUploads() {
  return express.static(UPLOAD_ROOT, {
    maxAge: "7d",
    setHeaders(res) {
      res.setHeader("X-Content-Type-Options", "nosniff");
    },
  });
}
