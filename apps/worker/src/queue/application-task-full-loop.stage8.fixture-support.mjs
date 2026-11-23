const ARM_RELEASE = "stage8-release-arm"
const FINAL_RELEASE = "stage8-release-final"

export function createStage8FixtureControl() {
  const queued = new Set()
  const waiters = new Map()
  let shuttingDown = false
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
      } else if (line) {
        const waiter = waiters.get(line)
        if (waiter) { clearTimeout(waiter.timer); waiters.delete(line); waiter.resolve(line) }
        else queued.add(line)
      }
    }
  })
  return {
    shutdown,
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

function trackStage8Pool(pool, control, workerTaskId, writeLine) {
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
              const result = await connection.query(...queryArgs)
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
  return queue.createApplyWorker({ stagedSubmissionStopProtocol: {
    isStopped: scope => stopProtocol.isApplicationSubmissionStoppedWithStopProtocol(pool, scope),
    onContinuationAcknowledged: scope => writeLine(`STAGE8_CONTINUE_ACK ${scope.workerTaskId}`),
    acquireStartFence: async scope => {
      const fence = await stopProtocol.acquireApplicationSubmissionStartFenceWithStopProtocol(
        trackStage8Pool(pool, control, scope.workerTaskId, writeLine), scope,
      )
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
