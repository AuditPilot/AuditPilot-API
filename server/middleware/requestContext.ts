import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { childLogger } from "../config/logger";

/**
 * Attaches a request id, a scoped logger, and timing to every request.
 * The request id is echoed to the client for support/debug correlation.
 */
export function requestContext(req: Request, res: Response, next: NextFunction) {
  req.requestId = (req.headers["x-request-id"] as string) || randomUUID();
  req.log = childLogger({ requestId: req.requestId });
  req.startAt = Date.now();

  res.setHeader("X-Request-Id", req.requestId);

  res.on("finish", () => {
    const durationMs = req.startAt ? Date.now() - req.startAt : -1;
    const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
    req.log[level](
      {
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs,
        userId: (req as { user?: { _id?: { toString(): string } | string } }).user &&
          String((req as { user?: { _id?: unknown } }).user?._id),
      },
      "request",
    );
  });

  next();
}
