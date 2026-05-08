/**
 * mcpSecret — process-scoped random secret for authenticating MCP loopback
 * requests. Generated once at import time; never persisted, never sent to
 * the browser, rotates on every server restart.
 *
 * The middleware checks `X-MCP-Secret` header against this value to verify
 * the request genuinely originates from the in-process MCP server and isn't
 * a spoofed external request.
 */

import { randomBytes } from "crypto";

export const mcpLoopbackSecret: string = randomBytes(32).toString("hex");
