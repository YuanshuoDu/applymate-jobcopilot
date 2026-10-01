import { Pool } from "pg"
import { createCanonicalTurnRuntime } from "../runtime/canonical-turn-runtime.ts"
import { startProductionAgentRuntime as startProductionAgentRuntimeHelper } from "./production-bootstrap.ts"
import { startProductionWorkerRuntime } from "./production-worker-runtime.ts"
import { closeSharedRedisConnections } from "../redis.ts"

const databaseUrl = process.env.AGENT_RUNTIME_PG_TEST_URL
const redisUrl = process.env.AGENT_TURN_REDIS_TEST_URL
const database = databaseUrl ? new URL(databaseUrl) : null
const redis = redisUrl ? new URL(redisUrl) : null
if (
  process.env.CI !== "true"
  || process.env.AGENT_RUNTIME_PG_TEST_REQUIRED !== "true"
  || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true"
  || !database
  || database.protocol !== "postgresql:"
  || database.hostname !== "127.0.0.1"
  || database.port !== "5432"
  || database.username !== "postgres"
  || database.password !== "postgres"
  || database.pathname !== "/applymate_agent_brain_ci"
  || database.search !== ""
  || database.hash !== ""
  || process.env.AGENT_TURN_REDIS_TEST_DISPOSABLE !== "true"
  || !redis
  || redis.protocol !== "redis:"
  || redis.hostname !== "127.0.0.1"
  || redis.port !== "6379"
  || redis.pathname !== "/15"
  || redis.username !== ""
  || redis.password !== ""
  || redis.search !== ""
  || redis.hash !== ""
  || process.env.REDIS_URL !== redisUrl
) throw new Error("worker_sse_fixture_accepts_only_disposable_CI_PostgreSQL_and_Redis_DB_15")

const pool = new Pool({ connectionString: databaseUrl, max: 5 })
const noOpProjection = { start: async () => undefined, finish: async () => undefined }
let bootstrap
let inputBuffer = ""
let resolveShutdown
const shutdown = new Promise(resolve => { resolveShutdown = resolve })

function say(value) { process.stdout.write(`${value}\n`) }

function modelProfile() {
  return {
    provider: "fixture", model: "worker-sse-fixture", nativeTools: true, structuredOutput: true, streaming: true,
    continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: true,
    supportsReasoningSummary: true, supportsResponseContinuation: false, supportsProviderConversation: false,
    supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: null, costClass: "low",
  }
}

process.stdin.setEncoding("utf8")
function onStdinData(chunk) {
  inputBuffer += chunk
  const lines = inputBuffer.split("\n")
  inputBuffer = lines.pop() ?? ""
  if (lines.some(line => line.trim() === "shutdown")) resolveShutdown()
}
process.stdin.on("data", onStdinData)

function closeInput() {
  process.stdin.off("data", onStdinData)
  process.stdin.pause()
  process.stdin.destroy()
}

try {
  bootstrap = await startProductionWorkerRuntime({
    pool,
    workerId: `worker-sse-reconnect-${process.pid}`,
    productionFlags: {
      taskGraphPlanningEnabled: false,
      childExecutionEnabled: false,
      coordinationEnabled: false,
      consumeWaitOutcomes: false,
      canonicalAutomationEnabled: false,
      turnBoundaryCompactionEnabled: false,
    },
    startAgentRunWorker() {},
  }, {
    createOptionalProductionChildExecutor() { return undefined },
    createCanonicalTurnRuntime(runtimePool, productionOptions) {
      return createCanonicalTurnRuntime(runtimePool, {
        ...productionOptions,
        modelRuntimeFactory() {
          let modelCalls = 0
          return {
            adapter: {
              id: "worker-sse-reconnect-fixture-model",
              profile: modelProfile(),
              async *stream() {
                say("FIXTURE_MODEL_USED")
                modelCalls += 1
                if (modelCalls === 1) {
                  yield {
                    type: "tool_call_completed",
                    callId: "fixture-jobs-search",
                    name: "jobs.search",
                    arguments: { target: "Worker event replay fixture", limit: 5 },
                  }
                  yield { type: "completed", finishReason: "tool_calls" }
                  return
                }
                yield { type: "text_delta", text: "Deterministic disposable Worker SSE proof." }
                yield { type: "completed", finishReason: "stop" }
              },
            },
            registry: {},
            candidates: [],
          }
        },
      })
    },
    createWorkerUsageAuthorizer() { return async () => ({ settle() {} }) },
    createCanonicalExecutionProjection() { return noOpProjection },
    createCanonicalSessionProjection() { return noOpProjection },
    startProductionAgentRuntime(startupOptions) {
      return startProductionAgentRuntimeHelper({
        ...startupOptions,
        bootstrapOptions: runtime => {
          const composed = typeof startupOptions.bootstrapOptions === "function"
            ? startupOptions.bootstrapOptions(runtime)
            : startupOptions.bootstrapOptions
          return { ...composed, ownerId: `worker-sse-reconnect-${process.pid}`, turnRecoveryIntervalMs: 50 }
        },
      })
    },
  })
  say("WORKER_READY")
  await shutdown
  closeInput()
  say("WORKER_SHUTDOWN_RECEIVED")
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
} finally {
  closeInput()
  try { if (bootstrap) { say("BOOTSTRAP_CLOSE_BEGIN"); await bootstrap.close(); say("BOOTSTRAP_CLOSE_DONE") } } catch (error) {
    process.stderr.write(`bootstrap_close: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
  try { await pool.end() } catch (error) {
    process.stderr.write(`pool_end: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
  try { await closeSharedRedisConnections() } catch (error) {
    process.stderr.write(`redis_close: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
