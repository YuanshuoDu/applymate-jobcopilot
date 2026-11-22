import { createStage8MarkerFenceTrace } from "./application-task-full-loop.stage8-marker-trace.mjs"

const ARM_RELEASE = "stage8-release-arm"
const FINAL_RELEASE = "stage8-release-final"
const MAX_REVIEWED_POST_BYTES = 16_384
const STOP_POLL_ERROR_MESSAGES = new Map([
  ["Application submission Turn binding is unavailable.", "turn_binding_unavailable"],
  ["Application submission task binding is unavailable.", "task_binding_unavailable"],
  ["Application submission request phase is unavailable.", "request_phase_unavailable"],
  ["Application submission Turn state is unavailable.", "turn_state_unavailable"],
  ["Application submission Stop state is unavailable.", "stop_state_unavailable"],
  ["Application submission scope changed during Stop polling.", "scope_changed"],
  ["Application submission Stop poll did not commit.", "poll_commit_failed"],
])
const STOP_POLL_SQL_STATES = new Set(["08000", "08001", "08003", "08006", "23502", "23503", "23505", "23514", "40001", "40P01", "55P03", "57P01", "57P03"])

export async function hasExactReviewedCoverLetter(request, expected) {
  const contentType = String(request.headers?.["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase()
  const declaredSize = Number(request.headers?.["content-length"])
  if (contentType !== "application/x-www-form-urlencoded" || declaredSize > MAX_REVIEWED_POST_BYTES) {
    request.resume()
    return false
  }

  const chunks = []
  let size = 0
  let exceededLimit = false
  try {
    for await (const chunk of request) {
      if (exceededLimit) continue
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += bytes.length
      if (size > MAX_REVIEWED_POST_BYTES) {
        exceededLimit = true
        chunks.length = 0
        continue
      }
      chunks.push(bytes)
    }
  } catch {
    return false
  }
  if (exceededLimit) return false

  const fields = new URLSearchParams(Buffer.concat(chunks).toString("utf8")).getAll("cover_letter")
  return fields.length === 1 && fields[0] === expected
}

export function classifyStage8StopPollError(error) {
  try {
    const message = error && typeof error === "object" && "message" in error && typeof error.message === "string"
      ? error.message : null
    if (message && STOP_POLL_ERROR_MESSAGES.has(message)) return STOP_POLL_ERROR_MESSAGES.get(message) ?? "other"
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null
    return code && STOP_POLL_SQL_STATES.has(code) ? "database" : "other"
  } catch { return "other" }
}

export function createStage8FixtureControl() {
  const queued = new Set()
  const waiters = new Map()
  let shuttingDown = false
  let failureTarget = null
  let finishShutdown
  const shutdown = new Promise(resolve => { finishShutdown = resolve })
  process.stdin.setEncoding("utf8")
  let buffer = ""
  process.stdin.on("data", chunk => {
    buffer += chunk
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines.map(value => value.trim())) {
      if (line === "shutdown") {
        shuttingDown = true
        process.stdin.pause()
        for (const waiter of waiters.values()) {
          clearTimeout(waiter.timer)
          waiter.resolve("shutdown")
        }
        waiters.clear()
        finishShutdown()
      } else if (line.startsWith("stage8-failure-target ")) {
        const match = /^stage8-failure-target (\S{1,256}) (\S{1,256})$/.exec(line)
        if (!failureTarget && match) failureTarget = { sessionId: match[1], turnId: match[2] }
      } else if (line) {
        const waiter = waiters.get(line)
        if (waiter) { clearTimeout(waiter.timer); waiters.delete(line); waiter.resolve(line) }
        else queued.add(line)
      }
    }
  })
  return {
    shutdown,
    matchesSubmissionTarget(scope) {
      return Boolean(failureTarget && scope?.sessionId === failureTarget.sessionId
        && scope?.turnId === failureTarget.turnId && scope?.fillTurnId === failureTarget.turnId)
    },
    waitFor(command, timeoutMs = 30_000) {
      if (shuttingDown) return Promise.resolve("shutdown")
      if (queued.delete(command)) return Promise.resolve(command)
      if (waiters.has(command)) return Promise.reject(new Error("stage8_duplicate_control_waiter"))
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(command)
          reject(new Error("stage8_control_timeout"))
        }, timeoutMs)
        waiters.set(command, { resolve, timer })
      })
    },
  }
}

export function createStage8ApplicationSubmitDrain(outbox, control) {
  let released = false
  return async (pool, queue) => {
    if (!released) {
      if (await control.waitFor("stage8-release-publisher", 900_000) !== "stage8-release-publisher") return 0
      released = true
    }
    return outbox.drainApplicationSubmitOutbox(pool, queue)
  }
}

function trackStage8Pool(pool, control, workerTaskId, writeLine, markerTrace) {
  return new Proxy(pool, {
    get(target, key) {
      if (key !== "connect") {
        const value = Reflect.get(target, key, target)
        return typeof value === "function" ? value.bind(target) : value
      }
      return async (...args) => {
        const client = await target.connect(...args)
        let identity
        try { identity = await client.query("SELECT pg_backend_pid() AS pid") }
        catch (error) { client.release(); throw error }
        const pid = identity.rows[0]?.pid
        if (Number.isSafeInteger(pid)) writeLine(`STAGE8_DB_PID ${workerTaskId} ${pid}`)
        let armedMarkerWritten = false
        return new Proxy(client, {
          get(connection, property) {
            if (property !== "query") {
              const value = Reflect.get(connection, property, connection)
              return typeof value === "function" ? value.bind(connection) : value
            }
            return async (...queryArgs) => {
              const command = queryArgs[0]
              const sql = typeof command === "string" ? command : typeof command?.text === "string" ? command.text : ""
              const values = Array.isArray(queryArgs[1]) ? queryArgs[1] : Array.isArray(command?.values) ? command.values : []
              let result
              try { result = await connection.query(...queryArgs) }
              catch (error) { markerTrace?.observeError(sql, values); throw error }
              markerTrace?.observe(sql, values, result)
              if (sql.includes('INSERT INTO "application_task_events"') && values[2] === "submission_stop_protocol") {
                try { armedMarkerWritten = JSON.parse(values[4]).stage === "armed" } catch { armedMarkerWritten = false }
              }
              if (armedMarkerWritten && sql.trim().toUpperCase() === "COMMIT") {
                armedMarkerWritten = false
                writeLine(`STAGE8_ARM_COMMITTED ${workerTaskId}`)
                if (await control.waitFor(ARM_RELEASE) !== ARM_RELEASE) throw new Error("stage8_fixture_shutdown")
              }
              return result
            }
          },
        })
      }
    },
  })
}

export function createStage8ApplyWorker({ queue, stopProtocol, pool, control, writeLine }) {
  let firstExactStopPollObserved = false
  const writeStopPollLine = line => { try { writeLine(line) } catch { /* Stop diagnostics cannot change the protocol result. */ } }
  return queue.createApplyWorker({ stagedSubmissionStopProtocol: {
    isStopped: async scope => {
      const exactTarget = control.matchesSubmissionTarget(scope)
      if (!exactTarget || firstExactStopPollObserved) {
        return stopProtocol.isApplicationSubmissionStoppedWithStopProtocol(pool, scope)
      }
      firstExactStopPollObserved = true
      writeStopPollLine("STAGE8_STOP_POLL_ENTERED")
      try {
        const stopped = await stopProtocol.isApplicationSubmissionStoppedWithStopProtocol(pool, scope)
        writeStopPollLine(stopped ? "STAGE8_STOP_POLL_RETURN_STOPPED" : "STAGE8_STOP_POLL_RETURN_CONTINUE")
        return stopped
      } catch (error) {
        writeStopPollLine(`STAGE8_STOP_POLL_CAUGHT ${classifyStage8StopPollError(error)}`)
        throw error
      }
    },
    onContinuationAcknowledged: scope => writeLine(`STAGE8_CONTINUE_ACK ${scope.workerTaskId}`),
    acquireStartFence: async scope => {
      const exactTarget = control.matchesSubmissionTarget(scope)
      if (exactTarget) {
        writeLine("STAGE8_EXACT_SUBMISSION_ROUTE_MATCHED")
        writeLine("STAGE8_START_FENCE_ENTERED")
      }
      const markerTrace = exactTarget ? createStage8MarkerFenceTrace(scope, writeStopPollLine) : null
      let fence
      try {
        fence = await stopProtocol.acquireApplicationSubmissionStartFenceWithStopProtocol(
          trackStage8Pool(pool, control, scope.workerTaskId, writeLine, markerTrace), scope,
        )
      } catch (error) {
        if (exactTarget) { markerTrace?.finish(); writeLine("STAGE8_START_FENCE_RESULT threw") }
        throw error
      }
      if (exactTarget) {
        markerTrace?.finish()
        const state = ["ready", "stopped", "inactive", "uncertain"].includes(fence.state) ? fence.state : "other"
        writeLine("STAGE8_START_FENCE_RESULT " + state)
      }
      if (fence.state !== "ready") return fence
      writeLine(`STAGE8_FINAL_FENCE_READY ${scope.workerTaskId}`)
      try {
        if (await control.waitFor(FINAL_RELEASE) !== FINAL_RELEASE) {
          await fence.release(false).catch(() => undefined)
          return { state: "uncertain", release: async () => undefined }
        }
      } catch (error) {
        await fence.release(false).catch(() => undefined)
        throw error
      }
      return { ...fence, release: async commit => {
        await fence.release(commit)
        writeLine(`STAGE8_FINAL_FENCE_RELEASED ${scope.workerTaskId}`)
      } }
    },
  } })
}

export async function closeStage8Workers(workers, timeoutMs = 6_000) {
  const settleWithin = async (operation, limit) => {
    let timer
    try {
      return await Promise.race([
        Promise.resolve().then(operation).then(() => true, () => false),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), limit) }),
      ])
    } finally { if (timer) clearTimeout(timer) }
  }
  const results = await Promise.all(workers.map(worker => settleWithin(() => worker.close(true), timeoutMs)))
  for (let index = 0; index < results.length; index += 1) {
    if (results[index] !== false) continue
    await settleWithin(() => workers[index]?.disconnect(), 2_000)
  }
  return results.every(result => result === true)
}
