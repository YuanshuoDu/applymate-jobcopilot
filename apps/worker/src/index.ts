import express from "express";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { createWorkerControlHandler, resolveWorkerAdminHost } from "./admin/control-plane.js";
import { bindWorkerControl, getWorkerRuntimeState, restoreWorkerRuntimeState } from "./admin/worker-state.js";
import { closeSharedRedisConnections } from "./redis.js";
import { workerHarnessFeatureHealth } from "./admin/harness-health.js";
import { startAgentWakeupConsumer } from "./runtime/wakeup/consumer.js";

async function main() {
  const adminHost = resolveWorkerAdminHost();
  const [
    applyResultsModule,
    applyQueueModule,
    scoutQueueModule,
    agentRunQueueModule,
    automationSchedulerModule,
    cloakPoolModule,
    deadLetterModule,
  ] = await Promise.all([
    import("./db/apply-results.js"),
    import("./queue/apply-queue.js"),
    import("./queue/scout-queue.js"),
    import("./queue/agent-run-queue.js"),
    import("./queue/automation-scheduler.js"),
    import("./cloak/pool.js"),
    import("./queue/dead-letter.js"),
  ]);
  const { ensureApplyResultsTable, closePool } = applyResultsModule;
  const { applyWorker, applyQueue, connection } = applyQueueModule;
  const { scoutWorker, scoutQueue, SCOUT_QUEUE_NAME } = scoutQueueModule;
  const { agentRunQueue, AGENT_RUN_QUEUE_NAME, closeAgentRunResources } = agentRunQueueModule;
  const { publicAutomationSchedulerStatus, startAutomationScheduler } = automationSchedulerModule;
  const { closeAllSlots } = cloakPoolModule;
  const { deadLetterQueue, registerDeadLetterListeners, closeDeadLetterResources } = deadLetterModule;
  registerDeadLetterListeners([
    { name: applyQueueModule.QUEUE_NAME, worker: applyWorker },
    { name: SCOUT_QUEUE_NAME, worker: scoutWorker },
    { name: AGENT_RUN_QUEUE_NAME, worker: agentRunQueueModule.agentRunWorker },
  ]);

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

  const agentWakeupConsumer = startAgentWakeupConsumer();
  console.log("[worker] Agent Turn wakeup consumer started");

  const workerControls = {
    "apply-tasks": bindWorkerControl(applyQueue, applyWorker),
    "scout-tasks": bindWorkerControl(scoutQueue, scoutWorker),
    "agent-runs": bindWorkerControl(agentRunQueue, agentRunQueueModule.agentRunWorker),
  };
  const workerRuntimeState = await restoreWorkerRuntimeState(connection, workerControls);
  console.log(`[worker] Runtime control state: ${workerRuntimeState.status}`);

  console.log(`[worker] Listening on queue 'apply-tasks' (concurrency: ${process.env.CLOAK_MAX_WORKERS ?? "1"})`);
  console.log(`[worker] Listening on queue '${SCOUT_QUEUE_NAME}' (concurrency: 1)`);
  console.log(`[worker] Listening on queue '${AGENT_RUN_QUEUE_NAME}' (concurrency: 1)`);
  const automationScheduler = startAutomationScheduler();
  console.log(`[worker] Automation scheduler ${automationScheduler.status().enabled ? "started" : "disabled"}`);

  const adminApp = express();
  adminApp.get("/healthz", (_req, res) => res.status(200).json({
    status: getWorkerRuntimeState().status === "paused" ? "paused" : "ok",
    workerState: getWorkerRuntimeState().status,
    automationScheduler: publicAutomationSchedulerStatus(automationScheduler.status()),
    agentHarnessFlags: workerHarnessFeatureHealth(),
  }));
  adminApp.post("/internal/admin/control", express.text({ type: "application/json", limit: "16kb" }), createWorkerControlHandler());

  // Bull Board contains task and application metadata. It is disabled unless
  // explicitly enabled, including in production, and is always password-gated.
  if (process.env.ENABLE_BULL_BOARD === "1") {
    const password = process.env.BULL_BOARD_PASSWORD;
    if (!password) throw new Error("BULL_BOARD_PASSWORD is required when ENABLE_BULL_BOARD=1");

    const serverAdapter = new ExpressAdapter();
    serverAdapter.setBasePath("/admin/queues");
    createBullBoard({
      queues: [new BullMQAdapter(applyQueue), new BullMQAdapter(scoutQueue), new BullMQAdapter(agentRunQueue), new BullMQAdapter(deadLetterQueue)],
      serverAdapter,
    });

    adminApp.use("/admin/queues", (req, res, next) => {
      const expected = "Basic " + Buffer.from("admin:" + password).toString("base64");
      if (req.headers.authorization !== expected) {
        res.setHeader("WWW-Authenticate", 'Basic realm="Bull Board"');
        return res.status(401).send("Unauthorized");
      }
      next();
    });
    adminApp.use("/admin/queues", serverAdapter.getRouter());
    console.log("[bull-board] Enabled at /admin/queues");
  }

  const boardPort = Number(process.env.BULL_BOARD_PORT ?? "3001");
  adminApp.listen(boardPort, adminHost, () =>
    console.log(`[worker-health] http://${adminHost}:${boardPort}/healthz`)
  );

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`[worker] Received ${signal}, shutting down...`);
    await scoutWorker.close();
    await applyWorker.close();
    await closeAgentRunResources();
    await closeDeadLetterResources();
    automationScheduler.close();
    await closeAllSlots();
    await agentWakeupConsumer.close();
    await closePool();
    await closeSharedRedisConnections();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[worker] Fatal startup error:", err);
  process.exit(1);
});
