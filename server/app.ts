import { connectDB } from "./config/mongo";
import "dotenv/config";
import cors from "cors";
import express from "express";
import cookieParser from "cookie-parser";
import { CLIENT_ORIGINS } from "./config/env";
import { requestContext } from "./middleware/requestContext";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { authRouter } from "./modules/auth/routes";
import { reposRouter } from "./modules/repos/routes";
import { auditsRouter } from "./modules/audits/routes";
import { reviewsRouter } from "./modules/reviews/routes";
import { reportsRouter } from "./modules/reports/routes";
import { billingRouter } from "./modules/billing/routes";
import { jobsRouter } from "./modules/jobs/routes";
import { prManagerRouter } from "./modules/pr-manager/routes";
import { logger } from "./config/logger";

declare module "http" {
  interface IncomingMessage {
    rawBody: Buffer | undefined;
  }
}

/**
 * Application factory — middleware chain + module routers.
 * Pure: no listening, no DB connection (wired in index.ts / containers).
 */
export function createApp(): express.Express {
  const app = express();
  app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (error) {
    console.error("MongoDB connection failed:", error);

    res.status(503).json({
      message: "Database temporarily unavailable",
    });
  }
});
  app.set("trust proxy", 1);

  // Cookie-auth browser clients on separate hosts (static site vs API
  // origin) — allowlist, never wildcard-with-credentials.
  app.use(cors({
    origin: (origin, callback) => {
      if (!origin || CLIENT_ORIGINS.includes(origin)) {
        return callback(null, true);
      }
      // Non-allowlisted origins are rejected with no CORS headers
      // (browser blocks the response; cross-origin credentials stay safe).
      return callback(null, false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  }));

  app.use(express.json({
    // rawBody is required by signature-verified webhooks (Stripe, GitHub)
    verify: (req, _res, buf) => {
      req.rawBody = Buffer.from(buf);
    },
  }));
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());
  app.use(requestContext);

  // Liveness probe for container orchestrators / Docker HEALTHCHECKs
  // (no auth, no DB round-trip — pure process report).
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", uptime: Math.floor(process.uptime()) });
  });

  // Module routers (paths preserved from the legacy routes.ts)
  app.use("/api", authRouter);
  app.use("/api", reposRouter);
  app.use("/api", auditsRouter);
  app.use("/api", reviewsRouter);
  app.use("/api", reportsRouter);
  app.use("/api", billingRouter);
  app.use("/api", jobsRouter);
  app.use("/api", prManagerRouter);

  logger.debug("app assembled");

  return app;
}

/**
 * Terminal handlers (404 → central error handler).
 *
 * MUST be registered AFTER dev vite middleware / static serving — these are
 * catch-alls and would otherwise shadow the vite/static responders. index.ts
 * calls this after its serve-time setup.
 */
export function registerTerminalHandlers(app: express.Express): void {
  app.use(notFoundHandler);
  app.use(errorHandler);
}

export const app = createApp();
