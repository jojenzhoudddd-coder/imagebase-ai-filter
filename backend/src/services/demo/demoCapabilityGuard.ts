/**
 * demoCapabilityGuard — Express middleware that gates every
 * `/api/demo-runtime/:demoId/*` request on the Demo's declared capabilities.
 *
 * Two layers of defence (see docs/vibe-demo-plan.md §6.2):
 *  1. **Architecture**: only 7 record-level + 2 idea-read handlers exist in
 *     the demo-runtime namespace. Schema / workspace / AI endpoints simply
 *     aren't wired — they 404.
 *  2. **Declaration**: this middleware checks that the requested
 *     (tableId|ideaId, operation) is in `demo.dataTables|dataIdeas` and
 *     `demo.capabilities[id]` respectively. Failing either → 403.
 *
 * Returned error shapes are stable so the FE SDK (`_req()`) shows actionable
 * messages instead of bare HTTP codes.
 */

import type { Request, Response, NextFunction } from "express";
import { PrismaClient } from "../../generated/prisma/client.js";
import type { Capability } from "../../schemas/demoSchema.js";

type ResourceKind = "table" | "idea";

export interface GuardContext {
  prisma: PrismaClient;
}

/**
 * Build a guard middleware that enforces the given op + resource kind.
 * `prisma` is passed at the router wiring layer so this stays a pure
 * factory (no global prisma import here).
 */
export function demoCapabilityGuard(
  op: Capability,
  kind: ResourceKind,
  ctx: GuardContext,
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const demoId = req.params.demoId;
      if (!demoId) {
        res.status(400).json({ error: "demoId param required" });
        return;
      }

      const resourceId = extractResourceId(req, kind);
      if (!resourceId) {
        res.status(400).json({ error: `${kind}Id required in body/query/params` });
        return;
      }

      const demo = await ctx.prisma.demo.findUnique({
        where: { id: demoId },
        select: {
          id: true,
          workspaceId: true,
          dataTables: true,
          dataIdeas: true,
          capabilities: true,
          publishSlug: true,
        },
      });
      if (!demo) {
        res.status(404).json({ error: `Demo not found: ${demoId}` });
        return;
      }

      // 1. declared-resource check
      const declaredList = kind === "table" ? demo.dataTables : demo.dataIdeas;
      if (!declaredList.includes(resourceId)) {
        res.status(403).json({
          error: `Demo ${demoId} 未声明 ${kind} ${resourceId}`,
          hint: `Agent 需先调 update_demo_capabilities 把该 id 加入 data${kind === "table" ? "Tables" : "Ideas"}`,
        });
        return;
      }

      // 2. per-resource capability check
      const caps = (demo.capabilities as Record<string, string[]> | null)?.[resourceId] ?? [];
      // Implicit reads: if resource is declared AND this is a read op, allow
      // even without explicit capability entry. Mirrors SDK generation logic.
      const isImplicitRead =
        (kind === "table" && (op === "query" || op === "getRecord" || op === "describeTable")) ||
        (kind === "idea" && (op === "listIdeas" || op === "readIdea"));
      if (!caps.includes(op) && !isImplicitRead) {
        res.status(403).json({
          error: `Demo ${demoId} 对 ${kind} ${resourceId} 未声明 ${op} 能力`,
          hint: "修改 capabilities 后重新 build / publish",
        });
        return;
      }

      // 3. cross-workspace isolation
      const resourceWs = await getResourceWorkspaceId(ctx.prisma, kind, resourceId);
      if (resourceWs && resourceWs !== demo.workspaceId) {
        res.status(403).json({ error: "cross-workspace demo access denied" });
        return;
      }

      // Attach to request for handler
      (req as any).demo = demo;
      next();
    } catch (err) {
      console.error("[demoCapabilityGuard] failed:", err);
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

/**
 * Special guard for endpoints that don't take a resource param (e.g. listIdeas).
 * It only enforces: the requested op is allowed for AT LEAST ONE resource in
 * the appropriate dataTables/dataIdeas set. Used by `GET /ideas`.
 */
export function demoListGuard(
  op: "listIdeas",
  ctx: GuardContext,
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const demoId = req.params.demoId;
      const demo = await ctx.prisma.demo.findUnique({
        where: { id: demoId },
        select: {
          id: true,
          workspaceId: true,
          dataIdeas: true,
          capabilities: true,
        },
      });
      if (!demo) {
        res.status(404).json({ error: `Demo not found: ${demoId}` });
        return;
      }
      // listIdeas is always allowed if the demo declares any idea. The list
      // endpoint returns *only* the declared ones.
      if (demo.dataIdeas.length === 0) {
        res.status(403).json({
          error: `Demo ${demoId} 没有声明任何 idea`,
          hint: "先调 update_demo_capabilities 声明 dataIdeas",
        });
        return;
      }
      (req as any).demo = demo;
      next();
    } catch (err) {
      console.error("[demoListGuard] failed:", err);
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

// ─── helpers ──────────────────────────────────────────────────────────────

function extractResourceId(req: Request, kind: ResourceKind): string | null {
  if (kind === "table") {
    const fromBody = (req.body as any)?.tableId;
    const fromQuery = (req.query as any)?.tableId;
    return (fromBody as string) || (fromQuery as string) || null;
  } else {
    // idea: prefer URL param over query/body
    const fromParam = (req.params as any)?.ideaId;
    const fromBody = (req.body as any)?.ideaId;
    const fromQuery = (req.query as any)?.ideaId;
    return (fromParam as string) || (fromBody as string) || (fromQuery as string) || null;
  }
}

async function getResourceWorkspaceId(
  prisma: PrismaClient,
  kind: ResourceKind,
  resourceId: string,
): Promise<string | null> {
  if (kind === "table") {
    const t = await prisma.table.findUnique({
      where: { id: resourceId },
      select: { workspaceId: true },
    });
    return t?.workspaceId ?? null;
  } else {
    const i = await prisma.idea.findUnique({
      where: { id: resourceId },
      select: { workspaceId: true },
    });
    return i?.workspaceId ?? null;
  }
}
