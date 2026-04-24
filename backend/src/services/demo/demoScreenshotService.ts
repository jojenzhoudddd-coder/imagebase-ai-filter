/**
 * demoScreenshotService — server-side headless-browser screenshots of a Demo
 * preview. Used by the MCP `screenshot_demo` tool so the Agent can visually
 * diff its freshly-built Demo against the original design reference during
 * the self-check / iterate loop.
 *
 * Implementation: `playwright-core` with a system-provided browser. We don't
 * ship Chromium (too big for the deploy surface); instead we probe common
 * install paths. When no browser is present the service returns a structured
 * "browser unavailable" error the tool can surface, and the Agent falls back
 * to coding without visual verification.
 *
 * A singleton browser instance amortizes launch cost across multiple
 * screenshots in the same agent turn. Disposed on process exit.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { Browser, BrowserType } from "playwright-core";

const CHROMIUM_CANDIDATES = [
  process.env.CHROME_BIN,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/opt/google/chrome/chrome",
  // macOS developer dev paths (local dev)
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].filter(Boolean) as string[];

async function findBrowserBinary(): Promise<string | null> {
  for (const p of CHROMIUM_CANDIDATES) {
    try {
      await fs.access(p);
      return p;
    } catch { /* not here, try next */ }
  }
  return null;
}

let browserPromise: Promise<Browser | null> | null = null;

async function getBrowser(): Promise<Browser | null> {
  if (browserPromise) return browserPromise;
  browserPromise = (async () => {
    const execPath = await findBrowserBinary();
    if (!execPath) return null;
    const { chromium } = (await import("playwright-core")) as { chromium: BrowserType };
    try {
      return await chromium.launch({
        executablePath: execPath,
        headless: true,
        args: [
          "--no-sandbox",            // root / container friendly
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage", // small /dev/shm on some hosts
        ],
      });
    } catch (err) {
      console.error("[demoScreenshot] browser launch failed:", err);
      browserPromise = null;
      return null;
    }
  })();
  return browserPromise;
}

export interface ScreenshotOptions {
  /** Viewport width; default 1440. Large mocks need wide canvas. */
  width?: number;
  /** Viewport height; default 900. */
  height?: number;
  /**
   * If true (default), capture the full scrolled page height. Otherwise crop
   * to viewport.
   */
  fullPage?: boolean;
  /**
   * Max milliseconds to wait for `load` + idle before snapping. If the Demo
   * does async data fetching this should be large enough to let the first
   * paint happen.
   */
  timeoutMs?: number;
}

export interface ScreenshotResult {
  mediaType: "image/png";
  /** Raw PNG bytes. */
  bytes: Buffer;
  /** Viewport + page dims for Agent context. */
  meta: {
    viewport: { width: number; height: number };
    capturedWidth: number;
    capturedHeight: number;
    durationMs: number;
  };
}

/** Throws on any failure; caller wraps into a friendly tool_result. */
export async function screenshotDemoPreview(
  previewUrl: string,
  opts: ScreenshotOptions = {},
): Promise<ScreenshotResult> {
  const width = opts.width ?? 1440;
  const height = opts.height ?? 900;
  const fullPage = opts.fullPage ?? true;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const started = Date.now();

  const browser = await getBrowser();
  if (!browser) {
    throw Object.assign(
      new Error(
        "Headless browser not available on this host. Install google-chrome " +
          "or chromium and set CHROME_BIN, or remove the screenshot tool from " +
          "the agent's toolset.",
      ),
      { code: "BROWSER_UNAVAILABLE" },
    );
  }

  const context = await browser.newContext({ viewport: { width, height } });
  try {
    const page = await context.newPage();
    await page.goto(previewUrl, { waitUntil: "networkidle", timeout: timeoutMs });
    const bytes = (await page.screenshot({ fullPage, type: "png" })) as Buffer;
    return {
      mediaType: "image/png",
      bytes,
      meta: {
        viewport: { width, height },
        capturedWidth: width,
        capturedHeight: fullPage ? (await page.evaluate(() => document.body.scrollHeight)) : height,
        durationMs: Date.now() - started,
      },
    };
  } finally {
    await context.close().catch(() => { /* ignore */ });
  }
}

export async function disposeScreenshotBrowser(): Promise<void> {
  const b = await browserPromise;
  if (b) {
    try { await b.close(); } catch { /* ignore */ }
  }
  browserPromise = null;
}

// Paranoid path helper (currently unused here but kept so imports stay symmetric
// with other demo/* services which do write to ~/.imagebase/demos/...)
export function demoInternalPreviewUrl(demoId: string): string {
  const base = process.env.BACKEND_BASE_URL || "http://localhost:3001";
  return `${base.replace(/\/$/, "")}/api/demos/${encodeURIComponent(demoId)}/preview/`;
}

// Local helper to keep imports sane in the routes file.
export const _internal = { findBrowserBinary, path };
