import { ensureApplyResultsTable, closePool } from "./db/apply-results.js";
import { applyWorker, connection } from "./queue/apply-queue.js";
import { closeAllSlots } from "./cloak/pool.js";

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

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`[worker] Received ${signal}, shutting down...`);
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
