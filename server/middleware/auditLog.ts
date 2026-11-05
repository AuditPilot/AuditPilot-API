import type { NextFunction, Request, Response } from "express";
import { AuditLog } from "../models/AuditLog";
import { logger } from "../config/logger";

export interface AuditLogEntry {
  action: string; // e.g. "auth.login", "billing.plan_changed", "pr.fix_applied"
  targetType?: string;
  targetId?: string;
  meta?: Record<string, unknown>;
}

/**
 * Records a sensitive action to the audit log. Fire-and-forget with logging on
 * failure — audit logging should never block or break the request.
 *
 * NEVER include secrets, customer code, or tokens in `meta`.
 */
export function recordAuditLog(req: Request, entry: AuditLogEntry): void {
  try {
    const user = (req as { user?: { _id?: unknown } }).user;
    const forwardIps = (req.headers["x-real-ip"] || req.headers["x-forwarded-for"]) as
      | string
      | string[]
      | undefined;
    const ip = typeof forwardIps === "string" ? forwardIps.split(",")[0] : req.ip;

    AuditLog.create({
      userId: user?._id,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      ip,
      userAgent: req.headers["user-agent"],
      meta: { requestId: req.requestId, ...entry.meta },
    }).catch(err => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "audit log write failed");
    });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "audit log construction failed");
  }
}

/** Express middleware factory for actions triggered by a single route. */
export function auditTrail(entry: AuditLogEntry | ((req: Request, res: Response) => AuditLogEntry)) {
  return (req: Request, res: Response, next: NextFunction) => {
    res.on("finish", () => {
      // only audit successful operations for most actions
      if (res.statusCode < 400) {
        try {
          const resolved = typeof entry === "function" ? entry(req, res) : entry;
          recordAuditLog(req, resolved);
        } catch (err) {
          logger.warn({ err: err instanceof Error ? err.message : String(err) }, "audit middleware failed");
        }
      }
    });
    next();
  };
}
