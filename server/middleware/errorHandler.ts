import type { NextFunction, Request, Response } from "express";
import { isDev } from "../config/env";
import { logger } from "../config/logger";

/**
 * Central error handling.
 * Every thrown/nexted error funnels through here; unhandled sync/async errors
 * in routers end up here too (Express 5 forwards rejected promises).
 */

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(message: string, details?: unknown) {
    return new AppError(400, "bad_request", message, details);
  }
  static unauthorized(message = "Unauthorized") {
    return new AppError(401, "unauthorized", message);
  }
  static paymentRequired(message: string, details?: unknown) {
    return new AppError(402, "payment_required", message, details);
  }
  static forbidden(message = "Forbidden") {
    return new AppError(403, "forbidden", message);
  }
  static notFound(message = "Not found") {
    return new AppError(404, "not_found", message);
  }
  static conflict(message: string, details?: unknown) {
    return new AppError(409, "conflict", message, details);
  }
  static tooMany(message = "Too many requests") {
    return new AppError(429, "rate_limited", message);
  }
  static serviceUnavailable(message: string, details?: unknown) {
    return new AppError(503, "service_unavailable", message, details);
  }
  static internal(message = "Internal server error", details?: unknown) {
    return new AppError(500, "internal", message, details);
  }
}

export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) {
    return next(err);
  }

  const isHttp = err instanceof AppError || (err as { status?: number })?.status != null;

  if (!isHttp) {
    logger.error(
      {
        err,
        requestId: (req as { requestId?: string }).requestId,
        method: req.method,
        url: req.originalUrl,
      },
      "unhandled error",
    );
  } else if (isDev) {
    logger.debug({ err, requestId: (req as { requestId?: string }).requestId }, "handled error");
  }

  let status = 500;
  let code = "internal";
  let message: string;
  let details: unknown;

  if (err instanceof AppError) {
    status = err.status;
    code = err.code;
    message = err.message;
    details = err.details;
  } else {
    const anyErr = err as { status?: number; statusCode?: number; name?: string; message?: string; type?: string };
    status = typeof anyErr.status === "number" ? anyErr.status : typeof anyErr.statusCode === "number" ? anyErr.statusCode : 500;
    if (anyErr.name === "ValidationError") {
      status = 400;
      code = "validation_error";
      message = (anyErr.message as string) || "Validation failed";
      details = (anyErr as unknown as { errors?: unknown }).errors;
    } else if (anyErr.name === "CastError") {
      status = 400;
      code = "invalid_id";
      message = "Malformed identifier";
    } else if (anyErr.name === "BodyParserError" || anyErr.type === "entity.parse.failed") {
      status = 400;
      code = "invalid_body";
      message = "Malformed JSON body";
    } else {
      message = isDev ? anyErr.message || "Internal server error" : "Internal server error";
    }
  }

  res.status(status).json({
    message,
    error: code,
    requestId: (req as { requestId?: string }).requestId,
    ...(details !== undefined && isDev ? { details } : {}),
  });
}

/** Wraps non-Express sync helpers so they always surface as AppError. */
export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ message: "Not found", error: "not_found" });
}
