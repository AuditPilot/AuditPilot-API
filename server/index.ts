import "dotenv/config";
import { createServer } from "node:http";
import { connectDB } from "./config/mongo";
import { ENV } from "./config/env";
import { logger } from "./config/logger";
import { app, registerTerminalHandlers } from "./app";

const httpServer = createServer(app);

async function startServer() {
  await connectDB();

  if (!ENV.DISABLE_WORKERS) {
    const { startWorkers } = await import("./modules/jobs/workers");
    startWorkers();
  }

  if (ENV.WORKER_ONLY) return;

  registerTerminalHandlers(app);
  httpServer.listen({ port: ENV.PORT, host: "0.0.0.0" }, () => {
    logger.info(`API listening on port ${ENV.PORT}`);
  });
}

startServer().catch((err) => {
  logger.fatal({ err: (err as Error).message }, "API initialization failed");
  process.exitCode = 1;
});

