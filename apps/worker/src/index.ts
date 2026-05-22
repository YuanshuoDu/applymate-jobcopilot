import { ensureApplyResultsTable, closePool } from "./db/apply-results.js";
import { applyWorker, applyQueue, connection } from "./queue/apply-queue.js";
import { scoutWorker, scoutQueue, SCOUT_QUEUE_NAME } from "./queue/scout-queue.js";
import { closeAllSlots } from "./cloak/pool.js";
import express from "express";
import { createBullBoard } from "@bull-board/api";
// @ts-ignore — @bull-board/api .js extension import lacks type declarations
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter.js";
import { ExpressAdapter } from "@bull-board/express";

async function main() {
  console.log("[worker] Starting ApplyMate worker...");
  console.log(`[worker] CLOAK_MAX_WORKERS=${process.env.CLOAK_MAX_WORKERS ?? "1"}`);
  console.log(`[worker] DATABASE_URL=${process.env.DATABASE_URL ? "set" : "not set"}`);
  console.log(`[worker] REDIS_URL=${process.env.REDIS_URL ? "set" : "not set"}`);

  // Ensure DB table exists
  try {
    await ensureApplyResultsTable();
    console.log("[worker] apply_results table ready");
  } catch (err) {
    console.error("[worker] Failed to ensure apply_results table:", err);
    process.exit(1);
  }

  // Wait for Redis connection
  try {
    await connection.ping();
    console.log("[worker] Redis connected");
  } catch (err) {
    console.error("[worker] Redis connection failed:", err);
    process.exit(1);
  }

  console.log(`[worker] Listening on queue 'apply-tasks' (concurrency: ${process.env.CLOAK_MAX_WORKERS ?? "1"})`);
  console.log(`[worker] Listening on queue '${SCOUT_QUEUE_NAME}' (concurrency: 1)`);

  // -- Bull Board admin UI ------------------------------------------------
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath("/admin/queues");
  createBullBoard({
    queues: [new BullMQAdapter(applyQueue), new BullMQAdapter(scoutQueue)],
    serverAdapter,
  });

  const adminApp = express();

  // Basic auth when BULL_BOARD_PASSWORD is set
  adminApp.use("/admin/queues", (req, res, next) => {
    const pwd = process.env.BULL_BOARD_PASSWORD;
    if (!pwd) return next();
    const expected = "Basic " + Buffer.from("admin:" + pwd).toString("base64");
    if (req.headers.authorization !== expected) {
      res.setHeader("WWW-Authenticate", 'Basic realm="Bull Board"');
      return res.status(401).send("Unauthorized");
    }
    next();
  });

  adminApp.use("/admin/queues", serverAdapter.getRouter());
  const boardPort = Number(process.env.BULL_BOARD_PORT ?? "3001");
  adminApp.listen(boardPort, () =>
    console.log(`[bull-board] http://localhost:${boardPort}/admin/queues`)
  );

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`[worker] Received ${signal}, shutting down...`);
    await scoutWorker.close();
    await applyWorker.close();
    await closeAllSlots();
    await closePool();
    connection.disconnect();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[worker] Fatal startup error:", err);
  process.exit(1);
});
