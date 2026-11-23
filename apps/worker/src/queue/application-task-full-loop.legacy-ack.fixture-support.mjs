const SYNTHETIC_SESSION = /^full-loop-session-[a-f0-9]{32}$/
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

function exactRecord(value, expectedKeys) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value), keys = Reflect.ownKeys(value)
    if ((prototype !== Object.prototype && prototype !== null) || keys.length !== expectedKeys.length
      || keys.some(key => typeof key !== "string" || !expectedKeys.includes(key))) return null
    const descriptors = Object.getOwnPropertyDescriptors(value), result = Object.create(null)
    for (const key of expectedKeys) {
      const descriptor = descriptors[key]
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null
      result[key] = descriptor.value
    }
    return result
  } catch {
    return null
  }
}

function parseArm(value) {
  const row = exactRecord(value, ["sessionId", "fillTurnId", "expectedAttempt"])
  if (!row || typeof row.sessionId !== "string" || !SYNTHETIC_SESSION.test(row.sessionId)
    || typeof row.fillTurnId !== "string" || !SAFE_ID.test(row.fillTurnId) || row.expectedAttempt !== 1) return null
  return { sessionId: row.sessionId, fillTurnId: row.fillTurnId, expectedAttempt: 1 }
}

function parseProof(value) {
  const row = exactRecord(value, ["sessionId", "fillTurnId", "jobId", "attemptsStarted"])
  if (!row || typeof row.sessionId !== "string" || !SYNTHETIC_SESSION.test(row.sessionId)
    || typeof row.fillTurnId !== "string" || !SAFE_ID.test(row.fillTurnId)
    || typeof row.jobId !== "string" || !SAFE_ID.test(row.jobId) || row.attemptsStarted !== 1) return null
  return { sessionId: row.sessionId, fillTurnId: row.fillTurnId, jobId: row.jobId, attemptsStarted: 1 }
}

/** Test-only gate between the real Worker processor result and BullMQ acknowledgement. */
export function createLegacyQueueAckWitness(writeLine) {
  if (typeof writeLine !== "function") throw new Error("legacy_ack_witness_writer_invalid")
  let scope = null
  let matched = null
  let shutdown = false
  let releaseHold = null

  function arm(value) {
    if (shutdown || scope) return false
    scope = parseArm(value)
    return scope !== null
  }

  function proves(value) {
    const proof = parseProof(value)
    return Boolean(!shutdown && releaseHold && proof && matched && proof.sessionId === matched.sessionId
      && proof.fillTurnId === matched.fillTurnId && proof.jobId === matched.jobId
      && proof.attemptsStarted === matched.attemptsStarted)
  }

  function wrap(worker) {
    const processor = worker?.processFn
    if (typeof processor !== "function") throw new Error("legacy_ack_witness_processor_missing")
    worker.processFn = async function (job, ...args) {
      const result = await processor.call(this, job, ...args)
      if (!scope || matched || shutdown) return result
      try {
        const payload = job?.data
        if (typeof job?.id !== "string" || !SAFE_ID.test(job.id)
          || payload?.operation !== "submit" || payload.sessionId !== scope.sessionId
          || payload.fillTurnId !== scope.fillTurnId || job.attemptsStarted !== scope.expectedAttempt) return result
        matched = { sessionId: scope.sessionId, fillTurnId: scope.fillTurnId,
          jobId: job.id, attemptsStarted: job.attemptsStarted }
      } catch {
        return result
      }
      let settled = false
      let resolveHold
      const held = new Promise(resolve => { resolveHold = resolve })
      const finish = () => {
        if (settled) return
        settled = true
        releaseHold = null
        resolveHold()
      }
      releaseHold = finish
      writeLine("LEGACY_ACK_BARRIER_REACHED attempt=1")
      await held
      return result
    }
  }

  function releaseForShutdown() {
    shutdown = true
    releaseHold?.()
  }

  return { arm, proves, wrap, releaseForShutdown }
}
