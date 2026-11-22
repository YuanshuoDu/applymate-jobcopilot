const phases = [
  "not_seen", "begin", "source_read", "source_fence", "session_lock", "turn_lock", "filler_lock",
  "task_lock", "job_lock", "task_proof", "attempt_proof", "approval_proof", "start_proof",
  "session_state", "turn_state", "interrupt_state", "mark_started", "stop_stage", "commit", "rollback", "other",
]
const transactions = ["not_started", "open", "committed", "rolled_back", "other"]
const counts = ["not_seen", "zero", "one", "multiple"]
const statuses = [
  "not_seen", "missing", "filling", "browser_active", "submission_request_started", "approved", "reserved",
  "consumed", "running", "completed", "waiting_for_user", "in_progress", "interrupted", "failed", "cancelled", "other",
]
const matches = ["not_seen", "match", "mismatch"]
const leases = ["not_seen", "live", "lease_free", "invalid"]
const interruptions = ["not_seen", "clear", "present", "unknown"]
const writes = ["not_seen", "started", "inactive", "recorded", "fenced", "error"]

const emptyTrace = Object.freeze({
  transaction: "not_started", lastPhase: "not_seen", queryErrorPhase: "not_seen", sourceReads: "not_seen",
  sessionLockRows: "not_seen", turnLockRows: "not_seen", fillerRows: "not_seen", taskLock: "not_seen",
  jobLockRows: "not_seen", taskRows: "not_seen", taskStatus: "not_seen", taskCheckpoint: "not_seen",
  taskWorkerMatch: "not_seen", attemptRows: "not_seen", attemptState: "not_seen", attemptMatch: "not_seen",
  approvalRows: "not_seen", approvalStatus: "not_seen", approvalMatch: "not_seen", priorStartRows: "not_seen",
  sessionStatus: "not_seen", turnStatus: "not_seen", lease: "not_seen", interruption: "not_seen",
  markStarted: "not_seen", stopStage: "not_seen",
})

function objectRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {}
}

function safeEnum(value, allowed, fallback = "other") {
  return allowed.includes(value) ? value : fallback
}

function rowCount(length) {
  return Number.isSafeInteger(length) && length >= 0
    ? length === 0 ? "zero" : length === 1 ? "one" : "multiple"
    : "not_seen"
}

/** Rebuilds a fixed, allowlisted snapshot from any value before the fixture prints it. */
export function sanitizeStage8MarkerFenceTrace(value) {
  try {
    const row = objectRecord(value)
    return {
      transaction: safeEnum(row.transaction, transactions),
      lastPhase: safeEnum(row.lastPhase, phases),
      queryErrorPhase: safeEnum(row.queryErrorPhase, phases),
      sourceReads: safeEnum(row.sourceReads, counts, "not_seen"),
      sessionLockRows: safeEnum(row.sessionLockRows, counts, "not_seen"),
      turnLockRows: safeEnum(row.turnLockRows, counts, "not_seen"),
      fillerRows: safeEnum(row.fillerRows, counts, "not_seen"),
      taskLock: safeEnum(row.taskLock, matches, "not_seen"),
      jobLockRows: safeEnum(row.jobLockRows, counts, "not_seen"),
      taskRows: safeEnum(row.taskRows, counts, "not_seen"),
      taskStatus: safeEnum(row.taskStatus, statuses, "not_seen"),
      taskCheckpoint: safeEnum(row.taskCheckpoint, statuses, "not_seen"),
      taskWorkerMatch: safeEnum(row.taskWorkerMatch, matches, "not_seen"),
      attemptRows: safeEnum(row.attemptRows, counts, "not_seen"),
      attemptState: safeEnum(row.attemptState, statuses, "not_seen"),
      attemptMatch: safeEnum(row.attemptMatch, matches, "not_seen"),
      approvalRows: safeEnum(row.approvalRows, counts, "not_seen"),
      approvalStatus: safeEnum(row.approvalStatus, statuses, "not_seen"),
      approvalMatch: safeEnum(row.approvalMatch, matches, "not_seen"),
      priorStartRows: safeEnum(row.priorStartRows, counts, "not_seen"),
      sessionStatus: safeEnum(row.sessionStatus, statuses, "not_seen"),
      turnStatus: safeEnum(row.turnStatus, statuses, "not_seen"),
      lease: safeEnum(row.lease, leases, "not_seen"),
      interruption: safeEnum(row.interruption, interruptions, "not_seen"),
      markStarted: safeEnum(row.markStarted, writes, "not_seen"),
      stopStage: safeEnum(row.stopStage, writes, "not_seen"),
    }
  } catch {
    return { ...emptyTrace }
  }
}

function classifyQuery(sql, values) {
  const query = typeof sql === "string" ? sql.trim().replace(/\s+/g, " ").toLowerCase() : ""
  if (query === "begin" || query === "commit" || query === "rollback") return query
  if (query.includes('select "input" from "agent_turns"')) return "source_read"
  if (query.includes("pg_current_xact_id()::text")) return "source_fence"
  if (query.includes('select "id" from "agent_sessions"') && query.includes("for update")) return "session_lock"
  if (query.includes('select "id" from "agent_turns"') && query.includes("for update")) return "turn_lock"
  if (query.includes('from "sub_agent_tasks" as filler')) return "filler_lock"
  if (query.includes('select "sessionid", "fillturnid", "fillturnsessionid", "fillturnuserid" from "application_tasks"')) return "task_lock"
  if (query.includes('select "id" from "job"')) return "job_lock"
  if (query.startsWith('select "status","checkpoint","workertaskid" from "application_tasks"')) return "task_proof"
  if (query.startsWith('select "userid","jobid","receiptid","constrainthash","artifacthash","state" from "submission_attempt"')) return "attempt_proof"
  if (query.startsWith('select "userid","sessionid","turnid","taskid","jobid","toolcallid","type","status","payload"')
    && query.includes('"consumedat"')) return "approval_proof"
  if (query.includes("submission_execution_started") && query.includes('from "application_task_events"')) return "start_proof"
  if (query.startsWith('select "status" from "agent_sessions"')) return "session_state"
  if (query.includes('"leaseownerid"') && query.includes('from "agent_turns"')) return "turn_state"
  if (query.includes("turn.interrupt.requested")) return "interrupt_state"
  if (query.startsWith('with started as (update application_tasks set "checkpoint" = \'submission_request_started\'')) return "mark_started"
  if (query.includes('insert into "application_task_events"') && values?.[2] === "submission_stop_protocol") return "stop_stage"
  return "other"
}

function safeStatus(value) {
  return safeEnum(value, statuses)
}

/** Observes only the exact start-fence connection and never issues its own query. */
export function createStage8MarkerFenceTrace(scope, writeLine) {
  const state = { ...emptyTrace }
  let active = true

  const finish = () => {
    if (!active) return
    active = false
    try {
      writeLine(`STAGE8_MARKER_TRANSACTION ${JSON.stringify(sanitizeStage8MarkerFenceTrace(state))}`)
    } catch {
      // Fixture diagnostics must not affect the request fence.
    }
  }

  const observe = (sql, values, result, failed = false) => {
    if (!active) return
    try {
      const phase = classifyQuery(sql, values)
      const rows = Array.isArray(result?.rows) ? result.rows : []
      const row = rows.length === 1 ? objectRecord(rows[0]) : {}
      if (failed) state.queryErrorPhase = safeEnum(phase, phases)
      if (!["begin", "commit", "rollback", "other"].includes(phase)) state.lastPhase = phase
      if (failed) {
        if (phase === "mark_started") state.markStarted = "error"
        if (phase === "stop_stage") state.stopStage = "error"
        return
      }
      if (phase === "begin") state.transaction = "open"
      if (phase === "commit" || phase === "rollback") {
        state.transaction = phase === "commit" ? "committed" : "rolled_back"
        finish()
        return
      }

      if (phase === "source_read") state.sourceReads = state.sourceReads === "not_seen" ? "one" : "multiple"
      if (phase === "session_lock") state.sessionLockRows = rowCount(rows.length)
      if (phase === "turn_lock") state.turnLockRows = rowCount(rows.length)
      if (phase === "filler_lock") state.fillerRows = rowCount(rows.length)
      if (phase === "task_lock") state.taskLock = rows.length === 1 && row.sessionId === scope.sessionId
        && row.fillTurnId === scope.fillTurnId && row.fillTurnSessionId === scope.sessionId && row.fillTurnUserId === scope.userId ? "match" : "mismatch"
      if (phase === "job_lock") state.jobLockRows = rowCount(rows.length)
      if (phase === "task_proof") {
        state.taskRows = rowCount(rows.length)
        state.taskStatus = rows.length === 1 ? row.status === "filling" ? "filling" : "other" : "missing"
        state.taskCheckpoint = rows.length === 1 ? safeStatus(row.checkpoint) : "missing"
        state.taskWorkerMatch = rows.length === 1 && row.workerTaskId === scope.workerTaskId ? "match" : "mismatch"
      }
      if (phase === "attempt_proof") {
        state.attemptRows = rowCount(rows.length)
        state.attemptState = rows.length === 1 ? safeStatus(row.state) : "missing"
        state.attemptMatch = rows.length === 1 && row.userId === scope.userId && row.jobId === scope.jobId
          && row.receiptId === scope.approvalId && row.constraintHash === scope.constraintHash ? "match" : "mismatch"
      }
      if (phase === "approval_proof") {
        state.approvalRows = rowCount(rows.length)
        state.approvalStatus = rows.length === 1 ? safeStatus(row.status) : "missing"
        state.approvalMatch = rows.length === 1 && row.userId === scope.userId && row.sessionId === scope.sessionId
          && row.turnId === scope.fillTurnId && row.taskId === scope.applicationTaskId && row.jobId === scope.jobId
          && row.type === "submit_application" && row.scopeHash === scope.constraintHash ? "match" : "mismatch"
      }
      if (phase === "start_proof") state.priorStartRows = rowCount(rows.length)
      if (phase === "session_state") state.sessionStatus = rows.length === 1 ? safeStatus(row.status) : "missing"
      if (phase === "turn_state") {
        state.turnStatus = rows.length === 1 ? safeStatus(row.status) : "missing"
        const started = row.leaseStartedAt instanceof Date ? row.leaseStartedAt.getTime() : Date.parse(row.leaseStartedAt)
        const expires = row.leaseExpiresAt instanceof Date ? row.leaseExpiresAt.getTime() : Date.parse(row.leaseExpiresAt)
        const versionValid = Number.isSafeInteger(row.leaseVersion) && row.leaseVersion >= 0
        state.lease = rows.length !== 1 || !versionValid ? "invalid"
          : row.leaseOwnerId === null && row.leaseStartedAt === null && row.leaseExpiresAt === null ? "lease_free"
            : typeof row.leaseOwnerId === "string" && row.leaseOwnerId.trim() === row.leaseOwnerId && row.leaseOwnerId.length > 0
              && Number.isFinite(started) && Number.isFinite(expires) && started <= Date.now() && expires > Date.now() ? "live" : "invalid"
      }
      if (phase === "interrupt_state") state.interruption = rows.length === 1
        ? row.stopped === true ? "present" : row.stopped === false ? "clear" : "unknown"
        : "unknown"
      if (phase === "mark_started") state.markStarted = result?.rowCount === 1 ? "started" : "inactive"
      if (phase === "stop_stage") state.stopStage = result?.rowCount === 1 ? "recorded" : "fenced"
    } catch {
      state.queryErrorPhase = "other"
    }
  }

  return { observe, observeError: (sql, values) => observe(sql, values, null, true), finish }
}
