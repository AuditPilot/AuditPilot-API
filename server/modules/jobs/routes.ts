import { Router, type Request, type Response } from "express";
import { requireAuth } from "../../middleware/auth";
import { logger } from "../../config/logger";
import { getById } from "./queue";

export const jobsRouter = Router();

/**
 * Client-safe projection — never ships secrets (workers store only repo
 * coordinates in payloads, never tokens).
 */
function publicJob(job: Record<string, unknown>) {
  const error = job.error as { message?: string } | null | undefined;
  return {
    id: String(job._id),
    type: job.type as string,
    state: job.state as string,
    stage: job.stage as string,
    percent: (job.percent as number) ?? 0,
    message: (job.message as string) ?? null,
    error: error?.message ?? null,
    attempts: (job.attempts as number) ?? 0,
    result: job.result ?? null,
    createdAt: job.createdAt,
    startedAt: (job.startedAt as Date | undefined) ?? null,
    finishedAt: (job.finishedAt as Date | undefined) ?? null,
  };
}

type LeanJob = Record<string, unknown>;

/**
 * Ownership check: a foreign job id is indistinguishable from a missing one.
 * (Same 404-not-403 rule as every other resource.)
 */
async function ownJobOr404(id: string, req: Request): Promise<LeanJob | null> {
  let job: LeanJob | null = null;
  try {
    job = (await getById(id)) as unknown as LeanJob | null;
  } catch {
    // Invalid ObjectId → treat as missing (existence not disclosed)
    return null;
  }
  if (!job) return null;
  if (String(job.userId) !== String(req.user!._id)) {
    return null;
  }
  return job;
}

jobsRouter.get("/jobs/:id", requireAuth, async (req: Request, res: Response) => {
  const job = await ownJobOr404(String(req.params.id), req);
  if (!job) {
    return res.status(404).json({ message: "Job not found" });
  }
  return res.json(publicJob(job));
});

/**
 * Server-Sent Events stream of job progress. Polling GET /api/jobs/:id is the
 * simpler alternative (used by the progress page) — SSE is provided for
 * low-latency clients and long-lived flows.
 */
jobsRouter.get("/jobs/:id/events", requireAuth, async (req: Request, res: Response) => {
  const job = await ownJobOr404(String(req.params.id), req);
  if (!job) {
    return res.status(404).json({ message: "Job not found" });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Prevent proxy buffering
    "X-Accel-Buffering": "no",
  });

  const send = (event: string, data: unknown) => {
    if (!res.writableEnded) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };
  send("connected", { id: String(job._id) });

  let closed = false;
  req.on("close", () => {
    closed = true;
  });

  const pulse = async (): Promise<void> => {
    if (closed) return;
    try {
      const current = (await getById(String(job._id))) as unknown as LeanJob | null;
      if (!current) {
        send("gone", { id: String(job._id) });
        clearInterval(timer);
        res.end();
        return;
      }
      const event = current.state === "done" ? "complete" : current.state === "failed" ? "failed" : "progress";
      send(event, publicJob(current));
      if (event === "complete" || event === "failed") {
        clearInterval(timer);
        res.end();
      }
    } catch (err) {
      // Transient DB hiccup — keep the stream alive rather than killing it.
      logger.debug({ err: err instanceof Error ? err.message : String(err) }, "SSE pulse error");
    }
  };

  const timer = setInterval(() => void pulse(), 1500);

  // Heartbeat keeps intermediaries from closing the connection.
  const heartbeat = setInterval(() => {
    if (closed || res.writableEnded) {
      clearInterval(heartbeat);
      return;
    }
    res.write(": ping\n\n");
  }, 20_000);

  req.on("close", () => {
    clearInterval(timer);
    clearInterval(heartbeat);
  });
});
