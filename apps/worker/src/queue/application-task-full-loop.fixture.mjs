import { createServer as createHttpsServer } from "node:https"
import { createServer as createHttpServer, request as createHttpRequest } from "node:http"
import { connect as connectTcp } from "node:net"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { unlink } from "node:fs/promises"
import { Pool } from "pg"
import { HOST, assertToolMessagePairs, failModel, fixtureModel, required, safeBlockedTarget } from "./application-task-full-loop.fixture-support.mjs"
import { applicationFillStageTrace, traceApplicationFillExecutor } from "./application-task-full-loop.trace-support.mjs"

const [, , mode] = process.argv
const SOCKET = process.env.APPLICATION_TASK_FULL_LOOP_SOCKET_PATH
const REVIEWED_SOURCE_GOAL = "FULL_LOOP_REVIEWED_SOURCE: produce and review a selected-job cover letter"
const REVIEWED_COVER_LETTER = "SYNTHETIC REVIEWED COVER LETTER — isolated fill only."
const REVIEWED_SOURCE_SCHEMA = "agent-harness.v2.subagent.result"
const REVIEWED_FILL_BRIDGE_PATH = "/__applymate-reviewed-fill"
const reviewedHash = createHash("sha256").update(REVIEWED_COVER_LETTER).digest("hex")
const stageObserver = process.env.APPLICATION_TASK_FULL_LOOP_STAGE_OBSERVER_TEST === "true" ? applicationFillStageTrace() : undefined
let legacyFinalResponseGate
function armLegacyFinalResponseGate(turnId) {
  if (typeof turnId !== "string" || !turnId || turnId.length > 256 || turnId.trim() !== turnId || legacyFinalResponseGate) throw new Error("legacy_final_response_gate_arm_invalid")
  let release
  const released = new Promise(resolve => { release = resolve })
  legacyFinalResponseGate = { turnId, release, released, claimed: false, acknowledged: false, resumed: false,
    streamCompleted: false, applyProcessorResultClaimed: false, releaseApplyProcessorResult: null }
}
function releaseLegacyFinalResponseGate(turnId) {
  const gate = legacyFinalResponseGate
  if (!gate || gate.turnId !== turnId) return false
  gate.acknowledged = true
  gate.release()
  return true
}
async function holdLegacyFinalResponse(turnId) {
  const gate = legacyFinalResponseGate
  if (!gate || gate.turnId !== turnId || gate.claimed) return
  gate.claimed = true
  say(`LEGACY_FINAL_RESPONSE_GATE_REACHED turnId=${turnId}`)
  let timer
  const outcome = await Promise.race([gate.released.then(() => "released"), new Promise(resolve => {
    timer = setTimeout(() => resolve("timeout"), 45_000)
    timer.unref?.()
  })])
  if (timer) clearTimeout(timer)
  if (outcome === "released" && gate.acknowledged) {
    gate.resumed = true
    say("LEGACY_FINAL_RESPONSE_GATE_RESUMED")
  }
  gate.release()
}
async function holdLegacyApplyProcessorResult(job) {
  const gate = legacyFinalResponseGate
  if (!gate || gate.applyProcessorResultClaimed || job?.data?.operation !== "submit"
    || job?.data?.fillTurnId !== gate.turnId) return
  gate.applyProcessorResultClaimed = true
  say("LEGACY_APPLY_PROCESSOR_RESULT_HELD")
  await new Promise(resolve => { gate.releaseApplyProcessorResult = resolve })
  gate.releaseApplyProcessorResult = null
}
function releaseLegacyApplyProcessorResult() {
  const gate = legacyFinalResponseGate
  const release = gate?.releaseApplyProcessorResult
  if (typeof release !== "function") return
  gate.releaseApplyProcessorResult = null
  release()
}
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
  const reviewedFillRouteSocketPath = required("APPLICATION_TASK_FULL_LOOP_REVIEWED_FILL_SOCKET_PATH")
  await unlink(SOCKET).catch(() => undefined)
  let submitCount = 0, reviewedSubmitCount = 0, reviewedMaterialExactCount = 0, reviewedGetCount = 0
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
        } else if (event === "input" && field === "cover_letter" && trace.valueHash === reviewedHash) {
          reviewedMaterialExactCount += 1
          browserTrace.push("input:cover_letter")
          if (Number.isFinite(elapsedMs) && elapsedMs >= 0 && Number.isSafeInteger(length) && length >= 0) {
            browserProgress.push({ event: "input:cover_letter", elapsedMs, length })
          }
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
    if (request.method === "GET" && request.url === "/example-reviewed/jobs/1") {
      reviewedGetCount += 1
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      response.end(`<!doctype html><title>Fixture Application</title><form method="post" action="/example-reviewed/jobs/1">
        <label for="first_name">First name</label><input id="first_name" name="first_name" required>
        <label for="cover_letter">Cover letter</label><textarea id="cover_letter" name="cover_letter" required></textarea>
        <button id="submit-app" type="submit">Submit application</button></form>
        <script>
          const traces = new Map();
          window.addEventListener('pagehide', () => { if (traces.size) fetch('/__trace?batch=' + encodeURIComponent(JSON.stringify([...traces.values()])), { method: 'POST', keepalive: true }).catch(() => {}); });
          document.addEventListener('DOMContentLoaded', () => {
            fetch('/__trace?event=dom_ready&elapsedMs=' + Math.round(performance.now()), { method: 'POST', keepalive: true }).catch(() => {});
          });
          document.querySelectorAll('input,textarea').forEach(field => field.addEventListener('input', async () => {
            const trace = { event: 'input', field: field.name, elapsedMs: Math.round(performance.now()), length: field.value.length };
            if (field.name === 'cover_letter') {
              const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(field.value));
              trace.valueHash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
              fetch('/__trace?' + new URLSearchParams(trace), { method: 'POST', keepalive: true }).catch(() => {});
              return;
            }
            traces.set(field.name, trace);
          }));
        </script>`)
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
    if (request.method === "POST" && ["/example/jobs/1", "/example-reviewed/jobs/1"].includes(request.url)) {
      submitCount += 1
      if (request.url === "/example-reviewed/jobs/1") reviewedSubmitCount += 1
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
    if (request.method === "POST" && request.url === REVIEWED_FILL_BRIDGE_PATH) {
      const forwarded = createHttpRequest({
        socketPath: reviewedFillRouteSocketPath, path: "/api/internal/agent-runtime/reviewed-fill", method: "POST",
        headers: {
          ...(typeof request.headers["content-type"] === "string" ? { "content-type": request.headers["content-type"] } : {}),
          ...(typeof request.headers["x-agent-worker-secret"] === "string"
            ? { "x-agent-worker-secret": request.headers["x-agent-worker-secret"] } : {}),
        },
      }, routed => {
        response.writeHead(routed.statusCode ?? 502, { "content-type": routed.headers["content-type"] ?? "application/json" })
        routed.on("aborted", () => { if (!response.destroyed) response.destroy() })
        routed.on("error", () => { if (!response.destroyed) response.destroy() })
        routed.pipe(response)
      })
      forwarded.on("error", () => { if (!response.destroyed) response.destroy() })
      request.pipe(forwarded)
      return
    }
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
      if (line === "stats") say(`FIXTURE_STATE ${JSON.stringify({ submitCount, reviewedSubmitCount, reviewedMaterialExactCount, reviewedGetCount, blocked, requests, browserTrace, browserProgress })}`)
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
    taskGraphTemplatesModule, queue, outbox, reviewedFillOutbox, { withCloakContext, closeAllSlots }, redis,
    { startAgentWakeupConsumer }] = await Promise.all([
    import("../runtime/canonical-turn-runtime.ts"), import("../runtime/subagents/production-child-runtime.ts"),
    import("./production-bootstrap.ts"), import("./production-worker-runtime.ts"), import("../runtime/production-agent-flags.ts"),
    import("../runtime/subagents/pg-task-graph-command-port.ts"), import("../runtime/subagents/task-graph-templates.ts"),
    import("./apply-queue.ts"), import("./application-submit-outbox.ts"), import("./reviewed-fill-handoff-outbox.ts"),
    import("../cloak/pool.js"), import("../redis.ts"), import("../runtime/wakeup/consumer.ts"),
  ])
  const originalApplyProcessor = queue.applyWorker.processFn
  if (typeof originalApplyProcessor !== "function") throw new Error("application_task_full_loop_apply_processor_unavailable")
  queue.applyWorker.processFn = async function (job, token, signal) {
    const result = await originalApplyProcessor.call(this, job, token, signal)
    await holdLegacyApplyProcessorResult(job)
    return result
  }
  const flags = { ...resolveProductionAgentFlags(), taskGraphPlanningEnabled: true, childExecutionEnabled: true,
    coordinationEnabled: true, consumeWaitOutcomes: true, canonicalAutomationEnabled: false, turnBoundaryCompactionEnabled: false }
  const taskGraphCommandPort = flags.taskGraphPlanningEnabled
    ? taskGraphCommandPortModule.createPgTaskGraphCommandPort(pool) : undefined
  const authorizeUsage = async () => ({
    outputReservationRequired: false,
    maxOutputTokens: null,
    settle: async () => undefined,
    settleUnknown: async () => undefined,
  })
  const reviewedRootModel = () => ({ ...fixtureModel(), adapter: {
    ...fixtureModel().adapter,
    id: "application-task-full-loop-reviewed-root-model",
    async *stream(request) {
      assertToolMessagePairs(request)
      const plan = toolCall(request, "agent.plan", "reviewed-source-plan")
      if (!plan) {
        yield { type: "tool_call_completed", callId: "reviewed-source-plan", name: "agent.plan", arguments: {
          expectedRevision: 0,
          nodes: [
            { key: "writer", templateId: "cover_letter_writer", goal: "Draft the selected-job cover letter",
              successCriteria: ["Persist the selected-job cover letter draft"], dependsOn: [] },
            { key: "reviewer", templateId: "cover_letter_reviewer", goal: "Review the exact Writer cover letter",
              successCriteria: ["Persist a passed review of the exact Writer artifact"], dependsOn: ["writer"] },
          ],
        } }
        yield { type: "completed", finishReason: "tool_calls" }
        return
      }
      const receipt = correlatedToolOutput(request, plan)
      const taskIds = Array.isArray(receipt.nodes) ? receipt.nodes.map(node => node?.taskId) : []
      if (taskIds.length !== 2 || taskIds.some(id => typeof id !== "string" || !id.trim())) failModel("application_fill_plan_receipt_invalid")
      const waits = toolUses(request, "agent.wait")
      const lastWait = waits.at(-1)
      if (lastWait) {
        const result = correlatedToolOutput(request, lastWait)
        const tasks = Array.isArray(result.tasks) ? result.tasks : []
        if (result.status === "ready" && tasks.length === 2 && tasks.every(task => task?.status === "completed")) {
          yield { type: "text_delta", text: "The selected-job Writer draft and Reviewer receipt completed." }
          yield { type: "completed", finishReason: "stop" }
          return
        }
      }
      const sequence = waits.length + 1
      if (sequence > 8) failModel("application_fill_wait_limit_exceeded")
      yield { type: "tool_call_completed", callId: `reviewed-source-wait-${sequence}`, name: "agent.wait", arguments: {
        idempotencyKey: `full-loop-reviewed-source:${sequence}`, taskIds, mode: "all", timeoutMs: 30_000,
      } }
      yield { type: "completed", finishReason: "tool_calls" }
    },
  } })
  const selectedJobChildModel = task => ({
    ...fixtureModel().adapter,
    id: `application-task-full-loop-reviewed-${task.role}-model`,
    async *stream(request) {
      assertToolMessagePairs(request)
      if (task.role === "writer") {
        const draftCall = toolCall(request, "cover_letter.draft", "reviewed-cover-letter-draft")
        if (!draftCall) {
          const jobId = task.context?.selectedJobPreparation?.jobId
          if (typeof jobId !== "string" || !jobId.trim()) failModel("application_fill_material_unavailable")
          const bases = await pool.query(`SELECT "id", "hash" FROM "agent_artifact" WHERE "userId"=$1 AND "jobId"=$2
            AND "artifactType"='cover_letter' AND "lifecycle"='base' LIMIT 2`, [task.userId, jobId])
          if (bases.rows.length !== 1 || typeof bases.rows[0]?.id !== "string" || typeof bases.rows[0]?.hash !== "string") failModel("application_fill_material_unavailable")
          yield { type: "tool_call_completed", callId: "reviewed-cover-letter-draft", name: "cover_letter.draft", arguments: {
            baseArtifactId: bases.rows[0].id, baseHash: bases.rows[0].hash, content: REVIEWED_COVER_LETTER,
            constraints: {}, expectedPreviousHash: null,
          } }
          yield { type: "completed", finishReason: "tool_calls" }
          return
        }
        const output = correlatedToolOutput(request, draftCall)
        if (!isRecord(output.artifactRef)) failModel("application_fill_wait_output_invalid")
        yield { type: "text_delta", text: JSON.stringify({ schemaVersion: REVIEWED_SOURCE_SCHEMA, role: "writer", status: "completed", artifactRef: output.artifactRef }) }
        yield { type: "completed", finishReason: "stop" }
        return
      }
      const dependency = task.context?.taskGraphDependencyResults?.items
      const artifactRef = Array.isArray(dependency) && dependency.length === 1 ? dependency[0]?.result?.artifactRef : undefined
      if (!isRecord(artifactRef)) failModel("application_fill_material_unavailable")
      const readCall = toolCall(request, "artifact.version.read", "reviewed-cover-letter-read")
      const reviewCall = toolCall(request, "artifact.review", "reviewed-cover-letter-review")
      if (!readCall && !reviewCall) {
        yield { type: "tool_call_completed", callId: "reviewed-cover-letter-read", name: "artifact.version.read", arguments: { artifactRef } }
        yield { type: "completed", finishReason: "tool_calls" }
        return
      }
      if (readCall && !reviewCall) {
        const read = correlatedToolOutput(request, readCall)
        if (!sameArtifactRef(read.artifactRef, artifactRef) || read.content !== REVIEWED_COVER_LETTER) failModel("application_fill_material_unavailable")
        yield { type: "tool_call_completed", callId: "reviewed-cover-letter-review", name: "artifact.review", arguments: { artifactRef, decision: "passed", findings: [] } }
        yield { type: "completed", finishReason: "tool_calls" }
        return
      }
      const review = correlatedToolOutput(request, reviewCall)
      if (!sameArtifactRef(review.artifactRef, artifactRef) || review.status !== "passed" || typeof review.reviewHash !== "string") failModel("application_fill_material_unavailable")
      yield { type: "text_delta", text: JSON.stringify({ schemaVersion: REVIEWED_SOURCE_SCHEMA, role: "reviewer", status: "completed",
        artifactRef: review.artifactRef, reviewStatus: review.status, reviewHash: review.reviewHash }) }
      yield { type: "completed", finishReason: "stop" }
    },
  })
  function selectedModelRuntime(task) {
    if ((task.role === "writer" || task.role === "reviewer") && task.context?.selectedJobPreparation) return selectedJobChildModel(task)
    return fixtureModel().adapter
  }
  let bootstrap
  await withCloakContext(userId, async page => {
    const response = await page.goto("https://boards.greenhouse.io/example/jobs/1")
    if (response?.status() !== 200) throw new Error("application_task_full_loop_browser_warmup_http_status_unexpected")
    if (await page.title() !== "Fixture Application") throw new Error("application_task_full_loop_browser_warmup_title_unexpected")
  })
  await startProductionWorkerRuntime({ pool, workerId: `application-full-loop-${process.pid}`, productionFlags: flags,
    onBootstrapReady: value => { bootstrap = value }, startAgentRunWorker() {} }, {
    createOptionalProductionChildExecutor: options => traceApplicationFillExecutor(options.enabled
      ? createOptionalProductionChildExecutor({ ...options, authorizeUsage, modelRuntimeFactory: ({ task }) => selectedModelRuntime(task), ...(stageObserver ? { applicationFillStageObserver: stageObserver } : {}) }) : undefined),
    createCanonicalTurnRuntime: (runtimePool, productionOptions) => createCanonicalTurnRuntime(runtimePool, {
      ...productionOptions, ...taskGraphTemplatesModule.taskGraphRuntimeOptions(taskGraphCommandPort),
      modelRuntimeFactory: ({ state }) => state.goal.includes(REVIEWED_SOURCE_GOAL) ? reviewedRootModel() : fixtureModel({
        beforeFinalResponse: request => holdLegacyFinalResponse(request.metadata.turnId),
        afterFinalResponse: request => {
          const gate = legacyFinalResponseGate
          if (gate?.turnId !== request.metadata.turnId || !gate.resumed || gate.streamCompleted) return
          gate.streamCompleted = true
          say("LEGACY_FINAL_RESPONSE_MODEL_STREAM_COMPLETED")
        },
      }), authorizeUsage,
    }),
    createWorkerUsageAuthorizer: () => authorizeUsage,
    createCanonicalExecutionProjection: () => noOpProjection,
    createCanonicalSessionProjection: () => noOpProjection,
    startReviewedFillHandoffOutboxPublisher: publisherPool => reviewedFillOutbox.startReviewedFillHandoffOutboxPublisher(publisherPool, {
      endpointUrl: required("APPLICATION_TASK_FULL_LOOP_REVIEWED_FILL_ENDPOINT_URL"),
      secret: required("APPLICATION_TASK_FULL_LOOP_REVIEWED_FILL_SECRET"), pollMs: 250,
    }),
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
  void queue.applyWorker.run().catch(() => say("APPLY_WORKER_RUN_FAILED"))
  say("CANONICAL_TURN_AND_SUBAGENT_CONSUMERS_READY")
  const wakeupConsumer = startAgentWakeupConsumer(pool)
  say("WORKER_READY")
  process.stdin.setEncoding("utf8")
  let buffer = ""
  await new Promise(resolve => process.stdin.on("data", chunk => {
    buffer += chunk
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines.map(value => value.trim())) {
      if (line.startsWith("arm-legacy-final-response ")) {
        try {
          armLegacyFinalResponseGate(line.slice("arm-legacy-final-response ".length))
          say("LEGACY_FINAL_RESPONSE_GATE_ARMED")
        } catch { say("LEGACY_FINAL_RESPONSE_GATE_ARM_FAILED") }
      } else if (line.startsWith("release-legacy-final-response ")) {
        if (releaseLegacyFinalResponseGate(line.slice("release-legacy-final-response ".length))) {
          say("LEGACY_FINAL_RESPONSE_GATE_RELEASED")
        }
      } else if (line === "shutdown") {
        releaseLegacyApplyProcessorResult()
        process.stdin.pause()
        resolve()
        return
      }
    }
  }))
  await wakeupConsumer.close()
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

function toolUses(request, name) {
  const calls = []
  for (const message of request.messages ?? []) for (const part of message.content ?? []) {
    if (message.role === "assistant" && part?.type === "tool_use" && part.name === name) calls.push(part)
  }
  return calls
}
function toolCall(request, name, id) { return toolUses(request, name).find(call => call.id === id) }
function correlatedToolOutput(request, call) {
  const results = []
  for (const message of request.messages ?? []) for (const part of message.content ?? []) {
    if (message.role === "tool" && part?.type === "tool_result" && part.toolUseId === call.id) results.push(part)
  }
  if (results.length !== 1 || results[0]?.isError === true) failModel("application_fill_wait_output_invalid")
  try { return JSON.parse(results[0].content) } catch { failModel("application_fill_wait_output_invalid") }
}
function isRecord(value) { return Boolean(value && typeof value === "object" && !Array.isArray(value)) }
function sameArtifactRef(left, right) {
  return isRecord(left) && isRecord(right)
    && left.artifactId === right.artifactId && left.version === right.version
    && left.contentHash === right.contentHash && left.sourceDigest === right.sourceDigest
}

if (mode === "site") await startSite()
else if (mode === "worker") await startWorker()
else throw new Error("fixture_mode_must_be_site_or_worker")
