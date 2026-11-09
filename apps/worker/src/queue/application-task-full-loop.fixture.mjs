import { createServer as createHttpsServer } from "node:https"
import { createServer as createHttpServer } from "node:http"
import { connect as connectTcp } from "node:net"
import { readFile } from "node:fs/promises"
import { unlink } from "node:fs/promises"
import { Pool } from "pg"
import { HOST, fixtureModel, required, safeBlockedTarget } from "./application-task-full-loop.fixture-support.mjs"
import { applicationFillStageTrace, traceApplicationFillExecutor } from "./application-task-full-loop.trace-support.mjs"

const [, , mode] = process.argv
const SOCKET = process.env.APPLICATION_TASK_FULL_LOOP_SOCKET_PATH
const stageObserver = process.env.APPLICATION_TASK_FULL_LOOP_STAGE_OBSERVER_TEST === "true" ? applicationFillStageTrace() : undefined
const tls = async () => {
  const cert = await readFile(required("AGENT_TEST_TLS_CERT_PATH"))
  const key = await readFile(required("AGENT_TEST_TLS_KEY_PATH"))
  await readFile(required("AGENT_TEST_TLS_CA_PATH"))
  return { cert, key }
}
function say(value) { process.stdout.write(`${value}\n`) }
function listen(server, ...args) {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(...args, () => { server.off("error", reject); resolve() })
  })
}
async function startSite() {
  if (!SOCKET) throw new Error("APPLICATION_TASK_FULL_LOOP_SOCKET_PATH_required")
  await unlink(SOCKET).catch(() => undefined)
  let submitCount = 0
  const requests = []
  const browserTrace = []
  const browserProgress = []
  const blocked = []
  const held = new Set()
  const siteSockets = new Set()
  const proxySockets = new Set()
  const site = createHttpsServer(await tls(), (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "https://boards.greenhouse.io")
    requests.push(`${request.method ?? "GET"} ${requestUrl.pathname}`)
    if (requests.length > 20) requests.shift()
    if (request.method === "POST" && requestUrl.pathname === "/__trace") {
      const batch = requestUrl.searchParams.get("batch")
      let traces = [Object.fromEntries(requestUrl.searchParams)]
      try { if (batch) traces = JSON.parse(batch) } catch { traces = [] }
      for (const trace of Array.isArray(traces) ? traces : []) {
        if (!trace || typeof trace !== "object") continue
        const { event, field } = trace
        const elapsedMs = Number(trace.elapsedMs)
        const length = Number(trace.length)
        if (event === "dom_ready") {
          browserTrace.push("dom_ready")
          if (Number.isFinite(elapsedMs) && elapsedMs >= 0) browserProgress.push({ event, elapsedMs })
        } else if (event === "input" && ["first_name", "work_authorization"].includes(field)) {
          browserTrace.push(`input:${field}`)
          if (Number.isFinite(elapsedMs) && elapsedMs >= 0 && Number.isSafeInteger(length) && length >= 0) {
            browserProgress.push({ event: `input:${field}`, elapsedMs, length })
          }
        }
      }
      if (browserTrace.length > 20) browserTrace.shift()
      if (browserProgress.length > 40) browserProgress.shift()
      response.writeHead(204).end()
      return
    }
    if (request.method === "GET" && request.url === "/example/jobs/1") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      response.end(`<!doctype html><title>Fixture Application</title><form method="post" action="/example/jobs/1">
        <label for="first_name">First name</label><input id="first_name" name="first_name" required>
        <label for="work_authorization">Are you legally authorized to work in Ireland?</label>
        <input id="work_authorization" name="work_authorization" required>
        <button id="submit-app" type="submit">Submit application</button></form>
        <script>
          const traces = new Map();
          window.addEventListener('pagehide', () => { if (traces.size) fetch('/__trace?batch=' + encodeURIComponent(JSON.stringify([...traces.values()])), { method: 'POST', keepalive: true }).catch(() => {}); });
          document.addEventListener('DOMContentLoaded', () => {
            fetch('/__trace?event=dom_ready&elapsedMs=' + Math.round(performance.now()), { method: 'POST', keepalive: true }).catch(() => {});
          });
          document.querySelectorAll('input').forEach(field => field.addEventListener('input', () => {
            traces.set(field.name, { event: 'input', field: field.name, elapsedMs: Math.round(performance.now()), length: field.value.length });
          }));
        </script>`)
      return
    }
    if (request.method === "POST" && request.url === "/example/jobs/1") {
      submitCount += 1
      held.add(response)
      request.resume()
      say(`SUBMIT_REQUEST ${submitCount}`)
      response.on("close", () => held.delete(response))
      return
    }
    response.writeHead(404).end("fixture route not found")
  })
  site.on("connection", socket => {
    siteSockets.add(socket)
    socket.once("close", () => siteSockets.delete(socket))
  })
  await listen(site, SOCKET)
  const proxy = createHttpServer((request, response) => {
    blocked.push(safeBlockedTarget(request.url))
    response.writeHead(405).end("CONNECT required")
  })
  proxy.on("connection", socket => {
    proxySockets.add(socket)
    socket.once("close", () => proxySockets.delete(socket))
  })
  proxy.on("connect", (request, client, head) => {
    if (request.url !== HOST) {
      blocked.push(safeBlockedTarget(request.url))
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n")
      return
    }
    const upstream = connectTcp(SOCKET, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      if (head.length) upstream.write(head)
      client.pipe(upstream).pipe(client)
    })
    const closeTunnel = () => {
      if (!client.destroyed) client.destroy()
      if (!upstream.destroyed) upstream.destroy()
    }
    upstream.on("error", closeTunnel)
    client.on("error", closeTunnel)
    client.once("close", () => { if (!upstream.destroyed) upstream.destroy() })
    upstream.once("close", () => { if (!client.destroyed) client.destroy() })
  })
  await listen(proxy, 9443, "127.0.0.1")
  say("FIXTURE_READY")
  process.stdin.setEncoding("utf8")
  let buffer = ""
  process.stdin.on("data", chunk => {
    buffer += chunk
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines.map(value => value.trim())) {
      if (line === "stats") say(`FIXTURE_STATE ${JSON.stringify({ submitCount, blocked, requests, browserTrace, browserProgress })}`)
      if (line === "shutdown") {
        process.stdin.pause()
        for (const response of held) response.destroy()
        for (const socket of proxySockets) socket.destroy()
        for (const socket of siteSockets) socket.destroy()
        void Promise.all([
          new Promise(resolve => proxy.close(() => resolve())),
          new Promise(resolve => site.close(() => resolve())),
        ]).then(() => unlink(SOCKET)).catch(error => {
          process.stderr.write(`FIXTURE_SHUTDOWN_FAILED ${error instanceof Error ? error.message : String(error)}\n`)
        })
      }
    }
  })
}

async function startWorker() {
  const userId = required("APPLICATION_TASK_FULL_LOOP_USER_ID")
  if (!userId.startsWith("full-loop-user-")) throw new Error("application_task_full_loop_synthetic_user_required")
  const databaseUrl = required("AGENT_RUNTIME_PG_TEST_URL")
  const redisUrl = required("AGENT_TURN_REDIS_TEST_URL")
  if (databaseUrl !== process.env.DATABASE_URL || redisUrl !== process.env.REDIS_URL
    || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true"
    || process.env.AGENT_RUNTIME_PG_TEST_REQUIRED !== "true"
    || process.env.AGENT_TURN_REDIS_TEST_DISPOSABLE !== "true"
    || process.env.APPLICATION_TASK_FULL_LOOP_EGRESS_ISOLATED !== "true"
    || process.env.CLOAK_PROXY_URL !== "http://127.0.0.1:9443") throw new Error("application_task_full_loop_service_guard_failed")
  const pool = new Pool({ connectionString: databaseUrl, max: 8 })
  const noOpProjection = { start: async () => undefined, finish: async () => undefined }
  const [{ createCanonicalTurnRuntime }, { createOptionalProductionChildExecutor }, { startProductionAgentRuntime },
    { startProductionWorkerRuntime }, { resolveProductionAgentFlags }, taskGraphCommandPortModule,
    taskGraphTemplatesModule, queue, outbox, { withCloakContext, closeAllSlots }, redis] = await Promise.all([
    import("../runtime/canonical-turn-runtime.ts"), import("../runtime/subagents/production-child-runtime.ts"),
    import("./production-bootstrap.ts"), import("./production-worker-runtime.ts"), import("../runtime/production-agent-flags.ts"),
    import("../runtime/subagents/pg-task-graph-command-port.ts"), import("../runtime/subagents/task-graph-templates.ts"),
    import("./apply-queue.ts"), import("./application-submit-outbox.ts"), import("../cloak/pool.js"), import("../redis.ts"),
  ])
  const flags = { ...resolveProductionAgentFlags(), taskGraphPlanningEnabled: true, childExecutionEnabled: true,
    coordinationEnabled: true, consumeWaitOutcomes: true, canonicalAutomationEnabled: false, turnBoundaryCompactionEnabled: false }
  const taskGraphCommandPort = flags.taskGraphPlanningEnabled
    ? taskGraphCommandPortModule.createPgTaskGraphCommandPort(pool) : undefined
  const authorizeUsage = async () => ({ settle: async () => undefined })
  let bootstrap
  await withCloakContext(userId, async page => {
    const response = await page.goto("https://boards.greenhouse.io/example/jobs/1")
    if (response?.status() !== 200) throw new Error("application_task_full_loop_browser_warmup_http_status_unexpected")
    if (await page.title() !== "Fixture Application") throw new Error("application_task_full_loop_browser_warmup_title_unexpected")
  })
  await startProductionWorkerRuntime({ pool, workerId: `application-full-loop-${process.pid}`, productionFlags: flags,
    onBootstrapReady: value => { bootstrap = value }, startAgentRunWorker() {} }, {
    createOptionalProductionChildExecutor: options => traceApplicationFillExecutor(options.enabled
      ? createOptionalProductionChildExecutor({ ...options, authorizeUsage, ...(stageObserver ? { applicationFillStageObserver: stageObserver } : {}) }) : undefined),
    createCanonicalTurnRuntime: (runtimePool, productionOptions) => createCanonicalTurnRuntime(runtimePool, {
      ...productionOptions, ...taskGraphTemplatesModule.taskGraphRuntimeOptions(taskGraphCommandPort),
      modelRuntimeFactory: () => fixtureModel(), authorizeUsage,
    }),
    createWorkerUsageAuthorizer: () => authorizeUsage,
    createCanonicalExecutionProjection: () => noOpProjection,
    createCanonicalSessionProjection: () => noOpProjection,
    startProductionAgentRuntime: options => startProductionAgentRuntime({
      ...options,
      bootstrapOptions: runtime => {
        const bootstrapOptions = (typeof options.bootstrapOptions === "function"
          ? options.bootstrapOptions(runtime)
          : options.bootstrapOptions) ?? {}
        const subagents = bootstrapOptions.subagents
        return {
          ...bootstrapOptions,
          ...(subagents ? { subagents: { ...subagents, intervalMs: 250 } } : {}),
        }
      },
    }),
  })
  const publisher = outbox.startApplicationSubmitOutboxPublisher(pool, queue.applyQueue, { pollMs: 250 })
  queue.applyWorker.on("active", job => say(`APPLY_JOB_ACTIVE ${job?.id ?? "unknown"} attemptsMade=${job?.attemptsMade ?? -1} attemptsStarted=${job?.attemptsStarted ?? -1} stalledCounter=${job?.stalledCounter ?? -1}`))
  queue.applyWorker.on("stalled", (jobId, previousState) => say(`APPLY_JOB_STALLED ${jobId} previousState=${previousState}`))
  queue.applyWorker.on("failed", (job, error) => say(`APPLY_JOB_FAILED ${job?.id ?? "unknown"} ${error.message}`))
  const turns = bootstrap?.turns.worker
  turns?.on("active", job => say(`TURN_JOB_ACTIVE ${job?.id ?? "unknown"} turnId=${job?.data?.turnId ?? "unknown"}`))
  turns?.on("completed", (job, result) => say(`TURN_JOB_COMPLETED ${job?.id ?? "unknown"} turnId=${job?.data?.turnId ?? "unknown"} status=${result?.status ?? "unknown"}`))
  turns?.on("failed", (job, error) => say(`TURN_JOB_FAILED ${job?.id ?? "unknown"} turnId=${job?.data?.turnId ?? "unknown"} ${error.message}`))
  turns?.on("error", error => say(`TURN_WORKER_ERROR ${error.message}`))
  turns?.on("stalled", jobId => say(`TURN_JOB_STALLED ${jobId}`))
  const subagents = bootstrap?.subagents?.queue.worker
  subagents?.on("active", job => say(`SUBAGENT_JOB_ACTIVE ${job?.id ?? "unknown"} taskId=${job?.data?.taskId ?? "unknown"}`))
  subagents?.on("completed", (job, result) => say(`SUBAGENT_JOB_COMPLETED ${job?.id ?? "unknown"} taskId=${job?.data?.taskId ?? "unknown"} status=${result?.status ?? "unknown"}`))
  subagents?.on("failed", (job, error) => say(`SUBAGENT_JOB_FAILED ${job?.id ?? "unknown"} taskId=${job?.data?.taskId ?? "unknown"} ${error.message}`))
  subagents?.on("error", error => say(`SUBAGENT_WORKER_ERROR ${error.message}`))
  subagents?.on("stalled", jobId => say(`SUBAGENT_JOB_STALLED ${jobId}`))
  if (!turns || !subagents) throw new Error("canonical_turn_or_subagent_consumer_missing")
  void queue.applyWorker.run().catch(() => say("APPLY_WORKER_RUN_FAILED")); say("CANONICAL_TURN_AND_SUBAGENT_CONSUMERS_READY")
  say("WORKER_READY")
  process.stdin.setEncoding("utf8")
  let buffer = ""
  await new Promise(resolve => process.stdin.on("data", chunk => {
    buffer += chunk
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    if (lines.some(line => line.trim() === "shutdown")) { process.stdin.pause(); resolve() }
  }))
  await publisher.close()
  await bootstrap?.close()
  await queue.applyWorker.close()
  await queue.applyQueue.close()
  await closeAllSlots()
  const { getPool } = await import("../db/apply-results.ts")
  await getPool().end()
  await pool.end()
  await redis.closeSharedRedisConnections()
}

if (mode === "site") await startSite()
else if (mode === "worker") await startWorker()
else throw new Error("fixture_mode_must_be_site_or_worker")
