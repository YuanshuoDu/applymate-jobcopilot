import { errorMonitor } from "node:events"
import { isDeepStrictEqual } from "node:util"
import { Queue, Worker } from "bullmq"
import { Pool } from "pg"
import { createCanonicalTurnRuntime } from "../canonical-turn-runtime.ts"
import { loadCanonicalTurnState } from "../canonical-turn-state.ts"
import { createPgTurnEngineStore } from "../turns/turn-engine-store.ts"
import { createPgTaskGraphCommandPort } from "./pg-task-graph-command-port.ts"
import { ROLE_RESULT_SCHEMA } from "./role-results.ts"
import { createProductionChildExecutor } from "./production-child-runtime.ts"
import { hashArtifactContent } from "./artifact-adapters.ts"
import { writerArtifactReferenceFromTaskContext } from "./task-graph-dependency-context.ts"
import { defaultSubagentPolicy, parseSubagentJobPayload } from "./types.ts"
import { PgSubagentTaskStore } from "./pg-store.ts"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.ts"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, TASK_GRAPH_VERIFICATION_SCHEMA_VERSION_V2 } from "../planning/task-graph-verification.ts"
import { TASK_GRAPH_VERIFIER_VERSION } from "./task-graph-pg-verification.ts"
import { taskGraphItemId, taskGraphLifecycleKey } from "./task-graph-snapshot.ts"
import { parseTaskGraphSupersededScoutRetirementReceipt, TASK_GRAPH_SUPERSEDED_SCOUT_RETIREMENT_EVENT_TYPE } from "./task-graph-scout-retirement-contract.ts"
import { parsePlanLedger, projectPlanLedger } from "@jobcopilot/agent-protocol"

const [, , mode, rawIds] = process.argv, ids = JSON.parse(rawIds)
const sourceGoal = "Read the durable TaskGraph source", dependentGoal = "Summarize the restored TaskGraph source"
const followUpGoal = "Verify the restored TaskGraph summary after restart", followUpKey = "verification"
const discoveryScoutGoal = "Find the owner-scoped fixture job"
const discoveryAnalystGoal = "Score the restored owner-scoped fixture job"
const discoveryPlanCallId = "p3-process-restart-discovery-plan"
const discoveryWaitCallId = "p3-process-restart-discovery-wait-call"
const discoveryAnalystPlanCallId = "p3-process-restart-discovery-analyst-plan"
const discoveryAnalystWaitCallId = "p3-process-restart-discovery-analyst-wait"
const discoveryFinalMarker = "p3-process-restart-discovery-shortlist-ready"
const processRestartSearchInput = Object.freeze({ target: "Software Engineer", location: "Dublin", limit: 10 })
const successiveSeattleKey = "scout-seattle", successiveDublinKey = "scout-dublin-replacement", successiveBerlinKey = "scout-berlin-final"
const successiveWaitIds = ids => ({
  seattlePlan: `p3-1248-seattle-plan:${ids.turnId}`, seattleWait: `p3-1248-seattle-wait:${ids.turnId}`,
  dublinPlan: `p3-1248-dublin-plan:${ids.turnId}`, dublinRefresh: `p3-1248-dublin-refresh:${ids.turnId}`,
  retireSeattle: `p3-1248-retire-seattle:${ids.turnId}`,
  firstWait: `p3-1248-first-retirement-wait:${ids.turnId}`, berlinInspect: `p3-1248-berlin-inspect:${ids.turnId}`,
  berlinPlan: `p3-1248-berlin-plan:${ids.turnId}`, berlinRefresh: `p3-1248-berlin-refresh:${ids.turnId}`,
  retireDublin: `p3-1248-retire-dublin:${ids.turnId}`,
  finalWait: `p3-1248-final-wait:${ids.turnId}`, finalList: `p3-1248-final-list:${ids.turnId}`,
  initialWaitKey: `p3-1248-initial:${ids.turnId}`, firstWaitKey: `p3-1248-after-seattle:${ids.turnId}`,
  finalWaitKey: `p3-1248-after-dublin:${ids.turnId}`,
})
const TASK_GRAPH_KEY_ALLOWLIST = new Set(["source", "summary", followUpKey])
const CHILD_FAILURE_DIAGNOSTIC_CODES = new Set(["invalid_structured_result", "model_incomplete", "invalid_output", "tool_execution_failed", "timeout", "cancelled", "step_limit", "budget_exhausted", "no_progress", "evidence_missing", "evidence_conflict", "final_unverified", "child_turn_missing", "child_resume_unavailable", "child_resume_evidence_unavailable", "selected_job_sources_unavailable", "selected_job_context_unavailable", "subagent_role_unknown"])
const CHILD_EXCEPTION_DIAGNOSTIC_NAMES = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "AbortError", "TimeoutError"])
const TURN_WORKER_ERROR_DIAGNOSTIC_NAMES = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "AbortError", "TimeoutError", "ConnectionError", "MaxRetriesPerRequestError", "ReplyError"])
const TURN_WORKER_ERROR_DIAGNOSTIC_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "ECONNABORTED", "NR_CLOSED"])
const TURN_STATUS_ALLOWLIST = new Set(["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user", "completed", "interrupted", "failed", "cancelled"])
const STEP_STATUS_ALLOWLIST = new Set(["completed", "failed", "interrupted", "waiting_for_tool", "waiting_for_approval", "waiting_for_user"])
const ROOT_TASK_STATUS_ALLOWLIST = new Set(["queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed"])
const ITEM_LIFECYCLE_STATUS_ALLOWLIST = new Set(["started", "completed", "failed", "cancelled"])
const TOOL_CALL_STATUS_ALLOWLIST = new Set(["started", "completed", "failed", "interrupted"])
const WAIT_OUTPUT_STATUS_ALLOWLIST = new Set(["waiting", "ready", "timed_out"])
const STEP_ERROR_CLASS_BY_CODE = new Map([
  ["40p01", "database_deadlock"], ["40001", "database_serialization"], ["55p03", "database_lock_wait"],
  ["coordination_invalid_input", "coordination_invalid_input"], ["coordination_task_not_found", "coordination_task_not_found"],
  ["coordination_scope_error", "coordination_scope_error"], ["coordination_wait_unavailable", "coordination_wait_unavailable"],
  ["wait_invalid", "wait_handoff_state"], ["wait_scope_error", "wait_handoff_state"], ["lease_lost", "turn_lease_state"],
  ["tool_execution_failed", "generic_tool_execution_failed"], ["business_precondition_failed", "business_precondition_failed"],
  ["invalid_output", "turn_output_invalid"], ["budget_exhausted", "turn_budget_exhausted"],
])
const RESTORED_GRAPH_GUARD_MARKERS = new Set([
  "snapshot_not_restored", "source_node_not_restored", "summary_node_not_restored", "other_node_not_restored",
  "wait_result_missing", "source_verification_not_restored", "summary_verification_not_restored",
  "source_projection_missing", "other",
])
const resultMarker = "p3-process-restart-source-result", finalMarker = "p3-process-restart-parent-resumed-after-follow-up"
const planCallId = "p3-process-restart-plan", waitCallId = "p3-process-restart-wait"
const followUpPlanCallId = "p3-process-restart-follow-up-plan", followUpWaitCallId = "p3-process-restart-follow-up-wait"
const archivedWaitCallId = "p3-process-archived-wait-call", archivedWaitFinalMarker = "p3-process-archived-wait-resumed"
const archivedWaitFreshListCallId = "p3-process-archived-wait-fresh-list"
const SELECTED_JOB_STOP_REVIEW_PHASE_MARKERS = Object.freeze({
  commandReceived: "P3_SELECTED_JOB_STOP_REVIEW_PHASE_COMMAND_RECEIVED",
  round1Entered: "P3_SELECTED_JOB_STOP_REVIEW_PHASE_ROUND_1_ENTERED",
  artifactVersionReadYieldReached: "P3_SELECTED_JOB_STOP_REVIEW_PHASE_ARTIFACT_VERSION_READ_YIELD_REACHED",
  round2Entered: "P3_SELECTED_JOB_STOP_REVIEW_PHASE_ROUND_2_ENTERED",
  readyEmissionReached: "P3_SELECTED_JOB_STOP_REVIEW_PHASE_READY_EMISSION_REACHED",
})
const pool = new Pool({ connectionString: process.env.AGENT_RUNTIME_PG_TEST_URL, max: 5 })
let bootstrap
let selectedJobWorker
let sharedRedisModule
let stdinBuffer = ""
let initialWaitLineage = null
let archivedWaitChildProgress = 0
let successiveSeattleSearchHeld = false
const successiveHeldChildren = new Set()
const successiveClaimedBeforeModel = new Set()
let successiveRecoveryTrace
let successiveRecoveryTraceEmitted = false
const successiveChildLeases = new Map()
let successiveRootLease = null
const queuedCommands = []
const commandWaiters = new Map()
process.stdin.setEncoding("utf8")
function onStdinData(chunk) {
  stdinBuffer += chunk
  const lines = stdinBuffer.split("\n")
  stdinBuffer = lines.pop() ?? ""
  for (const command of lines.map(line => line.trim()).filter(Boolean)) { const waiters = commandWaiters.get(command), resolve = waiters?.shift()
    if (resolve) { if (!waiters.length) commandWaiters.delete(command); resolve() } else queuedCommands.push(command) }
}
process.stdin.on("data", onStdinData)
function say(value) { process.stdout.write(value + "\n") }
const SUCCESSIVE_RECOVERY_TRACE_PREFIX = "WORKER_B_RECOVERY_PREDICATE_TRACE "
const SUCCESSIVE_RECOVERY_STAGES = new Set(["candidate_not_seen", "candidate_seen", "session_lock_mismatch", "turn_lock_mismatch",
  "expiry_preview_rejected", "root_turn_not_recoverable", "task_lock_parity_mismatch", "recovery_clock_missing",
  "lease_expiry_fence_mismatch", "unsettled_external_call_rejected", "durable_wait_graph_blocked",
  "task_graph_transition_blocked", "task_graph_finish_blocked", "task_update_rejected"])
const SUCCESSIVE_WAIT_PROJECTION_STAGES = new Set(["invalid_input", "wait_row_count", "wait_validation", "lease_fence_validation",
  "wait_timestamp_validation", "timeout_validation", "target_validation", "target_match_validation", "call_result_validation",
  "call_timestamp_validation", "call_contract_validation", "safe_serialization_validation", "optimistic_update_missed"])
const SUCCESSIVE_WAIT_PROJECTION_DISPOSITIONS = new Set(["skipped", "repaired", "already_current", "rejected"])
const SUCCESSIVE_DISPATCH_KEYS = ["present", "payloadValid", "task", "session", "root", "owner", "generation", "published"]
function boundedRecoveryCount(value) { return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 10_000) : 0 }
function recoveryTraceBoolean(value) { return typeof value === "boolean" ? value : null }
function armSuccessiveRecoveryTrace() {
  const target = process.env.AGENT_RUNTIME_PG_TEST_RECOVERY_TRACE_TASK_ID
  if (mode !== "resume-successive-replan" || process.env.NODE_ENV !== "test"
    || typeof target !== "string" || !target || target.length > 256) return
  successiveRecoveryTrace = { scanCount: 0, candidateNotSeenScanCount: 0, candidateSeenScanCount: 0,
    targetSeen: false, firstTargetSeenRejectionStage: null, waitProjectionDisposition: null,
    waitProjectionStage: null, childWaitResumable: null, waitRegistrationFound: null,
    waitRegistrationRejected: null, blockingExternalCall: null, dispatch: null, malformedTrace: false }
  const originalInfo = console.info.bind(console)
  console.info = (...args) => {
    const line = args[0]
    if (typeof line !== "string" || !line.startsWith(SUCCESSIVE_RECOVERY_TRACE_PREFIX)) return originalInfo(...args)
    try {
      const source = record(JSON.parse(line.slice(SUCCESSIVE_RECOVERY_TRACE_PREFIX.length)))
      const stage = source && SUCCESSIVE_RECOVERY_STAGES.has(source.rejectionStage) ? source.rejectionStage : null
      const pages = source && Array.isArray(source.pages) ? source.pages : null
      if (!source || !stage || !pages || pages.length > 16) { successiveRecoveryTrace.malformedTrace = true; return }
      const targetSeen = pages.some(page => record(page)?.targetSeen === true)
      successiveRecoveryTrace.scanCount = boundedRecoveryCount(successiveRecoveryTrace.scanCount + 1)
      if (targetSeen) {
        successiveRecoveryTrace.targetSeen = true
        successiveRecoveryTrace.candidateSeenScanCount = boundedRecoveryCount(successiveRecoveryTrace.candidateSeenScanCount + 1)
        if (successiveRecoveryTrace.firstTargetSeenRejectionStage === null) {
          successiveRecoveryTrace.firstTargetSeenRejectionStage = stage
          successiveRecoveryTrace.waitProjectionDisposition = SUCCESSIVE_WAIT_PROJECTION_DISPOSITIONS.has(source.waitProjectionDisposition)
            ? source.waitProjectionDisposition : "other"
          successiveRecoveryTrace.waitProjectionStage = SUCCESSIVE_WAIT_PROJECTION_STAGES.has(source.waitProjectionStage)
            ? source.waitProjectionStage : source.waitProjectionStage === undefined ? null : "other"
          successiveRecoveryTrace.childWaitResumable = recoveryTraceBoolean(source.childWaitResumable)
          successiveRecoveryTrace.waitRegistrationFound = recoveryTraceBoolean(source.waitRegistrationFound)
          successiveRecoveryTrace.waitRegistrationRejected = recoveryTraceBoolean(source.waitRegistrationRejected)
          successiveRecoveryTrace.blockingExternalCall = recoveryTraceBoolean(source.blockingExternalCall)
          const dispatch = record(source.dispatch)
          successiveRecoveryTrace.dispatch = dispatch ? Object.fromEntries(SUCCESSIVE_DISPATCH_KEYS.map(key =>
            [key, recoveryTraceBoolean(dispatch[key])])) : null
        }
      } else if (stage === "candidate_not_seen") {
        successiveRecoveryTrace.candidateNotSeenScanCount = boundedRecoveryCount(successiveRecoveryTrace.candidateNotSeenScanCount + 1)
      }
    } catch { successiveRecoveryTrace.malformedTrace = true }
  }
}
function emitSuccessiveRecoveryTrace() {
  if (!successiveRecoveryTrace || successiveRecoveryTraceEmitted) return
  successiveRecoveryTraceEmitted = true
  say("P3_SUCCESSIVE_REPLAN_RECOVERY_TRACE " + JSON.stringify(successiveRecoveryTrace))
}
function noReservationUsageAuthorization() {
  return {
    outputReservationRequired: false,
    maxOutputTokens: null,
    settle: async () => undefined,
    settleUnknown: async (_settlement) => undefined,
  }
}
const ARCHIVED_WAIT_PROGRESS_PHASES = new Set([
  "model_stream_entered", "tools_validated", "root_identity_validated", "child_create_started", "child_create_failed",
  "child_created", "child_claim_started", "child_claim_failed", "child_claimed", "child_finish_started",
  "child_finish_failed", "child_finished", "child_pending", "wait_call_emitted", "model_stream_failed",
])
const ARCHIVED_WAIT_ERROR_KINDS = new Set(["none", "error", "type_error", "range_error", "syntax_error", "non_error"])
function archivedWaitFailureKind(error) {
  try {
    if (error instanceof TypeError) return "type_error"
    if (error instanceof RangeError) return "range_error"
    if (error instanceof SyntaxError) return "syntax_error"
    return error instanceof Error ? "error" : "non_error"
  } catch {
    return "non_error"
  }
}
function archivedWaitProgress(phase, progress = 0, errorKind = "none") {
  const safePhase = ARCHIVED_WAIT_PROGRESS_PHASES.has(phase) ? phase : "other"
  const safeProgress = Number.isSafeInteger(progress) && progress >= 0 && progress <= 7 ? progress : 0
  const safeErrorKind = ARCHIVED_WAIT_ERROR_KINDS.has(errorKind)
    ? errorKind : "other"
  say("P3_ARCHIVED_WAIT_PROGRESS " + JSON.stringify({ phase: safePhase, progress: safeProgress, errorKind: safeErrorKind }))
}
function restoredGraphGuardMarker(error) {
  const message = error instanceof Error ? error.message : ""
  let marker = "other"
  if (message === "p3_task_graph_revision_or_snapshot_not_restored") marker = "snapshot_not_restored"
  else if (message.startsWith("p3_task_graph_node_not_restored:")) {
    const key = message.slice("p3_task_graph_node_not_restored:".length)
    marker = key === "source" ? "source_node_not_restored"
      : key === "summary" ? "summary_node_not_restored" : "other_node_not_restored"
  } else if (message === "p3_durable_wait_result_missing") marker = "wait_result_missing"
  else if (message === "p3_typed_verification_report_not_restored:candidate-count") marker = "source_verification_not_restored"
  else if (message === "p3_typed_verification_report_not_restored:finding-count") marker = "summary_verification_not_restored"
  else if (message.startsWith("p3_restored_graph_source_projection_missing:")) marker = "source_projection_missing"
  return RESTORED_GRAPH_GUARD_MARKERS.has(marker) ? marker : "other"
}
function safeFailureCategory(error) {
  const code = record(error)?.code
  if (typeof code === "string") {
    const category = STEP_ERROR_CLASS_BY_CODE.get(code.toLowerCase())
    if (category) return category
  }
  if (error instanceof Error && error.message === "p3_persisted_plan_ledger_projection_invalid") {
    return "plan_ledger_projection_invalid"
  }
  if (error instanceof Error && error.name === "CoordinationError") return "coordination_scope_error"
  if (error instanceof Error && error.name === "AssertionError") return "task_graph_failure"
  return "other"
}
function assertSafeFailureCategoryProjection() {
  const known = safeFailureCategory(new Error("p3_persisted_plan_ledger_projection_invalid"))
  const unknown = safeFailureCategory(new Error("p3_persisted_plan_ledger_projection_invalid:private-detail"))
  if (known !== "plan_ledger_projection_invalid" || unknown !== "other") {
    throw new Error("p3_failure_category_projection_self_test_failed")
  }
}
function captureModelStreamFailure(model, onFailure) {
  return {
    ...model,
    stream(request) {
      return (async function* () {
        try {
          for await (const event of model.stream(request)) yield event
        } catch (error) {
          onFailure(error)
          throw error
        }
      })()
    },
  }
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
function waitForCommand(command) {
  const index = queuedCommands.indexOf(command)
  if (index >= 0) { queuedCommands.splice(index, 1); return Promise.resolve() }
  return new Promise(resolve => { const waiters = commandWaiters.get(command) ?? []; waiters.push(resolve); commandWaiters.set(command, waiters) })
}
function record(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : null }
function assertNoPrivateArtifactFixtureData(value, serializedValue = rawIds) {
  const serialized = typeof serializedValue === "string" ? serializedValue : ""
  if (/(?:^|[,{])\s*"(?:body|draftBody|artifactRef|artifactReference)"\s*:/i.test(serialized)
    || /AC6_(?:PRIVATE_COVER_LETTER_|TRANSIENT_(?:JOB|RESUME|PERSONA)_SOURCE_)/.test(serialized)) {
    throw new Error("p3_second_worker_fixture_input_contains_private_artifact_data")
  }
  const visit = current => {
    if (typeof current === "string") return /AC6_(?:PRIVATE_COVER_LETTER_|TRANSIENT_(?:JOB|RESUME|PERSONA)_SOURCE_)/.test(current)
    if (Array.isArray(current)) return current.some(visit)
    const row = record(current)
    if (!row) return false
    return Object.entries(row).some(([key, child]) => {
      const normalized = key.replace(/[-_]/g, "").toLowerCase()
      return ["body", "draftbody", "artifactref", "artifactreference"].includes(normalized) || visit(child)
    })
  }
  if (visit(value)) throw new Error("p3_second_worker_fixture_input_contains_private_artifact_data")
}
function assertPrivateArtifactFixtureGuardSelfTest() {
  const safeInput = { selectedJob: { jobId: "p3-selected-job-fixture", expectedBodyHash: "sha256:fixture" } }
  assertNoPrivateArtifactFixtureData(safeInput, JSON.stringify(safeInput))
  const rejectedInputs = [
    { value: { nested: { selectedJob: { body: "AC6_PRIVATE_COVER_LETTER_fixture" } } } },
    { value: { runtime: { task: { context: { artifactRef: { artifactId: "private-ref" } } } } } },
    { value: { fixturePayload: { draft_body: "AC6_PRIVATE_COVER_LETTER_fixture" } } },
    { value: { nested: { safe: true } }, serialized: '{"nested":{"body":"AC6_PRIVATE_COVER_LETTER_fixture"},"nested":{"safe":true}}' },
    { value: { nested: { privateText: "AC6_PRIVATE_COVER_LETTER_fixture" } } },
    { value: { selectedJob: { source: "AC6_TRANSIENT_JOB_SOURCE_W2_fixture" } } },
    { value: { selectedJob: { source: "AC6_TRANSIENT_RESUME_SOURCE_W2_fixture" } } },
    { value: { selectedJob: { source: "AC6_TRANSIENT_PERSONA_SOURCE_W2_fixture" } } },
  ]
  for (const item of rejectedInputs) {
    let rejected = false
    try { assertNoPrivateArtifactFixtureData(item.value, item.serialized ?? JSON.stringify(item.value)) }
    catch (error) { rejected = error instanceof Error && error.message === "p3_second_worker_fixture_input_contains_private_artifact_data" }
    if (!rejected) throw new Error("p3_private_artifact_fixture_guard_self_test_failed")
  }
}
function assertDisposableServiceUrls() {
  const successiveMode = mode === "park-successive-replan" || mode === "resume-successive-replan"
  const localSuccessiveProof = successiveMode && process.env.AGENT_REPLAN_PROOF_LOCAL_DISPOSABLE === "1"
  const databaseValue = process.env.AGENT_RUNTIME_PG_TEST_URL
  const databaseConfiguredValue = process.env.DATABASE_URL
  const redisTestValue = process.env.AGENT_TURN_REDIS_TEST_URL
  const redisConfiguredValue = process.env.REDIS_URL
  if (process.env.CI !== "true" || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true"
    || process.env.AGENT_TURN_REDIS_TEST_DISPOSABLE !== "true"
    || successiveMode && process.env.AGENT_RUNTIME_PG_TEST_REQUIRED !== "true"
    || !databaseValue || !redisTestValue || !redisConfiguredValue) {
    throw new Error("p3_restart_fixture_requires_dedicated_disposable_ci_services")
  }
  try {
    const database = new URL(databaseValue)
    const redisTest = new URL(redisTestValue)
    const redisConfigured = new URL(redisConfiguredValue)
    const localSuccessivePair = (database.port === "15433" && redisTest.port === "16380")
      || (database.port === "15432" && redisTest.port === "16379")
    if (database.protocol !== "postgresql:" || database.hostname !== "127.0.0.1"
      || (localSuccessiveProof ? !localSuccessivePair : database.port !== "5432")
      || database.username !== "postgres" || database.password !== "postgres"
      || database.pathname !== "/applymate_agent_brain_ci" || database.search || database.hash
      || successiveMode && databaseConfiguredValue !== databaseValue
      || redisTest.protocol !== "redis:"
      || (localSuccessiveProof ? redisTest.hostname !== "127.0.0.1"
        : !["127.0.0.1", "localhost", "::1", "[::1]"].includes(redisTest.hostname))
      || (!localSuccessiveProof && redisTest.port !== "6379")
      || redisTest.pathname !== "/15" || redisTest.username || redisTest.password
      || redisTest.search || redisTest.hash || redisConfigured.href !== redisTest.href) {
      throw new Error("invalid")
    }
  } catch {
    throw new Error("p3_restart_fixture_rejects_non_disposable_service_urls")
  }
}
async function loadSharedRedisModule() {
  sharedRedisModule ??= await import("../../redis.ts")
  return sharedRedisModule
}
function turnErrorCategory(value) {
  if (typeof value !== "string") return "none"
  const prefix = value.slice(0, 2_000)
  if (prefix.trim().length === 0) return "none"
  const normalized = prefix.toLowerCase()
  if (/\b40p01\b|deadlock detected|deadlock found/.test(normalized)) return "database_deadlock"
  if (/\b40001\b|serialization failure/.test(normalized)) return "database_serialization"
  if (/\b55p03\b|\block_not_available\b|lock timeout/.test(normalized)) return "database_lock_wait"
  if (/\bwait_(?:invalid|scope_error)\b|durablewaithandofferror/.test(normalized)) return "wait_handoff_state"
  if (/\blease_lost\b|turnleaseerror/.test(normalized)) return "turn_lease_state"
  return "other"
}
function modelStepErrorClass(value) {
  if (typeof value !== "string") return "none"
  const code = value.slice(0, 2_000).trim().toLowerCase()
  if (code.length === 0) return "none"
  if (/^task_graph_[a-z0-9_]{1,80}$/.test(code)) return "task_graph_failure"
  return STEP_ERROR_CLASS_BY_CODE.get(code) ?? "other"
}
function fixedEnum(value, allowlist) {
  return value === null || value === undefined ? "none" : typeof value === "string" && allowlist.has(value) ? value : "other"
}
function waitFailureCategory(tool) {
  if (!tool.hasWaitToolCall) return "none"
  const errorClass = modelStepErrorClass(tool.waitToolErrorCode ?? tool.waitToolCallErrorCode)
  if (errorClass !== "none") return errorClass
  if (tool.waitToolCallStatus === "failed") return "generic_tool_execution_failed"
  return tool.hasWaitToolResult ? "none" : "tool_result_missing"
}
function taskStatusCounts(rows) {
  return rows.reduce((counts, row) => {
    const status = fixedEnum(row.status, ROOT_TASK_STATUS_ALLOWLIST)
    const key = status === "none" ? "other" : status
    counts[key] = (counts[key] ?? 0) + Number(row.count)
    return counts
  }, {})
}
function parentSuspensionProjection(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.waits)) return { diagnosticsAvailable: false }
  const matchedWaits = snapshot.waits.filter(wait => wait.matchesLatestWaitToolCall)
  const rootWaits = matchedWaits.filter(wait => wait.parentMatchesRoot)
  return {
    turnStatus: fixedEnum(snapshot.turnStatus, TURN_STATUS_ALLOWLIST),
    rootTaskStatus: snapshot.rootTaskStatus,
    latestModelStepStatus: fixedEnum(snapshot.latestModelStep?.status, STEP_STATUS_ALLOWLIST),
    latestModelStepErrorClass: snapshot.latestModelStep?.errorClass ?? "none",
    planFailureCategory: snapshot.planFailureCategory ?? "none",
    turnErrorCategory: snapshot.turnErrorCategory ?? "none",
    planAccepted: snapshot.planReceiptStatuses.some(status => status === "accepted" || status === "duplicate"),
    waitToolCallStatus: snapshot.waitToolCallStatus,
    waitToolCallLifecycleStatus: fixedEnum(snapshot.waitToolCallLifecycleStatus, ITEM_LIFECYCLE_STATUS_ALLOWLIST),
    waitToolResultLifecycleStatus: fixedEnum(snapshot.waitToolResultLifecycleStatus, ITEM_LIFECYCLE_STATUS_ALLOWLIST),
    waitToolOutputStatus: snapshot.waitToolOutputStatus,
    waitFailureCategory: snapshot.waitFailureCategory,
    waits: {
      count: snapshot.waits.length,
      rootCount: rootWaits.length,
      suspendedRootCount: rootWaits.filter(wait => wait.status === "waiting" && wait.hasSuspendedAt).length,
    },
    waitCallIdempotencyKeyPresent: snapshot.waitCallIdempotencyKeyPresent,
    graphNodeCount: snapshot.graph.nodeCount,
    initialWaitLineage: snapshot.initialWaitLineage,
    targetCounts: {
      requested: snapshot.requestedTaskCount,
      graphMatches: snapshot.requestedGraphMatchCount,
      taskRows: snapshot.requestedTaskRowMatchCount,
      graphRows: snapshot.graphTaskRowMatchCount,
    },
    missingKeys: {
      requestedGraph: snapshot.missingRequestedGraphTaskKeys,
      graphTasks: snapshot.missingGraphTaskKeys,
    },
    childStatusCounts: snapshot.childStatusCounts,
    likelyCause: snapshot.likelyCause,
  }
}
function stringArray(value) {
  let parsed = value
  if (typeof value === "string") {
    try { parsed = JSON.parse(value) } catch { return null }
  }
  return Array.isArray(parsed) && parsed.every(item => typeof item === "string") ? parsed : null
}
function isExpectedSourceProjection(value, jobId = "fixture-job-restart") {
  const projection = record(value), candidates = Array.isArray(projection?.candidates) ? projection.candidates.map(record) : [], candidate = candidates[0]
  return projection?.schemaVersion === "agent-harness.v2.task-graph.result-projection" && projection.trust === "untrusted"
    && projection.availability === "available" && projection.role === "scout" && projection.status === "completed"
    && projection.candidateCount === 1 && projection.evidenceCount === 1 && candidates.length === 1
    && candidate?.jobId === jobId && candidate.source === "greenhouse"
    && Array.isArray(candidate.evidenceKinds) && candidate.evidenceKinds.length === 1 && candidate.evidenceKinds[0] === "job"
}
const SOURCE_PROJECTION_AVAILABILITY = new Set(["available", "unavailable"])
const SOURCE_PROJECTION_ROLES = new Set(["scout", "analyst"])
const SOURCE_PROJECTION_STATUSES = new Set(["completed", "partial"])
const DIAGNOSTIC_COUNT_LIMIT = 99
const CHILD_RUNTIME_SCOPE_DIAGNOSTIC_LIMIT = 12
const CHILD_LEASE_SCOPE_DIAGNOSTIC_LIMIT = 12
const CHILD_LEASE_SCOPE_PHASES = new Set([
  "dispatch_context", "source_wait_state", "source_dispatch_state", "source_lookup", "source_verification",
  "source_completion", "dependent_dispatch", "dependency_context", "follow_up_context", "child_outcome", "child_exception",
  "diagnostic_limit_reached",
])
const RESTART_JOB_SOURCE_ENUMS = new Set(["greenhouse", "lever", "workday", "smartrecruiters", "personio", "jobs.read"])
const RESTART_RESULT_STATUSES = new Set(["completed", "partial", "failed"])
let childRuntimeScopeDiagnosticCount = 0
let childLeaseScopeDiagnosticCount = 0
function diagnosticEnum(value, allowlist) {
  if (value === null || value === undefined) return "missing"
  return typeof value === "string" && allowlist.has(value) ? value : "other"
}
function diagnosticCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, DIAGNOSTIC_COUNT_LIMIT) : null
}
function fixtureScopeMatch(value, expected) {
  return typeof value === "string" && typeof expected === "string" ? value === expected : null
}
function childLeaseScopeDiagnostic(lease, phase) {
  if (childLeaseScopeDiagnosticCount >= CHILD_LEASE_SCOPE_DIAGNOSTIC_LIMIT) return {
    phase: "diagnostic_limit_reached",
    leaseUserMatchesFixture: null,
    leaseSessionMatchesFixture: null,
    leaseTurnMatchesFixture: null,
  }
  childLeaseScopeDiagnosticCount++
  return {
    phase: CHILD_LEASE_SCOPE_PHASES.has(phase) ? phase : "other",
    leaseUserMatchesFixture: fixtureScopeMatch(lease?.userId, ids.userId),
    leaseSessionMatchesFixture: fixtureScopeMatch(lease?.sessionId, ids.sessionId),
    leaseTurnMatchesFixture: fixtureScopeMatch(lease?.turnId, ids.turnId),
  }
}
function emitChildRuntimeScopeDiagnostic(input) {
  if (childRuntimeScopeDiagnosticCount >= CHILD_RUNTIME_SCOPE_DIAGNOSTIC_LIMIT) return
  childRuntimeScopeDiagnosticCount++
  say("P3_CHILD_RUNTIME_SCOPE " + JSON.stringify({
    phase: input.phase,
    sessionMatchesFixture: fixtureScopeMatch(input.sessionId, ids.sessionId),
    turnMatchesFixture: fixtureScopeMatch(input.turnId, ids.turnId),
    userMatchesFixture: fixtureScopeMatch(input.userId, ids.userId),
    taskUserMatchesFixture: fixtureScopeMatch(input.taskUserId, ids.userId),
    modelTaskMatchesLease: fixtureScopeMatch(input.modelTaskId, input.leaseTaskId),
    matchingToolResultCount: diagnosticCount(input.matchingToolResultCount),
    resultJsonParsed: typeof input.resultJsonParsed === "boolean" ? input.resultJsonParsed : null,
    expectedJobPresent: typeof input.expectedJobPresent === "boolean" ? input.expectedJobPresent : null,
    returnedJobCount: diagnosticCount(input.returnedJobCount),
  }))
}
function toolResultDiagnostics(request, callId) {
  const messages = Array.isArray(request?.messages) ? request.messages : []
  let count = 0, latestContent = null
  for (const message of messages) {
    const content = Array.isArray(message?.content) ? message.content : []
    for (const part of content) {
      if (part?.type !== "tool_result" || part.toolUseId !== callId) continue
      count++
      latestContent = typeof part.content === "string" ? part.content : null
    }
  }
  if (latestContent === null) return { count: diagnosticCount(count), parsed: false }
  try { JSON.parse(latestContent); return { count: diagnosticCount(count), parsed: true } }
  catch { return { count: diagnosticCount(count), parsed: false } }
}
async function processRestartVerifierDiagnostic(lease, outcome) {
  const childResult = record(outcome?.result), structured = record(childResult?.structuredResult)
  const evidence = Array.isArray(structured?.evidence) ? structured.evidence.map(record).filter(Boolean) : []
  const jobEvidence = evidence.filter(item => item.kind === "job")
  const firstEvidence = jobEvidence[0]
  const evidenceSource = typeof firstEvidence?.source === "string" ? firstEvidence.source : null
  const rows = await pool.query(`SELECT result."status" AS "itemStatus", call."content"->>'status' AS "callStatus",
      result."content"->>'errorCode' AS "errorCode", jsonb_typeof(result."content"->'output'->'jobs') AS "jobsType",
      CASE WHEN jsonb_typeof(result."content"->'output'->'jobs') = 'array'
        THEN LEAST(jsonb_array_length(result."content"->'output'->'jobs'), ${DIAGNOSTIC_COUNT_LIMIT})::int ELSE NULL END AS "jobCount",
      COALESCE(jsonb_typeof(result."content"->'output'->'jobs') = 'array' AND stats."jobsValidShape", false) AS "jobsValidShape",
      LEAST(COALESCE(stats."matchingJobCount", 0), ${DIAGNOSTIC_COUNT_LIMIT})::int AS "matchingJobCount",
      COALESCE(stats."matchingJobSources", ARRAY[]::text[]) AS "matchingJobSources",
      CASE WHEN $6::text IS NULL THEN NULL ELSE stats."evidenceSourceMatches" END AS "evidenceSourceMatches"
    FROM "agent_items" AS result
    JOIN "agent_steps" AS resultStep ON resultStep."id" = result."stepId" AND resultStep."sessionId" = result."sessionId"
      AND resultStep."turnId" = result."turnId" AND resultStep."taskId" = result."taskId"
    JOIN "agent_items" AS call ON call."stepId" = result."stepId" AND call."sessionId" = result."sessionId"
      AND call."turnId" = result."turnId" AND call."taskId" = result."taskId" AND call."type" = 'tool_call'
      AND call."content"->>'toolCallId' = result."content"->>'toolCallId'
    JOIN "agent_steps" AS callStep ON callStep."id" = call."stepId" AND callStep."sessionId" = call."sessionId"
      AND callStep."turnId" = call."turnId" AND callStep."taskId" = call."taskId"
    LEFT JOIN LATERAL (
      SELECT
        count(*) FILTER (WHERE entry.job->>'id' = $5)::int AS "matchingJobCount",
        COALESCE(bool_and(
          jsonb_typeof(entry.job) = 'object' AND jsonb_typeof(entry.job->'id') = 'string'
          AND length(entry.job->>'id') > 0 AND btrim(entry.job->>'id') = entry.job->>'id'
        ) AND count(DISTINCT entry.job->>'id') = count(*), true) AS "jobsValidShape",
        array_agg(DISTINCT CASE
          WHEN entry.job->'source' IS NULL OR jsonb_typeof(entry.job->'source') = 'null' THEN 'jobs.read'
          WHEN jsonb_typeof(entry.job->'source') = 'string' AND length(entry.job->>'source') BETWEEN 1 AND 256
            AND btrim(entry.job->>'source') = entry.job->>'source'
            THEN CASE WHEN entry.job->>'source' = ANY(ARRAY['greenhouse','lever','workday','smartrecruiters','personio','jobs.read'])
              THEN entry.job->>'source' ELSE 'other' END
          ELSE 'invalid'
        END) FILTER (WHERE entry.job->>'id' = $5) AS "matchingJobSources",
        COALESCE(bool_and(CASE
          WHEN entry.job->'source' IS NULL OR jsonb_typeof(entry.job->'source') = 'null' THEN 'jobs.read' = $6::text
          WHEN jsonb_typeof(entry.job->'source') = 'string' AND length(entry.job->>'source') BETWEEN 1 AND 256
            AND btrim(entry.job->>'source') = entry.job->>'source' THEN entry.job->>'source' = $6::text
          ELSE false
        END) FILTER (WHERE entry.job->>'id' = $5), false) AS "evidenceSourceMatches"
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(result."content"->'output'->'jobs') = 'array'
        THEN result."content"->'output'->'jobs' ELSE '[]'::jsonb END) AS entry(job)
    ) AS stats ON true
    WHERE result."taskId" = $1 AND result."sessionId" = $2 AND result."turnId" = $3 AND resultStep."attempt" = $4
      AND callStep."attempt" = $4 AND result."type" = 'tool_result' AND call."content"->>'toolName' = 'jobs.search'
    ORDER BY resultStep."ordinal" ASC, result."createdAt" ASC, result."id" ASC LIMIT 9`,
  [lease.id, lease.sessionId, lease.turnId, lease.attemptCount, ids.jobId, evidenceSource])
  const persistedReads = rows.rows.slice(0, 8).map(raw => ({
    itemStatus: diagnosticEnum(raw.itemStatus, ITEM_LIFECYCLE_STATUS_ALLOWLIST),
    callStatus: diagnosticEnum(raw.callStatus, TOOL_CALL_STATUS_ALLOWLIST),
    hasErrorCode: typeof raw.errorCode === "string" && raw.errorCode.length > 0,
    jobsType: diagnosticEnum(raw.jobsType, new Set(["array"])),
    jobCount: diagnosticCount(raw.jobCount),
    jobsValidShape: raw.jobsValidShape === true,
    matchingJobCount: diagnosticCount(raw.matchingJobCount),
    matchingJobSources: Array.isArray(raw.matchingJobSources)
      ? [...new Set(raw.matchingJobSources.map(value => diagnosticEnum(value, RESTART_JOB_SOURCE_ENUMS)))].slice(0, 5) : [],
    evidenceSourceMatches: typeof raw.evidenceSourceMatches === "boolean" ? raw.evidenceSourceMatches : null,
  }))
  const claims = Array.isArray(structured?.candidates) ? structured.candidates.map(record).filter(Boolean)
    : Array.isArray(structured?.findings) ? structured.findings.map(record).filter(Boolean) : []
  say("P3_RESTART_VERIFIER_EVIDENCE_DIAGNOSTIC " + JSON.stringify({
    role: lease.role === "scout" || lease.role === "analyst" ? lease.role : "other",
    attempt: diagnosticCount(lease.attemptCount),
    childStatus: diagnosticEnum(outcome?.status, RESTART_RESULT_STATUSES),
    resultStatus: diagnosticEnum(childResult?.status, RESTART_RESULT_STATUSES),
    structuredResultStatus: diagnosticEnum(structured?.status, RESTART_RESULT_STATUSES),
    claimCount: diagnosticCount(claims.length),
    claimJobIdMatches: claims.slice(0, 5).map(item => item.jobId === ids.jobId),
    structuredEvidenceCount: diagnosticCount(evidence.length),
    jobEvidenceCount: diagnosticCount(jobEvidence.length),
    jobEvidence: jobEvidence.slice(0, 5).map(item => ({
      refMatchesRequestedJob: item.ref === ids.jobId,
      source: diagnosticEnum(item.source, RESTART_JOB_SOURCE_ENUMS),
    })),
    persistedSearchOutputCount: diagnosticCount(rows.rows.length),
    persistedSearchOutputLimitReached: rows.rows.length > 8,
    persistedReads,
  }))
}
function sourceProjectionDiagnostic(value) {
  if (value === null || value === undefined) return { category: "absent" }
  const projection = record(value)
  if (!projection) return { category: "invalid", shape: "not_object" }
  const candidates = Array.isArray(projection.candidates) ? projection.candidates : null
  const candidate = candidates?.length === 1 ? record(candidates[0]) : null
  const details = {
    category: "invalid",
    schema: projection.schemaVersion === "agent-harness.v2.task-graph.result-projection"
      ? "expected" : projection.schemaVersion === null || projection.schemaVersion === undefined ? "missing" : "other",
    availability: diagnosticEnum(projection.availability, SOURCE_PROJECTION_AVAILABILITY),
    role: diagnosticEnum(projection.role, SOURCE_PROJECTION_ROLES),
    status: diagnosticEnum(projection.status, SOURCE_PROJECTION_STATUSES),
    candidateCount: diagnosticCount(projection.candidateCount),
    evidenceCount: diagnosticCount(projection.evidenceCount),
    candidateArrayCount: candidates === null ? null : diagnosticCount(candidates.length),
    candidateIdentity: "unchecked",
  }
  if (details.schema !== "expected") return { ...details, category: "wrong_schema" }
  if (projection.trust !== "untrusted") return { ...details, invalidField: "trust" }
  if (details.availability === "unavailable") return { ...details, category: "unavailable" }
  if (details.availability !== "available") return { ...details, invalidField: "availability" }
  if (projection.role !== "scout") return { ...details, category: "wrong_role" }
  if (projection.status !== "completed") return { ...details, category: "wrong_status" }
  if (!candidates || details.candidateCount === null || details.evidenceCount === null) {
    return { ...details, invalidField: "count_or_candidates" }
  }
  if (details.candidateCount !== 1 || details.evidenceCount !== 1 || candidates.length !== 1) {
    return { ...details, category: "wrong_count" }
  }
  if (!candidate || !Array.isArray(candidate.evidenceKinds) || !candidate.evidenceKinds.every(kind => typeof kind === "string")) {
    return { ...details, invalidField: "candidate_shape" }
  }
  const candidateMatches = candidate.jobId === "fixture-job-restart" && candidate.source === "greenhouse"
    && candidate.evidenceKinds.length === 1 && candidate.evidenceKinds[0] === "job"
  return { ...details, category: candidateMatches ? "valid" : "candidate_identity_mismatch", candidateIdentity: candidateMatches ? "match" : "mismatch" }
}
function assertSourceProjectionDiagnostic() {
  const valid = {
    schemaVersion: "agent-harness.v2.task-graph.result-projection", trust: "untrusted", availability: "available",
    role: "scout", status: "completed", candidateCount: 1, evidenceCount: 1,
    candidates: [{ jobId: "fixture-job-restart", source: "greenhouse", evidenceKinds: ["job"] }],
  }
  const cases = [
    [null, "absent"],
    ["https://private.example/token", "invalid"],
    [{ schemaVersion: valid.schemaVersion, trust: "untrusted", availability: "unavailable" }, "unavailable"],
    [{ ...valid, schemaVersion: "private-projection-schema" }, "wrong_schema"],
    [{ ...valid, role: "private-role" }, "wrong_role"],
    [{ ...valid, status: "private-status" }, "wrong_status"],
    [{ ...valid, candidateCount: 2 }, "wrong_count"],
    [{ ...valid, candidates: [{ ...valid.candidates[0], jobId: "private-task-id" }] }, "candidate_identity_mismatch"],
  ]
  if (!isExpectedSourceProjection(valid) || sourceProjectionDiagnostic(valid).category !== "valid") {
    throw new Error("p3_source_projection_diagnostic_self_test_failed")
  }
  for (const [value, expectedCategory] of cases) {
    const serialized = JSON.stringify(sourceProjectionDiagnostic(value))
    if (!serialized.includes(`\"category\":\"${expectedCategory}\"`) || /private|https|token/i.test(serialized)) {
      throw new Error("p3_source_projection_diagnostic_self_test_failed")
    }
    if (isExpectedSourceProjection(value)) throw new Error("p3_source_projection_predicate_self_test_failed")
  }
  if (sourceProjectionDiagnostic({ ...valid, candidateCount: Number.MAX_SAFE_INTEGER }).candidateCount !== DIAGNOSTIC_COUNT_LIMIT) {
    throw new Error("p3_source_projection_count_bound_self_test_failed")
  }
}
function latestToolResultForExactToolInput(request, toolName, expectedInput) {
  const messages = Array.isArray(request?.messages) ? request.messages : []
  const uses = []
  let position = 0
  for (const message of messages) {
    const content = Array.isArray(message?.content) ? message.content : []
    for (const part of content) {
      if (message?.role === "assistant" && part?.type === "tool_use" && part.name === toolName
        && isDeepStrictEqual(part.input, expectedInput)) uses.push({ id: part.id, position })
      position++
    }
  }
  if (uses.length !== 1 || typeof uses[0]?.id !== "string" || !uses[0].id) return null
  const toolUseId = uses[0].id
  let sameIdUseCount = 0, resultCount = 0, result = null, resultPosition = -1
  position = 0
  for (const message of messages) {
    const content = Array.isArray(message?.content) ? message.content : []
    for (const part of content) {
      if (message?.role === "assistant" && part?.type === "tool_use" && part.id === toolUseId) sameIdUseCount++
      if (part?.type === "tool_result" && part.toolUseId === toolUseId) {
        resultCount++
        result = part
        resultPosition = position
      }
      position++
    }
  }
  if (sameIdUseCount !== 1 || resultCount !== 1 || result?.isError === true
    || resultPosition <= uses[0].position || typeof result.content !== "string") return null
  try {
    return { toolUseId, resultToolUseId: result.toolUseId, result: JSON.parse(result.content) }
  } catch { return null }
}
function latestToolResult(request, callId) {
  const messages = request.messages
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const content = messages[messageIndex]?.content ?? []
    for (let partIndex = content.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = content[partIndex]
      if (part?.type !== "tool_result" || part.toolUseId !== callId) continue
      if (typeof part.content !== "string") return null
      try { return JSON.parse(part.content) } catch { return null }
    }
  }
  return null
}
function planToolPairFromRequest(request, callId = planCallId) {
  const messages = Array.isArray(request?.messages) ? request.messages : []
  let planToolUseCount = 0, planToolResultCount = 0, expectedRevision = null
  let planToolUsePosition = null, planToolResultPosition = null, position = 0
  for (const message of messages) {
    const content = Array.isArray(message?.content) ? message.content : []
    for (const part of content) {
      if (part?.type === "tool_use" && part.id === callId && part.name === "agent.plan") {
        planToolUseCount += 1
        if (planToolUseCount === 1) planToolUsePosition = position
        if (planToolUseCount === 1) {
          const input = record(part.input)
          expectedRevision = Number.isSafeInteger(input?.expectedRevision) ? input.expectedRevision : null
        }
      }
      if (part?.type === "tool_result" && part.toolUseId === callId) {
        planToolResultCount += 1
        if (planToolResultCount === 1) planToolResultPosition = position
      }
      position += 1
    }
  }
  return {
    planToolUseCount,
    planToolResultCount,
    planExpectedRevision: planToolUseCount === 1 ? expectedRevision : null,
    planToolPairMatches: planToolUseCount === 1 && planToolResultCount === 1
      && planToolUsePosition !== null && planToolResultPosition !== null && planToolResultPosition > planToolUsePosition,
    planExpectedRevisionMatches: planToolUseCount === 1 && expectedRevision === 0,
  }
}
function plannedTaskIds(request, callId = planCallId, expectedCount = 2) {
  const result = record(latestToolResult(request, callId))
  if (result?.status !== "accepted" || !Array.isArray(result.nodes)) throw new Error("p3_plan_receipt_missing")
  const taskIds = result.nodes.map(node => record(node)?.taskId)
  if (taskIds.length !== expectedCount || taskIds.some(taskId => typeof taskId !== "string")) throw new Error("p3_plan_task_ids_missing")
  return taskIds
}
function graphFromRequest(request) {
  const messages = request.messages
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const content = messages[messageIndex]?.content ?? []
    for (let partIndex = content.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = content[partIndex]
      if (part?.type !== "text" || !part.text.includes('"kind":"task_graph_current"')) continue
      try { return record(JSON.parse(part.text.slice(part.text.indexOf("\n") + 1))) } catch { return null }
    }
  }
  return null
}
function nodeTaskMap(nodes) {
  if (!Array.isArray(nodes)) return null
  const byKey = new Map()
  const taskIds = new Set()
  for (const value of nodes) {
    const taskNode = record(value)
    if (typeof taskNode?.key !== "string" || typeof taskNode.taskId !== "string"
      || byKey.has(taskNode.key) || taskIds.has(taskNode.taskId)) return null
    byKey.set(taskNode.key, taskNode.taskId)
    taskIds.add(taskNode.taskId)
  }
  return byKey
}
function sortedTaskGraphPairs(nodes) {
  const byKey = nodeTaskMap(nodes)
  return byKey ? [...byKey].sort(([left], [right]) => left.localeCompare(right)) : null
}
function compareTaskGraphNodes(left, right) {
  const leftPairs = sortedTaskGraphPairs(left), rightPairs = sortedTaskGraphPairs(right)
  return leftPairs && rightPairs && leftPairs.length === rightPairs.length
    ? leftPairs.every(([key, taskId], index) => key === rightPairs[index][0] && taskId === rightPairs[index][1])
    : leftPairs && rightPairs ? false : null
}
function mismatchedTaskGraphKeys(left, right) {
  const leftByKey = nodeTaskMap(left), rightByKey = nodeTaskMap(right)
  if (!leftByKey || !rightByKey) return []
  return [...new Set([...leftByKey.keys(), ...rightByKey.keys()])]
    .filter(key => leftByKey.get(key) !== rightByKey.get(key) && TASK_GRAPH_KEY_ALLOWLIST.has(key))
    .sort()
}
function boundedTaskGraphRevision(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647 ? value : null
}
function persistedTaskGraphSnapshot(item) {
  const row = record(item), content = record(row?.content)
  const nodes = Array.isArray(content?.nodes) ? content.nodes : null
  const revision = boundedTaskGraphRevision(Number(row?.revision))
  return {
    found: Boolean(row),
    valid: Boolean(nodes && nodeTaskMap(nodes)),
    nodeCount: nodes?.length ?? 0,
    revision,
    nodes,
  }
}
function assertPersistedGraphComparator() {
  const receipt = [{ key: "source", taskId: "task-a" }, { key: "summary", taskId: "task-b" }]
  const sameInDifferentOrder = [{ key: "summary", taskId: "task-b" }, { key: "source", taskId: "task-a" }]
  const sameIdentityDifferentDetails = [
    { key: "source", taskId: "task-a", goal: "diagnostic self-test only" },
    { key: "summary", taskId: "task-b", goal: "diagnostic self-test only" },
  ]
  const mismatch = [{ key: "source", taskId: "task-c" }, { key: "summary", taskId: "task-d" }]
  const persistedItem = { revision: 1, content: { nodes: sameInDifferentOrder } }
  const malformedItem = { revision: 1, content: { nodes: [{ key: "source" }] } }
  if (!persistedTaskGraphSnapshot(persistedItem).valid
    || compareTaskGraphNodes(receipt, persistedTaskGraphSnapshot(persistedItem).nodes) !== true
    || compareTaskGraphNodes(receipt, sameIdentityDifferentDetails) !== true
    || compareTaskGraphNodes(receipt, mismatch) !== false
    || boundedTaskGraphRevision(2_147_483_647) !== 2_147_483_647
    || boundedTaskGraphRevision(2_147_483_648) !== null
    || persistedTaskGraphSnapshot(null).found
    || compareTaskGraphNodes(receipt, persistedTaskGraphSnapshot(null).nodes) !== null
    || persistedTaskGraphSnapshot(malformedItem).valid
    || compareTaskGraphNodes(receipt, persistedTaskGraphSnapshot(malformedItem).nodes) !== null) {
    throw new Error("p3_persisted_graph_comparator_self_test_failed")
  }
}
function assertInitialPlanToolPair() {
  const requestFor = (useCount, resultCount, expectedRevision, resultFirst = false) => ({ messages: [{ content: [
    ...(resultFirst ? Array.from({ length: resultCount }, () => ({ type: "tool_result", toolUseId: planCallId, content: "{}" })) : []),
    ...Array.from({ length: useCount }, () => ({
      type: "tool_use", id: planCallId, name: "agent.plan", input: { expectedRevision },
    })),
    ...(!resultFirst ? Array.from({ length: resultCount }, () => ({ type: "tool_result", toolUseId: planCallId, content: "{}" })) : []),
  ] }] })
  const valid = planToolPairFromRequest(requestFor(1, 1, 0))
  const duplicate = planToolPairFromRequest(requestFor(2, 2, 0))
  const missingResult = planToolPairFromRequest(requestFor(1, 0, 0))
  const wrongRevision = planToolPairFromRequest(requestFor(1, 1, 1))
  const reversed = planToolPairFromRequest(requestFor(1, 1, 0, true))
  if (!valid.planToolPairMatches || !valid.planExpectedRevisionMatches || valid.planExpectedRevision !== 0
    || duplicate.planToolPairMatches || duplicate.planToolUseCount !== 2 || duplicate.planToolResultCount !== 2
    || missingResult.planToolPairMatches || missingResult.planToolResultCount !== 0
    || !wrongRevision.planToolPairMatches || wrongRevision.planExpectedRevisionMatches || wrongRevision.planExpectedRevision !== 1
    || reversed.planToolPairMatches || !reversed.planExpectedRevisionMatches) {
    throw new Error("p3_initial_plan_tool_pair_self_test_failed")
  }
}
function countOutside(source, target) {
  if (!Array.isArray(source) || !Array.isArray(target)) return null
  const targetIds = new Set(target)
  return source.filter(taskId => !targetIds.has(taskId)).length
}
async function initialWaitLineageFor(request, requestedTaskIds) {
  const planToolPair = planToolPairFromRequest(request, planCallId)
  const receipt = record(latestToolResult(request, planCallId))
  const receiptNodes = Array.isArray(receipt?.nodes) ? receipt.nodes : null
  const graph = graphFromRequest(request)
  const graphNodes = Array.isArray(graph?.nodes) ? graph.nodes : null
  const receiptRevision = boundedTaskGraphRevision(receipt?.revision)
  const graphRevision = boundedTaskGraphRevision(graph?.revision)
  let parentTaskId = null, persistedItem = null, persistedItemReadSucceeded = false
  try {
    const { rows: [item] } = await pool.query(`SELECT turn."rootTaskId" AS "parentTaskId", item."id", item."revision", item."content"
      FROM "agent_turns" AS turn LEFT JOIN "agent_items" AS item
        ON item."sessionId" = turn."sessionId" AND item."turnId" = turn."id"
          AND item."taskId" = turn."rootTaskId" AND item."type" = 'task_graph'
      WHERE turn."sessionId" = $1 AND turn."id" = $2
      ORDER BY item."revision" DESC NULLS LAST, item."updatedAt" DESC NULLS LAST LIMIT 1`, [ids.sessionId, ids.turnId])
    parentTaskId = typeof item?.parentTaskId === "string" ? item.parentTaskId : null
    persistedItem = typeof item?.id === "string" ? item : null
    persistedItemReadSucceeded = true
  } catch {}
  let proposalEvent = null
  if (typeof parentTaskId === "string") {
    try {
      const { rows: [event] } = await pool.query(`SELECT event."sequence", event."payload"
        FROM "agent_events" AS event
        WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."taskId" = $3
          AND ($4::text IS NULL OR event."itemId" = $4)
          AND event."type" IN ('item.started', 'item.delta') AND event."payload"->>'kind' = 'proposal'
        ORDER BY event."sequence" DESC LIMIT 1`, [ids.sessionId, ids.turnId, parentTaskId, persistedItem?.id ?? null])
      proposalEvent = event ?? null
    } catch {}
  }
  const persistedSnapshot = persistedTaskGraphSnapshot(persistedItem)
  const proposalPayload = record(proposalEvent?.payload)
  const eventReceipt = record(proposalPayload?.receipt)
  const eventReceiptNodes = Array.isArray(eventReceipt?.nodes) ? eventReceipt.nodes : null
  const embeddedItem = record(proposalPayload?.item)
  const embeddedContent = record(embeddedItem?.content)
  const embeddedNodes = Array.isArray(embeddedContent?.nodes) ? embeddedContent.nodes : null
  const payloadContentPresent = proposalPayload !== null && Object.hasOwn(proposalPayload, "content")
  const payloadContent = record(proposalPayload?.content)
  const payloadContentNodes = Array.isArray(payloadContent?.nodes) ? payloadContent.nodes : null
  const proposalEventRevision = boundedTaskGraphRevision(proposalPayload?.revision)
  const eventReceiptRevision = boundedTaskGraphRevision(eventReceipt?.revision)
  const embeddedItemRevision = boundedTaskGraphRevision(embeddedItem?.revision)
  const receiptIds = receiptNodes?.map(value => record(value)?.taskId) ?? null
  const graphIds = graphNodes?.map(value => record(value)?.taskId) ?? null
  const validIds = values => Array.isArray(values) && values.every(value => typeof value === "string")
  const sameIds = (left, right) => validIds(left) && validIds(right)
    && left.length === right.length && new Set(left).size === left.length
    && new Set(right).size === right.length && left.every(value => right.includes(value))
  const receiptByKey = nodeTaskMap(receiptNodes)
  const graphNodeKeysMissingReceipt = receiptNodes && graphNodes
    ? [...new Set(graphNodes.flatMap(value => {
      const graphNode = record(value)
      return graphNode && typeof graphNode.key === "string" && TASK_GRAPH_KEY_ALLOWLIST.has(graphNode.key)
        && receiptByKey?.get(graphNode.key) !== graphNode.taskId ? [graphNode.key] : []
    }))].sort()
    : []
  return {
    ...planToolPair,
    proposalReceiptFound: receipt?.status === "accepted" && receiptNodes !== null,
    proposalNodeCount: receiptNodes?.length ?? 0,
    graphNodeCount: graphNodes?.length ?? 0,
    receiptRevision,
    graphRevision,
    persistedItemReadSucceeded,
    persistedItemFound: persistedSnapshot.found,
    persistedItemValid: persistedSnapshot.valid,
    persistedItemNodeCount: persistedSnapshot.nodeCount,
    persistedItemRevision: persistedSnapshot.revision,
    proposalRevisionMatchesGraph: receiptRevision !== null && receiptRevision === graphRevision,
    requestMatchesReceipt: sameIds(requestedTaskIds, receiptIds),
    requestMatchesCurrentGraph: sameIds(requestedTaskIds, graphIds),
    proposalMatchesGraph: compareTaskGraphNodes(receiptNodes, graphNodes) === true,
    proposalMatchesPersistedItem: compareTaskGraphNodes(receiptNodes, persistedSnapshot.nodes),
    persistedItemMatchesGraph: compareTaskGraphNodes(persistedSnapshot.nodes, graphNodes),
    requestedIdsOutsideReceiptCount: countOutside(requestedTaskIds, receiptIds),
    requestedIdsOutsideGraphCount: countOutside(requestedTaskIds, graphIds),
    graphNodeKeysMissingReceipt,
    receiptPersistedMismatchKeys: mismatchedTaskGraphKeys(receiptNodes, persistedSnapshot.nodes),
    persistedGraphMismatchKeys: mismatchedTaskGraphKeys(persistedSnapshot.nodes, graphNodes),
    proposalEventFound: Boolean(proposalEvent),
    proposalEventRevision,
    requestResultTaskIdentityMapMatchesEventReceipt: compareTaskGraphNodes(receiptNodes, eventReceiptNodes),
    eventReceiptTaskIdentityMapMatchesEmbeddedContent: compareTaskGraphNodes(eventReceiptNodes, embeddedNodes),
    embeddedContentTaskIdentityMapMatchesCurrentPersistedItem: compareTaskGraphNodes(embeddedNodes, persistedSnapshot.nodes),
    embeddedContentTaskIdentityMapMatchesPayloadContent: payloadContentPresent
      ? compareTaskGraphNodes(embeddedNodes, payloadContentNodes) : null,
    proposalEventRevisionMatchesReceipt: proposalEventRevision !== null && eventReceiptRevision !== null
      ? proposalEventRevision === eventReceiptRevision : null,
    proposalEventRevisionMatchesEmbeddedItem: proposalEventRevision !== null && embeddedItemRevision !== null
      ? proposalEventRevision === embeddedItemRevision : null,
    proposalEventRevisionMatchesCurrentPersistedItemRow: proposalEventRevision !== null && persistedSnapshot.revision !== null
      ? proposalEventRevision === persistedSnapshot.revision : null,
    eventReceiptEmbeddedTaskIdentityMapMismatchKeys: mismatchedTaskGraphKeys(eventReceiptNodes, embeddedNodes),
    embeddedCurrentPersistedTaskIdentityMapMismatchKeys: mismatchedTaskGraphKeys(embeddedNodes, persistedSnapshot.nodes),
    embeddedPayloadTaskIdentityMapMismatchKeys: payloadContentPresent
      ? mismatchedTaskGraphKeys(embeddedNodes, payloadContentNodes) : null,
  }
}
function assertLatestGraphObservationSelection() {
  const request = { messages: [
    { content: [{ type: "text", text: '[context]\n{"kind":"task_graph_current","revision":1,"nodes":[{"key":"source","taskId":"old"}]}' }] },
    { content: [{ type: "text", text: '[context]\n{"kind":"task_graph_current","revision":2,"nodes":[{"key":"source","taskId":"latest"}]}' }] },
  ] }
  if (graphFromRequest(request)?.revision !== 2) throw new Error("p3_latest_graph_observation_selection_failed")
}
function assertLatestToolResultSelection() {
  const request = { messages: [
    { content: [{ type: "tool_result", toolUseId: planCallId,
      content: JSON.stringify({ status: "accepted", nodes: [{ taskId: "stale" }] }) }] },
    { content: [{ type: "tool_result", toolUseId: "unrelated-call",
      content: JSON.stringify({ status: "accepted", nodes: [{ taskId: "unrelated" }] }) },
    { type: "tool_result", toolUseId: planCallId,
      content: JSON.stringify({ status: "accepted", nodes: [{ taskId: "latest" }] }) }] },
  ] }
  if (plannedTaskIds(request, planCallId, 1)[0] !== "latest") throw new Error("p3_latest_tool_result_selection_failed")
  const invalidNewest = { messages: [...request.messages, { content: [
    { type: "tool_result", toolUseId: planCallId, content: "{invalid json" },
  ] }] }
  if (latestToolResult(invalidNewest, planCallId) !== null) throw new Error("p3_latest_invalid_tool_result_fail_closed_failed")
}
function waitOutcomesFromRequest(request) {
  const outcomes = []
  for (const part of request.messages.flatMap(message => message.content)) {
    if (part.type !== "tool_result" || !part.toolUseId.startsWith("wait:") || typeof part.content !== "string") continue
    try { const outcome = record(JSON.parse(part.content)); if (outcome && Array.isArray(outcome.tasks)) outcomes.push(outcome) } catch { /* Ignore unrelated malformed results. */ }
  }
  return outcomes
}
function waitOutcomeFromRequest(request, predicate) {
  const outcome = waitOutcomesFromRequest(request).find(predicate ?? (() => true))
  if (!outcome) throw new Error("p3_durable_wait_result_missing"); return outcome
}
function assertPassedVerificationReport(value, criterionId) {
  const report = record(value), criteria = Array.isArray(report?.criteria) ? report.criteria.map(record) : []
  const criterion = criteria.find(item => item?.criterionId === criterionId)
  if (report?.verifierVersion !== TASK_GRAPH_VERIFIER_VERSION || report.status !== "passed" || report.reasonCode !== "criteria_met"
    || !/^[a-f0-9]{64}$/.test(report.evidenceDigest ?? "") || criteria.length !== 1
    || criterion?.status !== "passed" || criterion.reasonCode !== "criteria_met") {
    throw new Error("p3_typed_verification_report_not_restored:" + criterionId)
  }
  return report
}
function modelProfile() {
  return { provider: "fixture", model: "fixture-model", nativeTools: true, structuredOutput: true, streaming: true,
    continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: false, supportsReasoningSummary: false,
    supportsResponseContinuation: false, supportsProviderConversation: false, supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: 128, costClass: "low" }
}
function selectedJobDraftModel(selected, task, observations) {
  const callId = `ac6-selected-job-draft-receipt:attempt:${task.attemptCount}`
  const baseArtifactId = `cover-letter-base:${hashArtifactContent({ userId: selected.userId, jobId: selected.jobId }).slice(7)}`
  const baseHash = hashArtifactContent({ kind: "cover_letter_base", jobId: selected.jobId })
  let rounds = 0
  return {
    id: "ac6-disposable-pg-selected-job-model", profile: modelProfile(),
    async *stream(request) {
      rounds++
      if (rounds === 1) {
        observeSelectedJobSourceCanaries(request, selected, 1, observations)
        yield { type: "tool_call_completed", callId, name: "cover_letter.draft", arguments: {
          baseArtifactId, baseHash, content: selected.body, constraints: { maxWords: 160 },
        } }
        yield { type: "completed", finishReason: "tool_calls" }
        return
      }
      const receipt = record(latestToolResult(request, callId))
      const artifactRef = record(receipt?.artifactRef)
      if (!artifactRef) throw new Error("p3_selected_job_draft_receipt_missing")
      yield { type: "text_delta", text: JSON.stringify({
        schemaVersion: ROLE_RESULT_SCHEMA, role: "writer", status: "completed", artifactRef,
      }) }
      yield { type: "completed", finishReason: "stop" }
    },
  }
}
function selectedJobSourceCanaries(selected, worker) {
  const suffix = typeof selected.jobId === "string" && selected.jobId.startsWith("p3-selected-job-")
    ? selected.jobId.slice("p3-selected-job-".length) : ""
  if (!suffix) throw new Error("p3_selected_job_source_canary_unavailable")
  return {
    job: `AC6_TRANSIENT_JOB_SOURCE_W${worker}_${suffix}`,
    resume: `AC6_TRANSIENT_RESUME_SOURCE_W${worker}_${suffix}`,
    persona: `AC6_TRANSIENT_PERSONA_SOURCE_W${worker}_${suffix}`,
  }
}
function observeSelectedJobSourceCanaries(request, selected, worker, observations) {
  const requestText = JSON.stringify(request)
  const current = selectedJobSourceCanaries(selected, worker)
  const sourceCanariesReloaded = {
    job: requestText.includes(current.job),
    resume: requestText.includes(current.resume),
    persona: requestText.includes(current.persona),
  }
  observations.sourceCanariesReloaded = sourceCanariesReloaded
  const old = worker === 2 ? selectedJobSourceCanaries(selected, 1) : null
  if (old) observations.previousSourceCanariesAbsent = {
    job: !requestText.includes(old.job),
    resume: !requestText.includes(old.resume),
    persona: !requestText.includes(old.persona),
  }
  if (Object.values(sourceCanariesReloaded).some(value => !value)
    || (old && Object.values(observations.previousSourceCanariesAbsent).some(value => !value))) {
    throw new Error("p3_selected_job_transient_source_canaries_invalid")
  }
}
function selectedJobReviewerModel(selected, task, observations) {
  const artifactRef = writerArtifactReferenceFromTaskContext(task.context, selected.jobId)
  const bodyPrefix = "p3-selected-job-"
  if (typeof selected.jobId !== "string" || !selected.jobId.startsWith(bodyPrefix) || selected.jobId.length <= bodyPrefix.length) {
    throw new Error("p3_selected_job_fixture_body_canary_unavailable")
  }
  const privateBodyCanary = `AC6_PRIVATE_COVER_LETTER_${selected.jobId.slice(bodyPrefix.length)}`
  observations.writerReceiptReferenceRecovered = true
  const readCallId = `ac6-selected-job-review-read:attempt:${task.attemptCount}`
  const reviewCallId = `ac6-selected-job-review-receipt:attempt:${task.attemptCount}`
  const stopBeforeReview = task.id === selected.stopReviewerTaskId
  let rounds = 0
  return {
    id: "ac6-disposable-pg-selected-job-model", profile: modelProfile(),
    async *stream(request) {
      rounds++
      if (stopBeforeReview && rounds === 1) say(SELECTED_JOB_STOP_REVIEW_PHASE_MARKERS.round1Entered)
      if (rounds === 1) {
        observeSelectedJobSourceCanaries(request, selected, 2, observations)
        observations.advertisedTools = request.tools.map(tool => record(tool)?.name).filter(name => typeof name === "string")
        // Audit every model-visible request field, while excluding the opaque AbortSignal.
        const modelVisibleRequest = Object.fromEntries(Object.entries(request).filter(([key]) => key !== "signal"))
        const preReadContext = JSON.stringify({ request: modelVisibleRequest, taskContext: task.context })
        observations.preReadContextHash = hashArtifactContent(preReadContext)
        observations.privateBodyAbsentBeforeRead = !preReadContext.includes(privateBodyCanary)
        if (!observations.privateBodyAbsentBeforeRead) throw new Error("p3_selected_job_reviewer_received_body_before_persisted_read")
        if (stopBeforeReview) say(SELECTED_JOB_STOP_REVIEW_PHASE_MARKERS.artifactVersionReadYieldReached)
        yield { type: "tool_call_completed", callId: readCallId, name: "artifact.version.read", arguments: { artifactRef } }
        yield { type: "completed", finishReason: "tool_calls" }
        return
      }
      if (stopBeforeReview && rounds === 2) say(SELECTED_JOB_STOP_REVIEW_PHASE_MARKERS.round2Entered)
      if (rounds === 2) {
        const readResult = record(latestToolResult(request, readCallId))
        const readArtifactRef = record(readResult?.artifactRef)
        observations.sawBody = readArtifactRef?.artifactId === artifactRef.artifactId
          && readArtifactRef?.version === artifactRef.version
          && readArtifactRef?.contentHash === artifactRef.contentHash
          && readArtifactRef?.sourceDigest === artifactRef.sourceDigest
          && readResult?.content === privateBodyCanary
          && hashArtifactContent(readResult.content) === selected.expectedBodyHash
        if (!observations.sawBody) throw new Error("p3_selected_job_reviewer_did_not_receive_artifact_body")
        if (stopBeforeReview) {
          say(SELECTED_JOB_STOP_REVIEW_PHASE_MARKERS.readyEmissionReached)
          say("P3_SELECTED_JOB_STOP_REVIEW_READY " + task.id)
          await waitForCommand("release-selected-job-review:" + task.id)
        }
        yield { type: "tool_call_completed", callId: reviewCallId, name: "artifact.review", arguments: {
          artifactRef, decision: "passed", findings: [],
        } }
        yield { type: "completed", finishReason: "tool_calls" }
        return
      }
      const receipt = record(latestToolResult(request, reviewCallId))
      if (stopBeforeReview) {
        observations.reviewWriteError = receipt?.error ?? null
        if (observations.reviewWriteError !== "private_artifact_review_failed") {
          throw new Error("p3_selected_job_stopped_review_write_not_rejected")
        }
        say("P3_SELECTED_JOB_STOP_REVIEW_REJECTED " + task.id)
        const reviewHash = hashArtifactContent({ status: "stale", stoppedTaskId: task.id, artifactRef })
        yield { type: "text_delta", text: JSON.stringify({
          schemaVersion: ROLE_RESULT_SCHEMA, role: "reviewer", status: "completed", artifactRef,
          reviewStatus: "stale", reviewHash,
        }) }
        yield { type: "completed", finishReason: "stop" }
        return
      }
      if (receipt?.status !== "stale" || typeof receipt.reviewHash !== "string") {
        throw new Error("p3_selected_job_stale_review_receipt_missing")
      }
      observations.reviewStatus = receipt.status
      yield { type: "text_delta", text: JSON.stringify({
        schemaVersion: ROLE_RESULT_SCHEMA, role: "reviewer", status: "completed", artifactRef,
        reviewStatus: receipt.status, reviewHash: receipt.reviewHash,
      }) }
      yield { type: "completed", finishReason: "stop" }
    },
  }
}
async function startSelectedJobQueueWorker(runtime) {
  const { redisConnection } = await loadSharedRedisModule()
  const selected = record(ids.selectedJob)
  if (!selected || typeof selected.queueName !== "string" || selected.queueName.length === 0) return null
  const worker = new Worker(selected.queueName, async job => {
    const payload = parseSubagentJobPayload(job.data)
    if (!payload || payload.sessionId !== selected.sessionId || payload.rootTaskId !== selected.rootTaskId) {
      throw new Error("p3_selected_job_queue_payload_scope_invalid")
    }
    if (payload.taskId === selected.stopReviewerTaskId) {
      say("P3_SELECTED_JOB_STOP_REVIEW_QUEUED " + payload.taskId)
      await waitForCommand("start-selected-job-review:" + payload.taskId)
      say(SELECTED_JOB_STOP_REVIEW_PHASE_MARKERS.commandReceived)
    }
    let leaseIdentity = null
    let childResult = null
    const observations = {}
    const outcome = await runtime.manager.run(payload, async ({ lease }) => {
      if (lease.turnId !== selected.turnId || lease.rootTaskId !== selected.rootTaskId
        || lease.parentTaskId !== selected.rootTaskId || lease.userId !== selected.userId) {
        throw new Error("p3_selected_job_child_lease_scope_invalid")
      }
      const taskSelection = record(record(lease.context)?.selectedJobPreparation)
      const selectedTaskIds = [selected.writerTaskId, selected.reviewerTaskId, selected.stopReviewerTaskId]
        .filter(taskId => typeof taskId === "string")
      if (taskSelection?.jobId !== selected.jobId || !selectedTaskIds.includes(lease.id)) {
        throw new Error("p3_selected_job_task_lineage_invalid")
      }
      leaseIdentity = {
        role: lease.role, ownerId: lease.ownerId, attemptCount: lease.attemptCount,
        taskId: lease.id, path: lease.path,
      }
      const executor = createProductionChildExecutor({
        pool,
        authorizeUsage: async () => noReservationUsageAuthorization(),
        modelRuntimeFactory: ({ task }) => {
          if (task.role === "writer") return selectedJobDraftModel(selected, task, observations)
          if (task.role === "reviewer") return selectedJobReviewerModel(selected, task, observations)
          throw new Error("p3_unexpected_selected_job_child_role")
        },
      })
      childResult = await executor({ lease })
      return childResult
    })
    const structured = record(record(childResult?.result)?.structuredResult)
    say("P3_SELECTED_JOB_CHILD_SETTLED " + payload.taskId + " " + JSON.stringify({
      ...leaseIdentity,
      managerStatus: outcome.status,
      childStatus: childResult?.status ?? null,
      artifactRef: structured?.artifactRef ?? null,
      reviewStatus: structured?.reviewStatus ?? null,
      reviewHash: structured?.reviewHash ?? null,
      observations,
    }))
    return outcome
  }, { connection: redisConnection, skipVersionCheck: true, concurrency: 1 })
  selectedJobWorker = worker
  await worker.waitUntilReady()
  say("P3_SELECTED_JOB_QUEUE_READY " + selected.queueName)
  return worker
}
function flags() {
  return { cognitiveLoopEnabled: false, planningEnabled: true, planningExecutionEnabled: true, taskGraphPlanningEnabled: true,
    childExecutionEnabled: true, coordinationEnabled: true, consumeWaitOutcomes: true, canonicalAutomationEnabled: false }
}
function assertRestoredGraph(request) {
  const graph = graphFromRequest(request), nodes = Array.isArray(graph?.nodes) ? graph.nodes.map(record) : [], expected = ids.expectedSnapshot?.nodes
  if (graph?.kind !== "task_graph_current" || !Number.isSafeInteger(graph.revision) || graph.revision <= ids.expectedRevision
    || !Array.isArray(expected) || nodes.length !== expected.length) throw new Error("p3_task_graph_revision_or_snapshot_not_restored")
  const byKey = new Map(nodes.map(node => [node?.key, node]))
  for (const node of expected) {
    const current = byKey.get(node.key)
    if (!current || current.taskId !== node.taskId || current.goal !== node.goal || current.status !== "completed" || current.readiness !== "terminal") {
      throw new Error("p3_task_graph_node_not_restored:" + node.key)
    }
  }
  waitOutcomeFromRequest(request, outcome => outcome.status === "ready" && outcome.tasks.length === expected.length
    && outcome.tasks.every(task => record(task)?.status === "completed"))
  assertPassedVerificationReport(byKey.get("source")?.verificationReport, "candidate-count")
  assertPassedVerificationReport(byKey.get("summary")?.verificationReport, "finding-count")
  const wait = waitOutcomeFromRequest(request, outcome => outcome.status === "ready" && outcome.tasks.length === expected.length)
  for (const task of wait.tasks.map(record)) {
    const criterionId = task?.role === "scout" ? "candidate-count" : task?.role === "analyst" ? "finding-count" : ""
    assertPassedVerificationReport(task?.verificationReport, criterionId)
  }
  const sourceNode = byKey.get("source")
  if (!sourceNode || !isExpectedSourceProjection(sourceNode.resultProjection, ids.jobId)) {
    throw new Error("p3_restored_graph_source_projection_missing:" + JSON.stringify(sourceProjectionDiagnostic(sourceNode?.resultProjection)))
  }
  say("P3_RESTORED_GRAPH_OK " + JSON.stringify({ revision: graph.revision, nodeCount: nodes.length }))
  say("P3_PARENT_RESUME_CONTEXT_OK")
  return graph
}
function assertFollowUpGraph(request) {
  const graph = graphFromRequest(request), nodes = Array.isArray(graph?.nodes) ? graph.nodes.map(record) : [], expected = ids.expectedSnapshot?.nodes
  if (graph?.kind !== "task_graph_current" || !Number.isSafeInteger(graph.revision) || !Array.isArray(expected) || nodes.length !== expected.length + 1) {
    throw new Error("p3_follow_up_graph_not_restored")
  }
  const byKey = new Map(nodes.map(node => [node?.key, node]))
  for (const node of expected) {
    const current = byKey.get(node.key)
    if (!current || current.taskId !== node.taskId || current.goal !== node.goal || current.status !== "completed" || current.readiness !== "terminal") {
      throw new Error("p3_original_graph_node_changed:" + node.key)
    }
  }
  const followUp = byKey.get(followUpKey)
  if (!followUp || followUp.goal !== followUpGoal || followUp.dependsOn?.length !== 1 || followUp.dependsOn[0] !== "summary"
    || followUp.status !== "completed" || followUp.readiness !== "terminal") throw new Error("p3_follow_up_graph_node_not_completed")
  const wait = waitOutcomeFromRequest(request, outcome => outcome.status === "ready" && outcome.tasks.length === 1
    && record(outcome.tasks[0])?.taskId === followUp.taskId && record(outcome.tasks[0])?.status === "completed")
  const waitedFollowUp = record(wait.tasks[0])
  if (JSON.stringify(wait).includes(followUpGoal) || record(waitedFollowUp?.result)?.truncated !== true) {
    throw new Error("p3_follow_up_wait_redaction_invalid")
  }
  assertPassedVerificationReport(waitedFollowUp?.verificationReport, "finding-count")
  return { revision: graph.revision, taskId: followUp.taskId }
}
async function waitForParentSuspended(ownerId, timeoutMs = 20_000) {
  const waitIdempotencyKey = waitArgs("p3-process-restart-wait", []).idempotencyKey
  const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) {
    const result = await pool.query(`SELECT turn."status" AS "turnStatus", wait."status" AS "waitStatus", wait."suspendedAt", item."revision", item."content"
      FROM "agent_turns" AS turn JOIN "agent_wait_conditions" AS wait ON wait."turnId" = turn."id"
      JOIN "agent_items" AS item ON item."turnId" = turn."id" AND item."type" = 'task_graph'
      WHERE turn."id" = $1 AND wait."parentTaskId" = turn."rootTaskId" AND wait."idempotencyKey" = $2
      ORDER BY wait."createdAt" DESC LIMIT 1`, [ids.turnId, waitIdempotencyKey])
    const row = result.rows[0], content = record(row?.content)
    if (row?.turnStatus === "waiting_for_dependency" && row?.waitStatus === "waiting" && row.suspendedAt && Number(row.revision) > 0 && Array.isArray(content?.nodes) && content.nodes.length === 2) { say("P3_PARENT_SUSPENDED " + JSON.stringify({ ownerId, revision: Number(row.revision), snapshot: content })); return }
    await sleep(20)
  }
  say("P3_PARENT_SUSPENSION_DIAGNOSTICS " + JSON.stringify(parentSuspensionProjection(await parentSuspensionDiagnostics())))
  throw new Error("p3_parent_wait_not_suspended")
}
async function waitForDiscoveryParentSuspended(ownerId, timeoutMs = 20_000) {
  const waitIdempotencyKey = waitArgs("p3-process-restart-discovery-wait", []).idempotencyKey
  const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) {
    const result = await pool.query(`SELECT turn."status" AS "turnStatus", wait."status" AS "waitStatus", wait."suspendedAt", item."revision", item."content"
      FROM "agent_turns" AS turn JOIN "agent_wait_conditions" AS wait ON wait."turnId" = turn."id"
      JOIN "agent_items" AS item ON item."turnId" = turn."id" AND item."type" = 'task_graph'
      WHERE turn."id" = $1 AND wait."parentTaskId" = turn."rootTaskId" AND wait."idempotencyKey" = $2
      ORDER BY wait."createdAt" DESC LIMIT 1`, [ids.turnId, waitIdempotencyKey])
    const row = result.rows[0], content = record(row?.content)
    if (row?.turnStatus === "waiting_for_dependency" && row?.waitStatus === "waiting" && row.suspendedAt
      && Number(row.revision) > 0 && Array.isArray(content?.nodes) && content.nodes.length === 1
      && record(content.nodes[0])?.key === "scout") {
      say("P3_DISCOVERY_PARENT_SUSPENDED " + JSON.stringify({ ownerId, revision: Number(row.revision), snapshot: content })); return
    }
    await sleep(20)
  }
  say("P3_PARENT_SUSPENSION_DIAGNOSTICS " + JSON.stringify(parentSuspensionProjection(
    await parentSuspensionDiagnostics(waitIdempotencyKey, 1),
  )))
  throw new Error("p3_discovery_parent_wait_not_suspended")
}
async function parentSuspensionDiagnostics(expectedWaitIdempotencyKey = null, expectedGraphNodeCount = 2) {
  try {
    const [turnResult, stepResult, toolResult, waitResult, graphResult, childResult, taskRowResult] = await Promise.all([
      pool.query(`SELECT turn."status" AS "turnStatus", turn."rootTaskId" IS NOT NULL AS "hasRootTask",
          root."status" AS "rootTaskStatus", turn."startedAt" IS NOT NULL AS "hasStartedAt", turn."error" AS "turnError"
        FROM "agent_turns" AS turn LEFT JOIN "sub_agent_tasks" AS root
          ON root."id" = turn."rootTaskId" AND root."sessionId" = turn."sessionId" AND root."turnId" = turn."id"
        WHERE turn."id" = $1`, [ids.turnId]),
      pool.query(`SELECT step."ordinal", step."status", step."errorCode" FROM "agent_steps" AS step
        JOIN "agent_turns" AS turn ON turn."id" = step."turnId"
        WHERE turn."id" = $1 AND (step."taskId" IS NULL OR step."taskId" = turn."rootTaskId")
        ORDER BY step."ordinal"`, [ids.turnId]),
      pool.query(`WITH target_turn AS (
          SELECT "id", "sessionId", "rootTaskId" FROM "agent_turns" WHERE "id" = $1
        ), parent_items AS (
          SELECT item."type", item."status" AS "lifecycleStatus", item."content"->>'toolName' AS "toolName",
            item."content"->>'toolCallId' AS "toolCallId",
            item."content"->>'errorCode' AS "errorCode",
            item."content"->>'status' AS "toolOutcomeStatus",
            item."content"->'input'->'taskIds' AS "inputTaskIds",
            item."content"->'input'->>'idempotencyKey' AS "waitIdempotencyKey",
            item."createdAt" AS "createdAt",
            item."content"->'output'->>'status' AS "outputStatus",
            item."content"->'output'->>'status' AS "planReceiptStatus"
          FROM "agent_items" AS item JOIN target_turn AS turn ON turn."id" = item."turnId"
          WHERE item."sessionId" = turn."sessionId" AND (item."taskId" IS NULL OR item."taskId" = turn."rootTaskId")
            AND item."type" IN ('tool_call', 'tool_result')
        ), latest_wait_call AS (
          SELECT * FROM parent_items WHERE "type" = 'tool_call' AND "toolName" = 'agent.wait'
            AND ($2::text IS NULL OR "waitIdempotencyKey" = $2)
          ORDER BY "createdAt" DESC LIMIT 1
        )
        SELECT EXISTS (SELECT 1 FROM parent_items WHERE "type" = 'tool_call' AND "toolName" = 'agent.plan') AS "hasPlanToolCall",
          EXISTS (SELECT 1 FROM parent_items AS call JOIN parent_items AS result ON result."toolCallId" = call."toolCallId"
            WHERE call."type" = 'tool_call' AND call."toolName" = 'agent.plan' AND result."type" = 'tool_result') AS "hasPlanToolResult",
          EXISTS (SELECT 1 FROM parent_items AS call JOIN parent_items AS result ON result."toolCallId" = call."toolCallId"
            WHERE call."type" = 'tool_call' AND call."toolName" = 'agent.plan' AND result."type" = 'tool_result'
              AND (call."toolOutcomeStatus" = 'failed' OR call."errorCode" IS NOT NULL OR result."errorCode" IS NOT NULL)) AS "hasFailedPlanToolResult",
          ARRAY(SELECT result."planReceiptStatus" FROM parent_items AS call JOIN parent_items AS result ON result."toolCallId" = call."toolCallId"
            WHERE call."type" = 'tool_call' AND call."toolName" = 'agent.plan' AND result."type" = 'tool_result'
              AND result."planReceiptStatus" IN ('accepted', 'duplicate', 'rejected')
            ORDER BY result."planReceiptStatus") AS "planReceiptStatuses",
          (SELECT COALESCE(call."errorCode", result."errorCode") FROM parent_items AS call
            JOIN parent_items AS result ON result."toolCallId" = call."toolCallId"
            WHERE call."type" = 'tool_call' AND call."toolName" = 'agent.plan' AND result."type" = 'tool_result'
              AND (call."toolOutcomeStatus" = 'failed' OR call."errorCode" IS NOT NULL OR result."errorCode" IS NOT NULL)
            ORDER BY result."createdAt" DESC LIMIT 1) AS "planErrorCode",
          EXISTS (SELECT 1 FROM latest_wait_call) AS "hasWaitToolCall",
          EXISTS (SELECT 1 FROM latest_wait_call AS call JOIN parent_items AS result ON result."toolCallId" = call."toolCallId"
            WHERE result."type" = 'tool_result') AS "hasWaitToolResult",
          (SELECT call."toolOutcomeStatus" FROM latest_wait_call AS call) AS "waitToolCallStatus",
          (SELECT call."lifecycleStatus" FROM latest_wait_call AS call) AS "waitToolCallLifecycleStatus",
          (SELECT call."waitIdempotencyKey" FROM latest_wait_call AS call) AS "waitCallIdempotencyKey",
          (SELECT call."inputTaskIds" FROM latest_wait_call AS call) AS "waitCallTaskIds",
          (SELECT result."lifecycleStatus" FROM latest_wait_call AS call JOIN parent_items AS result ON result."toolCallId" = call."toolCallId"
            WHERE result."type" = 'tool_result' ORDER BY result."createdAt" DESC LIMIT 1) AS "waitToolResultLifecycleStatus",
          (SELECT result."outputStatus" FROM latest_wait_call AS call JOIN parent_items AS result ON result."toolCallId" = call."toolCallId"
            WHERE result."type" = 'tool_result' ORDER BY result."createdAt" DESC LIMIT 1) AS "waitToolOutputStatus",
          (SELECT result."errorCode" FROM latest_wait_call AS call JOIN parent_items AS result ON result."toolCallId" = call."toolCallId"
            WHERE result."type" = 'tool_result' ORDER BY result."createdAt" DESC LIMIT 1) AS "waitToolErrorCode",
          (SELECT call."errorCode" FROM latest_wait_call AS call) AS "waitToolCallErrorCode"`, [ids.turnId, expectedWaitIdempotencyKey]),
      pool.query(`SELECT wait."idempotencyKey" AS "waitIdempotencyKey", wait."status" AS "waitStatus", wait."targetTaskIds", wait."parentTaskId" = turn."rootTaskId" AS "parentMatchesRoot",
          wait."suspendedAt" IS NOT NULL AS "hasSuspendedAt"
        FROM "agent_wait_conditions" AS wait JOIN "agent_turns" AS turn ON turn."id" = wait."turnId"
        WHERE turn."id" = $1`, [ids.turnId]),
      pool.query(`SELECT item."revision", item."content"->'nodes' AS "nodes", jsonb_typeof(item."content"->'nodes') = 'array' AS "hasNodeArray",
          CASE WHEN jsonb_typeof(item."content"->'nodes') = 'array' THEN jsonb_array_length(item."content"->'nodes') ELSE NULL END AS "nodeCount"
        FROM "agent_items" AS item JOIN "agent_turns" AS turn ON turn."id" = item."turnId"
        WHERE turn."id" = $1 AND item."sessionId" = turn."sessionId" AND item."taskId" = turn."rootTaskId"
          AND item."type" = 'task_graph' ORDER BY item."revision" DESC, item."updatedAt" DESC LIMIT 1`, [ids.turnId]),
      pool.query(`SELECT child."status", COUNT(*)::int AS "count"
        FROM "sub_agent_tasks" AS child JOIN "agent_turns" AS turn
          ON turn."id" = child."turnId" AND turn."sessionId" = child."sessionId" AND turn."rootTaskId" = child."parentTaskId"
        WHERE turn."id" = $1 GROUP BY child."status"`, [ids.turnId]),
      pool.query(`SELECT child."id" FROM "sub_agent_tasks" AS child JOIN "agent_turns" AS turn
        ON turn."id" = child."turnId" AND turn."sessionId" = child."sessionId" AND turn."rootTaskId" = child."parentTaskId"
        WHERE turn."id" = $1`, [ids.turnId]),
    ])
    const turn = turnResult.rows[0]
    const graph = graphResult.rows[0]
    const tool = toolResult.rows[0] ?? {}
    const graphNodes = Array.isArray(graph?.nodes) ? graph.nodes.map(record) : []
    const graphTaskIds = graphNodes.map(node => node?.taskId).filter(taskId => typeof taskId === "string")
    const taskIds = taskRowResult.rows.map(row => row.id).filter(taskId => typeof taskId === "string")
    const requestedTaskIds = stringArray(tool.waitCallTaskIds)
    const matchingWait = waitResult.rows.find(row => row.parentMatchesRoot
      && typeof tool.waitCallIdempotencyKey === "string" && row.waitIdempotencyKey === tool.waitCallIdempotencyKey)
    const persistedWaitTaskIds = stringArray(matchingWait?.targetTaskIds)
    const latestStep = stepResult.rows[stepResult.rows.length - 1]
    const taskIdSet = new Set(taskIds)
    const graphTaskIdSet = new Set(graphTaskIds)
    const missingGraphTaskKeys = graphNodes.flatMap(node => {
      const key = typeof node?.key === "string" ? node.key : null
      return key && TASK_GRAPH_KEY_ALLOWLIST.has(key)
        && (typeof node.taskId !== "string" || !taskIdSet.has(node.taskId)) ? [key] : []
    })
    const missingRequestedGraphTaskKeys = requestedTaskIds ? graphNodes.flatMap(node => {
      const key = typeof node?.key === "string" ? node.key : null
      return key && TASK_GRAPH_KEY_ALLOWLIST.has(key)
        && (typeof node.taskId !== "string" || !requestedTaskIds.includes(node.taskId)) ? [key] : []
    }) : []
    const snapshot = {
      turnStatus: turn?.turnStatus ?? null,
      hasTurn: Boolean(turn),
      hasRootTask: Boolean(turn?.hasRootTask),
      rootTaskStatus: fixedEnum(turn?.rootTaskStatus, ROOT_TASK_STATUS_ALLOWLIST),
      hasStartedAt: Boolean(turn?.hasStartedAt),
      hasError: typeof turn?.turnError === "string" && turn.turnError.length > 0,
      turnErrorCategory: turnErrorCategory(turn?.turnError),
      modelStepCount: stepResult.rows.length,
      latestModelStep: stepResult.rows.length ? {
        ordinal: Number(latestStep.ordinal),
        status: latestStep.status,
        hasErrorCode: typeof latestStep.errorCode === "string" && latestStep.errorCode.length > 0,
        errorClass: modelStepErrorClass(latestStep.errorCode),
      } : null,
      hasPlanToolCall: Boolean(tool.hasPlanToolCall),
      hasPlanToolResult: Boolean(tool.hasPlanToolResult),
      hasFailedPlanToolResult: Boolean(tool.hasFailedPlanToolResult),
      planFailureCategory: modelStepErrorClass(tool.planErrorCode),
      planReceiptStatuses: Array.isArray(tool.planReceiptStatuses) ? tool.planReceiptStatuses : [],
      hasWaitToolCall: Boolean(tool.hasWaitToolCall),
      waitToolCallStatus: fixedEnum(tool.waitToolCallStatus, TOOL_CALL_STATUS_ALLOWLIST),
      waitToolCallLifecycleStatus: fixedEnum(tool.waitToolCallLifecycleStatus, ITEM_LIFECYCLE_STATUS_ALLOWLIST),
      waitToolResultLifecycleStatus: fixedEnum(tool.waitToolResultLifecycleStatus, ITEM_LIFECYCLE_STATUS_ALLOWLIST),
      waitCallIdempotencyKeyPresent: typeof tool.waitCallIdempotencyKey === "string",
      waitToolOutputStatus: fixedEnum(tool.waitToolOutputStatus, WAIT_OUTPUT_STATUS_ALLOWLIST),
      waitFailureCategory: waitFailureCategory(tool),
      initialWaitLineage,
      waits: waitResult.rows.map(row => ({
        status: row.waitStatus,
        parentMatchesRoot: Boolean(row.parentMatchesRoot),
        hasSuspendedAt: Boolean(row.hasSuspendedAt),
        matchesLatestWaitToolCall: typeof tool.waitCallIdempotencyKey === "string"
          && row.waitIdempotencyKey === tool.waitCallIdempotencyKey,
      })),
      graph: graph ? { present: true, revision: Number(graph.revision), hasNodeArray: Boolean(graph.hasNodeArray), nodeCount: graph.nodeCount === null ? null : Number(graph.nodeCount) }
        : { present: false, revision: null, hasNodeArray: false, nodeCount: null },
      graphTaskIdCount: graphNodes.filter(node => typeof node?.taskId === "string").length,
      taskRowCount: taskIds.length,
      requestedTaskCount: requestedTaskIds?.length ?? null,
      requestedGraphMatchCount: requestedTaskIds?.filter(taskId => graphTaskIdSet.has(taskId)).length ?? null,
      requestedTaskRowMatchCount: requestedTaskIds?.filter(taskId => taskIdSet.has(taskId)).length ?? null,
      persistedWaitTaskCount: persistedWaitTaskIds?.length ?? null,
      persistedWaitGraphMatchCount: persistedWaitTaskIds?.filter(taskId => graphTaskIdSet.has(taskId)).length ?? null,
      persistedWaitTaskRowMatchCount: persistedWaitTaskIds?.filter(taskId => taskIdSet.has(taskId)).length ?? null,
      graphTaskRowMatchCount: graphTaskIds.filter(taskId => taskIdSet.has(taskId)).length,
      missingRequestedGraphTaskKeys: [...new Set(missingRequestedGraphTaskKeys)].sort(),
      missingGraphTaskKeys: [...new Set(missingGraphTaskKeys)].sort(),
      childStatusCounts: taskStatusCounts(childResult.rows),
    }
    snapshot.likelyCause = !snapshot.hasTurn ? "turn_missing"
      : snapshot.modelStepCount === 0 ? "model_never_ran"
      : !snapshot.hasPlanToolCall ? "plan_not_called"
      : snapshot.hasFailedPlanToolResult || !snapshot.hasPlanToolResult
        || !snapshot.planReceiptStatuses.some(status => status === "accepted" || status === "duplicate")
        || !snapshot.graph.present ? "plan_failed_or_incomplete"
       : !snapshot.graph.hasNodeArray || snapshot.graph.nodeCount !== expectedGraphNodeCount ? "graph_shape_mismatch"
        : !snapshot.hasWaitToolCall ? "wait_call_missing"
        : !snapshot.hasWaitToolResult && snapshot.waitFailureCategory !== "none" && snapshot.waitFailureCategory !== "tool_result_missing"
          ? "wait_tool_failed_before_wait_persistence"
        : !snapshot.hasWaitToolResult ? "wait_result_missing_or_unknown"
       : snapshot.requestedTaskCount === null ? "wait_target_ids_unreadable"
      : snapshot.requestedGraphMatchCount !== snapshot.requestedTaskCount ? "requested_ids_not_in_graph"
      : snapshot.requestedTaskRowMatchCount !== snapshot.requestedTaskCount ? "requested_graph_tasks_missing_child_rows"
       : !snapshot.waits.some(wait => wait.parentMatchesRoot && wait.matchesLatestWaitToolCall)
         && snapshot.waitFailureCategory !== "none" ? "wait_tool_failed_before_wait_persistence"
       : !snapshot.waits.some(wait => wait.parentMatchesRoot && wait.matchesLatestWaitToolCall) ? "wait_row_missing_or_parent_mismatch"
      : snapshot.turnStatus === "failed" ? "turn_failed"
       : !snapshot.waits.some(wait => wait.parentMatchesRoot && wait.matchesLatestWaitToolCall
         && wait.status === "waiting" && wait.hasSuspendedAt) ? "wait_row_not_suspended"
      : "suspension_predicate_not_met"
    return snapshot
  } catch {
    return { diagnosticsAvailable: false }
  }
}
async function projectPersistedPlanLedger() {
  const { rows: [item] } = await pool.query(`SELECT item."taskId", item."revision", item."content" FROM "agent_items" AS item WHERE item."sessionId" = $1 AND item."turnId" = $2 AND item."type" = 'task_graph'`, [ids.sessionId, ids.turnId])
  if (!item) throw new Error("p3_persisted_plan_ledger_graph_missing")
  const { rows: tasks } = await pool.query(`SELECT "id", "sessionId", "status", "role", "goal", "result", "updatedAt" FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "turnId" = $2 AND ("id" = $3 OR "parentTaskId" = $3)`, [ids.sessionId, ids.turnId, item.taskId])
  const ledger = projectPlanLedger({ sessionId: ids.sessionId, revision: Number(item.revision), rootTaskId: item.taskId, graph: item.content, tasks })
  if (!ledger || !parsePlanLedger(JSON.stringify(ledger))) throw new Error("p3_persisted_plan_ledger_projection_invalid")
  return ledger
}
function toolCall(callId, name, args) { return { type: "tool_call_completed", callId, name, arguments: args } }
const fixtureVerifications = {
  scout: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout", criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } }] },
  analyst: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst", criteria: [{ id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } }] },
}
function node(key, templateId, goal, successCriteria, dependsOn) {
  const verification = fixtureVerifications[templateId]
  if (!verification) throw new Error("p3_fixture_verification_template_unsupported")
  return { key, templateId, goal, successCriteria, dependsOn, verification }
}
function waitArgs(key, taskIds) { return { idempotencyKey: key + ":" + ids.turnId, taskIds, mode: "all", timeoutMs: 30_000 } }
async function startRuntime(workerOwnerId, resume) {
  return createCanonicalTurnRuntime(pool, {
    workerId: workerOwnerId, productionFlags: flags(), taskGraphCommandPort: createPgTaskGraphCommandPort(pool),
    taskGraphTemplates: TASK_GRAPH_TEMPLATES, authorizeUsage: async () => noReservationUsageAuthorization(),
    modelRuntimeFactory() {
      let modelRounds = 0
      return { adapter: {
        id: resume ? "p3-process-restart-resume-model" : "p3-process-restart-plan-model", profile: modelProfile(),
        async *stream(request) {
          modelRounds++
          if (!resume && modelRounds === 1) {
            yield toolCall(planCallId, "agent.plan", { expectedRevision: 0, nodes: [
              node("source", "scout", sourceGoal, ["Persist source evidence"], []),
              node("summary", "analyst", dependentGoal, ["Use restored dependency evidence"], ["source"]),
            ] })
            yield { type: "completed", finishReason: "tool_calls" }; return
          }
          if (!resume && modelRounds === 2) {
            const taskIds = plannedTaskIds(request)
            initialWaitLineage = await initialWaitLineageFor(request, taskIds)
            if (!initialWaitLineage.planToolPairMatches || !initialWaitLineage.planExpectedRevisionMatches
              || !initialWaitLineage.proposalMatchesGraph || !initialWaitLineage.proposalRevisionMatchesGraph) {
              throw new Error("p3_initial_wait_plan_graph_mismatch")
            }
            yield toolCall(waitCallId, "agent.wait", waitArgs("p3-process-restart-wait", taskIds))
            yield { type: "completed", finishReason: "tool_calls" }; return
          }
          if (resume) {
            try {
              const graph = graphFromRequest(request), nodes = Array.isArray(graph?.nodes) ? graph.nodes.map(record) : []
              const followUp = nodes.find(item => item?.key === followUpKey)
              if (!followUp) {
                const restored = assertRestoredGraph(request)
                if (!request.tools.some(tool => record(tool)?.name === "agent.plan")) throw new Error("p3_follow_up_plan_tool_missing")
                yield toolCall(followUpPlanCallId, "agent.plan", { expectedRevision: restored.revision,
                  nodes: [node(followUpKey, "analyst", followUpGoal, ["Verify the restored summary evidence"], ["summary"])] })
                yield { type: "completed", finishReason: "tool_calls" }; return
              }
              const waitReady = waitOutcomesFromRequest(request).some(outcome => outcome.status === "ready"
                && outcome.tasks.some(task => record(task)?.taskId === followUp.taskId && record(task)?.status === "completed"))
              if (!waitReady) {
                const taskIds = plannedTaskIds(request, followUpPlanCallId, 1)
                if (followUp.taskId !== taskIds[0]) throw new Error("p3_follow_up_plan_task_mismatch")
                if (!request.tools.some(tool => record(tool)?.name === "agent.wait")) throw new Error("p3_follow_up_wait_tool_missing")
                yield toolCall(followUpWaitCallId, "agent.wait", waitArgs("p3-process-restart-follow-up-wait", taskIds))
                yield { type: "completed", finishReason: "tool_calls" }; return
              }
              if (followUp.status !== "completed") throw new Error("p3_follow_up_waited_task_not_completed")
              const state = assertFollowUpGraph(request)
              const ledger = await projectPersistedPlanLedger()
              say("P3_PLAN_LEDGER_PROJECTION " + JSON.stringify(ledger))
              say("P3_FOLLOW_UP_GRAPH_READY " + JSON.stringify(state)); await waitForCommand("finalize-parent")
              say("P3_FOLLOW_UP_GRAPH_OK " + JSON.stringify(state))
              yield { type: "text_delta", text: finalMarker }; yield { type: "completed", finishReason: "stop" }; return
            } catch (error) {
              say("P3_PARENT_MODEL_FAILURE_CLASS " + safeFailureCategory(error))
              say("P3_PARENT_MODEL_FAILURE_GUARD " + restoredGraphGuardMarker(error))
              throw error
            }
          }
          throw new Error("p3_unexpected_parent_model_round")
        },
      }, registry: {}, candidates: [] }
    },
  })
}
async function startDiscoveryRuntime(workerOwnerId, resume) {
  let waitOutcomeCheckpointUsed = false
  const stateLoader = resume && mode === "resume-discovery" && ids.checkpointAfterWaitConsume === true
    ? async (statePool, lease, now, loaderOptions) => {
      const state = await loadCanonicalTurnState(statePool, lease, now, loaderOptions)
      if (!waitOutcomeCheckpointUsed && lease.turnId === ids.turnId && loaderOptions?.consumeWaitOutcomes === true) {
        waitOutcomeCheckpointUsed = true
        say("P3_DISCOVERY_WAIT_OUTCOME_COMMITTED")
        await waitForCommand("continue-after-wait-outcome-commit")
      }
      return state
    }
    : undefined
  return createCanonicalTurnRuntime(pool, {
    workerId: workerOwnerId, productionFlags: flags(), taskGraphCommandPort: createPgTaskGraphCommandPort(pool),
    taskGraphTemplates: TASK_GRAPH_TEMPLATES, authorizeUsage: async () => noReservationUsageAuthorization(),
    ...(stateLoader ? { stateLoader } : {}),
    modelRuntimeFactory() {
      let modelRounds = 0
      const adapter = {
        id: resume ? "p3-process-restart-discovery-resume-model" : "p3-process-restart-discovery-plan-model", profile: modelProfile(),
        async *stream(request) {
          modelRounds++
          const graph = graphFromRequest(request), nodes = Array.isArray(graph?.nodes) ? graph.nodes.map(record) : []
          if (!resume && modelRounds === 1) {
            if (!request.tools.some(tool => record(tool)?.name === "agent.plan")) throw new Error("p3_discovery_initial_plan_tool_missing")
            yield toolCall(discoveryPlanCallId, "agent.plan", { expectedRevision: 0, nodes: [
              node("scout", "scout", discoveryScoutGoal, ["Read one owner-scoped job"], []),
            ] })
            yield { type: "completed", finishReason: "tool_calls" }; return
          }
          if (!resume && modelRounds === 2) {
            const taskIds = plannedTaskIds(request, discoveryPlanCallId, 1)
            yield toolCall(discoveryWaitCallId, "agent.wait", waitArgs("p3-process-restart-discovery-wait", taskIds))
            yield { type: "completed", finishReason: "tool_calls" }; return
          }
          if (!resume) throw new Error("p3_unexpected_discovery_first_worker_model_round")

          const scout = nodes.find(item => item?.key === "scout")
          const analyst = nodes.find(item => item?.key === "analyst")
          if (!scout || scout.status !== "completed" || typeof scout.taskId !== "string") {
            throw new Error("p3_discovery_restored_scout_not_completed")
          }
          if (!analyst) {
            waitOutcomeFromRequest(request, outcome => outcome.status === "ready"
              && outcome.tasks.some(task => record(task)?.taskId === scout.taskId && record(task)?.status === "completed"))
            if (!request.tools.some(tool => record(tool)?.name === "agent.plan")) throw new Error("p3_discovery_replan_tool_missing")
            yield toolCall(discoveryAnalystPlanCallId, "agent.plan", { expectedRevision: graph.revision, nodes: [
              node("analyst", "analyst", discoveryAnalystGoal, ["Return an evidence-bound score"], ["scout"]),
            ] })
            yield { type: "completed", finishReason: "tool_calls" }; return
          }
          if (analyst.status !== "completed") {
            const taskIds = plannedTaskIds(request, discoveryAnalystPlanCallId, 1)
            if (analyst.taskId !== taskIds[0]) throw new Error("p3_discovery_analyst_plan_task_mismatch")
            if (!request.tools.some(tool => record(tool)?.name === "agent.wait")) throw new Error("p3_discovery_analyst_wait_tool_missing")
            yield toolCall(discoveryAnalystWaitCallId, "agent.wait", waitArgs("p3-process-restart-discovery-analyst-wait", taskIds))
            yield { type: "completed", finishReason: "tool_calls" }; return
          }
          if (typeof analyst.taskId !== "string") throw new Error("p3_discovery_analyst_task_missing")
          const originalAnalystWait = record(latestToolResult(request, discoveryAnalystWaitCallId))
          const analystWaitId = originalAnalystWait?.waitId
          if (originalAnalystWait?.status !== "waiting" || typeof analystWaitId !== "string"
            || !Array.isArray(originalAnalystWait.taskIds) || originalAnalystWait.taskIds.length !== 1
            || originalAnalystWait.taskIds[0] !== analyst.taskId
            || !Array.isArray(originalAnalystWait.matchedTaskIds) || originalAnalystWait.matchedTaskIds.length !== 0) {
            throw new Error("p3_discovery_analyst_wait_receipt_invalid")
          }
          const analystWaitProjection = request.messages.flatMap(message => message.content).find(part =>
            part.type === "tool_result" && part.toolUseId === "wait:" + analystWaitId)
          let analystWaitOutcome = null
          if (typeof analystWaitProjection?.content === "string") {
            try { analystWaitOutcome = record(JSON.parse(analystWaitProjection.content)) } catch { /* Invalid archive stays absent. */ }
          }
          const archivedAnalystTasks = Array.isArray(analystWaitOutcome?.tasks) ? analystWaitOutcome.tasks.map(record) : []
          if (analystWaitOutcome?.waitId !== analystWaitId || analystWaitOutcome.status !== "ready"
            || !Array.isArray(analystWaitOutcome.targetTaskIds) || analystWaitOutcome.targetTaskIds.length !== 1
            || analystWaitOutcome.targetTaskIds[0] !== analyst.taskId
            || !Array.isArray(analystWaitOutcome.matchedTaskIds) || analystWaitOutcome.matchedTaskIds.length !== 1
            || analystWaitOutcome.matchedTaskIds[0] !== analyst.taskId || archivedAnalystTasks.length !== 1
            || archivedAnalystTasks[0]?.taskId !== analyst.taskId || archivedAnalystTasks[0]?.role !== "analyst"
            || archivedAnalystTasks[0]?.status !== "completed") {
            throw new Error("p3_durable_wait_result_missing")
          }
          assertPassedVerificationReport(archivedAnalystTasks[0]?.verificationReport, "finding-count")
          if (nodes.length !== 2 || nodes.some(item => item?.status !== "completed")) throw new Error("p3_discovery_final_graph_incomplete")
          say("P3_DISCOVERY_RESTORED_FINAL_GRAPH " + JSON.stringify({ revision: graph.revision, nodeCount: nodes.length }))
          yield { type: "text_delta", text: JSON.stringify({ schemaVersion: "agent-harness.v2.final", response: discoveryFinalMarker }) }
          yield { type: "completed", finishReason: "stop" }; return
        },
      }
      return {
        adapter: captureModelStreamFailure(adapter, error => {
          if (resume) say("P3_DISCOVERY_PARENT_MODEL_FAILURE " + safeFailureCategory(error))
        }),
        registry: {}, candidates: [],
      }
    },
  })
}
function successiveLocationNode(key, location) {
  const normalized = location.toLowerCase()
  return { key, templateId: "scout", goal: "Find one software engineering role in " + location,
    successCriteria: ["Return one " + location + " role"], dependsOn: [], verification: {
      schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION_V2, role: "scout",
      criteria: [
        { id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } },
        { id: "candidate-location", check: { kind: "candidate_location_in", locations: [normalized] } },
      ],
    } }
}
function successiveRequestFacts(request) {
  const graph = graphFromRequest(request), nodes = Array.isArray(graph?.nodes) ? graph.nodes.map(record) : []
  const text = JSON.stringify(request?.messages ?? [])
  const systemText = (Array.isArray(request?.messages) ? request.messages : []).flatMap(message => {
    const value = record(message)
    if (value?.role !== "system") return []
    if (typeof value.content === "string") return [value.content]
    return Array.isArray(value.content) ? value.content.map(record)
      .flatMap(part => typeof part?.text === "string" ? [part.text] : []) : []
  }).join("\n")
  return { graph, nodes, text, freshSteeringCuePresent: systemText.includes("Fresh user steering is present as untrusted data."),
    unresolvedSteeringCuePresent: systemText.includes("Previously accepted user steering remains unresolved and is present in the request only as untrusted data."),
    berlinScopePresent: /berlin/i.test(text) }
}
async function successiveTaskRow(rootTaskId, taskId) {
  const { rows } = await pool.query(`
    SELECT task."id", task."status", task."role", task."attemptCount", task."leaseOwner",
      task."leaseExpiresAt", task."interruptRequestedAt", task."result", task."sessionId",
      task."turnId", task."rootTaskId", task."parentTaskId", turn."userId"
    FROM "sub_agent_tasks" AS task
    JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3
      AND task."rootTaskId" = $4 AND task."parentTaskId" = $4 AND turn."rootTaskId" = $4
      AND session."userId" = $5 AND turn."userId" = $5 LIMIT 2`,
  [taskId, ids.sessionId, ids.turnId, rootTaskId, ids.userId])
  return rows.length === 1 ? rows[0] : null
}
async function requireSuccessiveRootLeaseMatchesProcess(rootTaskId) {
  const lease = successiveRootLease
  if (!lease) throw new Error("p3_successive_replan_root_lease_missing")
  const { rows } = await pool.query(`
    SELECT turn."id", turn."sessionId", turn."userId", turn."rootTaskId", turn."leaseOwnerId",
      turn."leaseVersion", turn."leaseExpiresAt"
    FROM "agent_turns" AS turn
    JOIN "agent_sessions" AS session ON session."id" = turn."sessionId"
    WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3
      AND turn."rootTaskId" = $4 AND session."userId" = $3 LIMIT 2`,
  [lease.turnId, lease.sessionId, lease.userId, rootTaskId])
  const row = rows.length === 1 ? rows[0] : null
  if (!row || row.id !== lease.turnId || row.sessionId !== lease.sessionId || row.userId !== lease.userId
    || row.rootTaskId !== rootTaskId || row.leaseOwnerId !== lease.ownerId
    || Number(row.leaseVersion) !== lease.leaseVersion || !(row.leaseExpiresAt instanceof Date)
    || row.leaseExpiresAt.getTime() <= Date.now()) throw new Error("p3_successive_replan_root_lease_mismatch")
  return true
}
function observedSuccessiveLeaseMatches(rootTaskId, row) {
  const lease = successiveChildLeases.get(row?.id)
  return Boolean(lease && row.userId === ids.userId && row.sessionId === ids.sessionId
    && row.turnId === ids.turnId && row.rootTaskId === rootTaskId && row.parentTaskId === rootTaskId
    && lease.userId === ids.userId && lease.sessionId === ids.sessionId && lease.turnId === ids.turnId
    && lease.rootTaskId === rootTaskId && lease.parentTaskId === rootTaskId
    && lease.attemptCount === row.attemptCount && lease.leaseOwner === row.leaseOwner
    && lease.ownerId === row.leaseOwner)
}
async function executeSuccessiveChild({ lease }, childExecutor) {
  if (!lease || lease.role !== "scout" || lease.userId !== ids.userId || lease.sessionId !== ids.sessionId
    || lease.turnId !== ids.turnId || typeof lease.id !== "string" || typeof lease.ownerId !== "string"
    || typeof lease.rootTaskId !== "string" || !lease.rootTaskId || lease.parentTaskId !== lease.rootTaskId
    || lease.leaseOwner !== lease.ownerId || !Number.isSafeInteger(lease.attemptCount) || lease.attemptCount < 1
    || !(lease.leaseExpiresAt instanceof Date) || lease.leaseExpiresAt.getTime() <= Date.now()) {
    throw new Error("p3_successive_replan_child_lease_invalid")
  }
  successiveChildLeases.set(lease.id, {
    userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId,
    rootTaskId: lease.rootTaskId, parentTaskId: lease.parentTaskId,
    ownerId: lease.ownerId, leaseOwner: lease.leaseOwner, attemptCount: lease.attemptCount,
  })
  if (mode === "park-successive-replan" && typeof lease.goal === "string" && lease.goal.includes("Dublin")) {
    await waitForSuccessiveTaskStarted(lease.rootTaskId, lease.id, successiveDublinKey)
    successiveClaimedBeforeModel.add(lease.id)
    say("P3_SUCCESSIVE_REPLAN_CHILD_CLAIMED_BEFORE_MODEL " + JSON.stringify({ role: "scout", location: "dublin",
      claimObserved: true, startLifecycleObserved: true, modelStarted: false, toolStarted: false }))
    await waitForCommand("release-dublin-before-model")
  }
  return await childExecutor({ lease })
}
async function successiveWaitState(rootTaskId, key) {
  const { rows } = await pool.query(`
    SELECT turn."status" AS "turnStatus", wait."status" AS "waitStatus", wait."suspendedAt",
      graph."revision", graph."content"
    FROM "agent_turns" AS turn
    JOIN "agent_sessions" AS session ON session."id" = turn."sessionId"
    JOIN "agent_wait_conditions" AS wait ON wait."userId" = turn."userId"
      AND wait."sessionId" = turn."sessionId" AND wait."turnId" = turn."id"
      AND wait."parentTaskId" = turn."rootTaskId" AND wait."idempotencyKey" = $4
    JOIN "agent_items" AS graph ON graph."sessionId" = turn."sessionId" AND graph."turnId" = turn."id"
      AND graph."taskId" = turn."rootTaskId" AND graph."id" = $5 AND graph."type" = 'task_graph'
    WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3 AND session."userId" = $3 LIMIT 2`,
  [ids.turnId, ids.sessionId, ids.userId, key, taskGraphItemId(rootTaskId)])
  return rows.length === 1 ? rows[0] : null
}
async function waitForSuccessiveSuspendedWait(rootTaskId, key, expectedKeys, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const wait = await successiveWaitState(rootTaskId, key)
    const graph = record(wait?.content), nodes = Array.isArray(graph?.nodes) ? graph.nodes.map(record) : []
    const keys = nodes.map(node => node?.key).sort()
    if (wait?.turnStatus === "waiting_for_dependency" && wait.waitStatus === "waiting" && wait.suspendedAt
      && isDeepStrictEqual(keys, [...expectedKeys].sort())) return { wait, nodes }
    await sleep(25)
  }
  throw new Error("p3_successive_replan_wait_not_suspended")
}
async function waitForSuccessiveTaskStarted(rootTaskId, taskId, nodeKey, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const row = await successiveTaskRow(rootTaskId, taskId)
    if (row?.status === "running" && row.role === "scout" && observedSuccessiveLeaseMatches(rootTaskId, row)
      && row.leaseOwner && row.leaseExpiresAt instanceof Date && row.leaseExpiresAt.getTime() > Date.now()
      && row.interruptRequestedAt === null) {
      const { rows } = await pool.query(`
        SELECT COUNT(*)::int AS "count" FROM "agent_events" AS event
        JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
        JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
        WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."itemId" = $3 AND event."taskId" = $4
          AND event."type" IN ('task_graph.lifecycle', 'item.delta')
          AND event."payload"->>'kind' = 'lifecycle' AND event."payload"->'event'->>'type' = 'task.started'
          AND event."payload"->'event'->>'nodeKey' = $5
          AND event."idempotencyKey" = $6 AND turn."rootTaskId" = $7
          AND session."userId" = $8 AND turn."userId" = $8`,
      [ids.sessionId, ids.turnId, taskGraphItemId(rootTaskId), taskId, nodeKey,
        taskGraphLifecycleKey(rootTaskId, nodeKey, row.attemptCount, "task.started"), rootTaskId, ids.userId])
      if (rows[0]?.count === 1) return row
    }
    await sleep(25)
  }
  throw new Error("p3_successive_replan_dublin_start_not_observed")
}
async function waitForSuccessiveChildBoundary(taskId, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (successiveHeldChildren.has(taskId) || successiveClaimedBeforeModel.has(taskId)) return
    await sleep(25)
  }
  throw new Error("p3_successive_replan_dublin_child_not_held")
}
async function waitForSuccessiveChildSearchHeld(taskId, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (successiveHeldChildren.has(taskId)) return
    await sleep(25)
  }
  throw new Error("p3_successive_replan_dublin_search_not_held")
}
async function successiveGraphRevision(rootTaskId) {
  const { rows } = await pool.query(`
    SELECT graph."revision" FROM "agent_items" AS graph
    JOIN "agent_sessions" AS session ON session."id" = graph."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = graph."turnId" AND turn."sessionId" = graph."sessionId"
    WHERE graph."id" = $1 AND graph."sessionId" = $2 AND graph."turnId" = $3 AND graph."taskId" = $4
      AND graph."type" = 'task_graph' AND turn."rootTaskId" = $4
      AND session."userId" = $5 AND turn."userId" = $5 LIMIT 2`,
  [taskGraphItemId(rootTaskId), ids.sessionId, ids.turnId, rootTaskId, ids.userId])
  return rows.length === 1 && Number.isSafeInteger(rows[0]?.revision) ? rows[0].revision : null
}
async function readSuccessiveRetirement(rootTaskId, nodeKey, taskId, replacementTaskId, callId) {
  const task = await successiveTaskRow(rootTaskId, taskId)
  if (!task || task.status !== "interrupted" || task.role !== "scout" || !Number.isSafeInteger(task.attemptCount)) return null
  const [receiptResult, ackResult] = await Promise.all([
    pool.query(`
      SELECT event."sequence", event."type", event."actor", event."correlationId", event."itemId",
        event."taskId", event."causationId", event."payload", call."stepId" AS "actionStepId",
        EXISTS (SELECT 1 FROM "agent_outbox" outbox WHERE outbox."idempotencyKey" = 'agent-event:' || event."id") AS "hasOutbox"
      FROM "agent_events" AS event
      JOIN "agent_items" AS call ON call."sessionId" = event."sessionId" AND call."turnId" = event."turnId"
        AND call."taskId" = $3 AND call."type" = 'tool_call' AND call."content"->>'toolCallId' = $4
      JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
      JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
      WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."type" = $5
        AND event."taskId" = $6 AND event."itemId" = $7 AND turn."rootTaskId" = $3
        AND session."userId" = $8 AND turn."userId" = $8 ORDER BY event."sequence" LIMIT 2`,
    [ids.sessionId, ids.turnId, rootTaskId, callId, TASK_GRAPH_SUPERSEDED_SCOUT_RETIREMENT_EVENT_TYPE,
      taskId, taskGraphItemId(rootTaskId), ids.userId]),
    pool.query(`
      SELECT event."sequence", event."type", event."actor", event."correlationId", event."itemId",
        event."taskId", event."causationId", event."payload", event."idempotencyKey",
        EXISTS (SELECT 1 FROM "agent_outbox" outbox WHERE outbox."idempotencyKey" = 'agent-event:' || event."id") AS "hasOutbox"
      FROM "agent_events" AS event
      JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
      JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
      WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."taskId" = $3
        AND event."type" = 'item.delta' AND event."payload"->'event'->>'type' = 'task.interrupted'
        AND event."idempotencyKey" = $4 AND turn."rootTaskId" = $5
        AND session."userId" = $6 AND turn."userId" = $6 ORDER BY event."sequence" LIMIT 2`,
    [ids.sessionId, ids.turnId, taskId, taskGraphLifecycleKey(rootTaskId, nodeKey, task.attemptCount, "task.interrupted"),
      rootTaskId, ids.userId]),
  ])
  if (receiptResult.rows.length !== 1 || ackResult.rows.length !== 1) return null
  const receiptRow = receiptResult.rows[0], ack = ackResult.rows[0]
  const receipt = parseTaskGraphSupersededScoutRetirementReceipt(receiptRow.payload,
    { sessionId: ids.sessionId, turnId: ids.turnId, rootTaskId, taskId })
  const ackPayload = record(ack.payload), ackEvent = record(ackPayload?.event)
  if (!receipt || receipt.attempt !== task.attemptCount || receipt.replacementTaskId !== replacementTaskId
    || receiptRow.type !== TASK_GRAPH_SUPERSEDED_SCOUT_RETIREMENT_EVENT_TYPE || receiptRow.actor !== "system"
    || receiptRow.correlationId !== ids.turnId || receiptRow.itemId !== taskGraphItemId(rootTaskId)
    || receiptRow.taskId !== taskId || receiptRow.causationId !== receiptRow.actionStepId || receiptRow.hasOutbox !== false
    || ack.type !== "item.delta" || ack.actor !== "system" || ack.correlationId !== ids.turnId
    || ack.itemId !== taskGraphItemId(rootTaskId) || ack.taskId !== taskId || ack.causationId !== null
    || ack.hasOutbox !== true || ackPayload?.kind !== "lifecycle" || ackEvent?.type !== "task.interrupted"
    || BigInt(ack.sequence) <= BigInt(receiptRow.sequence)) return null
  return { receipt, task }
}
async function waitForSuccessiveDublinReclaim(rootTaskId, taskId, priorAttempt, timeoutMs = 90_000) {
  if (!Number.isSafeInteger(priorAttempt) || priorAttempt < 0) throw new Error("p3_successive_replan_prior_attempt_missing")
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const row = await successiveTaskRow(rootTaskId, taskId)
    if (row?.status === "running" && row.role === "scout" && row.attemptCount > priorAttempt
      && observedSuccessiveLeaseMatches(rootTaskId, row)
      && row.leaseExpiresAt instanceof Date && row.leaseExpiresAt.getTime() > Date.now()
      && row.interruptRequestedAt === null) return row
    await sleep(25)
  }
  emitSuccessiveRecoveryTrace()
  throw new Error("p3_successive_replan_dublin_not_reclaimed")
}
function successiveBerlinResultVerified(row, expectedJobId) {
  const result = record(row?.result), structured = record(result?.structuredResult)
  const candidates = Array.isArray(structured?.candidates) ? structured.candidates.map(record) : []
  const report = record(result?.taskGraphVerificationReport)
  const criteria = Array.isArray(report?.criteria) ? report.criteria.map(record) : []
  return row?.status === "completed" && row.role === "scout" && structured?.role === "scout"
    && candidates.length === 1 && candidates[0]?.jobId === expectedJobId
    && report?.verifierVersion === TASK_GRAPH_VERIFIER_VERSION && report.status === "passed"
    && report.reasonCode === "criteria_met" && /^[a-f0-9]{64}$/.test(String(report.evidenceDigest ?? ""))
    && criteria.length === 2 && ["candidate-count", "candidate-location"].every(id => criteria.some(criterion =>
      criterion?.criterionId === id && criterion.status === "passed" && criterion.reasonCode === "criteria_met"))
}
async function waitForSuccessiveBerlinVerified(rootTaskId, taskId, expectedJobId, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const row = await successiveTaskRow(rootTaskId, taskId)
    if (successiveBerlinResultVerified(row, expectedJobId)) return row
    if (row && ["failed", "interrupted", "cancelled", "closed"].includes(row.status)) {
      throw new Error("p3_successive_replan_berlin_child_not_verified")
    }
    await sleep(25)
  }
  throw new Error("p3_successive_replan_berlin_child_not_verified")
}
async function countSuccessiveBerlinPlans(rootTaskId) {
  const { rows } = await pool.query(`
    SELECT COUNT(*)::int AS "count" FROM "agent_items" AS call
    JOIN "agent_sessions" AS session ON session."id" = call."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = call."turnId" AND turn."sessionId" = call."sessionId"
    WHERE call."sessionId" = $1 AND call."turnId" = $2 AND call."taskId" = $3
      AND call."type" = 'tool_call' AND call."content"->>'toolName' = 'agent.plan'
      AND call."content"->'input'->'nodes' @> $4::jsonb AND turn."rootTaskId" = $3
      AND session."userId" = $5 AND turn."userId" = $5`,
  [ids.sessionId, ids.turnId, rootTaskId, JSON.stringify([{ key: successiveBerlinKey }]), ids.userId])
  return rows.length === 1 && (rows[0]?.count === 0 || rows[0]?.count === 1) ? rows[0].count : null
}
function successiveWaitArgs(key, taskIds) {
  return { idempotencyKey: key, taskIds, mode: "all", timeoutMs: 30_000 }
}
async function currentSuccessiveRootId() {
  if (typeof ids.rootTaskId === "string" && ids.rootTaskId) return ids.rootTaskId
  const { rows } = await pool.query(`
    SELECT turn."rootTaskId" FROM "agent_turns" AS turn
    JOIN "agent_sessions" AS session ON session."id" = turn."sessionId"
    WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3
      AND session."userId" = $3 AND turn."rootTaskId" IS NOT NULL LIMIT 2`,
  [ids.turnId, ids.sessionId, ids.userId])
  if (rows.length !== 1 || typeof rows[0]?.rootTaskId !== "string") throw new Error("p3_successive_replan_root_missing")
  return rows[0].rootTaskId
}
async function waitForSuccessiveRootId(timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { return await currentSuccessiveRootId() } catch { await sleep(25) }
  }
  throw new Error("p3_successive_replan_root_not_initialized")
}
function acceptedNodeTaskId(request, callId, nodeKey) {
  const result = record(latestToolResult(request, callId))
  if (result?.status !== "accepted" || !Array.isArray(result.nodes)) return null
  const matches = result.nodes.map(record).filter(node => node?.key === nodeKey)
  return matches.length === 1 && typeof matches[0]?.taskId === "string" ? matches[0].taskId : null
}
async function assertSuccessiveLiveTask(rootTaskId, node) {
  if (typeof node?.taskId !== "string") throw new Error("p3_successive_replan_task_missing")
  const row = await successiveTaskRow(rootTaskId, node.taskId)
  if (!row || row.status !== "running" || row.role !== "scout"
    || !observedSuccessiveLeaseMatches(rootTaskId, row)
    || !(row.leaseExpiresAt instanceof Date) || row.leaseExpiresAt.getTime() <= Date.now()
    || row.interruptRequestedAt !== null) throw new Error("p3_successive_replan_live_task_missing")
  return row
}
async function waitForSuccessiveInitialWait(rootTaskId, calls) {
  const state = await waitForSuccessiveSuspendedWait(rootTaskId, calls.initialWaitKey, [successiveSeattleKey])
  const seattle = state.nodes.find(node => node?.key === successiveSeattleKey)
  if (typeof seattle?.taskId !== "string") throw new Error("p3_successive_replan_seattle_task_missing")
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const row = await successiveTaskRow(rootTaskId, seattle.taskId)
    if (!row || row.role !== "scout") throw new Error("p3_successive_replan_seattle_ownership_invalid")
    if (row.status === "queued") {
      if (row.leaseOwner !== null || row.leaseExpiresAt !== null || row.interruptRequestedAt !== null) {
        throw new Error("p3_successive_replan_seattle_ownership_invalid")
      }
      await sleep(25)
      continue
    }
    if (row.status === "running" && !successiveChildLeases.has(seattle.taskId)) {
      await sleep(25)
      continue
    }
    if (row.status !== "running" || row.attemptCount < 1
      || !observedSuccessiveLeaseMatches(rootTaskId, row) || !(row.leaseExpiresAt instanceof Date)
      || row.leaseExpiresAt.getTime() <= Date.now() || row.interruptRequestedAt !== null) {
      throw new Error("p3_successive_replan_seattle_not_live")
    }
    if (!successiveSeattleSearchHeld) { await sleep(25); continue }
    say("P3_SUCCESSIVE_REPLAN_SEATTLE_WAITING " + JSON.stringify({
      planAccepted: true, waitSuspended: true, seattleLive: true,
    }))
    return
  }
  throw new Error("p3_successive_replan_seattle_not_live")
}
async function waitForSuccessiveFirstRetirement(rootTaskId, calls) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const state = await successiveWaitState(rootTaskId, calls.firstWaitKey)
    const graph = record(state?.content), nodes = Array.isArray(graph?.nodes) ? graph.nodes.map(record) : []
    const seattle = nodes.find(node => node?.key === successiveSeattleKey)
    const dublin = nodes.find(node => node?.key === successiveDublinKey)
    const [retirement, dublinRow] = seattle && dublin ? await Promise.all([
      readSuccessiveRetirement(rootTaskId, successiveSeattleKey, seattle.taskId, dublin.taskId, calls.retireSeattle),
      successiveTaskRow(rootTaskId, dublin.taskId),
    ]) : [null, null]
    if (state?.turnStatus === "waiting_for_dependency" && state.waitStatus === "waiting" && state.suspendedAt
      && nodes.length === 2 && retirement && dublinRow?.status === "running" && dublinRow.role === "scout"
      && observedSuccessiveLeaseMatches(rootTaskId, dublinRow)
      && dublinRow.leaseOwner && dublinRow.leaseExpiresAt instanceof Date && dublinRow.leaseExpiresAt.getTime() > Date.now()
      && dublinRow.interruptRequestedAt === null) {
      say("P3_SUCCESSIVE_REPLAN_FIRST_RETIREMENT " + JSON.stringify({
        receiptValid: true, sameAttemptAck: retirement.receipt.attempt === retirement.task.attemptCount,
        dublinLeaseLive: true, waitPending: true,
      }))
      return
    }
    await sleep(25)
  }
  throw new Error("p3_successive_replan_first_retirement_not_acknowledged")
}
async function successiveChildModel({ task }) {
  if (task.role !== "scout") throw new Error("p3_successive_replan_unexpected_child_role")
  const location = task.goal.includes("Seattle") ? "Seattle" : task.goal.includes("Dublin") ? "Dublin" : "Berlin"
  const expectedJobId = ids[location.toLowerCase() + "JobId"]
  if (typeof expectedJobId !== "string") throw new Error("p3_successive_replan_fixture_job_missing")
  const input = { target: "Software Engineer", location, limit: 10 }
  const callId = "p3-1248-search:" + task.id
  return { id: "p3-successive-replan-" + location.toLowerCase() + "-child-model", profile: modelProfile(),
    async *stream(request) {
      const receipt = latestToolResultForExactToolInput(request, "jobs.search", input)
      if (!receipt) {
        if (!request.tools.some(tool => record(tool)?.name === "jobs.search")) throw new Error("p3_successive_replan_search_tool_missing")
        yield toolCall(callId, "jobs.search", input)
        yield { type: "completed", finishReason: "tool_calls" }
        return
      }
      const search = record(receipt.result), jobs = Array.isArray(search?.jobs) ? search.jobs.map(record) : []
      const job = jobs.find(item => item?.id === expectedJobId)
      if (!job) throw new Error("p3_successive_replan_search_evidence_missing")
      if (location === "Seattle" || location === "Dublin") {
        successiveHeldChildren.add(task.id)
        if (location === "Seattle") successiveSeattleSearchHeld = true
        say("P3_SUCCESSIVE_REPLAN_CHILD_HELD " + JSON.stringify({ role: "scout", location: location.toLowerCase(), searchResultPresent: true }))
        await waitForCommand(location === "Seattle" ? "release-seattle-child" : "release-dublin")
      }
      const evidenceId = "read:job:" + expectedJobId
      const result = { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed",
        candidates: [{ jobId: expectedJobId, source: job.source ?? "greenhouse", url: null, evidenceIds: [evidenceId] }],
        evidence: [{ id: evidenceId, kind: "job", ref: expectedJobId, source: job.source ?? "greenhouse" }],
        summary: "Found the confirmed " + location + " fixture role" }
      yield { type: "text_delta", text: JSON.stringify(result) }
      yield { type: "completed", finishReason: "stop" }
    },
  }
}
function startSuccessiveReplanRuntime(ownerId, resume, calls) {
  let initialWaitIssued = false, dublinPlanIssued = false, seattleRetirementIssued = false
  let dublinStartedObserved = false, dublinRefreshIssued = false, dublinGraphRefreshVerified = false
  let firstRetirementWaitIssued = false, berlinInspectionIssued = false, berlinPlanIssued = false
  let berlinRefreshIssued = false, dublinRetirementIssued = false, finalWaitIssued = false, finalListIssued = false
  let dublinReclaimAttempt
  return createCanonicalTurnRuntime(pool, {
    workerId: ownerId, productionFlags: flags(), taskGraphCommandPort: createPgTaskGraphCommandPort(pool),
    taskGraphTemplates: TASK_GRAPH_TEMPLATES, authorizeUsage: async () => noReservationUsageAuthorization(),
    modelRuntimeFactory() {
      return { adapter: {
        id: resume ? "p3-1248-successive-resume-model" : "p3-1248-successive-first-model", profile: modelProfile(),
        async *stream(request) {
          const facts = successiveRequestFacts(request), graph = facts.graph, nodes = facts.nodes
          const seattle = nodes.find(node => node?.key === successiveSeattleKey)
          const dublin = nodes.find(node => node?.key === successiveDublinKey)
          const berlin = nodes.find(node => node?.key === successiveBerlinKey)
          const rootTaskId = await waitForSuccessiveRootId()
          if (!resume) {
            if (!seattle) {
              if (!request.tools.some(tool => record(tool)?.name === "agent.plan")) throw new Error("p3_successive_replan_initial_plan_missing")
              yield toolCall(calls.seattlePlan, "agent.plan", { expectedRevision: 0,
                nodes: [successiveLocationNode(successiveSeattleKey, "Seattle")] })
              yield { type: "completed", finishReason: "tool_calls" }; return
            }
            if (!initialWaitIssued && !dublin) {
              const seattleTaskId = acceptedNodeTaskId(request, calls.seattlePlan, successiveSeattleKey) ?? seattle.taskId
              if (typeof seattleTaskId !== "string" || typeof graph?.revision !== "number") throw new Error("p3_successive_replan_initial_receipt_missing")
              initialWaitIssued = true
              yield toolCall(calls.seattleWait, "agent.wait", successiveWaitArgs(calls.initialWaitKey, [seattleTaskId]))
              yield { type: "completed", finishReason: "tool_calls" }; return
            }
            if (!dublinPlanIssued && !dublin) {
              if (!/dublin/i.test(facts.text) || !seattle || !request.tools.some(tool => record(tool)?.name === "agent.plan")
                || typeof graph?.revision !== "number") throw new Error("p3_successive_replan_dublin_scope_missing")
              dublinPlanIssued = true
              yield toolCall(calls.dublinPlan, "agent.plan", { expectedRevision: graph.revision,
                nodes: [successiveLocationNode(successiveDublinKey, "Dublin")] })
              yield { type: "completed", finishReason: "tool_calls" }; return
            }
            if (dublin && !seattleRetirementIssued) {
              const dublinTaskId = acceptedNodeTaskId(request, calls.dublinPlan, successiveDublinKey) ?? dublin.taskId
              const plan = record(latestToolResult(request, calls.dublinPlan))
              const acceptedNodes = Array.isArray(plan?.nodes) ? plan.nodes.map(record) : []
              const acceptedDublin = acceptedNodes.find(node => node?.key === successiveDublinKey)
              await assertSuccessiveLiveTask(rootTaskId, seattle)
              if (plan?.status !== "accepted" || typeof plan.revision !== "number"
                || dublinTaskId !== dublin.taskId || acceptedDublin?.taskId !== dublinTaskId
                || typeof graph?.revision !== "number") throw new Error("p3_successive_replan_dublin_plan_receipt_invalid")
              if (!dublinRefreshIssued) {
                await waitForSuccessiveTaskStarted(rootTaskId, dublinTaskId, successiveDublinKey)
                dublinStartedObserved = true
                await waitForSuccessiveChildBoundary(dublinTaskId)
                if (!request.tools.some(tool => record(tool)?.name === "agent.list")) {
                  throw new Error("p3_successive_replan_dublin_refresh_tool_missing")
                }
                dublinRefreshIssued = true
                yield toolCall(calls.dublinRefresh, "agent.list", { includeTerminal: true })
                yield { type: "completed", finishReason: "tool_calls" }; return
              }
              const listing = record(latestToolResult(request, calls.dublinRefresh))
              const listed = Array.isArray(listing?.tasks) ? listing.tasks.map(record) : []
              const persistedRevision = await successiveGraphRevision(rootTaskId)
              const dublinRunning = listed.filter(task => task?.taskId === dublinTaskId && task.status === "running").length === 1
              const seattleRunning = listed.filter(task => task?.taskId === seattle.taskId && task.status === "running").length === 1
              dublinGraphRefreshVerified = Boolean(listing && dublinStartedObserved && dublinRunning && seattleRunning
                && typeof graph.revision === "number" && graph.revision === persistedRevision && graph.revision > plan.revision)
              if (!dublinGraphRefreshVerified || !request.tools.some(tool => record(tool)?.name === "agent.retire_superseded_scout")) {
                throw new Error("p3_successive_replan_dublin_refresh_invalid")
              }
              say("P3_SUCCESSIVE_REPLAN_DUBLIN_REFRESHED " + JSON.stringify({
                planAccepted: true, startLifecycleObserved: dublinStartedObserved,
                childClaimedBeforeModel: successiveClaimedBeforeModel.has(dublinTaskId),
                listShowsBothRunning: true, graphRevisionMatches: true, graphRevisionAdvanced: true,
              }))
              seattleRetirementIssued = true
              yield toolCall(calls.retireSeattle, "agent.retire_superseded_scout", {
                expectedRevision: graph.revision, taskId: seattle.taskId,
              })
              yield { type: "completed", finishReason: "tool_calls" }; return
            }
            if (seattleRetirementIssued && !firstRetirementWaitIssued) {
              const result = record(latestToolResult(request, calls.retireSeattle))
              if (result?.status !== "interrupt_requested" || result.taskId !== seattle?.taskId
                || !dublinStartedObserved || !dublinGraphRefreshVerified
                || !request.tools.some(tool => record(tool)?.name === "agent.wait")) {
                throw new Error("p3_successive_replan_seattle_retirement_result_missing")
              }
              say("P3_SUCCESSIVE_REPLAN_SEATTLE_INTERRUPT_REQUESTED " + JSON.stringify({ replacementAccepted: true, interruptRequested: true,
                dublinStartedObserved, dublinGraphRefreshVerified,
                rootLeaseMatchesProcess: await requireSuccessiveRootLeaseMatchesProcess(rootTaskId) }))
              await waitForCommand("release-seattle")
              if (typeof dublin?.taskId !== "string") throw new Error("p3_successive_replan_dublin_task_missing")
              firstRetirementWaitIssued = true
              yield toolCall(calls.firstWait, "agent.wait", successiveWaitArgs(calls.firstWaitKey, [seattle.taskId, dublin.taskId]))
              yield { type: "completed", finishReason: "tool_calls" }; return
            }
            if (firstRetirementWaitIssued && !berlinInspectionIssued) {
              say("P3_SUCCESSIVE_REPLAN_BERLIN_REQUEST " + JSON.stringify({ requestEntered: true,
                freshSteeringCuePresent: facts.freshSteeringCuePresent, berlinScopePresent: facts.berlinScopePresent,
                listToolAvailable: request.tools.some(tool => record(tool)?.name === "agent.list") }))
              if (!facts.freshSteeringCuePresent || !facts.berlinScopePresent || !request.tools.some(tool => record(tool)?.name === "agent.list")) {
                throw new Error("p3_successive_replan_berlin_inspection_context_missing")
              }
              berlinInspectionIssued = true
              yield toolCall(calls.berlinInspect, "agent.list", { includeTerminal: true })
              yield { type: "completed", finishReason: "tool_calls" }; return
            }
            if (berlinInspectionIssued) {
              const listing = record(latestToolResult(request, calls.berlinInspect))
              const listed = Array.isArray(listing?.tasks) ? listing.tasks.map(record) : []
              const prior = await readSuccessiveRetirement(rootTaskId, successiveSeattleKey, seattle?.taskId,
                dublin?.taskId, calls.retireSeattle)
              const planCount = await countSuccessiveBerlinPlans(rootTaskId)
              const seattleInterrupted = listed.some(task => task?.taskId === seattle?.taskId && task.status === "interrupted")
              const dublinRunning = listed.some(task => task?.taskId === dublin?.taskId && task.status === "running")
              say("P3_SUCCESSIVE_REPLAN_BERLIN_LIST_PROOF " + JSON.stringify({ listResultPresent: Boolean(listing),
                seattleInterrupted, dublinRunning, unresolvedSteeringCuePresent: facts.unresolvedSteeringCuePresent,
                berlinScopePresent: facts.berlinScopePresent, priorRetirementPresent: Boolean(prior),
                noBerlinPlanYet: planCount === 0 }))
              if (!listing || !seattleInterrupted || !dublinRunning
                || !facts.unresolvedSteeringCuePresent || !facts.berlinScopePresent || !prior || planCount !== 0) {
                throw new Error("p3_successive_replan_crash_cut_proof_invalid")
              }
              say("P3_SUCCESSIVE_REPLAN_CRASH_CUT " + JSON.stringify({
                inspectResultValid: true, steerConsumed: true,
                unresolvedSteeringCuePresent: facts.unresolvedSteeringCuePresent, berlinScopePresent: true,
                priorRetirementPresent: true, acceptedBerlinPlanCount: 0,
                rootLeaseMatchesProcess: await requireSuccessiveRootLeaseMatchesProcess(rootTaskId),
              }))
              await waitForCommand("continue-after-consumed-steer")
              throw new Error("p3_successive_replan_crash_cut_not_killed")
            }
            throw new Error("p3_successive_replan_first_worker_state_invalid")
          }
          if (!berlinPlanIssued && !berlin) {
            const prior = seattle && dublin ? await readSuccessiveRetirement(rootTaskId, successiveSeattleKey,
              seattle.taskId, dublin.taskId, calls.retireSeattle) : null
            const planCount = await countSuccessiveBerlinPlans(rootTaskId)
            if (!seattle || !dublin || !facts.unresolvedSteeringCuePresent || !facts.berlinScopePresent || !prior
              || planCount !== 0 || typeof graph?.revision !== "number"
              || !request.tools.some(tool => record(tool)?.name === "agent.plan")) {
              throw new Error("p3_successive_replan_resume_context_invalid")
            }
            say("P3_SUCCESSIVE_REPLAN_CONTEXT " + JSON.stringify({
              unresolvedSteeringCuePresent: facts.unresolvedSteeringCuePresent,
              berlinScopePresent: true, priorRetirementPresent: true, planToolAvailable: true,
              rootLeaseMatchesProcess: await requireSuccessiveRootLeaseMatchesProcess(rootTaskId),
            }))
            berlinPlanIssued = true
            yield toolCall(calls.berlinPlan, "agent.plan", { expectedRevision: graph.revision,
              nodes: [successiveLocationNode(successiveBerlinKey, "Berlin")] })
            yield { type: "completed", finishReason: "tool_calls" }; return
          }
          if (berlin && !dublinRetirementIssued) {
            const plan = record(latestToolResult(request, calls.berlinPlan))
            const berlinTaskId = acceptedNodeTaskId(request, calls.berlinPlan, successiveBerlinKey) ?? berlin.taskId
            const planCount = await countSuccessiveBerlinPlans(rootTaskId)
            if (plan?.status !== "accepted" || typeof plan.revision !== "number"
              || typeof berlinTaskId !== "string" || berlinTaskId !== berlin.taskId || typeof dublin?.taskId !== "string"
              || planCount !== 1 || typeof graph?.revision !== "number"
              || !request.tools.some(tool => record(tool)?.name === "agent.retire_superseded_scout")) {
              throw new Error("p3_successive_replan_berlin_plan_receipt_invalid")
            }
            if (!berlinRefreshIssued) {
              say("P3_SUCCESSIVE_REPLAN_PLAN_ACCEPTED " + JSON.stringify({
                accepted: true, berlinNodePresent: true, acceptedPlanCount: 1,
                rootLeaseMatchesProcess: await requireSuccessiveRootLeaseMatchesProcess(rootTaskId),
              }))
              const dublinLease = await waitForSuccessiveDublinReclaim(rootTaskId, dublin?.taskId, ids.dublinAttemptBeforeRestart)
              dublinReclaimAttempt = dublinLease.attemptCount
              await waitForSuccessiveChildSearchHeld(dublin?.taskId)
              const activeDublin = await successiveTaskRow(rootTaskId, dublin?.taskId)
              const verifiedBerlin = await waitForSuccessiveBerlinVerified(rootTaskId, berlinTaskId, ids.berlinJobId)
              if (!activeDublin || activeDublin.status !== "running" || activeDublin.role !== "scout"
                || activeDublin.attemptCount !== dublinLease.attemptCount
                || !observedSuccessiveLeaseMatches(rootTaskId, activeDublin)
                || !(activeDublin.leaseExpiresAt instanceof Date) || activeDublin.leaseExpiresAt.getTime() <= Date.now()
                || activeDublin.interruptRequestedAt !== null || !successiveBerlinResultVerified(verifiedBerlin, ids.berlinJobId)
                || !request.tools.some(tool => record(tool)?.name === "agent.list")) {
                throw new Error("p3_successive_replan_children_not_stable_for_refresh")
              }
              berlinRefreshIssued = true
              yield toolCall(calls.berlinRefresh, "agent.list", { includeTerminal: true })
              yield { type: "completed", finishReason: "tool_calls" }; return
            }
            const listing = record(latestToolResult(request, calls.berlinRefresh))
            const listed = Array.isArray(listing?.tasks) ? listing.tasks.map(record) : []
            const persistedRevision = await successiveGraphRevision(rootTaskId)
            const activeDublin = await successiveTaskRow(rootTaskId, dublin?.taskId)
            const verifiedBerlin = await successiveTaskRow(rootTaskId, berlinTaskId)
            const dublinListed = listed.filter(task => task?.taskId === dublin?.taskId && task.status === "running").length === 1
            const berlinListed = listed.filter(task => task?.taskId === berlinTaskId && task.status === "completed").length === 1
            if (!listing || !dublinListed || !berlinListed || !activeDublin || activeDublin.status !== "running"
              || !Number.isSafeInteger(dublinReclaimAttempt) || activeDublin.attemptCount !== dublinReclaimAttempt
              || !observedSuccessiveLeaseMatches(rootTaskId, activeDublin)
              || !(activeDublin.leaseExpiresAt instanceof Date) || activeDublin.leaseExpiresAt.getTime() <= Date.now()
              || activeDublin.interruptRequestedAt !== null || !successiveBerlinResultVerified(verifiedBerlin, ids.berlinJobId)
              || typeof graph.revision !== "number" || graph.revision !== persistedRevision || graph.revision <= plan.revision
              || berlin.status !== "completed" || dublin.status !== "running") {
              throw new Error("p3_successive_replan_berlin_refresh_invalid")
            }
            say("P3_SUCCESSIVE_REPLAN_BERLIN_REFRESHED " + JSON.stringify({ listResultPresent: true,
              dublinSearchHeld: true, dublinRunning: true, berlinVerified: true,
              graphRevisionMatches: true, graphRevisionAdvanced: true }))
            dublinRetirementIssued = true
            yield toolCall(calls.retireDublin, "agent.retire_superseded_scout", {
              expectedRevision: graph.revision, taskId: dublin.taskId,
            })
            yield { type: "completed", finishReason: "tool_calls" }; return
          }
          if (dublinRetirementIssued && !finalWaitIssued) {
            const retirement = record(latestToolResult(request, calls.retireDublin))
            const dublinRow = await successiveTaskRow(rootTaskId, dublin?.taskId)
            if (retirement?.status !== "interrupt_requested" || retirement.taskId !== dublin?.taskId
              || !dublinRow || dublinRow.status !== "running" || dublinRow.interruptRequestedAt === null
              || !request.tools.some(tool => record(tool)?.name === "agent.wait")) {
              throw new Error("p3_successive_replan_dublin_retirement_result_invalid")
            }
            say("P3_SUCCESSIVE_REPLAN_DUBLIN_INTERRUPT_REQUESTED " + JSON.stringify({ interruptRequested: true, liveLeaseBound: true,
              rootLeaseMatchesProcess: await requireSuccessiveRootLeaseMatchesProcess(rootTaskId) }))
            finalWaitIssued = true
            yield toolCall(calls.finalWait, "agent.wait", successiveWaitArgs(calls.finalWaitKey, [dublin.taskId, berlin.taskId]))
            yield { type: "completed", finishReason: "tool_calls" }; return
          }
          if (finalWaitIssued && !finalListIssued) {
            const outcome = record(latestToolResult(request, calls.finalWait))
            const tasks = Array.isArray(outcome?.tasks) ? outcome.tasks.map(record) : []
            if (outcome?.status !== "ready" || !tasks.some(task => task?.taskId === dublin?.taskId && task.status === "interrupted")
              || !tasks.some(task => task?.taskId === berlin?.taskId && task.status === "completed")
              || !request.tools.some(tool => record(tool)?.name === "agent.list")) {
              throw new Error("p3_successive_replan_final_wait_invalid")
            }
            finalListIssued = true
            yield toolCall(calls.finalList, "agent.list", { includeTerminal: true })
            yield { type: "completed", finishReason: "tool_calls" }; return
          }
          if (finalListIssued) {
            const listing = record(latestToolResult(request, calls.finalList))
            const tasks = Array.isArray(listing?.tasks) ? listing.tasks.map(record) : []
            if (!tasks.some(task => task?.taskId === seattle?.taskId && task.status === "interrupted")
              || !tasks.some(task => task?.taskId === dublin?.taskId && task.status === "interrupted")
              || !tasks.some(task => task?.taskId === berlin?.taskId && task.status === "completed")) {
              throw new Error("p3_successive_replan_final_list_invalid")
            }
            yield { type: "text_delta", text: JSON.stringify({ schemaVersion: "agent-harness.v2.final",
              response: "The confirmed Berlin search is complete." }) }
            yield { type: "completed", finishReason: "stop" }; return
          }
          throw new Error("p3_successive_replan_resume_state_invalid")
        },
      }, registry: {}, candidates: [] }
    },
  })
}
async function waitForSuccessiveTurnCompletion(rootTaskId, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const [{ rows: turns }, { rows: graphs }] = await Promise.all([
      pool.query(`
        SELECT turn."status" FROM "agent_turns" AS turn
        JOIN "agent_sessions" AS session ON session."id" = turn."sessionId"
        WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3
          AND session."userId" = $3 AND turn."rootTaskId" = $4 LIMIT 2`,
      [ids.turnId, ids.sessionId, ids.userId, rootTaskId]),
      pool.query(`
        SELECT graph."content" FROM "agent_items" AS graph
        JOIN "agent_sessions" AS session ON session."id" = graph."sessionId"
        JOIN "agent_turns" AS turn ON turn."id" = graph."turnId" AND turn."sessionId" = graph."sessionId"
        WHERE graph."id" = $1 AND graph."taskId" = $2 AND graph."sessionId" = $3 AND graph."turnId" = $4
          AND graph."type" = 'task_graph' AND session."userId" = $5 AND turn."userId" = $5
          AND turn."rootTaskId" = $2 LIMIT 2`,
      [taskGraphItemId(rootTaskId), rootTaskId, ids.sessionId, ids.turnId, ids.userId]),
    ])
    if (turns.length === 1 && graphs.length === 1 && turns[0]?.status === "completed") {
      const graph = record(graphs[0]?.content), nodes = Array.isArray(graph?.nodes) ? graph.nodes.map(record) : []
      const byKey = new Map(nodes.map(node => [node?.key, node]))
      const seattle = byKey.get(successiveSeattleKey), dublin = byKey.get(successiveDublinKey)
      const berlin = byKey.get(successiveBerlinKey)
      const marker = { turnCompleted: true, berlinResultValid: berlin?.status === "completed",
        retiredNodeCount: [seattle, dublin].filter(node => node?.status === "interrupted").length,
        currentNodeCount: nodes.filter(node => node?.status === "completed").length }
      say("P3_SUCCESSIVE_REPLAN_FINAL " + JSON.stringify(marker))
      if (marker.berlinResultValid && marker.retiredNodeCount === 2 && marker.currentNodeCount === 1) return
      throw new Error("p3_successive_replan_final_graph_invalid")
    }
    await sleep(25)
  }
  throw new Error("p3_successive_replan_turn_not_completed")
}
async function runSuccessiveReplanWorker(resume) {
  if (resume) armSuccessiveRecoveryTrace()
  const ownerId = "p3-process-restart-successive-worker-" + process.pid
  const calls = successiveWaitIds(ids)
  const runtime = await startSuccessiveReplanRuntime(ownerId, resume, calls)
  const executeTurn = runtime.execute
  runtime.execute = input => {
    const lease = input?.lease
    if (lease?.turnId === ids.turnId && lease.sessionId === ids.sessionId && lease.userId === ids.userId
      && typeof lease.ownerId === "string" && Number.isSafeInteger(lease.leaseVersion) && lease.leaseVersion > 0) {
      successiveRootLease = { turnId: lease.turnId, sessionId: lease.sessionId, userId: lease.userId,
        ownerId: lease.ownerId, leaseVersion: lease.leaseVersion }
    }
    return executeTurn(input)
  }
  const childExecutor = createProductionChildExecutor({
    pool, authorizeUsage: async () => noReservationUsageAuthorization(),
    modelRuntimeFactory: successiveChildModel,
  })
  const { createProductionWorkerBootstrap } = await import("../../queue/production-bootstrap.ts")
  bootstrap = await createProductionWorkerBootstrap({
    pool, runtime, ownerId, turnRecoveryIntervalMs: 10,
    waitResolver: { intervalMs: 10, ownerId: "p3-process-restart-successive-resolver-" + process.pid },
    subagents: { intervalMs: 10, async execute({ lease }) { return executeSuccessiveChild({ lease }, childExecutor) } },
  })
  const rootTaskId = await waitForSuccessiveRootId()
  if (resume) await waitForSuccessiveTurnCompletion(rootTaskId)
  else {
    await waitForSuccessiveInitialWait(rootTaskId, calls)
    await waitForSuccessiveFirstRetirement(rootTaskId, calls)
  }
  await waitForStop()
}
async function createArchivedWaitChildren(rootTaskId) {
  const store = new PgSubagentTaskStore(pool), policy = defaultSubagentPolicy(), taskIds = []
  for (let index = 0; index < 7; index++) {
    const childProgress = index + 1
    archivedWaitChildProgress = childProgress
    archivedWaitProgress("child_create_started", childProgress)
    let task
    try {
      task = await store.create({
        userId: ids.userId, sessionId: ids.sessionId, turnId: ids.turnId, parentTaskId: rootTaskId,
        role: "auditor", taskType: "research", goal: `Inspect archived wait fixture ${childProgress}`,
        allowedActions: [], expectedOutputSchema: {}, policy,
      })
    } catch (error) {
      archivedWaitProgress("child_create_failed", childProgress, archivedWaitFailureKind(error))
      throw error
    }
    taskIds.push(task.id)
    archivedWaitProgress("child_created", childProgress)
    if (index < 6) {
      const childOwner = `p3-archived-wait-child-${process.pid}-${index + 1}`
      archivedWaitProgress("child_claim_started", childProgress)
      let lease
      try { lease = await store.claim({ taskId: task.id, sessionId: ids.sessionId, ownerId: childOwner, policy, now: new Date() }) }
      catch (error) {
        archivedWaitProgress("child_claim_failed", childProgress, archivedWaitFailureKind(error))
        throw error
      }
      if (!lease) {
        archivedWaitProgress("child_claim_failed", childProgress, "error")
        throw new Error("p3_archived_wait_child_claim_missing")
      }
      archivedWaitProgress("child_claimed", childProgress)
      archivedWaitProgress("child_finish_started", childProgress)
      let status
      try {
        status = await store.finish({
          taskId: task.id, sessionId: ids.sessionId, ownerId: childOwner, attemptCount: lease.attemptCount,
          status: "completed", result: { summary: `bounded fixture result ${childProgress} ${"x".repeat(1_400)}` }, now: new Date(),
        })
      } catch (error) {
        archivedWaitProgress("child_finish_failed", childProgress, archivedWaitFailureKind(error))
        throw error
      }
      if (status !== "completed") {
        archivedWaitProgress("child_finish_failed", childProgress, "error")
        throw new Error("p3_archived_wait_child_finish_missing")
      }
      archivedWaitProgress("child_finished", childProgress)
    } else archivedWaitProgress("child_pending", childProgress)
  }
  return taskIds
}
async function startArchivedWaitRuntime(workerOwnerId, resume) {
  let barrierReached = false, rounds = 0
  return createCanonicalTurnRuntime(pool, {
    workerId: workerOwnerId,
    productionFlags: { ...flags(), taskGraphPlanningEnabled: false },
    authorizeUsage: async () => noReservationUsageAuthorization(),
    turnEngineStoreFactory(database, terminalGuard) {
      const base = createPgTurnEngineStore(database, terminalGuard)
      return new Proxy(base, { get(target, property, receiver) {
        if (property === "updateStep") return async input => {
          if (!resume && !barrierReached && input.owner.kind === "turn" && input.owner.turnId === ids.turnId
            && input.status === "waiting_for_tool") {
            barrierReached = true
            say("P3_ARCHIVED_WAIT_STEP_CLOSE_BARRIER")
            await waitForCommand("release-archived-wait-step-close")
          }
          return target.updateStep(input)
        }
        const value = Reflect.get(target, property, receiver)
        return typeof value === "function" ? value.bind(target) : value
      } })
    },
    modelRuntimeFactory() {
      const adapter = {
        id: resume ? "p3-archived-wait-resume-model" : "p3-archived-wait-first-model",
        profile: modelProfile(),
        async *stream(request) {
          rounds++
          if (!resume) archivedWaitProgress("model_stream_entered", rounds)
          if (!resume) {
            if (rounds !== 1) throw new Error("p3_archived_wait_unexpected_first_model_round")
            if (!request.tools.some(tool => record(tool)?.name === "agent.wait")
              || !request.tools.some(tool => record(tool)?.name === "agent.list")) {
              throw new Error("p3_archived_wait_fixture_tools_missing")
            }
            archivedWaitProgress("tools_validated", rounds)
            const rootTaskId = record(request?.metadata)?.taskId
            if (typeof rootTaskId !== "string" || !rootTaskId) throw new Error("p3_archived_wait_root_identity_missing")
            archivedWaitProgress("root_identity_validated", rounds)
            const taskIds = await createArchivedWaitChildren(rootTaskId)
            say("P3_ARCHIVED_WAIT_TASKS_CREATED " + JSON.stringify({ rootTaskId, taskIds }))
            archivedWaitProgress("wait_call_emitted", taskIds.length)
            yield toolCall(archivedWaitCallId, "agent.wait", {
              idempotencyKey: `p3-process-archived-wait:${ids.turnId}`, taskIds, mode: "all", timeoutMs: 30_000,
            })
            yield toolCall("p3-process-archived-wait-unexecuted-tail", "agent.list", { includeTerminal: true })
            yield { type: "usage", inputTokens: 23, outputTokens: 11, estimatedCostUsd: 0.004 }
            yield { type: "completed", finishReason: "tool_calls" }
            return
          }
          const expected = Array.isArray(ids.taskIds) ? ids.taskIds : []
          if (expected.length !== 7 || expected.some(taskId => typeof taskId !== "string" || !taskId)
            || new Set(expected).size !== expected.length || typeof ids.waitId !== "string" || !ids.waitId) {
            throw new Error("p3_archived_wait_fixture_resume_identity_invalid")
          }
          const outcome = waitOutcomeFromRequest(request, value => value.waitId === ids.waitId && value.status === "ready"
            && Array.isArray(value.targetTaskIds) && value.targetTaskIds.length === expected.length
            && expected.every(taskId => value.targetTaskIds.includes(taskId))
            && Array.isArray(value.matchedTaskIds) && value.matchedTaskIds.length === expected.length
            && expected.every(taskId => value.matchedTaskIds.includes(taskId))
            && Array.isArray(value.tasks) && value.tasks.length === expected.length
            && value.tasks.every(task => record(task)?.status === "completed"))
          say("P3_ARCHIVED_WAIT_READY_OUTCOME_SEEN " + JSON.stringify({ status: outcome.status, targetCount: expected.length, matchedCount: outcome.matchedTaskIds.length }))
          if (rounds === 1) {
            if (!request.tools.some(tool => record(tool)?.name === "agent.list")) throw new Error("p3_archived_wait_fresh_list_tool_missing")
            yield toolCall(archivedWaitFreshListCallId, "agent.list", {})
            yield { type: "usage", inputTokens: 5, outputTokens: 2, estimatedCostUsd: 0.0002 }
            yield { type: "completed", finishReason: "tool_calls" }
            return
          }
          if (rounds !== 2) throw new Error("p3_archived_wait_unexpected_resume_model_round")
          const listResults = request.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
            .filter(part => part.type === "tool_result" && part.toolUseId === archivedWaitFreshListCallId)
          if (listResults.length !== 1 || typeof listResults[0]?.content !== "string") {
            throw new Error("p3_archived_wait_fresh_list_result_missing")
          }
          let listed
          try { listed = record(JSON.parse(listResults[0].content)) } catch { listed = null }
          if (!listed || !Array.isArray(listed.tasks) || listed.tasks.length !== 0) {
            throw new Error("p3_archived_wait_fresh_list_result_invalid")
          }
          yield { type: "text_delta", text: archivedWaitFinalMarker }
          yield { type: "usage", inputTokens: 9, outputTokens: 4, estimatedCostUsd: 0.001 }
          yield { type: "completed", finishReason: "stop" }
        },
      }
      return {
        adapter: resume ? adapter : captureModelStreamFailure(adapter, error => {
          archivedWaitProgress("model_stream_failed", archivedWaitChildProgress, archivedWaitFailureKind(error))
        }),
        registry: {}, candidates: [],
      }
    },
  })
}
async function waitForStop() {
  await waitForCommand("shutdown"); process.stdin.off("data", onStdinData); process.stdin.pause(); process.stdin.destroy()
}
function pausedArchivedWaitSubagentQueueFactory(queueName, connection, pollingOptions) {
  return options => {
    const queue = options.queue ?? new Queue(queueName, { connection, skipVersionCheck: true })
    const worker = new Worker(queueName, async () => {
      throw new Error("p3_archived_wait_fixture_child_must_not_run")
    }, { connection, skipVersionCheck: true, ...pollingOptions(), concurrency: 8, autorun: false })
    return { queue, worker, async close() { await worker.close(); if (!options.queue) await queue.close() } }
  }
}
async function runArchivedWaitFirstWorker() {
  const ownerId = `p3-archived-wait-worker-${process.pid}`, runtime = await startArchivedWaitRuntime(ownerId, false)
  const [{ createProductionWorkerBootstrap }, { SUBAGENT_QUEUE_NAME }, { redisConnection }, { workerPollingOptions }] = await Promise.all([
    import("../../queue/production-bootstrap.ts"), import("../../queue/subagent-queue.ts"),
    import("../../redis.ts"), import("../../queue/worker-polling-options.ts"),
  ])
  bootstrap = await createProductionWorkerBootstrap({ pool, runtime, ownerId, turnRecoveryIntervalMs: 10,
    waitResolver: { intervalMs: 10, ownerId: `p3-archived-wait-resolver-${process.pid}` },
    subagents: { intervalMs: 10, queueFactory: pausedArchivedWaitSubagentQueueFactory(SUBAGENT_QUEUE_NAME, redisConnection, workerPollingOptions),
      async execute() { throw new Error("p3_archived_wait_fixture_child_must_not_run") } } })
  const activated = await pool.query(`UPDATE "agent_turns" SET "status" = 'queued', "completedAt" = NULL,
      "leaseOwnerId" = NULL, "leaseExpiresAt" = NULL, "leaseStartedAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "status" = 'waiting_for_user'`, [ids.turnId, ids.sessionId, ids.userId])
  if (activated.rowCount !== 1) throw new Error("p3_archived_wait_turn_not_parked")
  const { enqueueTurn } = await import("../turns/turn-queue.ts")
  await enqueueTurn(pool, bootstrap.turns.queue, { turnId: ids.turnId, sessionId: ids.sessionId, ownerId })
  say("P3_ARCHIVED_WAIT_FIRST_WORKER_READY " + ownerId)
  await waitForStop()
}
async function runArchivedWaitResumeWorker() {
  const ownerId = `p3-archived-wait-resume-worker-${process.pid}`, runtime = await startArchivedWaitRuntime(ownerId, true)
  const [{ createProductionWorkerBootstrap }, { SUBAGENT_QUEUE_NAME }, { redisConnection }, { workerPollingOptions }] = await Promise.all([
    import("../../queue/production-bootstrap.ts"), import("../../queue/subagent-queue.ts"),
    import("../../redis.ts"), import("../../queue/worker-polling-options.ts"),
  ])
  bootstrap = await createProductionWorkerBootstrap({ pool, runtime, ownerId, turnRecoveryIntervalMs: 10,
    waitResolver: { intervalMs: 10, ownerId: `p3-archived-wait-resolver-${process.pid}` },
    subagents: { intervalMs: 10, queueFactory: pausedArchivedWaitSubagentQueueFactory(SUBAGENT_QUEUE_NAME, redisConnection, workerPollingOptions),
      async execute() { throw new Error("p3_archived_wait_fixture_child_must_not_run") } } })
  say("P3_ARCHIVED_WAIT_RESUME_WORKER_READY " + ownerId)
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const status = await pool.query(`SELECT "status" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`,
      [ids.turnId, ids.sessionId, ids.userId])
    if (status.rows[0]?.status === "completed") {
      say("P3_ARCHIVED_WAIT_TURN_COMPLETED")
      break
    }
    await sleep(20)
  }
  await waitForStop()
}
async function runFirstWorker() {
  say("P3_FIRST_WORKER_START_RUNTIME_BEGIN")
  const ownerId = "p3-process-restart-worker-" + process.pid, runtime = await startRuntime(ownerId, false)
  say("P3_FIRST_WORKER_START_RUNTIME_DONE")
  const { createProductionWorkerBootstrap } = await import("../../queue/production-bootstrap.ts")
  bootstrap = await createProductionWorkerBootstrap({ pool, runtime, ownerId, turnRecoveryIntervalMs: 10,
    waitResolver: { intervalMs: 10, ownerId: "p3-process-restart-wait-resolver-" + process.pid },
    subagents: { intervalMs: 10, async execute() { throw new Error("p3_first_worker_must_not_execute_children") } } })
  say("P3_FIRST_WORKER_BOOTSTRAP_DONE")
  const subagentWorker = bootstrap.subagents?.queue?.worker
  if (typeof subagentWorker?.pause !== "function") throw new Error("p3_first_worker_subagent_pause_unavailable")
  await subagentWorker.pause()
  say("P3_FIRST_WORKER_PAUSE_DONE")
  await startSelectedJobQueueWorker(runtime)
  const activated = await pool.query(`UPDATE "agent_turns" SET "status" = 'queued', "completedAt" = NULL,
      "leaseOwnerId" = NULL, "leaseExpiresAt" = NULL, "leaseStartedAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "status" = 'waiting_for_user'`, [ids.turnId, ids.sessionId, ids.userId])
  if (activated.rowCount !== 1) throw new Error("p3_first_worker_fixture_turn_not_parked")
  say("P3_FIRST_WORKER_TURN_ACTIVATED")
  const { enqueueTurn } = await import("../turns/turn-queue.ts")
  await enqueueTurn(pool, bootstrap.turns.queue, { turnId: ids.turnId, sessionId: ids.sessionId, ownerId })
  say("P3_FIRST_WORKER_ENQUEUE_DONE")
  await waitForParentSuspended(ownerId); await waitForStop()
}
async function runSecondWorker() {
  assertNoPrivateArtifactFixtureData(ids)
  const ownerId = "p3-process-restart-worker-" + process.pid, runtime = await startRuntime(ownerId, true)
  const { createProductionChildExecutor } = await import("./production-child-runtime.ts")
  const executeChild = createProductionChildExecutor({
    pool, authorizeUsage: async () => noReservationUsageAuthorization(),
    modelRuntimeFactory({ task }) {
      emitChildRuntimeScopeDiagnostic({ phase: "model", sessionId: task.sessionId, turnId: task.turnId,
        userId: task.userId, taskUserId: task.userId, leaseTaskId: task.id })
      let rounds = 0
      const callId = `p3-process-restart-read:${task.id}:${task.attemptCount}:415-555-0134`
      return { id: `p3-process-restart-${task.role}-model`, profile: modelProfile(), async *stream(request) {
        rounds++
        if (rounds === 1) {
          if (!request.tools.some(tool => record(tool)?.name === "jobs.search")) throw new Error("p3_restart_child_search_tool_missing")
          yield toolCall(callId, "jobs.search", processRestartSearchInput)
          yield { type: "completed", finishReason: "tool_calls" }; return
        }
        const searchReceipt = latestToolResultForExactToolInput(request, "jobs.search", processRestartSearchInput)
        if (!searchReceipt || searchReceipt.resultToolUseId !== searchReceipt.toolUseId || searchReceipt.toolUseId === callId) {
          throw new Error("p3_restart_child_search_receipt_missing")
        }
        const search = record(searchReceipt.result), jobs = Array.isArray(search?.jobs) ? search.jobs.map(record) : []
        const job = jobs.find(item => item?.id === ids.jobId)
        const toolResult = toolResultDiagnostics(request, searchReceipt.toolUseId)
        emitChildRuntimeScopeDiagnostic({ phase: "search_result", sessionId: task.sessionId, turnId: task.turnId,
          userId: task.userId, taskUserId: task.userId, leaseTaskId: task.id,
          modelTaskId: record(request?.metadata)?.taskId, matchingToolResultCount: toolResult.count,
          resultJsonParsed: toolResult.parsed, expectedJobPresent: Boolean(job),
          returnedJobCount: Array.isArray(search?.jobs) ? jobs.length : null })
        if (!job || !["scout", "analyst"].includes(task.role)) throw new Error("p3_restart_child_search_receipt_missing")
        const evidence = [{ id: `read:job:${ids.jobId}`, kind: "job", ref: ids.jobId, source: job.source ?? "greenhouse" }]
        const summary = task.goal === sourceGoal ? resultMarker : task.goal === dependentGoal ? dependentGoal : followUpGoal
        const result = task.role === "scout"
          ? { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed", candidates: [{ jobId: ids.jobId, source: evidence[0].source, url: null, evidenceIds: [evidence[0].id] }], evidence, summary }
          : { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed", findings: [{ jobId: ids.jobId, score: 8, evidenceIds: [evidence[0].id] }], evidence, summary }
        if (task.goal === followUpGoal) await waitForCommand("complete-follow-up-child")
        yield { type: "text_delta", text: JSON.stringify(result) }
        yield { type: "completed", finishReason: "stop" }
      } }
    },
  })
  async function executeRestartChild(lease) {
    const role = lease.role === "scout" || lease.role === "analyst" ? lease.role : "other"
    try {
      const outcome = await executeChild({ lease }), result = record(outcome.result), rawFailure = outcome.failureReason
      if (role === "scout" || role === "analyst") {
        try { await processRestartVerifierDiagnostic(lease, outcome) }
        catch { say("P3_RESTART_VERIFIER_EVIDENCE_DIAGNOSTIC " + JSON.stringify({ role, diagnosticUnavailable: true })) }
      }
      say("P3_CHILD_OUTCOME " + JSON.stringify({
        ...childLeaseScopeDiagnostic(lease, "child_outcome"),
        role, status: outcome.status === "completed" || outcome.status === "failed" ? outcome.status : "other",
        failureCode: typeof rawFailure === "string" && CHILD_FAILURE_DIAGNOSTIC_CODES.has(rawFailure) ? rawFailure : rawFailure ? "other" : "none",
        hasResult: outcome.result !== undefined && outcome.result !== null,
        resultStatus: result?.status === "completed" || result?.status === "failed" ? result.status : result ? "other" : "missing",
        hasStructuredResult: Boolean(result && Object.hasOwn(result, "structuredResult")),
      }))
      return outcome
    } catch (error) {
      const row = record(error), rawCode = typeof row?.code === "string" ? row.code : error instanceof Error ? error.message : ""
      const failureCode = CHILD_FAILURE_DIAGNOSTIC_CODES.has(rawCode) ? rawCode
        : rawCode === "40P01" ? "database_deadlock" : rawCode === "40001" ? "database_serialization"
          : rawCode.startsWith("p3_") ? "fixture_error" : "other"
      const errorName = error instanceof Error && CHILD_EXCEPTION_DIAGNOSTIC_NAMES.has(error.name) ? error.name : "other"
      say("P3_CHILD_EXCEPTION " + JSON.stringify({
        ...childLeaseScopeDiagnostic(lease, "child_exception"),
        role, stage: "execute_child", errorName, failureCode,
      }))
      throw error
    }
  }
  const { createProductionWorkerBootstrap } = await import("../../queue/production-bootstrap.ts")
  bootstrap = await createProductionWorkerBootstrap({ pool, runtime, ownerId, turnRecoveryIntervalMs: 10,
    waitResolver: { intervalMs: 10, ownerId: "p3-process-restart-wait-resolver-" + process.pid },
    subagents: { intervalMs: 10, async execute({ lease }) {
      const role = lease.role === "scout" || lease.role === "analyst" ? lease.role : "other"
      let stage = "dispatch_context"
      try {
        emitChildRuntimeScopeDiagnostic({ phase: "dispatch", sessionId: lease.sessionId,
          turnId: lease.turnId, userId: lease.userId })
        const dependencyResults = record(record(lease.context)?.taskGraphDependencyResults)
        const dependencyItems = Array.isArray(dependencyResults?.items) ? dependencyResults.items.map(record) : []
        say("P3_CHILD_LEASE " + JSON.stringify({
          taskId: lease.id,
          goal: lease.goal,
          role: lease.role,
          dependencies: dependencyItems.map(item => ({
            dependencyKey: item?.dependencyKey,
            taskStatus: item?.taskStatus,
            hasSourceResult: (JSON.stringify(item?.result) ?? "").includes(resultMarker),
          })),
        }))
        if (lease.goal === sourceGoal && lease.role === "scout") {
          stage = "source_wait_state"
          const dependent = await pool.query(`SELECT task."id", task."status" FROM "sub_agent_tasks" task WHERE task."turnId" = $1 AND task."goal" = $2`, [ids.turnId, dependentGoal])
          if (dependent.rows.length !== 1 || dependent.rows[0].status !== "waiting") throw new Error("p3_dependent_not_waiting_before_source_proof")
          stage = "source_dispatch_state"
          const dispatch = await pool.query(`SELECT 1 FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" = 'agent.subagent.dispatch' AND "idempotencyKey" = $2`, [ids.sessionId, `subagent-dispatch:${dependent.rows[0].id}`])
          if (dispatch.rowCount !== 0) throw new Error("p3_dependent_dispatched_before_source_proof")
          say("P3_DEPENDENT_WAITING_BEFORE_SOURCE_PROOF")
        } else if (lease.goal === dependentGoal && lease.role === "analyst") {
          stage = "source_lookup"
          const source = await pool.query(`SELECT task."id", task."status", task."result" FROM "sub_agent_tasks" task WHERE task."turnId" = $1 AND task."goal" = $2`, [ids.turnId, sourceGoal])
          const sourceResult = record(source.rows[0]?.result), report = record(sourceResult?.taskGraphVerificationReport)
          stage = "source_verification"
          assertPassedVerificationReport(report, "candidate-count")
          stage = "source_completion"
          if (source.rows.length !== 1 || source.rows[0].status !== "completed") throw new Error("p3_source_not_complete_before_dependent_dispatch")
          stage = "dependent_dispatch"
          const dispatch = await pool.query(`SELECT "id" FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" = 'agent.subagent.dispatch' AND "idempotencyKey" = $2`, [ids.sessionId, `subagent-dispatch:${lease.id}`])
          if (dispatch.rows.length !== 1) throw new Error("p3_dependent_dispatch_missing_after_source_proof")
          stage = "dependency_context"
          const items = Array.isArray(record(record(lease.context)?.taskGraphDependencyResults)?.items)
            ? record(record(lease.context)?.taskGraphDependencyResults).items.map(record) : []
          if (items[0]?.dependencyKey !== "source" || items[0]?.taskStatus !== "completed" || !isExpectedSourceProjection(items[0]?.result, ids.jobId)) {
            throw new Error("p3_dependency_context_not_restored")
          }
          say("P3_SOURCE_PROOF_UNLOCKED_DEPENDENT")
          say("P3_DEPENDENCY_CONTEXT_OK")
        } else if (lease.goal === followUpGoal && lease.role === "analyst") {
          stage = "follow_up_context"
          const items = Array.isArray(record(record(lease.context)?.taskGraphDependencyResults)?.items)
            ? record(record(lease.context)?.taskGraphDependencyResults).items.map(record) : []
          const projection = record(items[0]?.result), findings = Array.isArray(projection?.findings) ? projection.findings.map(record) : []
          if (items[0]?.dependencyKey !== "summary" || items[0]?.taskStatus !== "completed"
            || projection?.role !== "analyst" || projection?.availability !== "available"
            || !findings.some(finding => finding?.jobId === ids.jobId && finding.score === 8)) {
            throw new Error("p3_follow_up_dependency_context_missing")
          }
          say("P3_FOLLOW_UP_DEPENDENCY_CONTEXT_OK")
        } else throw new Error("p3_unexpected_child:" + lease.goal)
      } catch (error) {
        const row = record(error), rawCode = typeof row?.code === "string" ? row.code : error instanceof Error ? error.message : ""
        const failureCode = CHILD_FAILURE_DIAGNOSTIC_CODES.has(rawCode) ? rawCode
          : rawCode === "40P01" ? "database_deadlock" : rawCode === "40001" ? "database_serialization"
          : rawCode.startsWith("p3_") ? "fixture_error" : "other"
        const errorName = error instanceof Error && CHILD_EXCEPTION_DIAGNOSTIC_NAMES.has(error.name) ? error.name : "other"
        say("P3_CHILD_EXCEPTION " + JSON.stringify({
          ...childLeaseScopeDiagnostic(lease, stage),
          role, stage, errorName, failureCode,
        }))
        throw error
      }
      return executeRestartChild(lease)
    } } })
  await startSelectedJobQueueWorker(runtime)
  say("P3_SECOND_WORKER_READY " + ownerId); await waitForStop()
}
async function runDiscoveryFirstWorker() {
  const ownerId = "p3-process-restart-discovery-worker-" + process.pid
  const runtime = await startDiscoveryRuntime(ownerId, false)
  const { createProductionWorkerBootstrap } = await import("../../queue/production-bootstrap.ts")
  bootstrap = await createProductionWorkerBootstrap({ pool, runtime, ownerId, turnRecoveryIntervalMs: 10,
    waitResolver: { intervalMs: 10, ownerId: "p3-process-restart-discovery-wait-resolver-" + process.pid },
    subagents: { intervalMs: 10, async execute() { throw new Error("p3_discovery_first_worker_must_not_execute_children") } } })
  const subagentWorker = bootstrap.subagents?.queue?.worker
  if (typeof subagentWorker?.pause !== "function") throw new Error("p3_discovery_first_worker_subagent_pause_unavailable")
  await subagentWorker.pause()
  const activated = await pool.query(`UPDATE "agent_turns" SET "status" = 'queued', "completedAt" = NULL,
      "leaseOwnerId" = NULL, "leaseExpiresAt" = NULL, "leaseStartedAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "status" = 'waiting_for_user'`, [ids.turnId, ids.sessionId, ids.userId])
  if (activated.rowCount !== 1) throw new Error("p3_discovery_first_worker_fixture_turn_not_parked")
  const { enqueueTurn } = await import("../turns/turn-queue.ts")
  await enqueueTurn(pool, bootstrap.turns.queue, { turnId: ids.turnId, sessionId: ids.sessionId, ownerId })
  await waitForDiscoveryParentSuspended(ownerId)
  await waitForStop()
}
async function runDiscoverySecondWorker() {
  assertNoPrivateArtifactFixtureData(ids)
  const ownerId = "p3-process-restart-discovery-worker-" + process.pid
  const runtime = await startDiscoveryRuntime(ownerId, true)
  const { createProductionChildExecutor } = await import("./production-child-runtime.ts")
  const executeChild = createProductionChildExecutor({
    pool, authorizeUsage: async () => noReservationUsageAuthorization(),
    modelRuntimeFactory({ task }) {
      let rounds = 0
      const callId = `p3-process-restart-discovery-read:${task.id}:${task.attemptCount}:415-555-0134`
      return { id: `p3-process-restart-discovery-${task.role}-model`, profile: modelProfile(), async *stream(request) {
        rounds++
        if (rounds === 1) {
          if (!request.tools.some(tool => record(tool)?.name === "jobs.search")) throw new Error("p3_discovery_child_search_tool_missing")
          yield toolCall(callId, "jobs.search", processRestartSearchInput)
          yield { type: "completed", finishReason: "tool_calls" }; return
        }
        if (task.role !== "scout" && task.role !== "analyst") throw new Error("p3_unexpected_discovery_child_role")
        const searchReceipt = latestToolResultForExactToolInput(request, "jobs.search", processRestartSearchInput)
        if (!searchReceipt || searchReceipt.resultToolUseId !== searchReceipt.toolUseId || searchReceipt.toolUseId === callId) {
          throw new Error("p3_discovery_child_search_receipt_missing")
        }
        const search = record(searchReceipt.result), jobs = Array.isArray(search?.jobs) ? search.jobs.map(record) : []
        if (!jobs.some(item => item?.id === ids.jobId)) throw new Error("p3_discovery_child_search_receipt_missing")
        const evidence = [{ id: `read:job:${ids.jobId}`, kind: "job", ref: ids.jobId, source: "greenhouse" }]
        const result = task.role === "scout"
          ? { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed", candidates: [{ jobId: ids.jobId, source: evidence[0].source, url: null, evidenceIds: [evidence[0].id] }], evidence, summary: "Found the persisted fixture role" }
          : { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed", findings: [{ jobId: ids.jobId, score: 8.5, evidenceIds: [evidence[0].id] }], evidence, summary: "Scored the persisted fixture role" }
        yield { type: "text_delta", text: JSON.stringify(result) }
        yield { type: "completed", finishReason: "stop" }
      } }
    },
  })
  const { createProductionWorkerBootstrap } = await import("../../queue/production-bootstrap.ts")
  bootstrap = await createProductionWorkerBootstrap({ pool, runtime, ownerId, turnRecoveryIntervalMs: 10,
    waitResolver: { intervalMs: 10, ownerId: "p3-process-restart-discovery-wait-resolver-" + process.pid },
    subagents: { intervalMs: 10, async execute({ lease }) {
      say("P3_DISCOVERY_CHILD_STARTED " + lease.id + " " + lease.role)
      const outcome = await executeChild({ lease })
      try { await processRestartVerifierDiagnostic(lease, outcome) }
      catch { say("P3_RESTART_VERIFIER_EVIDENCE_DIAGNOSTIC " + JSON.stringify({
        role: lease.role === "scout" || lease.role === "analyst" ? lease.role : "other",
        diagnosticUnavailable: true,
      })) }
      say("P3_DISCOVERY_CHILD_SETTLED " + lease.id + " " + lease.role + " " + outcome.status)
      return outcome
    } } })
  const turnWorker = bootstrap.turns?.worker
  const workerLabel = ids.checkpointAfterWaitConsume === true ? "worker2" : "worker3"
  let turnWorkerDiagnosticCount = 0
  const boundedWorkerNumber = (value, maximum) => Number.isSafeInteger(value) && value >= 1 && value <= maximum ? value : null
  const { turnJobId } = await import("../turns/recovery-scanner.ts")
  const turnJobPrefix = turnJobId(ids.turnId, 0).slice(0, -1)
  const generationForJob = job => {
    const match = typeof job?.id === "string" ? /-(0|[1-9][0-9]*)$/.exec(job.id) : null
    if (!match) return null
    const generation = Number(match[1])
    return Number.isSafeInteger(generation) && generation >= 0 && generation <= 100_000 ? generation : null
  }
  const observeTurnWorker = (event, source = null) => {
    try {
      if (turnWorkerDiagnosticCount >= 16) return
      let generation = null
      let errorName = null
      let errorCode = null
      if (event === "stalled") {
        if (typeof source !== "string" || !source.startsWith(turnJobPrefix)) return
        generation = generationForJob({ id: source })
        if (generation === null) return
      } else if (event === "error") {
        const name = source instanceof Error ? source.name : null
        errorName = TURN_WORKER_ERROR_DIAGNOSTIC_NAMES.has(name) ? name : "other"
        const code = record(source)?.code
        errorCode = typeof code === "string" && TURN_WORKER_ERROR_DIAGNOSTIC_CODES.has(code) ? code : "other"
      } else if (event !== "observer_attached") {
        const payload = record(source?.data)
        if (payload?.turnId !== ids.turnId || payload.sessionId !== ids.sessionId) return
        generation = generationForJob(source)
      }
      const workerState = turnWorker
      const opts = record(workerState?.opts) ?? {}
      const registrySize = bootstrap.turns?.active?.size
      const marker = {
        worker: workerLabel,
        event,
        isRunning: typeof workerState?.isRunning === "function" ? (() => { try { const value = workerState.isRunning(); return typeof value === "boolean" ? value : null } catch { return null } })() : null,
        isPaused: typeof workerState?.isPaused === "function" ? (() => { try { const value = workerState.isPaused(); return typeof value === "boolean" ? value : null } catch { return null } })() : null,
        stalledInterval: boundedWorkerNumber(opts.stalledInterval, 300_000),
        lockDuration: boundedWorkerNumber(opts.lockDuration, 300_000),
        concurrency: boundedWorkerNumber(opts.concurrency, 64),
        activeRegistryCount: typeof registrySize === "number" && Number.isSafeInteger(registrySize) && registrySize >= 0 && registrySize <= 64 ? registrySize : null,
        generation,
        errorName,
        errorCode,
      }
      say("P3_DISCOVERY_TURN_WORKER " + JSON.stringify(marker))
      turnWorkerDiagnosticCount += 1
    } catch {
      // Diagnostics must never affect Turn processing.
    }
  }
  if (turnWorker && typeof turnWorker.on === "function") {
    observeTurnWorker("observer_attached")
    turnWorker.on("active", job => observeTurnWorker("active", job))
    turnWorker.on("completed", job => observeTurnWorker("completed", job))
    turnWorker.on("failed", job => observeTurnWorker("failed", job))
    // Observe Worker errors without adding a consuming listener or changing BullMQ's default error handling.
    turnWorker.on(errorMonitor, error => observeTurnWorker("error", error))
    turnWorker.on("stalled", (jobId, previousState) => {
      if (previousState === "active") observeTurnWorker("stalled", jobId)
    })
  }
  say("P3_DISCOVERY_SECOND_WORKER_READY " + ownerId)
  await waitForStop()
}
try {
  assertLatestGraphObservationSelection()
  assertLatestToolResultSelection()
  assertPersistedGraphComparator()
  assertInitialPlanToolPair()
  assertSafeFailureCategoryProjection()
  assertSourceProjectionDiagnostic()
  if (mode === "self-test") say("P3_FIXTURE_SELF_TEST_OK")
  else if (mode === "worker2-input-guard-self-test") {
    assertPrivateArtifactFixtureGuardSelfTest()
    say("P3_PRIVATE_FIXTURE_GUARD_OK")
    process.stdin.off("data", onStdinData); process.stdin.pause(); process.stdin.destroy()
  }
  else if (mode === "park-parent" || mode === "resume-parent" || mode === "park-discovery" || mode === "resume-discovery"
    || mode === "park-successive-replan" || mode === "resume-successive-replan"
    || mode === "crash-archived-wait" || mode === "resume-archived-wait") {
    assertDisposableServiceUrls()
    await loadSharedRedisModule()
    if (mode === "park-parent") await runFirstWorker()
    else if (mode === "resume-parent") await runSecondWorker()
    else if (mode === "park-discovery") await runDiscoveryFirstWorker()
    else if (mode === "resume-discovery") await runDiscoverySecondWorker()
    else if (mode === "park-successive-replan") await runSuccessiveReplanWorker(false)
    else if (mode === "resume-successive-replan") await runSuccessiveReplanWorker(true)
    else if (mode === "crash-archived-wait") await runArchivedWaitFirstWorker()
    else await runArchivedWaitResumeWorker()
  }
  else throw new Error("p3_unknown_process_restart_mode")
} catch (error) {
  process.stderr.write((error instanceof Error ? error.stack ?? error.message : String(error)) + "\n"); process.exitCode = 1
  process.stdin.off("data", onStdinData); process.stdin.pause(); process.stdin.destroy()
} finally {
  try { if (selectedJobWorker) await selectedJobWorker.close() } catch (error) { process.stderr.write("p3_selected_job_worker_close_failed:" + String(error) + "\n"); process.exitCode = 1 }
  try { if (bootstrap) await bootstrap.close() } catch (error) { process.stderr.write("p3_bootstrap_close_failed:" + String(error) + "\n"); process.exitCode = 1 }
  try { await pool.end() } catch (error) { process.stderr.write("p3_pool_end_failed:" + String(error) + "\n"); process.exitCode = 1 }
  try { if (sharedRedisModule) await sharedRedisModule.closeSharedRedisConnections() }
  catch (error) { process.stderr.write("p3_redis_close_failed:" + String(error) + "\n"); process.exitCode = 1 }
}
