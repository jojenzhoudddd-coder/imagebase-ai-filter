/**
 * Express 4 async error boundary.
 *
 * Express 4 doesn't auto-catch promise rejections from async route handlers.
 * Without this shim:
 *   `router.post(path, async (req, res) => { throw new Error(...) })`
 * lets the throw escape into `unhandledRejection`. The response is never
 * sent, the request hangs until nginx upstream timeout, and the browser
 * receives an HTML 502/504 — which the FE then chokes on with
 * `SyntaxError: Unexpected token '<', "<html>"... is not valid JSON`.
 *
 * The shim is a 6-line monkey-patch on `Layer.prototype.handle_request` that
 * wraps every handler in `Promise.resolve(fn(...)).catch(next)`. Same idea
 * as the `express-async-errors` npm package, inlined to avoid a new dep.
 *
 * MUST be imported from `index.ts` BEFORE any router is constructed.
 *
 * Pair this with `globalErrorHandler` mounted as the LAST middleware so the
 * captured error actually turns into a 500 JSON response.
 */

// @ts-expect-error — express does not ship typings for this internal module,
// but it's a stable public-internal that express-async-errors and others rely on.
import Layer from "express/lib/router/layer.js";
import type { Request, Response, NextFunction } from "express";

let installed = false;

export function installAsyncErrorBoundary(): void {
  if (installed) return;
  installed = true;
  const proto = (Layer as any).prototype as {
    handle_request: (req: Request, res: Response, next: NextFunction) => unknown;
  };
  const original = proto.handle_request;
  proto.handle_request = function (this: any, req, res, next) {
    const fn = this.handle as (...args: unknown[]) => unknown;
    // Error-handling middleware (4-arg signature) → call original behavior
    if (typeof fn === "function" && fn.length > 3) {
      return original.call(this, req, res, next);
    }
    try {
      const ret = fn(req, res, next);
      if (ret && typeof (ret as Promise<unknown>).then === "function") {
        (ret as Promise<unknown>).catch(next);
      }
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Global error-handling middleware. Mount AFTER all routes:
 *   `app.use(globalErrorHandler);`
 *
 * Any error forwarded via `next(err)` (including those auto-forwarded by
 * `installAsyncErrorBoundary`) lands here. We log it loudly and respond
 * with a generic 500 JSON so the FE always parses something — never an
 * HTML upstream timeout page.
 *
 * If a response was already partially sent (streaming, SSE), we delegate
 * back to Express's default handler so the connection closes cleanly.
 */
export function globalErrorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  const msg = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  console.error(
    `[express] unhandled error on ${req.method} ${req.originalUrl}: ${msg}\n${stack ?? ""}`,
  );
  if (res.headersSent) {
    // Connection is mid-flight (e.g. SSE). Best we can do is end it.
    try {
      res.end();
    } catch {
      /* swallow */
    }
    return;
  }
  res.status(500).json({
    error: "internal server error",
    message: msg,
  });
}
