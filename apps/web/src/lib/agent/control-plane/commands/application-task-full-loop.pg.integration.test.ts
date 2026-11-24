import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { isDeepStrictEqual } from "node:util"
import { spawn, type ChildProcess } from "node:child_process"
import { createServer, type Server } from "node:http"
import { connect as connectSocket } from "node:net"
import { access, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import { Prisma, PrismaClient } from "@prisma/client"
import { hashApprovalNonce, hashApprovalScope, objectiveApplicationApprovalSetItemId, parseObjectiveTailorGraph, schemaVersion } from "@jobcopilot/agent-protocol"
import { hashReviewedApplicationMaterialProof } from "@jobcopilot/shared"
import { SignJWT } from "jose"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, onTestFailed, vi } from "vitest"

import { EXTENSION_TOKEN_AUDIENCE, EXTENSION_TOKEN_ISSUER, getAuthJwtSecret } from "@/lib/auth-secret"
import { protocolScope, type ApprovalScopeInput } from "@/lib/agent/approval/types"
import type { ApplicationPackage, PipelineCtx } from "@/lib/agent/types"

const objectiveResumeAmbientAuth = vi.hoisted(() => ({ authorization: null as string | null }))

vi.mock("next/headers", async importOriginal => {
  const actual = await importOriginal<typeof import("next/headers")>()
  return {
    ...actual,
    headers: async () => objectiveResumeAmbientAuth.authorization
      ? new Headers({ authorization: objectiveResumeAmbientAuth.authorization })
      : await actual.headers(),
  }
})

vi.mock("@/lib/safe-auth", () => ({ safeAuth: async () => null }))

const DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:5432/applymate_agent_brain_ci"
const REDIS_URL = "redis://127.0.0.1:6379/15"
const runId = randomUUID().replaceAll("-", "")
const candidateName = "A B"
const candidateEmail = `${runId.slice(0, 1)}@${runId.slice(1, 3)}.co`
const reviewedCoverLetter = "SYNTHETIC REVIEWED COVER LETTER — isolated fill only."
const reviewedSourceGoal = "FULL_LOOP_REVIEWED_SOURCE: produce and review a selected-job cover letter"
const reviewedFillBridgePath = "/__applymate-reviewed-fill"
const reviewedFillEndpointUrl = `http://127.0.0.1:9443${reviewedFillBridgePath}`
const ids = {
  user: `full-loop-user-${runId}`,
  foreignUser: `full-loop-foreign-${runId}`,
  session: `full-loop-session-${runId}`,
  gateTurn: `full-loop-gate-turn-${runId}`,
  execution: `full-loop-execution-${runId}`,
  job: `full-loop-job-${runId}`,
  resume: `full-loop-resume-${runId}`,
}
const SAFE_DIAGNOSTIC_ERROR_CODES = new Set([
  "turn_execution_failed",
  "model_execution_failed",
  "application_fill_state_invalid",
  "application_fill_binding_invalid",
  "application_fill_material_unavailable",
  "application_fill_fixture_model_validation_failed",
  "application_fill_tool_transcript_invalid",
  "application_fill_tool_use_id_invalid",
  "application_fill_plan_receipt_missing_ready_task",
  "application_fill_plan_receipt_invalid",
  "application_fill_wait_limit_exceeded",
  "application_fill_wait_output_missing",
  "application_fill_wait_output_invalid",
  "application_fill_wait_scope_or_status_invalid",
  "application_fill_wait_terminal_interrupted",
  "application_fill_wait_terminal_closed",
  "application_fill_child_terminal_status_invalid",
  "fill_role_invalid",
  "fill_lease_invalid",
  "lease_lost",
  "fill_scope_mismatch",
  "account_inactive",
  "application_task_inactive",
  "fill_checkpoint_invalid",
  "fill_turn_inactive",
  "fill_material_unavailable",
  "fill_rate_limited",
  "fill_preflight_unavailable",
  "fill_prestart_unavailable",
  "fill_start_conflict",
  "unattended_apply_unavailable",
  "unknown_sensitive_field",
  "required_field",
  "fill_cancelled",
  "fill_outcome_uncertain",
  "fill_wait_conflict",
  "fill_wait_persistence_unavailable",
  "fill_cancellation_conflict",
  "fill_cancellation_unavailable",
  "fill_prestart_failure_conflict",
  "fill_prestart_failure_unavailable",
  "fill_completion_conflict",
])
const REVIEWED_SOURCE_DIAGNOSTIC_STATUSES = new Set([
  "queued", "running", "waiting", "completed", "failed", "cancelled", "interrupted", "retrying",
])
const REVIEWED_SOURCE_DIAGNOSTIC_TOOLS = new Set([
  "agent.plan", "agent.wait", "cover_letter.draft", "artifact.version.read", "artifact.review",
])

function diagnosticMachineErrorCode(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return typeof value === "string" && SAFE_DIAGNOSTIC_ERROR_CODES.has(value) ? value : "present"
}

function reviewedSourceDiagnosticStatus(value: unknown): string {
  return typeof value === "string" && REVIEWED_SOURCE_DIAGNOSTIC_STATUSES.has(value) ? value : "other"
}

function boundedPersistedCount(value: number): { count: number; overflow: boolean } {
  return { count: Math.min(8, Math.max(0, value)), overflow: value > 8 }
}

function legacyFinalGateMarkerPresence(lines: readonly string[] | undefined) {
  return {
    resumed: lines?.includes("LEGACY_FINAL_RESPONSE_GATE_RESUMED") ?? false,
    modelStreamCompleted: lines?.includes("LEGACY_FINAL_RESPONSE_MODEL_STREAM_COMPLETED") ?? false,
  }
}

async function postReleaseFinalGateDiagnostics(turnId: string) {
  const turn = await testDb.agentTurn.findFirst({ where: { id: turnId, sessionId: ids.session, userId: ids.user }, select: {
    rootTaskId: true, status: true, finalResponse: true, error: true, leaseOwnerId: true, leaseExpiresAt: true,
  } })
  const [applicationTask, attempts] = await Promise.all([
    gateTaskId ? testDb.applicationTask.findFirst({ where: {
      id: gateTaskId, userId: ids.user, jobId: ids.job, sessionId: ids.session,
    }, select: { status: true, checkpoint: true, error: true, workerTaskId: true } }) : null,
    testDb.submissionAttempt.findMany({ where: { userId: ids.user, jobId: ids.job }, orderBy: { createdAt: "desc" }, take: 8,
      select: { state: true, errorCode: true } }),
  ])
  const rootTaskId = turn?.rootTaskId
  const root = rootTaskId ? await testDb.subAgentTask.findFirst({ where: {
    id: rootTaskId, rootTaskId, sessionId: ids.session, turnId, parentTaskId: null, role: "orchestrator", taskType: "root",
  }, select: { id: true, status: true } }) : null
  const [lastStep, modelCompletionCount, finalItemCount, terminalEventCount] = root ? await Promise.all([
    testDb.agentStep.findFirst({ where: { sessionId: ids.session, turnId, taskId: root.id }, orderBy: { ordinal: "desc" },
      select: { ordinal: true, status: true, finishReason: true, errorCode: true } }),
    testDb.agentEvent.count({ where: { sessionId: ids.session, turnId, taskId: root.id, type: "model.completed" } }),
    testDb.agentItem.count({ where: { sessionId: ids.session, turnId, taskId: root.id, phase: "final_answer", status: "completed" } }),
    testDb.agentEvent.count({ where: { sessionId: ids.session, turnId, taskId: root.id,
      type: { in: ["turn.completed", "turn.failed", "turn.interrupted"] } } }),
  ]) : [null, 0, 0, 0] as const
  const finishReason = lastStep?.finishReason
  const safeFinishReason = finishReason === "stop" || finishReason === "tool_calls" || finishReason === "length"
    ? finishReason : finishReason == null ? null : "other"
  return {
    workerMarkers: legacyFinalGateMarkerPresence(worker?.lines),
    applicationTask: applicationTask ? {
      status: reviewedFillDiagnosticValue(applicationTask.status, REVIEWED_FILL_DIAGNOSTIC_STATUSES),
      checkpoint: reviewedFillDiagnosticValue(applicationTask.checkpoint, REVIEWED_FILL_DIAGNOSTIC_CHECKPOINTS),
      errorPresent: Boolean(applicationTask.error), workerTaskPresent: Boolean(applicationTask.workerTaskId),
    } : { present: false },
    submissionAttempts: {
      count: boundedPersistedCount(attempts.length),
      states: attempts.map(attempt => ({
        state: attempt.state === "reserved" || attempt.state === "submitted" || attempt.state === "failed" ? attempt.state : "other",
        errorPresent: Boolean(attempt.errorCode),
      })),
    },
    turn: turn ? {
      status: reviewedSourceDiagnosticStatus(turn.status), finalResponsePresent: Boolean(turn.finalResponse),
      errorPresent: Boolean(turn.error), leaseActive: Boolean(turn.leaseOwnerId && turn.leaseExpiresAt && turn.leaseExpiresAt > new Date()),
    } : { present: false },
    root: root ? { present: true, status: reviewedSourceDiagnosticStatus(root.status) } : { present: false },
    lastStep: lastStep ? {
      ordinal: Number.isSafeInteger(lastStep.ordinal) ? Math.max(0, Math.min(999, lastStep.ordinal)) : null,
      status: reviewedSourceDiagnosticStatus(lastStep.status), finishReason: safeFinishReason, errorPresent: Boolean(lastStep.errorCode),
    } : { present: false },
    persisted: {
      modelCompletionEvents: boundedPersistedCount(modelCompletionCount),
      finalAnswerItems: boundedPersistedCount(finalItemCount),
      terminalEvents: boundedPersistedCount(terminalEventCount),
    },
  }
}

function reviewedSourceDiagnosticSummary(
  turn: { status: unknown; error: unknown } | null,
  tasks: readonly { role: unknown; status: unknown; failureReason: unknown }[],
  tools: readonly { status: unknown; content: unknown }[],
) {
  return {
    root: { status: reviewedSourceDiagnosticStatus(turn?.status), errorCode: diagnosticMachineErrorCode(turn?.error) },
    tasks: tasks.map(task => ({
      role: task.role === "writer" || task.role === "reviewer" ? task.role : "other",
      status: reviewedSourceDiagnosticStatus(task.status), failureCode: diagnosticMachineErrorCode(task.failureReason),
    })),
    tools: tools.map(item => {
      const name = jsonString(item.content, "toolName")
      return { name: name && REVIEWED_SOURCE_DIAGNOSTIC_TOOLS.has(name) ? name : "other",
        status: reviewedSourceDiagnosticStatus(item.status) }
    }),
  }
}

async function reviewedSourceTurnDiagnostics(sessionId: string, turnId: string) {
  const [turn, tasks, tools] = await Promise.all([
    testDb.agentTurn.findUnique({ where: { id: turnId }, select: { status: true, error: true } }),
    testDb.subAgentTask.findMany({ where: { sessionId, turnId }, orderBy: { createdAt: "asc" }, take: 12,
      select: { role: true, status: true, failureReason: true } }),
    testDb.agentItem.findMany({ where: { sessionId, turnId, type: "tool_call" }, orderBy: { createdAt: "asc" }, take: 24,
      select: { status: true, content: true } }),
  ])
  return reviewedSourceDiagnosticSummary(turn, tasks, tools)
}

const OBJECTIVE_WAVE_CODES = new Set([
  "revision_mismatch", "revision_limit", "idempotency_conflict", "task_graph_state_missing", "task_graph_objective_coverage_incomplete",
  "objective_tailor_wave_not_eligible", "objective_tailor_wave_source_stale", "objective_tailor_wave_stale",
  "objective_tailor_correction_stale", "objective_tailor_correction_source_stale", "objective_tailor_wave_failed",
  "objective_tailor_wave_receipt_invalid", "fixture_root_stream_failed",
])
const OBJECTIVE_WAVE_MARKERS = [
  "TAILOR_WAVE_WORKER_READY resume", "TAILOR_ROOT_FACTORY_ENTERED", "TAILOR_ROOT_FACTORY_BOUND",
  "TAILOR_ROOT_FACTORY_ROOT_UNAVAILABLE", "TAILOR_ROOT_STREAM_ENTERED", "TAILOR_ROOT_REQUEST_SCOPE_OK",
  "TAILOR_ROOT_INITIAL_PLAN_REQUESTED", "TAILOR_ROOT_SOURCE_WAIT_REQUESTED",
  "TAILOR_PLAN_FAILED objective_coverage_incomplete", "TAILOR_SOURCE_GRAPH_READY 7", "TAILOR_WAVE1_GRAPH_CONTEXT_PARSED",
  "TAILOR_WAVE1_GRAPH_CONTEXT_UNAVAILABLE", "TAILOR_WAVE1_TOOL_ABSENT", "TAILOR_WAVE1_TOOL_AMBIGUOUS", "TAILOR_WAVE1_TOOL_V2",
  "TAILOR_WAVE1_TOOL_VERSION_OTHER", "TAILOR_WAVE1_CATALOG_MISSING", "TAILOR_WAVE1_CATALOG_INVALID",
  "TAILOR_WAVE1_CATALOG_COUNT_MATCH", "TAILOR_WAVE1_CATALOG_COUNT_MISMATCH", "TAILOR_WAVE1_CATALOG_REVISION_MATCH",
  "TAILOR_WAVE1_CATALOG_REVISION_MISMATCH", "TAILOR_WAVE1_CANDIDATE_REFS_INVALID", "TAILOR_WAVE1_TOOL_CALL_EMITTED",
  "TAILOR_WAVE1_RECEIPT_ACCEPTED", "TAILOR_WAVE1_RECEIPT_DENIED", "TAILOR_WAVE1_RECEIPT_INVALID",
  "TAILOR_WAVE1_POST_APPEND_GRAPH_OBSERVED", "TAILOR_WAVE1_POST_APPEND_GRAPH_UNAVAILABLE",
  "TAILOR_WAVE1_POST_APPEND_IDENTITY_VALID", "TAILOR_WAVE1_POST_APPEND_IDENTITY_INVALID",
  "TAILOR_WAVE1_ORDINARY_PLAN_PROBE_EMITTED", "TAILOR_WAVE1_WAIT_EMITTED", "TAILOR_WAVE1_WAIT_READY",
  "TAILOR_WAVE1_REPLAY_EMITTED", "TAILOR_WAVE1_REPLAY_RESULT_PRESENT", "TAILOR_WAVE1_REPLAY_RESULT_MISSING",
  "TAILOR_WAVE1_REPLAY_MATCHED", "TAILOR_WAVE2_WAIT_READY", "TAILOR_CORRECTIONS_WAIT_READY", "TAILOR_ROOT_STREAM_FAILED",
] as const

function objectiveWaveFixtureDiagnostics(lines: readonly string[], errors: readonly string[]) {
  const catalog = [...lines].reverse().map(line => {
    const result = /^TAILOR_WAVE_CATALOG_READ (?:[1-9]|1[0-6]) (returned|absent) ([0-8])$/.exec(line)
    const failure = /^TAILOR_WAVE_CATALOG_READ (?:[1-9]|1[0-6]) failed ([a-z_]{1,64}) 0$/.exec(line)
    return result ? { outcome: result[1], candidateCount: Number(result[2]) }
      : failure ? { outcome: "failed", code: OBJECTIVE_WAVE_CODES.has(failure[1]!) ? failure[1] : "other", candidateCount: 0 }
        : null
  }).find((entry): entry is NonNullable<typeof entry> => entry !== null) ?? null
  const append = [...lines].reverse().map(line => {
    const result = /^TAILOR_WAVE_APPEND (accepted|duplicate|other) ([0-8])$/.exec(line)
    const failure = /^TAILOR_WAVE_APPEND failed ([a-z_]{1,64})$/.exec(line)
    return result ? { outcome: result[1], nodeCount: Number(result[2]) }
      : failure ? { outcome: "failed", code: OBJECTIVE_WAVE_CODES.has(failure[1]!) ? failure[1] : "other", nodeCount: 0 }
        : null
  }).find((entry): entry is NonNullable<typeof entry> => entry !== null) ?? null
  return { markers: Object.fromEntries(OBJECTIVE_WAVE_MARKERS.map(marker => [marker, lines.includes(marker)])),
    catalog, append, workerFailed: errors.includes("TAILOR_WAVE_WORKER_FAILED") }
}

function objectiveSourceStatus(value: unknown): string {
  return typeof value === "string" && ["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval",
    "waiting_for_user", "running", "completed", "failed", "cancelled", "interrupted"].includes(value) ? value : "other"
}

async function objectiveSourceFailureSnapshot(input: { sessionId: string; turnId: string; lines: readonly string[]; errors: readonly string[] }) {
  const turn = await testDb.agentTurn.findFirst({ where: { id: input.turnId, sessionId: input.sessionId, userId: ids.user },
    select: { id: true, status: true, error: true, rootTaskId: true } })
  const rootId = typeof turn?.rootTaskId === "string" ? turn.rootTaskId : null
  const [root, graphRow, tasks] = await Promise.all([
    rootId ? testDb.subAgentTask.findFirst({ where: { id: rootId, sessionId: input.sessionId, turnId: input.turnId,
      rootTaskId: rootId, parentTaskId: null, role: "orchestrator", taskType: "root" }, select: { status: true, failureReason: true } }) : null,
    rootId ? testDb.agentItem.findFirst({ where: { sessionId: input.sessionId, turnId: input.turnId, taskId: rootId, type: "task_graph" },
      select: { revision: true, content: true } }) : null,
    rootId ? testDb.subAgentTask.findMany({ where: { sessionId: input.sessionId, turnId: input.turnId, rootTaskId: rootId },
      take: 32, select: { role: true, status: true } }) : [],
  ])
  const content = jsonRecord(graphRow?.content), rawNodes = Array.isArray(content?.nodes) ? content.nodes : []
  const marker = parseObjectiveTailorGraph(content?.objectiveTailor, content?.nodes)
  const roleCounts = { scout: 0, analyst: 0, writer: 0, reviewer: 0, orchestrator: 0, other: 0 }
  const statusCounts = { active: 0, completed: 0, failed: 0, terminal: 0, other: 0 }
  for (const task of tasks) {
    const role = task.role === "scout" || task.role === "analyst" || task.role === "writer" || task.role === "reviewer"
      || task.role === "orchestrator" ? task.role : "other"
    roleCounts[role]++
    const status = typeof task.status === "string" ? task.status : ""
    statusCounts[status === "completed" ? "completed" : status === "failed" ? "failed"
      : ["pending", "queued", "running", "in_progress", "waiting", "waiting_for_dependency"].includes(status) ? "active"
        : ["cancelled", "interrupted"].includes(status) ? "terminal" : "other"]++
  }
  return {
    turn: { present: turn !== null, status: objectiveSourceStatus(turn?.status), errorCode: diagnosticMachineErrorCode(turn?.error) },
    root: { present: root !== null, status: objectiveSourceStatus(root?.status), failureCode: diagnosticMachineErrorCode(root?.failureReason) },
    graph: { present: graphRow !== null, revision: Number.isSafeInteger(graphRow?.revision) ? graphRow!.revision : null,
      markerValid: Boolean(marker), sourceNodeCount: marker?.sourceNodeCount ?? null, slotCount: marker?.slots.length ?? null,
      nodeCount: Math.min(32, rawNodes.length), nodeCountOverflow: rawNodes.length > 32 },
    children: { count: Math.min(32, tasks.length), overflow: tasks.length === 32, roles: roleCounts, statuses: statusCounts },
    fixture: objectiveWaveFixtureDiagnostics(input.lines, input.errors),
  }
}

const SAFE_SUBMIT_OUTBOX_ERROR_CATEGORIES = [
  "queue_delivery_or_ack_failed",
  "terminal:invalid_intent_payload",
  "terminal:outbox_identity_mismatch",
  "terminal:outbox_identity_changed",
  "terminal:queue_job_identity_mismatch",
  "terminal:application_task_scope_mismatch",
  "terminal:worker_task_id_mismatch",
  "terminal:application_job_state_mismatch",
  "terminal:attempt_already_claimed_or_terminal",
  "terminal:application_account_inactive",
  "terminal:approval_scope_mismatch",
  "terminal:submission_queued_event_mismatch",
  "terminal:submission_scope_mismatch",
  "terminal:submission_attempt_fenced",
  "terminal:attempt_superseded",
  "terminal:terminal_submit_reconciled",
] as const
const SAFE_SUBMIT_OUTBOX_ERROR_CATEGORY_SET: ReadonlySet<string> = new Set(SAFE_SUBMIT_OUTBOX_ERROR_CATEGORIES)
type SafeSubmitOutboxErrorCategory = typeof SAFE_SUBMIT_OUTBOX_ERROR_CATEGORIES[number]

function diagnosticSubmitOutboxErrorCategory(value: unknown): "none" | "other" | SafeSubmitOutboxErrorCategory {
  if (value === null || value === undefined) return "none"
  return typeof value === "string" && SAFE_SUBMIT_OUTBOX_ERROR_CATEGORY_SET.has(value)
    ? value as SafeSubmitOutboxErrorCategory
    : "other"
}

const SAFE_SUBMISSION_ATTEMPT_ERROR_CODES = [
  "approval_not_found",
  "approval_scope_mismatch",
  "approval_integrity_error",
  "approval_expired",
  "approval_not_approved",
  "approval_already_consumed",
  "approval_nonce_mismatch",
  "approval_revision_mismatch",
  "approval_reservation_conflict",
  "browser_412",
  "browser_manual",
  "browser_failed",
  "idempotency_conflict",
  "idempotency_replay",
  "invalid_state",
  "not_found",
  "submission_attempt_fenced",
  "submission_scope_mismatch",
  "invalid_input",
  "target_not_found",
  "submission_in_flight",
  "stale_artifact",
  "submission_guard_denied",
  "provider_invalid_response",
  "provider_error",
] as const
const SAFE_SUBMISSION_ATTEMPT_ERROR_CODE_SET: ReadonlySet<string> = new Set(SAFE_SUBMISSION_ATTEMPT_ERROR_CODES)
type SafeSubmissionAttemptErrorCode = typeof SAFE_SUBMISSION_ATTEMPT_ERROR_CODES[number]

function diagnosticSubmissionAttemptErrorCode(value: unknown): null | "other" | SafeSubmissionAttemptErrorCode {
  if (value === null || value === undefined) return null
  return typeof value === "string" && SAFE_SUBMISSION_ATTEMPT_ERROR_CODE_SET.has(value)
    ? value as SafeSubmissionAttemptErrorCode
    : "other"
}

function serviceUrl(value: string | undefined, kind: "postgres" | "redis"): string | null {
  const required = process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true"
  if (!value) {
    if (required) throw new Error(`ApplicationTask full-loop integration requires its disposable ${kind} URL`)
    return null
  }
  const url = new URL(value)
  const valid = kind === "postgres"
    ? process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE === "true" && value === DATABASE_URL
      && url.protocol === "postgresql:" && url.hostname === "127.0.0.1" && url.port === "5432"
      && url.username === "postgres" && url.password === "postgres" && url.pathname === "/applymate_agent_brain_ci"
      && !url.search && !url.hash
    : process.env.RUN_AGENT_TURN_REDIS_INTEGRATION === "1" && process.env.AGENT_TURN_REDIS_TEST_DISPOSABLE === "true"
      && value === REDIS_URL && process.env.REDIS_URL === value && url.protocol === "redis:"
      && url.hostname === "127.0.0.1" && url.port === "6379" && url.pathname === "/15"
      && !url.username && !url.password && !url.search && !url.hash
  if (!valid) throw new Error(`ApplicationTask full-loop integration rejects non-dedicated ${kind}`)
  return value
}

const databaseUrl = serviceUrl(process.env.AGENT_RUNTIME_PG_TEST_URL, "postgres")
const redisUrl = serviceUrl(process.env.AGENT_TURN_REDIS_TEST_URL, "redis")
const enabled = databaseUrl !== null && redisUrl !== null
const describeWithServices = enabled ? describe : describe.skip

type Child = ChildProcess & { readonly lines: string[]; readonly errors: string[] }
type FixtureStats = {
  submitCount: number
  reviewedSubmitCount: number
  reviewedMaterialExactCount: number
  objectiveMaterialExactCount: number
  reviewedGetCount: number
  blocked: string[]
  requests: string[]
  browserTrace: string[]
  browserProgress: Array<{ event: string; elapsedMs: number; length?: number }>
}
type ReviewedFillBridgeAttempt = {
  outboxId: string | null
  status: number
  acknowledgement: string | null
  predecessorStatus: string | null
  acknowledgementDropped: boolean
}
type ObjectiveFillDeliveryHold = {
  sessionId: string
  approvalId: string
  outboxId: string | null
  reached: boolean
  release: (() => void) | null
  released: Promise<void>
}
type ApplicationFillExecutorTrace = {
  attemptCount: number | null
  executorInvocationOrdinal: number
  elapsedMs: number
  returned: boolean
  threw: boolean
  statusCompleted: boolean
  statusWaiting: boolean
  statusWaitingForUser: boolean
  statusFailed: boolean
  failureReasonLeaseLost: boolean
  leaseSignalAbortedAtStart: boolean
  leaseSignalAbortedAtEnd: boolean
}
type ApplicationFillCompletionStaleGate = "lease_input_invalid" | "session_scope" | "turn_row_unavailable" | "turn_status_queued" | "turn_status_interrupted" | "turn_status_terminal" | "turn_status_other" | "child_lease_fence" | "application_task_scope"
type ApplicationFillStageTrace = { entryValidation: boolean; waitPersistence: boolean; completion: boolean; accepted: boolean; rejected: boolean; waiting: boolean; completed: boolean; stale: boolean; conflict: boolean; failed: boolean; cancelled: boolean; unavailable: boolean; leaseLost: boolean; signalAborted: boolean; staleGate?: ApplicationFillCompletionStaleGate }
type ApplicationFillAcquisitionPhase = "before_control_read" | "before_pattern_read" | "context_requested" | "page_acquired" | "navigation_returned" | "navigation_response_success" | "navigation_response_unavailable" | "destination_allowed" | "destination_rejected" | "wait_detection_returned" | "outer_wait_clear" | "outer_wait_detected" | "executor_started" | "executor_wait_clear" | "executor_wait_detected" | "deterministic_flow_started" | "deterministic_flow_review_ready" | "deterministic_flow_wait" | "deterministic_flow_other" | "fill_returned" | "callback_settled" | "context_returned"
type ApplicationFillPhaseTrace = { phase: ApplicationFillAcquisitionPhase }
type ApplicationTaskRow = {
  id: string; userId: string; jobId: string; sessionId: string | null; fillTurnId: string | null
  status: string; checkpoint: string | null; question: unknown; confirmedAnswers: unknown
  workerTaskId?: string | null; error?: string | null
}
const workerCwd = resolve(process.cwd(), "../worker")
const fixturePath = resolve(workerCwd, "src/queue/application-task-full-loop.fixture.mjs")
const objectiveTailorWaveFixturePath = resolve(workerCwd, "src/runtime/subagents/objective-tailor-wave-process.fixture.mjs")
const objectiveTailorWaveSourceFixturePath = resolve(workerCwd, "src/runtime/subagents/objective-tailor-wave-source.fixture.mjs")
const socketPath = join(tmpdir(), `applymate-${runId}.sock`)
const reviewedFillRouteSocketPath = join(tmpdir(), `am-${runId.slice(0, 16)}-rf.sock`)
const tlsPaths = ["AGENT_TEST_TLS_CERT_PATH", "AGENT_TEST_TLS_KEY_PATH", "AGENT_TEST_TLS_CA_PATH"] as const
const testDb = new PrismaClient({ datasources: { db: { url: databaseUrl ?? DATABASE_URL } } })
const workerRequire = createRequire(new URL("../../../../../../worker/package.json", import.meta.url))
const { Queue } = workerRequire("bullmq") as { Queue: new (name: string, options: { connection: { host: string; port: number; db: number } }) => {
  getJobs(states: readonly string[], start: number, end: number): Promise<Array<{ id?: string; data: unknown; attemptsMade: number; attemptsStarted: number; stalledCounter: number; getState(): Promise<string>; remove(): Promise<void> }>>
  getJob(id: string): Promise<{ id?: string; data: unknown; attemptsMade: number; attemptsStarted: number; stalledCounter: number; getState(): Promise<string>; remove(): Promise<void> } | undefined>
  add(name: string, data: unknown, options: { jobId: string }): Promise<{ id?: string; getState(): Promise<string> }>
  close(): Promise<void>
  disconnect(): Promise<void>
} }
let site: Child | undefined
let worker: Child | undefined
let legacyFinalResponseGateTurnId: string | undefined
let applyQueue: InstanceType<typeof Queue> | undefined
let turnQueue: InstanceType<typeof Queue> | undefined
let subagentQueue: InstanceType<typeof Queue> | undefined
let createdUsers: string[] = []
const reviewedSessionIds: string[] = []
const reviewedJobIds: string[] = []
const reviewedFillBridgeSecret = `application-task-full-loop-${runId}`
const reviewedFillBridgeAttempts: ReviewedFillBridgeAttempt[] = []
let reviewedFillBridgeServer: Server | undefined
let reviewedFillRouteDb: PrismaClient | undefined
let dropNextReviewedFillAcknowledgement = false
let objectiveFillDeliveryHold: ObjectiveFillDeliveryHold | undefined
let priorAgentWorkerSecret: string | undefined
let priorDatabaseUrl: string | undefined
let agentWorkerSecretOverridden = false
let databaseUrlOverridden = false
let dbConnected = false
let priorApplicationFillTaskGraph: string | undefined

function checkTlsAndIsolation(): void {
  if (!enabled) return
  if (process.env.CI !== "true" || process.env.AGENT_RUNTIME_PG_TEST_REQUIRED !== "true"
    || process.env.APPLICATION_TASK_FULL_LOOP_EGRESS_ISOLATED !== "true"
    || process.env.CLOAK_PROXY_URL !== "http://127.0.0.1:9443") {
    throw new Error("ApplicationTask full-loop CI isolation contract is missing")
  }
  if (process.platform !== "linux") throw new Error("ApplicationTask full-loop browser fixture requires the isolated Linux CI runner")
  for (const name of tlsPaths) if (!process.env[name]) throw new Error(`${name} is required for browser certificate verification`)
}

async function assertEgressBlocked(): Promise<void> {
  if (!enabled) return
  for (const host of ["1.1.1.1", "2606:4700:4700::1111"]) {
    await new Promise<void>((resolveProbe, rejectProbe) => {
      const socket = connectSocket({ host, port: 443, ...(host.includes(":") ? { family: 6 } : { family: 4 }) })
      const finish = (error?: Error) => { socket.destroy(); error ? rejectProbe(error) : resolveProbe() }
      socket.once("connect", () => finish(new Error(`external egress unexpectedly succeeded for ${host}`)))
      socket.once("error", () => finish())
      socket.setTimeout(2_000, () => finish())
    })
  }
}

function spawnFixture(mode: "site" | "worker"): Child {
  const child = spawn(process.execPath, ["--import", "tsx", fixturePath, mode], {
    cwd: workerCwd,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl!, AGENT_RUNTIME_PG_TEST_URL: databaseUrl!,
      REDIS_URL: redisUrl!, AGENT_TURN_REDIS_TEST_URL: redisUrl!,
      AGENT_RUNTIME_PG_TEST_DISPOSABLE: "true", AGENT_RUNTIME_PG_TEST_REQUIRED: "true",
      AGENT_TURN_REDIS_TEST_DISPOSABLE: "true", RUN_AGENT_TURN_REDIS_INTEGRATION: "1",
      CLOAK_PROXY_URL: "http://127.0.0.1:9443", APPLICATION_TASK_FULL_LOOP_SOCKET_PATH: socketPath,
      APPLICATION_TASK_FULL_LOOP_STAGE_OBSERVER_TEST: mode === "worker" ? "true" : "false",
      APPLICATION_TASK_FULL_LOOP_REVIEWED_FILL_SOCKET_PATH: reviewedFillRouteSocketPath,
      ...(mode === "worker" ? { AGENT_WEB_URL: "", WEB_APP_URL: "", APPLYMATE_WEB_URL: "", AGENT_WORKER_SECRET: "",
        APPLICATION_TASK_FULL_LOOP_REVIEWED_FILL_ENDPOINT_URL: reviewedFillEndpointUrl,
        APPLICATION_TASK_FULL_LOOP_REVIEWED_FILL_SECRET: reviewedFillBridgeSecret } : {}),
      BULLMQ_STALLED_INTERVAL_MS: "30000",
      ...(mode === "worker" ? { APPLICATION_TASK_FULL_LOOP_USER_ID: ids.user } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  }) as Child
  Object.defineProperties(child, { lines: { value: [] }, errors: { value: [] } })
  for (const [stream, target] of [[child.stdout, child.lines], [child.stderr, child.errors]] as const) {
    let pending = ""
    stream?.setEncoding("utf8")
    stream?.on("data", chunk => {
      pending += String(chunk)
      const parts = pending.split("\n")
      pending = parts.pop() ?? ""
      target.push(...parts.map(line => line.trim()).filter(Boolean))
    })
  }
  return child
}

function spawnObjectiveTailorWaveFixture(scope: { userId: string; sessionId: string; turnId: string }): Child {
  const child = spawn(process.execPath, ["--import", "tsx", objectiveTailorWaveFixturePath, "resume", JSON.stringify(scope)], {
    cwd: workerCwd,
    env: { ...process.env, DATABASE_URL: databaseUrl!, AGENT_RUNTIME_PG_TEST_URL: databaseUrl!,
      REDIS_URL: redisUrl!, AGENT_TURN_REDIS_TEST_URL: redisUrl!, AGENT_RUNTIME_PG_TEST_REQUIRED: "true",
      AGENT_RUNTIME_PG_TEST_DISPOSABLE: "true", AGENT_TURN_REDIS_TEST_DISPOSABLE: "true",
      RUN_AGENT_TURN_REDIS_INTEGRATION: "1", ENABLE_AGENT_OBJECTIVE_TAILOR_WAVES: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  }) as Child
  Object.defineProperties(child, { lines: { value: [] }, errors: { value: [] } })
  for (const [stream, target] of [[child.stdout, child.lines], [child.stderr, child.errors]] as const) {
    let pending = ""
    stream?.setEncoding("utf8")
    stream?.on("data", chunk => {
      pending += String(chunk)
      const parts = pending.split("\n")
      pending = parts.pop() ?? ""
      target.push(...parts.map(line => line.trim()).filter(Boolean))
    })
  }
  return child
}

function exited(child: Child): boolean { return child.exitCode !== null || child.signalCode !== null }

function childSummary(child: Child) {
  return {
    exitCode: child.exitCode,
    signalCode: child.signalCode,
    stdoutLineCount: child.lines.length,
    stderrLineCount: child.errors.length,
  }
}

function fixtureStatsSummary(stats: FixtureStats) {
  return {
    submitCount: stats.submitCount,
    reviewedGetCount: stats.reviewedGetCount,
    blockedCount: stats.blocked.length,
    requestCount: stats.requests.length,
    browserTrace: stats.browserTrace,
    browserProgress: stats.browserProgress,
  }
}

function applicationFillExecutorTraces(child: Child | undefined, startIndex = 0): Array<ApplicationFillExecutorTrace | { traceInvalid: true }> {
  const prefix = "APPLICATION_FILL_EXEC_TRACE "
  const traces: Array<ApplicationFillExecutorTrace | { traceInvalid: true }> = []
  for (const line of (child?.lines ?? []).slice(startIndex)) {
    if (!line.startsWith(prefix)) continue
    try {
      const row = jsonRecord(JSON.parse(line.slice(prefix.length)))
      if (!row) {
        traces.push({ traceInvalid: true })
        continue
      }
      const attemptCount = row.attemptCount
      const executorInvocationOrdinal = row.executorInvocationOrdinal
      const elapsedMs = row.elapsedMs
      const booleans = [row.returned, row.threw, row.statusCompleted, row.statusWaiting, row.statusWaitingForUser,
        row.statusFailed, row.failureReasonLeaseLost, row.leaseSignalAbortedAtStart, row.leaseSignalAbortedAtEnd]
      if (!(attemptCount === null || typeof attemptCount === "number" && Number.isSafeInteger(attemptCount) && attemptCount >= 1)
        || typeof executorInvocationOrdinal !== "number" || !Number.isSafeInteger(executorInvocationOrdinal) || executorInvocationOrdinal < 1
        || typeof elapsedMs !== "number" || !Number.isSafeInteger(elapsedMs) || elapsedMs < 0
        || booleans.some(value => typeof value !== "boolean")) {
        traces.push({ traceInvalid: true })
        continue
      }
      traces.push({
        attemptCount, executorInvocationOrdinal, elapsedMs,
        returned: row.returned === true,
        threw: row.threw === true,
        statusCompleted: row.statusCompleted === true,
        statusWaiting: row.statusWaiting === true,
        statusWaitingForUser: row.statusWaitingForUser === true,
        statusFailed: row.statusFailed === true,
        failureReasonLeaseLost: row.failureReasonLeaseLost === true,
        leaseSignalAbortedAtStart: row.leaseSignalAbortedAtStart === true,
        leaseSignalAbortedAtEnd: row.leaseSignalAbortedAtEnd === true,
      })
    } catch {
      traces.push({ traceInvalid: true })
    }
  }
  return traces.slice(-12)
}

function applicationFillStageTraces(child: Child | undefined, startIndex = 0): Array<ApplicationFillStageTrace | { traceInvalid: true }> {
  const prefix = "APPLICATION_FILL_STAGE_TRACE ", keys = ["entryValidation", "waitPersistence", "completion", "accepted", "rejected", "waiting", "completed", "stale", "conflict", "failed", "cancelled", "unavailable", "leaseLost", "signalAborted"]
  const staleGates = ["lease_input_invalid", "session_scope", "turn_row_unavailable", "turn_status_queued", "turn_status_interrupted", "turn_status_terminal", "turn_status_other", "child_lease_fence", "application_task_scope"]
  const traces: Array<ApplicationFillStageTrace | { traceInvalid: true }> = []
  for (const line of (child?.lines ?? []).slice(startIndex)) {
    if (!line.startsWith(prefix)) continue
    try {
      const row = jsonRecord(JSON.parse(line.slice(prefix.length)))
      if (!row) {
        traces.push({ traceInvalid: true })
        continue
      }
      const hasStaleGate = Object.prototype.hasOwnProperty.call(row, "staleGate"), expectedKeys = [...keys, ...(hasStaleGate ? ["staleGate"] : [])]
      if (Object.keys(row).sort().join(",") !== expectedKeys.sort().join(",") || keys.some(key => typeof row[key] !== "boolean")
        || (hasStaleGate && (typeof row.staleGate !== "string" || !staleGates.includes(row.staleGate) || row.completion !== true || row.stale !== true))
        || (row.completion === true && row.stale === true && !hasStaleGate)) {
        traces.push({ traceInvalid: true })
        continue
      }
      traces.push({ ...Object.fromEntries(keys.map(key => [key, row[key] === true])), ...(hasStaleGate ? { staleGate: row.staleGate as ApplicationFillCompletionStaleGate } : {}) } as ApplicationFillStageTrace)
    } catch { traces.push({ traceInvalid: true }) }
  }
  return traces.slice(-24)
}

const APPLICATION_FILL_ACQUISITION_PHASES = new Set<ApplicationFillAcquisitionPhase>([
  "before_control_read", "before_pattern_read", "context_requested", "page_acquired", "navigation_returned",
  "navigation_response_success", "navigation_response_unavailable", "destination_allowed", "destination_rejected", "wait_detection_returned", "outer_wait_clear", "outer_wait_detected", "executor_started", "executor_wait_clear", "executor_wait_detected", "deterministic_flow_started", "deterministic_flow_review_ready", "deterministic_flow_wait", "deterministic_flow_other", "fill_returned", "callback_settled", "context_returned",
])

function applicationFillAcquisitionPhases(child: Child | undefined, startIndex = 0): Array<ApplicationFillPhaseTrace | { traceInvalid: true }> {
  const prefix = "APPLICATION_FILL_PHASE_TRACE "
  const traces: Array<ApplicationFillPhaseTrace | { traceInvalid: true }> = []
  for (const line of (child?.lines ?? []).slice(startIndex)) {
    if (!line.startsWith(prefix)) continue
    try {
      const row = jsonRecord(JSON.parse(line.slice(prefix.length)))
      if (!row || Object.keys(row).length !== 1 || !Object.hasOwn(row, "phase") || typeof row.phase !== "string"
        || !APPLICATION_FILL_ACQUISITION_PHASES.has(row.phase as ApplicationFillAcquisitionPhase)) {
        traces.push({ traceInvalid: true })
        continue
      }
      traces.push({ phase: row.phase as ApplicationFillAcquisitionPhase })
    } catch { traces.push({ traceInvalid: true }) }
  }
  return traces.slice(-24)
}

const APPLICATION_FILL_STALE_GATES: readonly ApplicationFillCompletionStaleGate[] = [
  "lease_input_invalid", "session_scope", "turn_row_unavailable", "turn_status_queued", "turn_status_interrupted",
  "turn_status_terminal", "turn_status_other", "child_lease_fence", "application_task_scope",
]

describe("ApplicationTask full-loop stage trace parser", () => {
  it.each(APPLICATION_FILL_STALE_GATES)("accepts the sanitized %s category", staleGate => {
    const trace: ApplicationFillStageTrace = {
      entryValidation: false, waitPersistence: false, completion: true,
      accepted: false, rejected: false, waiting: false, completed: false, stale: true,
      conflict: false, failed: false, cancelled: false, unavailable: false,
      leaseLost: true, signalAborted: false, staleGate,
    }
    const child = { lines: [`APPLICATION_FILL_STAGE_TRACE ${JSON.stringify(trace)}`] } as unknown as Child
    expect(applicationFillStageTraces(child)).toEqual([trace])
  })

  it("rejects an unlisted stale category", () => {
    const trace = {
      entryValidation: false, waitPersistence: false, completion: true,
      accepted: false, rejected: false, waiting: false, completed: false, stale: true,
      conflict: false, failed: false, cancelled: false, unavailable: false,
      leaseLost: true, signalAborted: false, staleGate: "unlisted_category",
    }
    const child = { lines: [`APPLICATION_FILL_STAGE_TRACE ${JSON.stringify(trace)}`] } as unknown as Child
    expect(applicationFillStageTraces(child)).toEqual([{ traceInvalid: true }])
  })
})

describe("ApplicationTask full-loop acquisition phase trace parser", () => {
  const phases: readonly ApplicationFillAcquisitionPhase[] = [
    "before_control_read", "before_pattern_read", "context_requested", "page_acquired", "navigation_returned",
    "navigation_response_success", "navigation_response_unavailable", "destination_allowed", "destination_rejected", "wait_detection_returned", "outer_wait_clear", "outer_wait_detected", "executor_started", "executor_wait_clear", "executor_wait_detected", "deterministic_flow_started", "deterministic_flow_review_ready", "deterministic_flow_wait", "deterministic_flow_other", "fill_returned", "callback_settled", "context_returned",
  ]

  it.each(phases)("accepts only the sanitized %s phase after the supplied offset", phase => {
    const lines = [
      "APPLICATION_FILL_PHASE_TRACE " + JSON.stringify({ phase: "fill_returned" }),
      "APPLICATION_FILL_PHASE_TRACE " + JSON.stringify({ phase }),
    ]
    expect(applicationFillAcquisitionPhases({ lines } as unknown as Child, 1)).toEqual([{ phase }])
  })

  it("rejects unknown phases and extra data, and caps the sequence", () => {
    const invalid = [
      "APPLICATION_FILL_PHASE_TRACE " + JSON.stringify({ phase: "private_phase" }),
      "APPLICATION_FILL_PHASE_TRACE " + JSON.stringify({ phase: "context_requested", url: "private" }),
    ]
    expect(applicationFillAcquisitionPhases({ lines: invalid } as unknown as Child)).toEqual([{ traceInvalid: true }, { traceInvalid: true }])
    const lines = Array.from({ length: 30 }, (_, index) =>
      "APPLICATION_FILL_PHASE_TRACE " + JSON.stringify({ phase: phases[index % phases.length] }))
    expect(applicationFillAcquisitionPhases({ lines } as unknown as Child)).toHaveLength(24)
  })
})

describe("reviewed source turn diagnostics", () => {
  it("keeps only bounded allowlisted fields", () => {
    const summary = reviewedSourceDiagnosticSummary(
      { status: "failed", error: "private root error detail" },
      [
        { role: "writer", status: "failed", failureReason: "application_fill_material_unavailable" },
        { role: "private role", status: "private status", failureReason: "private task error" },
      ],
      [
        { status: "completed", content: { toolName: "agent.plan", input: { text: "private source text" } } },
        { status: "private status", content: { toolName: "private.tool", arguments: { secret: "private" } } },
      ],
    )
    expect(summary).toEqual({
      root: { status: "failed", errorCode: "present" },
      tasks: [
        { role: "writer", status: "failed", failureCode: "application_fill_material_unavailable" },
        { role: "other", status: "other", failureCode: "present" },
      ],
      tools: [{ name: "agent.plan", status: "completed" }, { name: "other", status: "other" }],
    })
    expect(JSON.stringify(summary)).not.toContain("private")
  })
})

describe("ApplicationTask submit outbox diagnostic classifier", () => {
  it("preserves only fixed allowlisted outbox categories", () => {
    for (const category of SAFE_SUBMIT_OUTBOX_ERROR_CATEGORIES) {
      expect(diagnosticSubmitOutboxErrorCategory(category)).toBe(category)
    }
  })

  it("uses none for absent errors and other for unlisted values", () => {
    expect(diagnosticSubmitOutboxErrorCategory(null)).toBe("none")
    expect(diagnosticSubmitOutboxErrorCategory(undefined)).toBe("none")
    expect(diagnosticSubmitOutboxErrorCategory("unlisted_outbox_detail")).toBe("other")
    expect(diagnosticSubmitOutboxErrorCategory("terminal:unlisted_detail")).toBe("other")
    expect(diagnosticSubmitOutboxErrorCategory({ message: "raw error detail" })).toBe("other")
  })
})

describe("ApplicationTask submission attempt diagnostic classifier", () => {
  it("preserves only fixed allowlisted attempt error codes", () => {
    for (const errorCode of SAFE_SUBMISSION_ATTEMPT_ERROR_CODES) {
      expect(diagnosticSubmissionAttemptErrorCode(errorCode)).toBe(errorCode)
    }
  })

  it("uses null for absent errors and other for unlisted values", () => {
    expect(diagnosticSubmissionAttemptErrorCode(null)).toBeNull()
    expect(diagnosticSubmissionAttemptErrorCode(undefined)).toBeNull()
    expect(diagnosticSubmissionAttemptErrorCode("unlisted_attempt_detail")).toBe("other")
    expect(diagnosticSubmissionAttemptErrorCode({ message: "raw error detail" })).toBe("other")
  })
})

describe("legacy final gate bounded diagnostics", () => {
  it("recognizes only exact fixed post-release markers", () => {
    expect(legacyFinalGateMarkerPresence([
      "LEGACY_FINAL_RESPONSE_GATE_RESUMED",
      "LEGACY_FINAL_RESPONSE_MODEL_STREAM_COMPLETED turnId=private",
    ])).toEqual({ resumed: true, modelStreamCompleted: false })
    expect(legacyFinalGateMarkerPresence([
      "LEGACY_FINAL_RESPONSE_GATE_RESUMED",
      "LEGACY_FINAL_RESPONSE_MODEL_STREAM_COMPLETED",
    ])).toEqual({ resumed: true, modelStreamCompleted: true })
  })

  it("caps persisted counters and reports overflow without exposing records", () => {
    expect(boundedPersistedCount(11)).toEqual({ count: 8, overflow: true })
    expect(boundedPersistedCount(3)).toEqual({ count: 3, overflow: false })
  })
})

async function waitLine(child: Child, expected: string, timeoutMs = 30_000): Promise<string> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const line = child.lines.find(value => value === expected || value.startsWith(`${expected} `))
    if (line) return line
    if (exited(child)) throw new Error(`Fixture exited before ${expected}; child=${JSON.stringify(childSummary(child))}`)
    await delay(25)
  }
  throw new Error(`Fixture line ${expected} missing; child=${JSON.stringify(childSummary(child))}`)
}

async function armLegacyFinalResponseGate(turnId: string): Promise<void> {
  if (!worker?.stdin) throw new Error("Worker fixture stdin is unavailable")
  legacyFinalResponseGateTurnId = turnId
  worker.stdin.write("arm-legacy-final-response " + turnId + String.fromCharCode(10))
  await waitLine(worker, "LEGACY_FINAL_RESPONSE_GATE_ARMED", 5_000)
}

async function releaseLegacyFinalResponseGate(): Promise<void> {
  const turnId = legacyFinalResponseGateTurnId
  if (!turnId || !worker?.stdin || exited(worker)) { legacyFinalResponseGateTurnId = undefined; return }
  worker.stdin.write("release-legacy-final-response " + turnId + String.fromCharCode(10))
  try { await waitLine(worker, "LEGACY_FINAL_RESPONSE_GATE_RELEASED", 3_000) }
  finally { legacyFinalResponseGateTurnId = undefined }
}

async function expectLegacyFillTurnLeased(turnId: string): Promise<string> {
  const turn = await testDb.agentTurn.findUniqueOrThrow({ where: { id: turnId }, select: {
    userId: true, sessionId: true, rootTaskId: true, status: true, leaseOwnerId: true, leaseExpiresAt: true, completedAt: true,
  } })
  expect(turn).toMatchObject({ userId: ids.user, sessionId: ids.session, status: "in_progress", completedAt: null })
  const rootTaskId = turn.rootTaskId
  if (typeof rootTaskId !== "string" || !rootTaskId) throw new Error("Successor Fill Turn root identity is missing")
  const root = await testDb.subAgentTask.findFirst({ where: {
    id: rootTaskId, rootTaskId, sessionId: ids.session, turnId, parentTaskId: null,
  }, select: { id: true, rootTaskId: true, sessionId: true, turnId: true, parentTaskId: true, role: true, taskType: true, status: true } })
  expect(root).toMatchObject({ id: rootTaskId, rootTaskId, sessionId: ids.session, turnId, parentTaskId: null,
    role: "orchestrator", taskType: "root", status: "running" })
  expect(turn.leaseOwnerId).toEqual(expect.any(String))
  expect(turn.leaseExpiresAt).toBeInstanceOf(Date)
  expect(turn.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now())
  return rootTaskId
}
async function waitExit(child: Child, timeoutMs: number): Promise<boolean> {
  if (exited(child)) return true
  return new Promise(resolveExit => {
    const timer = setTimeout(() => resolveExit(false), timeoutMs)
    child.once("exit", () => { clearTimeout(timer); resolveExit(true) })
  })
}

async function stopFixture(child: Child | undefined): Promise<void> {
  if (!child || exited(child)) return
  child.stdin?.write("shutdown\n")
  if (!await waitExit(child, 10_000)) {
    child.kill("SIGKILL")
    if (!await waitExit(child, 1_000)) throw new Error("Fixture did not shut down cleanly")
    return
  }
  if (child.exitCode !== 0) throw new Error(`Fixture exited with nonzero status; child=${JSON.stringify(childSummary(child))}`)
}

async function signedBearer(userId: string): Promise<string> {
  return new SignJWT({ authVersion: 1 }).setProtectedHeader({ alg: "HS256" })
    .setIssuer(EXTENSION_TOKEN_ISSUER).setAudience(EXTENSION_TOKEN_AUDIENCE)
    .setSubject(userId).setIssuedAt().setExpirationTime("5m").sign(getAuthJwtSecret())
}

function apiRequest(path: string, token: string, method: "GET" | "PATCH" | "POST", body?: unknown,
  additionalHeaders: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { ...additionalHeaders, authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}

async function jsonResponse(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json()
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON API response")
  return value as Record<string, unknown>
}

async function answerResumeFailureCategory(response: Response): Promise<string> {
  try {
    const error = (await jsonResponse(response.clone())).error
    if (typeof error !== "string") return "unclassified"
    switch (error) {
      case "A complete job description is required before materials can be generated.": return "job_description_required"
      case "Application fill materials are unavailable for this task": return "command_preflight_materials_unavailable"
      case "Agent session is no longer waiting for user input": return "session_status_compare_and_set"
      case "Application fill attempt was claimed by another request": return "application_task_claim_compare_and_set"
      case "Application task is not ready to resume after persisted user answers": return "resume_task_not_ready"
      case "Application task is not waiting for persisted form answers": return "resume_answers_not_ready"
      case "The bound fill Turn has no durable form-answer wait": return "resume_wait_missing"
      case "Persist form answers for this wait before resuming": return "resume_answer_event_missing"
      case "The bound fill Turn is not durably waiting for user input": return "resume_turn_not_waiting"
      case "The prior fill Turn still owns an active execution lease": return "resume_turn_lease_active"
      case "The application filler must be durably waiting with no live browser lease": return "resume_filler_not_waiting"
      default: return "unclassified"
    }
  } catch {
    return "invalid_error_response"
  }
}

async function waitForTask(predicate: (task: ApplicationTaskRow) => boolean, timeoutMs = 120_000): Promise<ApplicationTaskRow> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const task = await testDb.applicationTask.findUnique({ where: { id: gateTaskId! } }) as ApplicationTaskRow | null
    if (task && predicate(task)) return task
    if (worker && exited(worker)) throw new Error(`Worker exited while waiting for task state; child=${JSON.stringify(childSummary(worker))}`)
    await delay(100)
  }
  const current = await testDb.applicationTask.findUnique({ where: { id: gateTaskId! } })
  let diagnostics: string
  try { diagnostics = JSON.stringify(await taskRuntimeDiagnostics(current as ApplicationTaskRow | null)) }
  catch { diagnostics = "diagnostics_unavailable" }
  throw new Error(`ApplicationTask state timeout: ${diagnostics}`)
}

async function waitForSubmissionTerminalProof(expected: {
  taskId: string
  userId: string
  jobId: string
  sessionId: string
  fillTurnId: string
  workerTaskId: string
  approvalId: string
  constraintHash: unknown
}, timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs
  let latestCount = 0
  while (Date.now() < until) {
    const proofs = await testDb.applicationTaskEvent.findMany({ where: {
      taskId: expected.taskId, type: "submission_terminal_observed", actor: "worker",
    }, select: { id: true, taskId: true, type: true, actor: true, data: true } })
    latestCount = proofs.length
    const proof = proofs[0]
    const data = jsonRecord(proof?.data)
    const attemptsMade = data?.attemptsMade
    const attempts = data?.attempts
    const exactProof = proofs.length === 1 && proof?.taskId === expected.taskId
      && proof.type === "submission_terminal_observed" && proof.actor === "worker"
      && data?.applicationTaskId === expected.taskId && data.userId === expected.userId
      && data.jobId === expected.jobId && data.sessionId === expected.sessionId
      && data.fillTurnId === expected.fillTurnId && data.workerTaskId === expected.workerTaskId
      && data.approvalId === expected.approvalId && data.receiptId === expected.approvalId
      && data.constraintHash === expected.constraintHash
      && (data.terminalState === "completed" || data.terminalState === "failed")
      && typeof attemptsMade === "number" && Number.isSafeInteger(attemptsMade) && attemptsMade >= 0
      && typeof attempts === "number" && Number.isSafeInteger(attempts) && attempts >= 1
      && (data.terminalState !== "failed" || attemptsMade >= attempts)
    if (exactProof) return proofs
    await delay(100)
  }
  throw new Error(`Timed out waiting for one exact Worker submission terminal proof; count=${latestCount}`)
}

async function matchingQueueJobs(queue: InstanceType<typeof Queue> | undefined, field: "turnId" | "taskId", id: string) {
  if (!queue) return []
  const jobs = await queue.getJobs(["waiting", "active", "delayed", "completed", "failed", "paused", "waiting-children", "prioritized"], 0, -1)
  return Promise.all(jobs.filter(job => jsonString(job.data, field) === id).map(async job => ({
    id: job.id ?? null, state: await job.getState(), attemptsMade: job.attemptsMade,
    attemptsStarted: job.attemptsStarted, stalledCounter: job.stalledCounter,
  })))
}

async function waitForStableTurnQueueJobs(turnId: string, stableMs = 750, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs
  let signature = ""
  let stableSince = Date.now()
  let latest: Awaited<ReturnType<typeof matchingQueueJobs>> = []
  while (Date.now() < until) {
    const [dispatch, jobs] = await Promise.all([
      testDb.agentOutbox.findUnique({
        where: { idempotencyKey: `turn-dispatch:${turnId}` },
        select: { publishedAt: true },
      }),
      matchingQueueJobs(turnQueue, "turnId", turnId),
    ])
    latest = jobs
    const nextSignature = JSON.stringify([...jobs].sort((left, right) => String(left.id).localeCompare(String(right.id))))
    if (nextSignature !== signature) {
      signature = nextSignature
      stableSince = Date.now()
    } else if (dispatch?.publishedAt && jobs.length > 0 && Date.now() - stableSince >= stableMs) {
      return jobs
    }
    await delay(100)
  }
  throw new Error(`Successor Turn queue publication did not stabilize; turnId=${turnId}; jobs=${JSON.stringify(latest)}`)
}

async function taskRuntimeDiagnostics(task: ApplicationTaskRow | null) {
  const turnId = task?.fillTurnId ?? null
  const taskId = task?.id ?? gateTaskId ?? null
  const [turn, turnDispatch, taskGraph, turnSteps, recentEvents, childDispatches, applicationTaskEvents, submitOutbox, applyJobs, sessionTurns, sessionSubagents, syntheticJob, submissionAttempts] = await Promise.all([
    turnId ? testDb.agentTurn.findUnique({ where: { id: turnId }, select: {
      id: true, source: true, status: true, rootTaskId: true, revision: true, error: true,
      leaseOwnerId: true, leaseExpiresAt: true, startedAt: true, completedAt: true,
    } }) : null,
    turnId ? testDb.agentOutbox.findUnique({ where: { idempotencyKey: `turn-dispatch:${turnId}` }, select: {
      id: true, publishedAt: true, attemptCount: true, lastError: true,
    } }) : null,
    turnId ? testDb.subAgentTask.findMany({ where: { sessionId: ids.session, turnId }, orderBy: { createdAt: "asc" }, select: {
      id: true, rootTaskId: true, parentTaskId: true, role: true, taskType: true, status: true,
      failureReason: true, attemptCount: true, leaseOwner: true, leaseExpiresAt: true, createdAt: true, updatedAt: true,
    } }) : [],
    turnId ? testDb.agentStep.findMany({ where: { sessionId: ids.session, turnId }, orderBy: { ordinal: "asc" }, select: {
      id: true, ordinal: true, status: true, errorCode: true, createdAt: true, completedAt: true,
    } }) : [],
    turnId ? testDb.agentEvent.findMany({ where: { sessionId: ids.session, turnId }, orderBy: { sequence: "desc" }, take: 12, select: {
      sequence: true, type: true, actor: true, taskId: true, itemId: true, correlationId: true, createdAt: true,
    } }) : [],
    testDb.agentOutbox.findMany({ where: { aggregateId: ids.session, topic: "agent.subagent.dispatch" }, orderBy: { createdAt: "asc" }, select: {
      idempotencyKey: true, publishedAt: true, attemptCount: true, lastError: true,
    } }),
    taskId ? testDb.applicationTaskEvent.findMany({ where: { taskId }, orderBy: { createdAt: "asc" }, select: {
      id: true, type: true, actor: true, createdAt: true, data: true,
    } }) : [],
    testDb.agentOutbox.findMany({ where: { aggregateId: ids.session, topic: "application.submit.dispatch" }, orderBy: { createdAt: "asc" }, select: {
      idempotencyKey: true, aggregateId: true, payload: true, publishedAt: true, attemptCount: true, lastError: true,
    } }),
    applyQueue ? applyQueue.getJobs(["waiting", "active", "delayed", "completed", "failed", "paused", "waiting-children", "prioritized"], 0, -1) : [],
    testDb.agentTurn.findMany({ where: { sessionId: ids.session }, select: { id: true } }),
    testDb.subAgentTask.findMany({ where: { sessionId: ids.session }, select: { id: true } }),
    testDb.job.findUnique({ where: { id: ids.job }, select: { status: true, workflowState: true } }),
    testDb.submissionAttempt.findMany({ where: { userId: ids.user, jobId: ids.job }, orderBy: { createdAt: "asc" }, select: {
      state: true, errorCode: true,
    } }),
  ])
  const [sessionTurnJobs, sessionSubagentJobs] = await Promise.all([
    Promise.all(sessionTurns.map(turnRow => matchingQueueJobs(turnQueue, "turnId", turnRow.id))),
    Promise.all(sessionSubagents.map(taskRow => matchingQueueJobs(subagentQueue, "taskId", taskRow.id))),
  ])
  const ownedApplyJobIds = new Set(submitOutbox.map(row => jsonString(row.payload, "workerTaskId")).filter((id): id is string => Boolean(id)))
  if (task?.workerTaskId) ownedApplyJobIds.add(task.workerTaskId)
  const applyQueueJobs = await Promise.all(applyJobs.filter(job => {
    const applicationTaskId = jsonString(job.data, "applicationTaskId")
    return (Boolean(job.id) && ownedApplyJobIds.has(job.id!)) || (taskId !== null && applicationTaskId === taskId)
  }).map(async job => ({
    id: job.id ?? null, state: await job.getState(), attemptsMade: job.attemptsMade,
    attemptsStarted: job.attemptsStarted, stalledCounter: job.stalledCounter,
  })))
  const fixtureStats = await requestFixtureStats().then(fixtureStatsSummary).catch(() => ({ errorPresent: true }))
  return {
    task: task ? {
      id: task.id, userId: task.userId, jobId: task.jobId, sessionId: task.sessionId, fillTurnId: turnId,
      status: task.status, checkpoint: task.checkpoint, waitId: jsonRecord(task.question)?.waitId ?? null,
      workerTaskId: task.workerTaskId ?? null, errorPresent: Boolean(task.error),
    } : null,
    syntheticJob: syntheticJob ? { status: syntheticJob.status, workflowState: syntheticJob.workflowState } : null,
    turn: turn ? {
      id: turn.id, source: turn.source, status: turn.status, rootTaskId: turn.rootTaskId, revision: turn.revision,
      errorPresent: Boolean(turn.error), leaseOwnerId: turn.leaseOwnerId, leaseExpiresAt: turn.leaseExpiresAt,
      startedAt: turn.startedAt, completedAt: turn.completedAt,
    } : null,
    turnDispatch: turnDispatch ? {
      id: turnDispatch.id, publishedAt: turnDispatch.publishedAt, attemptCount: turnDispatch.attemptCount,
      lastErrorPresent: Boolean(turnDispatch.lastError),
    } : null,
    turnQueueJobs: sessionTurns.flatMap((turnRow, index) => sessionTurnJobs[index]!.map(job => ({ turnId: turnRow.id, ...job }))),
    taskGraph: taskGraph.map(node => ({
      id: node.id, rootTaskId: node.rootTaskId, parentTaskId: node.parentTaskId, role: node.role, taskType: node.taskType,
      status: node.status, failureReasonCode: diagnosticMachineErrorCode(node.failureReason), attemptCount: node.attemptCount,
      leaseOwner: node.leaseOwner, leaseExpiresAt: node.leaseExpiresAt, createdAt: node.createdAt, updatedAt: node.updatedAt,
    })),
    subagentDispatches: childDispatches.map(({ idempotencyKey, publishedAt, attemptCount, lastError }) => ({
      idempotencyKey, publishedAt, attemptCount, lastErrorPresent: Boolean(lastError),
    })),
    subagentQueueJobs: sessionSubagents.flatMap((taskRow, index) => sessionSubagentJobs[index]!.map(job => ({ taskId: taskRow.id, ...job }))),
    turnSteps: turnSteps.map(step => ({
      id: step.id, ordinal: step.ordinal, status: step.status, errorCode: diagnosticMachineErrorCode(step.errorCode),
      createdAt: step.createdAt, completedAt: step.completedAt,
    })),
    applicationTaskEvents: applicationTaskEvents.map(({ data, ...event }) => {
      const safeData = jsonRecord(data)
      return { ...event, dataKeys: Object.keys(safeData ?? {}).sort(), waitIdPresent: typeof safeData?.waitId === "string" }
    }),
    submitOutbox: submitOutbox.map(({ idempotencyKey, aggregateId, payload, publishedAt, attemptCount, lastError }) => ({
      idempotencyKey, aggregateId, publishedAt, attemptCount,
      workerTaskId: jsonString(payload, "workerTaskId") ?? null,
      payloadKeys: Object.keys(jsonRecord(payload) ?? {}).sort(), lastErrorPresent: Boolean(lastError),
      lastErrorCategory: diagnosticSubmitOutboxErrorCategory(lastError),
    })),
    submissionAttempts: submissionAttempts.map(({ state, errorCode }) => ({
      state, errorCode: diagnosticSubmissionAttemptErrorCode(errorCode),
    })),
    applyQueueJobs,
    sessionTurnIds: sessionTurns.map(turnRow => turnRow.id), sessionSubagentTaskIds: sessionSubagents.map(taskRow => taskRow.id),
    recentEvents: recentEvents.map(event => ({ ...event, sequence: event.sequence.toString() })),
    fixtureStats,
    applicationFillExecutorTraces: applicationFillExecutorTraces(worker),
    applicationFillStageTraces: applicationFillStageTraces(worker),
    workerExited: worker ? exited(worker) : null,
    workerLineCount: worker?.lines.length ?? 0, workerErrorCount: worker?.errors.length ?? 0,
  }
}

let gateTaskId: string | undefined

async function submitQueueJobs() {
  return applyQueue!.getJobs(["waiting", "active", "delayed", "completed", "failed", "paused", "waiting-children", "prioritized"], 0, -1)
}

type ApplyJobActiveEvent = { jobId: string; attemptsMade: number; attemptsStarted: number; stalledCounter: number }

function parseApplyJobActiveEvent(line: string): ApplyJobActiveEvent | null {
  const match = /^APPLY_JOB_ACTIVE ([^ ]+) attemptsMade=(\d+) attemptsStarted=(\d+) stalledCounter=(\d+)$/.exec(line)
  if (!match) return null
  return { jobId: match[1]!, attemptsMade: Number(match[2]), attemptsStarted: Number(match[3]), stalledCounter: Number(match[4]) }
}

async function waitForWorkerRedelivery(child: Child, jobId: string, timeoutMs = 120_000): Promise<ApplyJobActiveEvent> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const redelivery = child.lines.map(parseApplyJobActiveEvent).find(event => event !== null && event.jobId === jobId
      && event.attemptsStarted >= 2 && event.stalledCounter >= 1)
    if (redelivery) return redelivery
    if (exited(child)) throw new Error(`Worker exited before BullMQ redelivered ${jobId}; child=${JSON.stringify(childSummary(child))}`)
    await delay(50)
  }
  const matchingEvents = child.lines.map(parseApplyJobActiveEvent).filter((event): event is ApplyJobActiveEvent => event?.jobId === jobId)
  const maxAttemptsStarted = matchingEvents.length ? Math.max(...matchingEvents.map(event => event.attemptsStarted)) : null
  const maxStalledCounter = matchingEvents.length ? Math.max(...matchingEvents.map(event => event.stalledCounter)) : null
  throw new Error(`BullMQ did not redeliver ${jobId}; matchingEventCount=${matchingEvents.length}; maxAttemptsStarted=${maxAttemptsStarted}; maxStalledCounter=${maxStalledCounter}`)
}

function jsonString(value: unknown, key: string): string | undefined {
  const field = jsonRecord(value)?.[key]
  return typeof field === "string" ? field : undefined
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

async function reviewedSourceStructuredResult(taskStatus: string, value: unknown, role: "writer" | "reviewer") {
  const { projectTaskGraphResult } = await import("../../../../../../worker/src/runtime/subagents/task-graph-result-projection")
  const projection = projectTaskGraphResult(role, taskStatus, value)
  if (projection.availability !== "available" || projection.role !== role) {
    throw new Error("reviewed_source_worker_result_invalid")
  }
  const result = jsonRecord(jsonRecord(value)?.structuredResult)
  if (!result || result.role !== role) throw new Error("reviewed_source_worker_result_invalid")
  return result
}

async function startReviewedFillRouteBridge(): Promise<void> {
  const { db } = await import("@/lib/db")
  reviewedFillRouteDb = db
  const { POST: reviewedFillRoute } = await import("@/app/api/internal/agent-runtime/reviewed-fill/route")
  dropNextReviewedFillAcknowledgement = true
  reviewedFillBridgeAttempts.length = 0
  await unlink(reviewedFillRouteSocketPath).catch(() => undefined)
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      if (incoming.method !== "POST" || incoming.url !== "/api/internal/agent-runtime/reviewed-fill") {
        outgoing.writeHead(404).end()
        return
      }
      const chunks: Buffer[] = []
      let length = 0
      for await (const chunk of incoming) {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        length += value.byteLength
        if (length > 1_024) {
          outgoing.writeHead(413).end()
          return
        }
        chunks.push(value)
      }
      const requestBody = Buffer.concat(chunks).toString("utf8")
      const body = jsonRecord(JSON.parse(requestBody))
      const outboxId = typeof body?.outboxId === "string" ? body.outboxId : null
      const hold = objectiveFillDeliveryHold
      const objectiveOutbox = hold && outboxId ? await testDb.agentOutbox.findUnique({ where: { id: outboxId },
        select: { id: true, topic: true, aggregateId: true, idempotencyKey: true, payload: true } }) : null
      const objectivePayload = jsonRecord(objectiveOutbox?.payload)
      if (hold && outboxId && objectiveOutbox?.topic === "agent.objective-reviewed-fill.dispatch"
        && objectiveOutbox.aggregateId === hold.sessionId
        && objectiveOutbox.idempotencyKey === `agent-objective-reviewed-fill:${hold.approvalId}`
        && objectivePayload?.sessionId === hold.sessionId && objectivePayload.approvalId === hold.approvalId) {
        if (!hold.reached) {
          hold.outboxId = outboxId
          hold.reached = true
        }
        await hold.released
      }
      const headers = new Headers()
      for (const name of ["content-type", "x-agent-worker-secret"] as const) {
        const value = incoming.headers[name]
        if (typeof value === "string") headers.set(name, value)
        else if (Array.isArray(value)) headers.set(name, value.join(","))
      }
      const routeResponse = await reviewedFillRoute(new NextRequest(new URL(incoming.url ?? "/", "http://127.0.0.1"), {
        method: "POST", headers, body: requestBody,
      }))
      const responseBody = await routeResponse.text()
      const ack = jsonRecord(JSON.parse(responseBody))
      const outbox = outboxId ? await testDb.agentOutbox.findUnique({ where: { id: outboxId }, select: { payload: true } }) : null
      const predecessorTurnId = jsonString(outbox?.payload, "predecessorTurnId")
      const predecessor = predecessorTurnId
        ? await testDb.agentTurn.findUnique({ where: { id: predecessorTurnId }, select: { status: true } }) : null
      const attempt: ReviewedFillBridgeAttempt = {
        outboxId, status: routeResponse.status,
        acknowledgement: typeof ack?.status === "string" ? ack.status : null,
        predecessorStatus: predecessor?.status ?? null,
        acknowledgementDropped: false,
      }
      const dropAcknowledgement = dropNextReviewedFillAcknowledgement
        && routeResponse.status === 200 && attempt.acknowledgement === "queued"
      if (dropAcknowledgement) {
        dropNextReviewedFillAcknowledgement = false
        attempt.acknowledgementDropped = true
      }
      reviewedFillBridgeAttempts.push(attempt)
      if (dropAcknowledgement) {
        outgoing.destroy()
        return
      }
      outgoing.writeHead(routeResponse.status, { "content-type": routeResponse.headers.get("content-type") ?? "application/json" })
      outgoing.end(responseBody)
    })().catch(() => {
      if (!outgoing.destroyed) outgoing.writeHead(500).end()
    })
  })
  reviewedFillBridgeServer = server
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen)
    server.listen(reviewedFillRouteSocketPath, resolveListen)
  })
}

async function stopReviewedFillRouteBridge(): Promise<void> {
  const server = reviewedFillBridgeServer
  reviewedFillBridgeServer = undefined
  if (!server) return
  let closeError: unknown
  try {
    await new Promise<void>((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()))
  } catch (error) {
    closeError = error
  } finally {
    await unlink(reviewedFillRouteSocketPath).catch(() => undefined)
  }
  if (closeError) throw closeError
}

function armObjectiveFillDeliveryHold(sessionId: string, approvalId: string): ObjectiveFillDeliveryHold {
  let release: (() => void) | null = null
  const released = new Promise<void>(resolveRelease => { release = resolveRelease })
  const hold: ObjectiveFillDeliveryHold = { sessionId, approvalId, outboxId: null, reached: false, release, released }
  objectiveFillDeliveryHold = hold
  return hold
}

async function waitForObjectiveFillDeliveryHold(hold: ObjectiveFillDeliveryHold, timeoutMs = 60_000): Promise<string> {
  const until = Date.now() + timeoutMs
  while (!hold.reached && Date.now() < until) {
    if (worker && exited(worker)) throw new Error("Worker exited before the exact Objective handoff was held")
    await delay(50)
  }
  if (!hold.reached || !hold.outboxId) throw new Error("Exact Objective handoff did not reach the delivery hold")
  return hold.outboxId
}

function releaseObjectiveFillDeliveryHold(hold: ObjectiveFillDeliveryHold): void {
  hold.release?.()
  hold.release = null
  if (objectiveFillDeliveryHold === hold) objectiveFillDeliveryHold = undefined
}

async function waitForReviewedFillBridgeRecoveryAttempts(outboxId: string, timeoutMs = 30_000): Promise<ReviewedFillBridgeAttempt[]> {
  const until = Date.now() + timeoutMs
  let attempts = reviewedFillBridgeAttempts.filter(attempt => attempt.outboxId === outboxId)
  while (attempts.filter(attempt => attempt.acknowledgement !== "deferred").length < 2 && Date.now() < until) {
    if (worker && exited(worker)) throw new Error("Worker exited before the reviewed-fill publisher retried the internal route")
    await delay(50)
    attempts = reviewedFillBridgeAttempts.filter(attempt => attempt.outboxId === outboxId)
  }
  if (attempts.filter(attempt => attempt.acknowledgement !== "deferred").length < 2) {
    throw new Error("reviewed_fill_publisher_retry_timeout")
  }
  return attempts
}

async function withObjectiveResumeAmbientAuth<T>(token: string, operation: () => Promise<T>): Promise<T> {
  const previous = objectiveResumeAmbientAuth.authorization
  objectiveResumeAmbientAuth.authorization = `Bearer ${token}`
  try { return await operation() }
  finally { objectiveResumeAmbientAuth.authorization = previous }
}

async function waitForOutboxPublished(outboxId: string, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs
  let outbox = await testDb.agentOutbox.findUnique({
    where: { id: outboxId }, select: { publishedAt: true, attemptCount: true },
  })
  while (!outbox?.publishedAt && Date.now() < until) {
    if (worker && exited(worker)) throw new Error("Worker exited before the outbox was marked published")
    await delay(50)
    outbox = await testDb.agentOutbox.findUnique({
      where: { id: outboxId }, select: { publishedAt: true, attemptCount: true },
    })
  }
  if (!outbox?.publishedAt) throw new Error("outbox_publish_timeout")
  return outbox
}

const ALL_QUEUE_STATES = ["waiting", "active", "delayed", "completed", "failed", "paused", "waiting-children", "prioritized"] as const
const CLEANUP_DEADLINE_EXCEEDED = "Scoped BullMQ cleanup deadline exceeded"
const queueDisconnects = new WeakMap<object, Promise<void>>()

function beforeDeadline<T>(operation: () => Promise<T>, deadlineAt: number): Promise<T> {
  const remainingMs = deadlineAt - Date.now()
  if (remainingMs <= 0) return Promise.reject(new Error(CLEANUP_DEADLINE_EXCEEDED))
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(CLEANUP_DEADLINE_EXCEEDED)), remainingMs)
  })
  let pending: Promise<T>
  try {
    pending = operation()
  } catch (error) {
    if (timer) clearTimeout(timer)
    return Promise.reject(error)
  }
  return Promise.race([pending, deadline]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function disconnectQueue(queue: InstanceType<typeof Queue>): Promise<void> {
  const existing = queueDisconnects.get(queue)
  if (existing) return existing
  const disconnecting = Promise.resolve().then(() => queue.disconnect()).catch(() => undefined)
  queueDisconnects.set(queue, disconnecting)
  return disconnecting
}

async function queueOperationBeforeDeadline<T>(
  queue: InstanceType<typeof Queue>,
  operation: () => Promise<T>,
  deadlineAt: number,
): Promise<T> {
  try {
    return await beforeDeadline(operation, deadlineAt)
  } catch (error) {
    if (error instanceof Error && error.message === CLEANUP_DEADLINE_EXCEEDED) void disconnectQueue(queue)
    throw error
  }
}

async function closeQueueWithinDeadline(
  queue: InstanceType<typeof Queue> | undefined,
  deadlineAt: number,
): Promise<void> {
  if (!queue) return
  try {
    await queueOperationBeforeDeadline(queue, () => queue.close(), deadlineAt)
  } catch (error) {
    await Promise.race([disconnectQueue(queue), delay(1_000)])
    throw error
  }
}

async function ownedQueueStateSnapshot(): Promise<Array<{ queue: string; id: string; state: string }>> {
  const [turns, subagentTasks, applyJobs, turnJobs, subagentJobs] = await Promise.all([
    testDb.agentTurn.findMany({ where: { sessionId: ids.session }, select: { id: true } }),
    testDb.subAgentTask.findMany({ where: { sessionId: ids.session }, select: { id: true } }),
    applyQueue?.getJobs(ALL_QUEUE_STATES, 0, -1) ?? Promise.resolve([]),
    turnQueue?.getJobs(ALL_QUEUE_STATES, 0, -1) ?? Promise.resolve([]),
    subagentQueue?.getJobs(ALL_QUEUE_STATES, 0, -1) ?? Promise.resolve([]),
  ])
  const turnIds = new Set(turns.map(row => row.id))
  const subagentTaskIds = new Set(subagentTasks.map(row => row.id))
  const owned = [
    { queue: "apply", jobs: applyJobs.filter(job => jsonString(job.data, "applicationTaskId") === gateTaskId) },
    { queue: "turn", jobs: turnJobs.filter(job => {
      const turnId = jsonString(job.data, "turnId")
      return turnId !== undefined && turnIds.has(turnId)
    }) },
    { queue: "subagent", jobs: subagentJobs.filter(job => {
      const taskId = jsonString(job.data, "taskId")
      return taskId !== undefined && subagentTaskIds.has(taskId)
    }) },
  ]
  const snapshots = await Promise.all(owned.flatMap(({ queue, jobs }) => jobs
    .filter((job): job is typeof job & { id: string } => Boolean(job.id))
    .map(async job => ({ queue, id: job.id, state: await job.getState() }))))
  return snapshots.sort((left, right) => left.queue.localeCompare(right.queue) || left.id.localeCompare(right.id))
}

async function waitForStableOwnedQueueState(stableMs = 750, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs
  let signature: string | undefined
  let stableSince = Date.now()
  let latest: Awaited<ReturnType<typeof ownedQueueStateSnapshot>> = []
  while (Date.now() < until) {
    latest = await ownedQueueStateSnapshot()
    const nextSignature = JSON.stringify(latest)
    if (nextSignature !== signature) {
      signature = nextSignature
      stableSince = Date.now()
    } else if (Date.now() - stableSince >= stableMs) {
      return latest
    }
    await delay(100)
  }
  throw new Error(`Owned BullMQ state did not stabilize; jobCount=${latest.length}`)
}

async function removeScopedQueueJobs(
  queue: InstanceType<typeof Queue> | undefined,
  isOwned: (job: { id?: string; data: unknown }) => boolean,
  deadlineAt: number,
): Promise<void> {
  if (!queue) return
  let pendingJobs = (await queueOperationBeforeDeadline(queue, () => queue.getJobs(ALL_QUEUE_STATES, 0, -1), deadlineAt))
    .filter(job => Boolean(job.id) && isOwned(job))
  while (pendingJobs.length > 0) {
    const results = await Promise.allSettled(pendingJobs.map(job => queueOperationBeforeDeadline(queue, () => job.remove(), deadlineAt)))
    pendingJobs = pendingJobs.filter((_, index) => results[index]?.status === "rejected")
    if (pendingJobs.length === 0) return
    const remainingMs = deadlineAt - Date.now()
    if (remainingMs <= 0) break
    await delay(Math.min(500, remainingMs))
  }
  if (pendingJobs.length > 0) throw new Error(CLEANUP_DEADLINE_EXCEEDED)
}

async function cleanRunArtifacts(): Promise<void> {
  if (!dbConnected) {
    await unlink(socketPath).catch(() => undefined)
    return
  }
  const sessionIds = [ids.session, ...reviewedSessionIds]
  const [submitOutbox, task, sessionTurns, sessionSubagents] = await Promise.all([
    testDb.agentOutbox.findMany({ where: { aggregateId: { in: sessionIds }, topic: "application.submit.dispatch" }, select: { payload: true } }),
    gateTaskId ? testDb.applicationTask.findUnique({ where: { id: gateTaskId }, select: { workerTaskId: true } }) : Promise.resolve(null),
    testDb.agentTurn.findMany({ where: { sessionId: { in: sessionIds } }, select: { id: true } }),
    testDb.subAgentTask.findMany({ where: { sessionId: { in: sessionIds } }, select: { id: true } }),
  ])
  const ownedSubmitJobIds = new Set(submitOutbox.map(row => jsonString(row.payload, "workerTaskId")).filter((id): id is string => Boolean(id)))
  if (task?.workerTaskId) ownedSubmitJobIds.add(task.workerTaskId)
  const ownedApplicationTaskIds = new Set((await testDb.applicationTask.findMany({
    where: { sessionId: { in: sessionIds } }, select: { id: true, workerTaskId: true },
  })).flatMap(row => [row.id, ...(row.workerTaskId ? [row.workerTaskId] : [])]))
  const ownedTurnIds = new Set(sessionTurns.map(turnRow => turnRow.id))
  const ownedSubagentTaskIds = new Set(sessionSubagents.map(taskRow => taskRow.id))
  const queueCleanupDeadline = Date.now() + 20_000
  const queueCleanup = await Promise.allSettled([
    removeScopedQueueJobs(applyQueue, job => {
      const applicationTaskId = jsonString(job.data, "applicationTaskId")
      return Boolean(job.id && ownedSubmitJobIds.has(job.id)) || Boolean(applicationTaskId && ownedApplicationTaskIds.has(applicationTaskId))
    }, queueCleanupDeadline),
    removeScopedQueueJobs(turnQueue, job => {
      const turnId = jsonString(job.data, "turnId")
      return turnId !== undefined && ownedTurnIds.has(turnId)
    }, queueCleanupDeadline),
    removeScopedQueueJobs(subagentQueue, job => {
      const taskId = jsonString(job.data, "taskId")
      return taskId !== undefined && ownedSubagentTaskIds.has(taskId)
    }, queueCleanupDeadline),
  ])
  const failedQueueCleanup = queueCleanup.some(result => result.status === "rejected")
  await testDb.agentOutbox.deleteMany({ where: { aggregateId: { in: sessionIds } } })
  if (reviewedJobIds.length) {
    await testDb.agentArtifact.deleteMany({ where: { userId: ids.user, jobId: { in: reviewedJobIds } } })
    await testDb.agentSession.deleteMany({ where: { id: { in: reviewedSessionIds }, userId: ids.user } })
    await testDb.job.deleteMany({ where: { id: { in: reviewedJobIds }, userId: ids.user } })
  }
  if (createdUsers.length) await testDb.user.deleteMany({ where: { id: { in: createdUsers } } })
  await unlink(socketPath).catch(() => undefined)
  if (failedQueueCleanup) throw new Error("Scoped BullMQ cleanup left owned jobs behind")
}

async function assertNoSubmitBeforeApproval(): Promise<void> {
  expect(await submitQueueJobs()).toHaveLength(0)
  const outbox = await testDb.agentOutbox.count({ where: { topic: "application.submit.dispatch", aggregateId: ids.session } })
  expect(outbox).toBe(0)
  expect(await requestFixtureStats()).toMatchObject({ submitCount: 0, blocked: [] })
}

async function waitForAgentTurnTerminal(turnId: string, timeoutMs = 180_000) {
  const until = Date.now() + timeoutMs
  let latest: { status: string; error: string | null } | null = null
  while (Date.now() < until) {
    latest = await testDb.agentTurn.findUnique({ where: { id: turnId }, select: { status: true, error: true } })
    if (latest && ["completed", "failed", "cancelled", "interrupted"].includes(latest.status)) return latest
    if (worker && exited(worker)) throw new Error("Worker exited while waiting for a canonical Turn")
    await delay(100)
  }
  throw new Error(`Canonical Turn did not reach terminal state; status=${latest?.status ?? "missing"}`)
}

async function waitForReviewedApproval(approvalId: string, timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const approval = await testDb.agentApproval.findUnique({ where: { id: approvalId } })
    if (approval) return approval
    if (worker && exited(worker)) throw new Error("Worker exited while waiting for reviewed approval")
    await delay(100)
  }
  throw new Error("Worker did not issue the reviewed-application approval")
}

async function waitForReviewedApplicationTask(jobId: string, predicate: (task: ApplicationTaskRow) => boolean, timeoutMs = 120_000): Promise<ApplicationTaskRow> {
  const until = Date.now() + timeoutMs
  let latest: ApplicationTaskRow | null = null
  while (Date.now() < until) {
    latest = await testDb.applicationTask.findUnique({ where: { userId_jobId: { userId: ids.user, jobId } } }) as ApplicationTaskRow | null
    if (latest && predicate(latest)) return latest
    if (worker && exited(worker)) throw new Error("Worker exited while waiting for reviewed ApplicationTask")
    await delay(100)
  }
  throw new Error(`Reviewed ApplicationTask did not reach the expected state; status=${latest?.status ?? "missing"}; checkpoint=${latest?.checkpoint ?? "missing"}`)
}

const REVIEWED_FILL_DIAGNOSTIC_STATUSES = new Set([
  "queued", "in_progress", "running", "waiting", "waiting_for_user", "waiting_for_approval", "waiting_for_dependency",
  "waiting_for_authorization", "filling", "completed", "submitted", "failed", "cancelled", "interrupted", "retrying",
])
const REVIEWED_FILL_DIAGNOSTIC_CHECKPOINTS = new Set([
  "materials_ready", "taskgraph_fill_queued", "browser_active", "form_answer_required", "fill_outcome_uncertain",
  "form_filled", "submission_authorized", "submission_request_started", "submission_uncertain", "submission_verified",
  "queue_retry", "turn_stopped_before_submit", "fill_prestart_failed",
])

function reviewedFillDiagnosticValue(value: unknown, allowed: ReadonlySet<string>): string {
  return value === null || value === undefined ? "none" : typeof value === "string" && allowed.has(value) ? value : "other"
}

async function reviewedFillTimeoutSnapshot(input: {
  sessionId: string; jobId: string; applicationTaskId: string; fillTurnId: string; traceOffset: number; reviewedGetBaseline: number
}) {
  const stats = await requestFixtureStats(300).catch(() => null)
  const fixture = stats ? {
    available: true,
    reviewedPageGetObserved: stats.reviewedGetCount > input.reviewedGetBaseline,
    exactReviewedCoverLetterObserved: stats.reviewedMaterialExactCount > 0,
    noReviewedSubmitRequest: stats.reviewedSubmitCount === 0 && !stats.requests.includes("POST /example-reviewed/jobs/1"),
  } : { available: false }
  const runtime = {
    executor: applicationFillExecutorTraces(worker, input.traceOffset).slice(-4),
    stages: applicationFillStageTraces(worker, input.traceOffset).slice(-6),
    phases: applicationFillAcquisitionPhases(worker, input.traceOffset).slice(-16),
    workerExited: worker ? exited(worker) : null,
  }
  try {
    return await beforeDeadline(async () => {
      const task = await testDb.applicationTask.findUnique({ where: { userId_jobId: { userId: ids.user, jobId: input.jobId } } }) as ApplicationTaskRow | null
      const taskBound = Boolean(task && task.id === input.applicationTaskId && task.userId === ids.user
        && task.sessionId === input.sessionId && task.jobId === input.jobId && task.fillTurnId === input.fillTurnId)
      if (!task || !taskBound) return { databaseSnapshotAvailable: true, applicationTaskBound: taskBound, fixture, runtime }
      const turn = await testDb.agentTurn.findFirst({ where: {
        id: input.fillTurnId, userId: ids.user, sessionId: input.sessionId, session: { userId: ids.user },
      }, select: { status: true, rootTaskId: true, error: true } })
      const [root, fillers, events] = await Promise.all([
        turn?.rootTaskId ? testDb.subAgentTask.findFirst({ where: {
          id: turn.rootTaskId, rootTaskId: turn.rootTaskId, sessionId: input.sessionId, turnId: input.fillTurnId,
          parentTaskId: null, role: "orchestrator", taskType: "root", session: { userId: ids.user },
        }, select: { status: true, failureReason: true } }) : Promise.resolve(null),
        turn?.rootTaskId ? testDb.subAgentTask.findMany({ where: {
          sessionId: input.sessionId, turnId: input.fillTurnId, rootTaskId: turn.rootTaskId,
          role: "application_filler", taskType: "application_fill_for_review", session: { userId: ids.user },
        }, orderBy: { createdAt: "asc" }, take: 4, select: { status: true, failureReason: true } }) : Promise.resolve([]),
        testDb.applicationTaskEvent.findMany({ where: { taskId: task.id, actor: "worker",
          type: { in: ["reviewed_application_fill_browser_started", "form_filled"] } }, take: 4, select: { type: true } }),
      ])
      return {
        databaseSnapshotAvailable: true, applicationTaskBound: true,
        applicationTask: { status: reviewedFillDiagnosticValue(task.status, REVIEWED_FILL_DIAGNOSTIC_STATUSES),
          checkpoint: reviewedFillDiagnosticValue(task.checkpoint, REVIEWED_FILL_DIAGNOSTIC_CHECKPOINTS), errorPresent: Boolean(task.error) },
        turn: { status: reviewedFillDiagnosticValue(turn?.status, REVIEWED_FILL_DIAGNOSTIC_STATUSES), errorCategory: diagnosticMachineErrorCode(turn?.error) },
        root: { present: root !== null, status: reviewedFillDiagnosticValue(root?.status, REVIEWED_FILL_DIAGNOSTIC_STATUSES),
          failureCategory: diagnosticMachineErrorCode(root?.failureReason) },
        fillers: fillers.map(filler => ({ status: reviewedFillDiagnosticValue(filler.status, REVIEWED_FILL_DIAGNOSTIC_STATUSES),
          failureCategory: diagnosticMachineErrorCode(filler.failureReason) })),
        events: { browserStarted: events.some(event => event.type === "reviewed_application_fill_browser_started"),
          formFilled: events.some(event => event.type === "form_filled") },
        fixture, runtime,
      }
    }, Date.now() + 1_200)
  } catch {
    return { databaseSnapshotAvailable: false, fixture, runtime }
  }
}

async function createReviewedSourceScenario(label: "positive" | "stale", description: string) {
  const jobId = `full-loop-reviewed-job-${runId}-${label}`
  const sessionId = `full-loop-reviewed-session-${runId}-${label}`
  reviewedJobIds.push(jobId)
  reviewedSessionIds.push(sessionId)
  await testDb.job.create({ data: {
    id: jobId, userId: ids.user, company: "ApplyMate Synthetic Fixture Employer", role: "Software Engineer", location: "Dublin",
    url: "https://boards.greenhouse.io/example-reviewed/jobs/1", description, keywords: "TypeScript", score: 92,
    workflowState: "ready_to_apply", status: "saved",
  } })
  await testDb.agentSession.create({ data: { id: sessionId, userId: ids.user, goal: `Isolated reviewed fill ${label}`, status: "running", source: "application_full_loop_reviewed" } })
  return { jobId, sessionId }
}

async function startSelectedJobSource(input: { sessionId: string; jobId: string; token: string; key: string }) {
  const { POST } = await import("@/app/api/agent/sessions/[id]/messages/route")
  const response = await POST(apiRequest(`/api/agent/sessions/${input.sessionId}/messages`, input.token, "POST", {
    clientMessageId: input.key, delivery: "follow_up",
    content: [{ type: "text", text: reviewedSourceGoal }], selectedJobPreparation: { jobId: input.jobId },
  }), { params: Promise.resolve({ id: input.sessionId }) })
  expect(response.status).toBe(202)
  const body = await jsonResponse(response)
  expect(typeof body.turnId).toBe("string")
  const turnId = body.turnId as string
  const terminal = await waitForAgentTurnTerminal(turnId)
  if (terminal.status !== "completed") {
    const diagnostics = await reviewedSourceTurnDiagnostics(input.sessionId, turnId)
    throw new Error(`selected_job_source_turn_not_completed ${JSON.stringify(diagnostics)}`)
  }
  const turn = await testDb.agentTurn.findUniqueOrThrow({ where: { id: turnId } })
  expect(turn).toMatchObject({ source: "user", status: "completed", executionMode: "canonical_task_graph" })
  expect(turn.input).toMatchObject({ selectedJobPreparation: { jobId: input.jobId } })
  return { turnId, turn }
}

async function startReviewedApplicationReview(input: { sessionId: string; sourceTurnId: string; token: string; key: string }) {
  const { POST } = await import("@/app/api/agent/sessions/[id]/reviewed-application-review/route")
  const path = `/api/agent/sessions/${input.sessionId}/reviewed-application-review`
  const response = await POST(apiRequest(path, input.token, "POST", {
    sourceTurnId: input.sourceTurnId, idempotencyKey: input.key,
  }), { params: Promise.resolve({ id: input.sessionId }) })
  return { response, body: await jsonResponse(response) }
}

async function startObjectiveApplicationReview(input: { sessionId: string; token: string; key: string; selection: unknown }) {
  const { POST } = await import("@/app/api/agent/sessions/[id]/objective-application-review/route")
  const path = `/api/agent/sessions/${input.sessionId}/objective-application-review`
  const response = await POST(apiRequest(path, input.token, "POST", { idempotencyKey: input.key, selection: input.selection }), {
    params: Promise.resolve({ id: input.sessionId }),
  })
  return { response, body: await jsonResponse(response) }
}

async function readObjectiveApplicationReviewSnapshot(input: { sessionId: string; turnId: string; token: string }) {
  const { GET } = await import("@/app/api/agent/sessions/[id]/objective-application-review/[turnId]/route")
  const path = `/api/agent/sessions/${input.sessionId}/objective-application-review/${input.turnId}`
  const response = await GET(apiRequest(path, input.token, "GET"), {
    params: Promise.resolve({ id: input.sessionId, turnId: input.turnId }),
  })
  return { response, body: await jsonResponse(response) }
}

async function waitForObjectiveApplicationReviewSnapshot(
  input: { sessionId: string; turnId: string; token: string }, predicate: (snapshot: Record<string, unknown>) => boolean,
  timeoutMs = 120_000,
): Promise<Record<string, unknown>> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const current = await readObjectiveApplicationReviewSnapshot(input)
    const snapshot = jsonRecord(current.body.snapshot)
    if (current.response.status === 200 && snapshot && predicate(snapshot)) return snapshot
    if (worker && exited(worker)) throw new Error("Worker exited while waiting for Objective review snapshot")
    await delay(100)
  }
  throw new Error("Objective review snapshot did not reach the expected state")
}

describeWithServices("ApplicationTask production full-loop PostgreSQL integration", () => {
  beforeAll(async () => {
    // This fixture creates a TaskGraph-bound fill; exercise the matching production PATCH route.
    priorApplicationFillTaskGraph = process.env.ENABLE_APPLICATION_FILL_TASKGRAPH
    process.env.ENABLE_APPLICATION_FILL_TASKGRAPH = "1"
    checkTlsAndIsolation()
    if (!enabled) return
    await Promise.all(tlsPaths.map(name => access(process.env[name]!)))
    await assertEgressBlocked()
    applyQueue = new Queue("apply-tasks", { connection: { host: "127.0.0.1", port: 6379, db: 15 } })
    turnQueue = new Queue("agent-turns", { connection: { host: "127.0.0.1", port: 6379, db: 15 } })
    subagentQueue = new Queue("agent-subagents", { connection: { host: "127.0.0.1", port: 6379, db: 15 } })
    priorAgentWorkerSecret = process.env.AGENT_WORKER_SECRET
    process.env.AGENT_WORKER_SECRET = reviewedFillBridgeSecret
    agentWorkerSecretOverridden = true
    priorDatabaseUrl = process.env.DATABASE_URL
    process.env.DATABASE_URL = databaseUrl!
    databaseUrlOverridden = true
    await testDb.$connect()
    dbConnected = true
    await startReviewedFillRouteBridge()
    site = spawnFixture("site")
    await waitLine(site, "FIXTURE_READY")
    worker = spawnFixture("worker")
    await waitLine(worker, "WORKER_READY", 90_000)
  }, 120_000)

  afterAll(async () => {
    let cleanupError: unknown
    if (objectiveFillDeliveryHold) releaseObjectiveFillDeliveryHold(objectiveFillDeliveryHold)
    try { await releaseLegacyFinalResponseGate() } catch (error) { cleanupError = error }
    try { await stopFixture(worker) } catch (error) { cleanupError ??= error }
    try { await stopFixture(site) } catch (error) { cleanupError ??= error }
    try { await stopReviewedFillRouteBridge() } catch (error) { cleanupError ??= error }
    try { await cleanRunArtifacts() } catch (error) { cleanupError ??= error }
    const queueCloseDeadline = Date.now() + 4_000
    try { await closeQueueWithinDeadline(applyQueue, queueCloseDeadline) } catch (error) { cleanupError ??= error }
    try { await closeQueueWithinDeadline(turnQueue, queueCloseDeadline) } catch (error) { cleanupError ??= error }
    try { await closeQueueWithinDeadline(subagentQueue, queueCloseDeadline) } catch (error) { cleanupError ??= error }
    try { await reviewedFillRouteDb?.$disconnect() } catch (error) { cleanupError ??= error }
    try { await testDb.$disconnect(); dbConnected = false } catch (error) { cleanupError ??= error }
    if (databaseUrlOverridden) {
      if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = priorDatabaseUrl
    }
    if (agentWorkerSecretOverridden) {
      if (priorAgentWorkerSecret === undefined) delete process.env.AGENT_WORKER_SECRET
      else process.env.AGENT_WORKER_SECRET = priorAgentWorkerSecret
    }
    if (priorApplicationFillTaskGraph === undefined) delete process.env.ENABLE_APPLICATION_FILL_TASKGRAPH
    else process.env.ENABLE_APPLICATION_FILL_TASKGRAPH = priorApplicationFillTaskGraph
    if (cleanupError) throw cleanupError
  }, 60_000)

  it("runs Gate → authenticated form answer → scoped submit approval → durable BullMQ/Worker with uncertain-submit no-replay", async () => {
    let postReleaseDiagnosticTurnId: string | null = null
    onTestFailed(async () => {
      let snapshot: unknown
      try {
        if (dbConnected && postReleaseDiagnosticTurnId) {
          snapshot = await postReleaseFinalGateDiagnostics(postReleaseDiagnosticTurnId)
        } else if (dbConnected) {
          const current = gateTaskId
            ? await testDb.applicationTask.findUnique({ where: { id: gateTaskId } }) as ApplicationTaskRow | null
            : null
          snapshot = await taskRuntimeDiagnostics(current)
        } else {
          snapshot = {
            dbConnected,
            fixtureStats: await requestFixtureStats().then(fixtureStatsSummary).catch(() => ({ errorPresent: true })),
            applicationFillExecutorTraces: applicationFillExecutorTraces(worker),
            applicationFillStageTraces: applicationFillStageTraces(worker),
            workerExited: worker ? exited(worker) : null,
            worker: worker ? childSummary(worker) : null,
            site: site ? childSummary(site) : null,
          }
        }
      } catch {
        snapshot = { diagnosticErrorPresent: true }
      }
      process.stderr.write(`APPLICATION_TASK_FULL_LOOP_FAILURE ${JSON.stringify(snapshot)}\n`)
    })
    checkTlsAndIsolation()
    const [{ db }, { runGate }, { AgentCommandService }, { formAnswerKeyForSelector }] = await Promise.all([
      import("@/lib/db"), import("@/lib/agent/stages/gate"),
      import("@/lib/agent/control-plane/commands/agent-command-service"),
      import("../../../../../../worker/src/form-answer-key"),
    ])
    expect(db).toBeDefined()
    const primaryUser = await testDb.user.create({ data: {
      id: ids.user, email: candidateEmail, name: candidateName, plan: "pro",
      phone: "+353000000000", location: "Dublin", personaFields: [
        { key: "firstName", value: "A" }, { key: "lastName", value: "B" },
      ],
    } })
    createdUsers = [primaryUser.id]
    const foreignUser = await testDb.user.create({ data: { id: ids.foreignUser, email: `${ids.foreignUser}@example.test`, name: "Other Candidate", plan: "pro" } })
    createdUsers.push(foreignUser.id)
    const job = await testDb.job.create({ data: {
      id: ids.job, userId: ids.user, company: "ApplyMate Synthetic Fixture Employer", role: "Software Engineer", location: "Dublin",
      url: "https://boards.greenhouse.io/example/jobs/1", description: "Synthetic role description for isolated form-fill testing.", keywords: "TypeScript", score: 92,
      workflowState: "ready_to_apply", status: "saved",
    } })
    const resume = await testDb.resume.create({ data: {
      id: ids.resume, userId: ids.user, name: "Synthetic Resume", isDefault: true,
      content: { basics: { name: candidateName, email: primaryUser.email }, experience: [], education: [], skills: [] },
    } })
    await testDb.agentSession.create({ data: { id: ids.session, userId: ids.user, goal: "Create and safely complete a synthetic job application", status: "running", source: "application_full_loop" } })
    await testDb.agentTurn.create({ data: {
      id: ids.gateTurn, userId: ids.user, sessionId: ids.session, source: "user", status: "waiting_for_approval",
      input: { goal: "Review synthetic application materials" }, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {},
    } })
    await testDb.agentExecution.create({ data: {
      id: ids.execution, userId: ids.user, sessionId: ids.session, status: "running", checkpoint: "gate", attemptCount: 1,
    } })

    const gateContext: PipelineCtx = {
      userId: ids.user, sessionId: ids.session, turnId: ids.gateTurn, executionAttempt: { id: ids.execution, attemptCount: 1 },
      agentCfg: {
        id: `full-loop-config-${runId}`, userId: ids.user, isRunning: true, dailyLimit: 3, minMatchScore: 70,
        autoApply: false, requireApproval: true, targetLocations: ["Dublin"], targetRoles: ["Software Engineer"],
        excludeCompanies: [], priorityCompanies: [], autoCoverLetter: false, coverTone: "professional",
        useTailoredCV: false, model: "fixture",
      },
      roleConfigs: {} as PipelineCtx["roleConfigs"], resumeText: "Synthetic candidate resume",
      resumeContent: resume.content as unknown as PipelineCtx["resumeContent"], defaultResume: { id: resume.id, name: resume.name, templateId: null,
        templateOptions: null, directionId: null, basicsDetached: false }, aiConfig: { provider: "minimax", model: "fixture" }, autonomous: true,
      signal: new AbortController().signal, emit: () => undefined,
    }
    const gatePackage: ApplicationPackage = {
      job, score: 92, matchedKeywords: ["TypeScript"], missingKeywords: [],
      recommendation: "Strong synthetic match; continue to a user-reviewed fill.",
    }
    const gateResult = await runGate([gatePackage], gateContext)
    expect(gateResult).toBeTruthy()
    const gateTask = await testDb.applicationTask.findUnique({ where: { userId_jobId: { userId: ids.user, jobId: ids.job } } })
    expect(gateTask).toMatchObject({ userId: ids.user, jobId: ids.job, sessionId: ids.session, status: "waiting_for_user", checkpoint: "materials_ready" })
    gateTaskId = gateTask!.id
    expect(await testDb.applicationTaskEvent.count({ where: { taskId: gateTaskId, type: "materials_ready" } })).toBe(1)
    expect(await testDb.agentApproval.count({ where: { userId: ids.user, sessionId: ids.session, type: "review_application", status: "pending" } })).toBe(1)

    // runGate owns ApplicationTask creation. The synthetic Gate Turn is then explicitly closed before the
    // production command starts the TaskGraph fill; this does not exercise the initial Gate approval route.
    await testDb.agentTurn.update({ where: { id: ids.gateTurn }, data: { status: "completed", completedAt: new Date() } })
    await testDb.agentExecution.update({ where: { id: ids.execution }, data: { status: "completed", completedAt: new Date() } })
    const fillCommand = await new AgentCommandService(db).startApplicationFillForReview({
      sessionId: ids.session, userId: ids.user, applicationTaskId: gateTaskId,
      clientMessageId: `full-loop-fill-${runId}`,
    })
    expect(fillCommand.disposition).toBe("started")
    const firstFillTurnId = fillCommand.turnId
    expect(firstFillTurnId).toBeTruthy()

    const waitingTask = await waitForTask(task => task.status === "waiting_for_user" && task.checkpoint === "form_answer_required")
    expect(waitingTask.id).toBe(gateTaskId)
    expect(waitingTask.fillTurnId).toBe(firstFillTurnId)
    expect((await requestFixtureStats()).requests.filter(request => request === "GET /example/jobs/1").length).toBeGreaterThanOrEqual(2)
    const question = waitingTask.question as { waitId?: unknown; missing?: Array<{ key: string | null; label: string }>; sensitive?: Array<{ key: string | null; label: string }> }
    expect(typeof question.waitId).toBe("string")
    expect(question.waitId).not.toBe("")
    const field = [...(question.missing ?? []), ...(question.sensitive ?? [])].find(value => value.label.includes("authorized to work"))
    expect(field?.key).toBe(formAnswerKeyForSelector("work_authorization", "work_authorization"))
    const formAnswerEvents = await testDb.applicationTaskEvent.findMany({
      where: { taskId: gateTaskId, type: "form_answer_required" },
      select: { id: true, taskId: true, type: true, actor: true, data: true },
    })
    expect(formAnswerEvents).toHaveLength(1)
    expect(formAnswerEvents[0]).toMatchObject({ taskId: gateTaskId, type: "form_answer_required", actor: "worker" })
    const formAnswerEventData = jsonRecord(formAnswerEvents[0]!.data)
    if (formAnswerEventData && Object.prototype.hasOwnProperty.call(formAnswerEventData, "waitId")) {
      expect(formAnswerEventData.waitId).toBe(question.waitId)
    }
    expect(await testDb.agentTurn.findUnique({ where: { id: firstFillTurnId }, select: { status: true } })).toMatchObject({ status: "waiting_for_user" })
    await assertNoSubmitBeforeApproval()

    const ownerToken = await signedBearer(ids.user)
    const foreignToken = await signedBearer(ids.foreignUser)
    const { PATCH: answerApplicationTask } = await import("@/app/api/agent/application-tasks/route")
    const answerPath = "/api/agent/application-tasks"
    const baselineEvents = await testDb.applicationTaskEvent.count({ where: { taskId: gateTaskId } })
    const baselineTurns = await testDb.agentTurn.count({ where: { sessionId: ids.session } })
    const queuesBeforeRejectedAnswers = await waitForStableOwnedQueueState()
    const turnDispatchWhere = { aggregateId: ids.session, topic: "agent.turn.dispatch" }
    const turnDispatchSnapshot = () => testDb.agentOutbox.findMany({
      where: turnDispatchWhere,
      orderBy: { createdAt: "asc" },
      select: {
        id: true, aggregateId: true, topic: true, idempotencyKey: true, payload: true,
        publishedAt: true, attemptCount: true, lastError: true, createdAt: true,
      },
    })
    const baselineTurnDispatches = await turnDispatchSnapshot()
    expect(baselineTurnDispatches).toHaveLength(1)
    expect(baselineTurnDispatches[0]).toMatchObject({
      aggregateId: ids.session,
      topic: "agent.turn.dispatch",
      idempotencyKey: `turn-dispatch:${firstFillTurnId}`,
      payload: { turnId: firstFillTurnId, sessionId: ids.session },
      publishedAt: expect.any(Date),
      attemptCount: expect.any(Number),
      lastError: null,
    })
    const taskBeforeRejectedAnswers = await testDb.applicationTask.findUnique({ where: { id: gateTaskId } })
    expect(taskBeforeRejectedAnswers).not.toBeNull()
    const stale = await answerApplicationTask(apiRequest(answerPath, ownerToken, "PATCH", {
      id: gateTaskId, action: "answer_and_resume", waitId: `${String(question.waitId)}-stale`, answers: { [field!.key!]: "Yes" },
    }))
    expect(stale.status).toBe(409)
    expect(await testDb.applicationTask.findUnique({ where: { id: gateTaskId } })).toEqual(taskBeforeRejectedAnswers)
    expect(await ownedQueueStateSnapshot()).toEqual(queuesBeforeRejectedAnswers)
    expect(await turnDispatchSnapshot()).toEqual(baselineTurnDispatches)
    const foreign = await answerApplicationTask(apiRequest(answerPath, foreignToken, "PATCH", {
      id: gateTaskId, action: "answer_and_resume", waitId: question.waitId, answers: { [field!.key!]: "Yes" },
    }))
    expect([404, 409]).toContain(foreign.status)
    expect(await testDb.applicationTask.findUnique({ where: { id: gateTaskId } })).toEqual(taskBeforeRejectedAnswers)
    expect(await ownedQueueStateSnapshot()).toEqual(queuesBeforeRejectedAnswers)
    expect(await turnDispatchSnapshot()).toEqual(baselineTurnDispatches)
    expect(await testDb.applicationTaskEvent.count({ where: { taskId: gateTaskId } })).toBe(baselineEvents)
    expect(await testDb.agentTurn.count({ where: { sessionId: ids.session } })).toBe(baselineTurns)
    expect(await submitQueueJobs()).toHaveLength(0)

    const answerBody = { id: gateTaskId, action: "answer_and_resume", waitId: question.waitId, answers: { [field!.key!]: "Yes" } }
    const answered = await answerApplicationTask(apiRequest(answerPath, ownerToken, "PATCH", answerBody))
    const answerFailureCategory = answered.status === 200 ? "none" : await answerResumeFailureCategory(answered)
    expect(answered.status, `answer_resume_error_category=${answerFailureCategory}`).toBe(200)
    const answeredJson = await jsonResponse(answered)
    expect(answeredJson).toMatchObject({ resumed: true })
    const confirmedTask = await waitForTask(task => task.status === "filling" && task.checkpoint === "taskgraph_fill_queued" && task.fillTurnId !== firstFillTurnId)
    const successorTurnId = confirmedTask.fillTurnId!
    await armLegacyFinalResponseGate(successorTurnId)
    const successorTurn = await testDb.agentTurn.findUniqueOrThrow({ where: { id: successorTurnId }, select: {
      userId: true, sessionId: true,
    } })
    expect(successorTurn).toMatchObject({ userId: ids.user, sessionId: ids.session })
    expect(confirmedTask.confirmedAnswers).toMatchObject({ [field!.key!]: "Yes" })
    expect(JSON.stringify(await testDb.applicationTaskEvent.findMany({ where: { taskId: gateTaskId, type: "user_answers_confirmed" }, select: { data: true } }))).not.toContain("Yes")
    const duplicate = await answerApplicationTask(apiRequest(answerPath, ownerToken, "PATCH", answerBody))
    expect(duplicate.status).toBe(200)
    expect(await testDb.agentTurn.count({ where: { sessionId: ids.session, id: successorTurnId } })).toBe(1)
    expect(await testDb.agentOutbox.count({ where: { aggregateId: ids.session, topic: "agent.turn.dispatch", idempotencyKey: `turn-dispatch:${successorTurnId}` } })).toBe(1)
    expect(await testDb.agentTurn.count({ where: { sessionId: ids.session } })).toBe(baselineTurns + 1)
    const successorTurnJobs = await waitForStableTurnQueueJobs(successorTurnId)
    expect(successorTurnJobs).toHaveLength(1)
    expect(successorTurnJobs[0]?.id).toBeTruthy()
    const initialTurnJobId = successorTurnJobs[0]?.id
    if (!initialTurnJobId) throw new Error("Successor Turn dispatch is missing its initial BullMQ job ID")
    const initialTurnCompletion = await waitLine(
      worker!, `TURN_JOB_COMPLETED ${initialTurnJobId} turnId=${successorTurnId}`, 30_000,
    )
    expect(initialTurnCompletion).toContain("status=")
    const initialTurnJob = await turnQueue!.getJob(initialTurnJobId)
    expect(initialTurnJob).toBeDefined()
    expect(await initialTurnJob!.getState()).toBe("completed")
    expect(await testDb.applicationTaskEvent.count({ where: { taskId: gateTaskId, type: "user_answers_confirmed" } })).toBe(1)

    const completedTask = await waitForTask(task => task.status === "waiting_for_authorization" && task.checkpoint === "form_filled", 180_000)
    expect(completedTask.id).toBe(gateTaskId)
    expect(completedTask.fillTurnId).toBe(successorTurnId)
    expect((await requestFixtureStats()).browserTrace).toContain("input:first_name")
    expect((await requestFixtureStats()).browserTrace).toContain("input:work_authorization")
    expect(await testDb.agentApproval.count({ where: { userId: ids.user, sessionId: ids.session, turnId: successorTurnId,
      taskId: gateTaskId, type: "submit_application", status: "pending" } })).toBe(1)
    await assertNoSubmitBeforeApproval()


    const turnDispatch = await testDb.agentOutbox.findUniqueOrThrow({
      where: { idempotencyKey: `turn-dispatch:${successorTurnId}` }, select: { payload: true },
    })
    const turnDispatchPayload = jsonRecord(turnDispatch.payload)
    expect(Object.keys(turnDispatchPayload ?? {}).sort()).toEqual(["ownerId", "sessionId", "turnId"])
    if (jsonString(turnDispatchPayload, "turnId") !== successorTurnId
      || jsonString(turnDispatchPayload, "sessionId") !== ids.session
      || !jsonString(turnDispatchPayload, "ownerId")) {
      throw new Error("Successor Turn dispatch payload is incomplete or mismatched")
    }

    const submitApproval = await testDb.agentApproval.findFirstOrThrow({ where: {
      userId: ids.user, sessionId: ids.session, turnId: successorTurnId,
      taskId: gateTaskId, type: "submit_application", status: "pending",
    } })
    expect(submitApproval).toMatchObject({ userId: ids.user, sessionId: ids.session, turnId: successorTurnId,
      jobId: ids.job, type: "submit_application", status: "pending" })
    expect(submitApproval.taskId).toBe(gateTaskId)
    expect(submitApproval.payload).toMatchObject({ applicationTaskId: gateTaskId, jobId: ids.job, resumeId: ids.resume })
    const { GET: getApproval } = await import("@/app/api/agent/sessions/[id]/approvals/[approvalId]/route")
    const nonceResponse = await getApproval(apiRequest(`/api/agent/sessions/${ids.session}/approvals/${submitApproval.id}`, ownerToken, "GET"), {
      params: Promise.resolve({ id: ids.session, approvalId: submitApproval.id }),
    })
    expect(nonceResponse.status).toBe(200)
    const nonceBody = await jsonResponse(nonceResponse)
    const receiptNonce = typeof nonceBody.receiptNonce === "string" ? nonceBody.receiptNonce
      : typeof nonceBody.nonce === "string" ? nonceBody.nonce : ""
    expect(receiptNonce.length).toBeGreaterThan(20)
    const { POST: approvalAction } = await import("@/app/api/agent/sessions/[id]/actions/route")
    const actionPath = `/api/agent/sessions/${ids.session}/actions`
    const missingReceipt = await approvalAction(apiRequest(actionPath, ownerToken, "POST", {
      type: "approval_response", approvalId: submitApproval.id, decision: "approved",
    }), { params: Promise.resolve({ id: ids.session }) })
    expect(missingReceipt.status).toBe(428)
    await assertNoSubmitBeforeApproval()
    const invalidReceipt = await approvalAction(apiRequest(actionPath, ownerToken, "POST", {
      type: "approval_response", approvalId: submitApproval.id, decision: "approved", receiptNonce: "invalid-fixture-receipt",
    }), { params: Promise.resolve({ id: ids.session }) })
    expect(invalidReceipt.status).toBe(409)
    await assertNoSubmitBeforeApproval()
    const reviewApproval = await testDb.agentApproval.findFirstOrThrow({ where: {
      userId: ids.user, sessionId: ids.session, type: "review_application", status: "pending",
    } })
    const reviewNonceResponse = await getApproval(apiRequest(`/api/agent/sessions/${ids.session}/approvals/${reviewApproval.id}`, ownerToken, "GET"), {
      params: Promise.resolve({ id: ids.session, approvalId: reviewApproval.id }),
    })
    expect(reviewNonceResponse.status).toBe(200)
    const reviewNonceBody = await jsonResponse(reviewNonceResponse)
    const mismatchedReceiptNonce = typeof reviewNonceBody.receiptNonce === "string" ? reviewNonceBody.receiptNonce : ""
    expect(mismatchedReceiptNonce.length).toBeGreaterThan(20)
    const mismatchedReceipt = await approvalAction(apiRequest(actionPath, ownerToken, "POST", {
      type: "approval_response", approvalId: submitApproval.id, decision: "approved", receiptNonce: mismatchedReceiptNonce,
    }), { params: Promise.resolve({ id: ids.session }) })
    expect(mismatchedReceipt.status).toBe(409)
    await assertNoSubmitBeforeApproval()
    const expiredApprovalId = `expired-submit-${runId}`
    const expiredAt = new Date(Date.now() - 60_000), expiredReceiptNonce = `expired-submit-receipt-${runId}`
    const expiredNonceHash = await hashApprovalNonce(expiredReceiptNonce)
    const expiredScope: ApprovalScopeInput = { userId: ids.user, sessionId: ids.session, turnId: successorTurnId, jobId: ids.job,
      toolCallId: submitApproval.toolCallId!, action: "submit_application", resourceHash: submitApproval.resourceHash!,
      materialHash: submitApproval.materialHash!, answersHash: submitApproval.answersHash!, revision: submitApproval.revision, expiresAt: expiredAt }
    const expiredScopeHash = await hashApprovalScope(protocolScope(expiredScope, expiredNonceHash))
    await testDb.agentApproval.create({ data: {
      id: expiredApprovalId, sessionId: submitApproval.sessionId, taskId: submitApproval.taskId,
      userId: submitApproval.userId, turnId: submitApproval.turnId, toolCallId: submitApproval.toolCallId,
      jobId: submitApproval.jobId, type: submitApproval.type, status: "pending", title: submitApproval.title,
      body: submitApproval.body, payload: submitApproval.payload as Prisma.InputJsonValue,
      resourceHash: expiredScope.resourceHash, materialHash: expiredScope.materialHash,
      answersHash: expiredScope.answersHash, scopeHash: expiredScopeHash,
      nonceHash: expiredNonceHash, revision: expiredScope.revision, expiresAt: expiredAt,
    } })
    const expiredReceipt = await approvalAction(apiRequest(actionPath, ownerToken, "POST", {
      type: "approval_response", approvalId: expiredApprovalId, decision: "approved", receiptNonce: expiredReceiptNonce,
    }), { params: Promise.resolve({ id: ids.session }) })
    expect(expiredReceipt.status).toBe(409)
    await expect(jsonResponse(expiredReceipt)).resolves.toMatchObject({ error: expect.stringContaining("expiry") })
    expect(await testDb.agentApproval.count({ where: { id: submitApproval.id, status: "pending" } })).toBe(1)
    expect(await testDb.agentApproval.count({ where: { id: expiredApprovalId, status: "pending" } })).toBe(1)
    await assertNoSubmitBeforeApproval()
    expect(await testDb.agentOutbox.count({ where: { topic: "application.submit.dispatch", aggregateId: ids.session } })).toBe(0)

    const approved = await approvalAction(apiRequest(actionPath, ownerToken, "POST", {
      type: "approval_response", approvalId: submitApproval.id, decision: "approved", receiptNonce,
    }), { params: Promise.resolve({ id: ids.session }) })
    expect(approved.status).toBe(200)
    await Promise.all([
      waitLine(worker!, `LEGACY_FINAL_RESPONSE_GATE_REACHED turnId=${successorTurnId}`, 45_000),
      waitLine(site!, "SUBMIT_REQUEST 1", 120_000),
    ])
    expect((await requestFixtureStats()).submitCount).toBe(1)
    const outbox = await testDb.agentOutbox.findMany({ where: { topic: "application.submit.dispatch", aggregateId: ids.session },
      select: { id: true, idempotencyKey: true, aggregateId: true, topic: true, payload: true, publishedAt: true } })
    expect(outbox).toHaveLength(1)
    const pendingOutbox = outbox[0]!
    const publication = await waitForOutboxPublished(pendingOutbox.id)
    const publishedOutbox = await testDb.agentOutbox.findUniqueOrThrow({ where: { id: pendingOutbox.id }, select: {
      idempotencyKey: true, aggregateId: true, topic: true, payload: true, publishedAt: true,
    } })
    expect(publishedOutbox).toMatchObject({ idempotencyKey: pendingOutbox.idempotencyKey, aggregateId: ids.session,
      topic: "application.submit.dispatch", publishedAt: publication.publishedAt })
    expect(publishedOutbox.payload).toEqual(pendingOutbox.payload)
    const intent = jsonRecord(publishedOutbox.payload)
    if (!intent) throw new Error("Submit outbox payload is not an object")
    expect(Object.keys(intent).sort()).toEqual([
      "applicationTaskId", "constraintHash", "fillTurnId", "jobId", "receiptId", "sessionId", "submitPayload", "userId", "workerTaskId",
    ])
    expect(intent).toMatchObject({ applicationTaskId: gateTaskId, userId: ids.user, jobId: ids.job,
      sessionId: ids.session, fillTurnId: successorTurnId, receiptId: submitApproval.id })
    const workerTaskId = jsonString(intent, "workerTaskId")
    if (!workerTaskId) throw new Error("Submit outbox Worker task identity is missing")
    await waitLine(worker!, `APPLY_JOB_ACTIVE ${workerTaskId}`)
    const queueJobs = await submitQueueJobs()
    expect(queueJobs).toHaveLength(1)
    const submitJob = queueJobs[0]!
    expect(submitJob.id).toBe(workerTaskId)
    expect(await submitJob.getState()).toBe("active")
    expect(submitJob.data).toEqual(intent.submitPayload)
    expect(submitJob.data).toMatchObject({ applicationTaskId: gateTaskId, userId: ids.user, jobId: ids.job,
      sessionId: ids.session, fillTurnId: successorTurnId, receiptId: submitApproval.id, operation: "submit" })
    const successorRootTaskId = await expectLegacyFillTurnLeased(successorTurnId)
    await releaseLegacyFinalResponseGate()
    postReleaseDiagnosticTurnId = successorTurnId
    expect((await waitForAgentTurnTerminal(successorTurnId, 30_000)).status).toBe("completed")
    postReleaseDiagnosticTurnId = null
    expect(await testDb.agentTurn.findUniqueOrThrow({ where: { id: successorTurnId }, select: {
      rootTaskId: true, status: true, completedAt: true, leaseOwnerId: true, leaseExpiresAt: true,
    } })).toMatchObject({
      rootTaskId: successorRootTaskId, status: "completed", completedAt: expect.any(Date),
      leaseOwnerId: null, leaseExpiresAt: null,
    })
    const submitStarted = await waitForTask(task => task.checkpoint === "submission_request_started" || task.checkpoint === "submission_uncertain")
    expect(submitStarted.status).toBe(submitStarted.checkpoint === "submission_request_started" ? "filling" : "waiting_for_user")
    const turnBeforeDuplicate = await testDb.agentTurn.findUniqueOrThrow({
      where: { id: successorTurnId },
      select: { status: true, revision: true, leaseOwnerId: true, leaseExpiresAt: true, completedAt: true },
    })
    const taskBeforeDuplicate = await testDb.applicationTask.findUniqueOrThrow({
      where: { id: gateTaskId }, select: { status: true, checkpoint: true, fillTurnId: true },
    })
    const approvalBeforeDuplicate = await testDb.agentApproval.findUniqueOrThrow({
      where: { id: submitApproval.id }, select: { status: true },
    })
    expect(approvalBeforeDuplicate.status).not.toBe("pending")
    const duplicateTurnJobId = `test-duplicate-${successorTurnId}`
    await turnQueue!.add("turn", turnDispatch.payload, { jobId: duplicateTurnJobId })
    const duplicateTurnCompletion = await waitLine(
      worker!, `TURN_JOB_COMPLETED ${duplicateTurnJobId} turnId=${successorTurnId}`, 30_000,
    )
    expect(duplicateTurnCompletion).toContain("status=skipped")
    const duplicateTurnJob = await turnQueue!.getJob(duplicateTurnJobId)
    expect(duplicateTurnJob).toBeDefined()
    expect(await duplicateTurnJob!.getState()).toBe("completed")
    expect(await testDb.agentTurn.findUniqueOrThrow({
      where: { id: successorTurnId },
      select: { status: true, revision: true, leaseOwnerId: true, leaseExpiresAt: true, completedAt: true },
    })).toEqual(turnBeforeDuplicate)
    expect(await testDb.applicationTask.findUniqueOrThrow({
      where: { id: gateTaskId }, select: { status: true, checkpoint: true, fillTurnId: true },
    })).toEqual(taskBeforeDuplicate)
    expect(await testDb.agentApproval.findUniqueOrThrow({
      where: { id: submitApproval.id }, select: { status: true },
    })).toEqual(approvalBeforeDuplicate)
    expect((await requestFixtureStats()).submitCount).toBe(1)
    await waitLine(worker!, "LEGACY_APPLY_PROCESSOR_RESULT_HELD", 30_000)
    const taskBeforeKill = await testDb.applicationTask.findUniqueOrThrow({
      where: { id: gateTaskId! },
      select: { userId: true, jobId: true, sessionId: true, fillTurnId: true, workerTaskId: true, status: true, checkpoint: true },
    })
    const jobBeforeKill = await applyQueue!.getJob(workerTaskId)
    const expectedTaskStage = (taskBeforeKill.status === "filling" && taskBeforeKill.checkpoint === "submission_request_started")
      || (taskBeforeKill.status === "waiting_for_user" && taskBeforeKill.checkpoint === "submission_uncertain")
    expect(expectedTaskStage).toBe(true)
    expect(Boolean(taskBeforeKill.userId === ids.user && taskBeforeKill.jobId === ids.job
      && taskBeforeKill.sessionId === ids.session && taskBeforeKill.fillTurnId === successorTurnId
      && taskBeforeKill.workerTaskId === workerTaskId)).toBe(true)
    expect(Boolean(jobBeforeKill && jobBeforeKill.id === workerTaskId
      && await jobBeforeKill.getState() === "active")).toBe(true)
    expect(isDeepStrictEqual(jobBeforeKill?.data, intent.submitPayload)).toBe(true)
    worker!.kill("SIGKILL")
    expect(await waitExit(worker!, 5_000)).toBe(true)
    worker = spawnFixture("worker")
    await waitLine(worker, "WORKER_READY", 90_000)
    const redeliveryEvent = await waitForWorkerRedelivery(worker, workerTaskId)
    expect(redeliveryEvent).toMatchObject({ jobId: workerTaskId })
    expect(redeliveryEvent.attemptsStarted).toBeGreaterThanOrEqual(2)
    expect(redeliveryEvent.stalledCounter).toBeGreaterThanOrEqual(1)
    const fixtureStats = await requestFixtureStats()
    expect(fixtureStats.submitCount).toBe(1)
    expect(fixtureStats.blocked).toEqual([])
    await waitForTask(task => task.status === "waiting_for_user" && task.checkpoint === "submission_uncertain")
    const restartedTask = await testDb.applicationTask.findUniqueOrThrow({ where: { id: gateTaskId }, select: {
      id: true, userId: true, jobId: true, sessionId: true, fillTurnId: true, workerTaskId: true, status: true, checkpoint: true,
    } })
    expect(restartedTask).toMatchObject({ id: gateTaskId, userId: ids.user, jobId: ids.job,
      sessionId: ids.session, fillTurnId: successorTurnId, workerTaskId })
    expect(["submission_request_started", "submission_uncertain"]).toContain(restartedTask.checkpoint)
    const durableOutbox = await testDb.agentOutbox.findMany({ where: { topic: "application.submit.dispatch", aggregateId: ids.session },
      select: { idempotencyKey: true, aggregateId: true, topic: true, payload: true, publishedAt: true } })
    expect(durableOutbox).toHaveLength(1)
    expect(durableOutbox[0]).toMatchObject({
      idempotencyKey: outbox[0]!.idempotencyKey, aggregateId: ids.session, topic: "application.submit.dispatch",
      payload: intent, publishedAt: expect.any(Date),
    })
    const terminalProofs = await waitForSubmissionTerminalProof({
      taskId: gateTaskId!, userId: ids.user, jobId: ids.job, sessionId: ids.session,
      fillTurnId: successorTurnId, workerTaskId, approvalId: submitApproval.id,
      constraintHash: intent.constraintHash,
    })
    expect(terminalProofs).toHaveLength(1)
    const terminalProof = terminalProofs[0]!
    expect(terminalProof).toMatchObject({ taskId: gateTaskId, type: "submission_terminal_observed", actor: "worker" })
    expect(terminalProof.data).toMatchObject({
      applicationTaskId: gateTaskId, userId: ids.user, jobId: ids.job, sessionId: ids.session,
      fillTurnId: successorTurnId, workerTaskId, approvalId: submitApproval.id, receiptId: submitApproval.id,
      constraintHash: intent.constraintHash,
      terminalState: expect.stringMatching(/^(completed|failed)$/),
      attemptsMade: expect.any(Number), attempts: expect.any(Number),
    })
    const terminalData = jsonRecord(terminalProof.data)
    const terminalAttempts = terminalData?.attempts as number
    const terminalAttemptsMade = terminalData?.attemptsMade as number
    expect(terminalAttempts).toBeGreaterThanOrEqual(1)
    expect(terminalAttemptsMade).toBeGreaterThanOrEqual(0)
    if (terminalData?.terminalState === "failed") {
      expect(terminalAttemptsMade).toBeGreaterThanOrEqual(terminalAttempts)
    }
    expect(redeliveryEvent.jobId).toBe(workerTaskId)
    expect((await requestFixtureStats()).submitCount).toBe(1)
  }, 300_000)

  it("runs selected-job Writer → Reviewer → user approval → the same submit-disabled Fill Turn", async () => {
    const scenario = await createReviewedSourceScenario("positive", "Synthetic source description for reviewed fill integration.")
    const token = await signedBearer(ids.user)
    const source = await startSelectedJobSource({ ...scenario, token, key: `reviewed-source-positive-${runId}` })
    const sourceRootTaskId = source.turn.rootTaskId
    if (typeof sourceRootTaskId !== "string" || !sourceRootTaskId) throw new Error("reviewed_source_root_missing")
    const sourceGraph = await testDb.agentItem.findFirstOrThrow({ where: {
      sessionId: scenario.sessionId, turnId: source.turnId, taskId: sourceRootTaskId, type: "task_graph",
    }, select: { revision: true } })
    const sourceChildren = await testDb.subAgentTask.findMany({ where: {
      sessionId: scenario.sessionId, turnId: source.turnId, role: { in: ["writer", "reviewer"] }, status: "completed",
    }, select: { id: true, role: true, status: true, result: true } })
    expect(sourceChildren.map(child => child.role).sort()).toEqual(["reviewer", "writer"])
    const writer = sourceChildren.find(child => child.role === "writer")!
    const reviewer = sourceChildren.find(child => child.role === "reviewer")!
    const writerResult = await reviewedSourceStructuredResult(writer.status, writer.result, "writer")
    const reviewerResult = await reviewedSourceStructuredResult(reviewer.status, reviewer.result, "reviewer")
    expect(writerResult.role).toBe("writer")
    expect(writerResult.status).toBe("completed")
    expect(reviewerResult.role).toBe("reviewer")
    expect(reviewerResult.status).toBe("completed")
    expect(reviewerResult.reviewStatus).toBe("passed")
    const artifactRef = jsonRecord(writerResult?.artifactRef)
    const reviewerArtifactRef = jsonRecord(reviewerResult.artifactRef)
    const validArtifactRef = typeof artifactRef?.artifactId === "string" && artifactRef.artifactId.length > 0
      && Number.isSafeInteger(artifactRef.version)
      && typeof artifactRef.contentHash === "string" && /^sha256:[a-f0-9]{64}$/.test(artifactRef.contentHash)
      && typeof artifactRef.sourceDigest === "string" && /^sha256:[a-f0-9]{64}$/.test(artifactRef.sourceDigest)
    expect(validArtifactRef).toBe(true)
    const sameArtifactRef = Boolean(artifactRef && reviewerArtifactRef
      && artifactRef.artifactId === reviewerArtifactRef.artifactId
      && artifactRef.version === reviewerArtifactRef.version
      && artifactRef.contentHash === reviewerArtifactRef.contentHash
      && artifactRef.sourceDigest === reviewerArtifactRef.sourceDigest)
    expect(sameArtifactRef).toBe(true)
    const versions = await testDb.agentArtifactVersion.findMany({ where: {
      userId: ids.user, sessionId: scenario.sessionId, jobId: scenario.jobId, artifactId: artifactRef!.artifactId as string,
    }, select: { artifactId: true, version: true, content: true, contentHash: true, sourceDigest: true, taskId: true } })
    expect(versions).toHaveLength(1)
    const version = versions[0]
    const exactWriterArtifactVersion = Boolean(version && version.artifactId === artifactRef!.artifactId
      && version.version === artifactRef!.version && version.content === reviewedCoverLetter
      && version.contentHash === artifactRef!.contentHash && version.sourceDigest === artifactRef!.sourceDigest
      && version.taskId === writer.id)
    expect(exactWriterArtifactVersion).toBe(true)
    const reviews = await testDb.agentArtifactReview.findMany({ where: {
      userId: ids.user, sessionId: scenario.sessionId, jobId: scenario.jobId, artifactId: artifactRef!.artifactId as string,
      version: artifactRef!.version as number, status: "passed",
    }, select: { artifactId: true, version: true, taskId: true, toolCallId: true, reviewHash: true, status: true } })
    expect(reviews).toHaveLength(1)
    const review = reviews[0]
    const exactReviewerReceipt = Boolean(review && review.taskId === reviewer.id
      && review.reviewHash === reviewerResult.reviewHash && review.status === "passed")
    expect(exactReviewerReceipt).toBe(true)

    const reviewKey = `reviewed-review-positive-${runId}`
    const firstRequest = await startReviewedApplicationReview({ ...scenario, sourceTurnId: source.turnId, token, key: reviewKey })
    expect(firstRequest.response.status).toBe(202)
    const reviewTurnValue = firstRequest.body.turnId
    if (typeof reviewTurnValue !== "string" || !reviewTurnValue.trim()) throw new Error("reviewed_application_review_turn_id_invalid")
    const reviewTurnId = reviewTurnValue
    const duplicateRequest = await startReviewedApplicationReview({ ...scenario, sourceTurnId: source.turnId, token, key: reviewKey })
    expect([200, 202]).toContain(duplicateRequest.response.status)
    expect(duplicateRequest.body.turnId).toBe(reviewTurnId)

    const approvalId = `reviewed-application-review:${String(reviewTurnId)}`
    const approval = await waitForReviewedApproval(approvalId)
    expect(approval).toMatchObject({ id: approvalId, userId: ids.user, sessionId: scenario.sessionId,
      turnId: reviewTurnId, type: "review_application", status: "pending", jobId: scenario.jobId })
    const applicationTaskId = approval.taskId
    expect(typeof applicationTaskId).toBe("string")
    const taskBeforeDecision = await testDb.applicationTask.findUniqueOrThrow({ where: { id: applicationTaskId! } })
    expect(taskBeforeDecision).toMatchObject({ userId: ids.user, sessionId: scenario.sessionId, jobId: scenario.jobId,
      status: "waiting_for_user", checkpoint: "materials_ready" })
    const waitId = `agent-wait:approval:${approvalId}`
    const waitItem = await testDb.agentItem.findUniqueOrThrow({ where: { id: waitId } })
    expect(waitItem).toMatchObject({ id: waitId, sessionId: scenario.sessionId, turnId: reviewTurnId,
      type: "approval_request", status: "started" })
    expect(waitItem.content).toMatchObject({ waitKind: "approval", approvalId, action: "review_application",
      impact: { externalSubmission: false, jobId: scenario.jobId } })
    expect(jsonRecord(waitItem.content)).not.toHaveProperty("responseAvailable")

    const { GET: getApproval } = await import("@/app/api/agent/sessions/[id]/approvals/[approvalId]/route")
    const nonceResponse = await getApproval(apiRequest(`/api/agent/sessions/${scenario.sessionId}/approvals/${approvalId}`, token, "GET"), {
      params: Promise.resolve({ id: scenario.sessionId, approvalId }),
    })
    expect(nonceResponse.status).toBe(200)
    const nonceBody = await jsonResponse(nonceResponse)
    const receiptNonce = typeof nonceBody.receiptNonce === "string" ? nonceBody.receiptNonce : ""
    expect(receiptNonce).toMatch(/^[a-f0-9]{64}$/)
    const decisionFence = await testDb.agentTurn.findUniqueOrThrow({ where: { id: reviewTurnId }, select: {
      id: true, userId: true, sessionId: true, revision: true,
    } })
    expect(decisionFence).toMatchObject({ id: reviewTurnId, userId: ids.user, sessionId: scenario.sessionId })
    const decisionRevision = decisionFence.revision
    if (typeof decisionRevision !== "number" || !Number.isSafeInteger(decisionRevision) || decisionRevision < 0) {
      throw new Error("reviewed_approval_turn_revision_invalid")
    }
    const decisionClientMessageId = `reviewed-approval-decision-${runId}`
    const { POST: decideApprovalWait } = await import("@/app/api/agent/sessions/[id]/approvals/[approvalId]/route")
    const reviewedFillTraceOffset = worker?.lines.length ?? 0
    const reviewedGetBaseline = (await requestFixtureStats()).reviewedGetCount
    const decision = await decideApprovalWait(apiRequest(
      `/api/agent/sessions/${scenario.sessionId}/approvals/${approvalId}`, token, "POST", {
        clientMessageId: decisionClientMessageId, expectedTurnId: reviewTurnId,
        expectedRevision: decisionRevision, decision: "approved", receiptNonce,
      }, { "idempotency-key": decisionClientMessageId }), {
      params: Promise.resolve({ id: scenario.sessionId, approvalId }),
    })
    expect(decision.status).toBe(202)
    expect((await waitForAgentTurnTerminal(String(reviewTurnId))).status).toBe("completed")
    expect(await testDb.agentApproval.findUniqueOrThrow({ where: { id: approvalId }, select: { status: true } })).toEqual({ status: "approved" })
    expect(await testDb.agentItem.findUniqueOrThrow({ where: { id: waitId }, select: { status: true } })).toEqual({ status: "completed" })

    const sourceEvents = await testDb.applicationTaskEvent.findMany({ where: {
      taskId: applicationTaskId!, type: "reviewed_material_source_bound", actor: "user",
    }, select: { type: true, actor: true, data: true } })
    expect(sourceEvents).toHaveLength(1)
    expect(sourceEvents[0]).toMatchObject({ type: "reviewed_material_source_bound", actor: "user",
      data: { schemaVersion: "agent-harness.v2.selected-job-reviewed-fill-source.v1", approvalId, sourceTurnId: source.turnId } })
    expect(JSON.stringify(sourceEvents[0]?.data)).not.toContain(reviewedCoverLetter)
    const handoffs = await testDb.agentOutbox.findMany({ where: { topic: "agent.reviewed-fill.dispatch", aggregateId: scenario.sessionId } })
    expect(handoffs).toHaveLength(1)
    const handoff = handoffs[0]!
    expect(handoff).toMatchObject({ topic: "agent.reviewed-fill.dispatch", aggregateId: scenario.sessionId,
      idempotencyKey: `agent-reviewed-fill:${approvalId}` })
    const handoffPayload = jsonRecord(handoff.payload)
    expect(Object.keys(handoffPayload ?? {}).sort()).toEqual([
      "approvalId", "applicationTaskId", "predecessorTurnId", "schemaVersion", "sessionId", "userId",
    ].sort())
    expect(handoffPayload).toEqual({ schemaVersion: "agent-harness.v2.reviewed-fill-handoff.v1", userId: ids.user,
      sessionId: scenario.sessionId, applicationTaskId, approvalId, predecessorTurnId: reviewTurnId })

    const bridgeAttempts = await waitForReviewedFillBridgeRecoveryAttempts(handoff.id)
    expect(bridgeAttempts.every(attempt => attempt.outboxId === handoff.id)).toBe(true)
    const deferredAttempts = bridgeAttempts.filter(attempt => attempt.acknowledgement === "deferred")
    expect(deferredAttempts.every(attempt => attempt.status === 200 && attempt.acknowledgementDropped === false)).toBe(true)
    const recoveryAttempts = bridgeAttempts.filter(attempt => attempt.acknowledgement !== "deferred")
    expect(recoveryAttempts).toEqual([
      { outboxId: handoff.id, status: 200, acknowledgement: "queued", predecessorStatus: "completed", acknowledgementDropped: true },
      { outboxId: handoff.id, status: 200, acknowledgement: "duplicate", predecessorStatus: "completed", acknowledgementDropped: false },
    ])
    expect(reviewedFillBridgeAttempts).toHaveLength(bridgeAttempts.length)
    const publishedHandoff = await waitForOutboxPublished(handoff.id)
    expect(publishedHandoff.publishedAt).toBeInstanceOf(Date)
    expect(publishedHandoff.attemptCount).toBe(1)
    const firstFill = await waitForReviewedApplicationTask(scenario.jobId, task => Boolean(task.fillTurnId))
    const fillTurnId = firstFill.fillTurnId!
    const replayedTask = await testDb.applicationTask.findUniqueOrThrow({ where: { id: applicationTaskId! } })
    expect(replayedTask.fillTurnId).toBe(fillTurnId)
    expect(await testDb.agentTurn.count({ where: { id: fillTurnId, sessionId: scenario.sessionId } })).toBe(1)
    expect(await testDb.agentOutbox.count({ where: { aggregateId: scenario.sessionId, topic: "agent.turn.dispatch",
      idempotencyKey: `turn-dispatch:${fillTurnId}` } })).toBe(1)
    const fillTurn = await testDb.agentTurn.findUniqueOrThrow({ where: { id: fillTurnId } })
    expect(jsonRecord(fillTurn.input)?.reviewedApplicationMaterialSource).toEqual({
      schemaVersion: "agent-harness.v2.selected-job-reviewed-fill-source.v1", sourceTurnId: source.turnId,
    })

    let completedFill: ApplicationTaskRow
    try {
      completedFill = await waitForReviewedApplicationTask(scenario.jobId,
        task => task.status === "waiting_for_authorization" && task.checkpoint === "form_filled", 180_000)
    } catch {
      const snapshot = await reviewedFillTimeoutSnapshot({ sessionId: scenario.sessionId, jobId: scenario.jobId,
        applicationTaskId: applicationTaskId!, fillTurnId, traceOffset: reviewedFillTraceOffset, reviewedGetBaseline })
      throw new Error(`Reviewed fill timeout snapshot ${JSON.stringify(snapshot)}`)
    }
    expect(completedFill.fillTurnId).toBe(fillTurnId)
    const reviewedBrowserEvents = await testDb.applicationTaskEvent.findMany({ where: {
      taskId: applicationTaskId!, type: "reviewed_application_fill_browser_started", actor: "worker",
    }, select: { type: true, actor: true, data: true } })
    expect(reviewedBrowserEvents).toHaveLength(1)
    const reviewedBrowserBinding = jsonRecord(reviewedBrowserEvents[0]?.data)
    expect(Object.keys(reviewedBrowserBinding ?? {}).sort()).toEqual([
      "applicationTaskId", "artifactId", "attemptCount", "contentHash", "fillTurnId", "fillerTaskId", "graphRevision",
      "jobId", "leaseExpiresAt", "leaseOwner", "reviewHash", "reviewerTaskId", "reviewerToolCallId", "rootTaskId",
      "schemaVersion", "sessionId", "sourceDigest", "sourceTurnId", "userId", "version", "writerTaskId",
    ])
    expect(reviewedBrowserBinding).toMatchObject({
      schemaVersion: "agent-harness.v2.reviewed-application-fill-browser-start.v1", userId: ids.user,
      sessionId: scenario.sessionId, fillTurnId, applicationTaskId, jobId: scenario.jobId, sourceTurnId: source.turnId,
      rootTaskId: sourceRootTaskId, graphRevision: sourceGraph.revision, writerTaskId: writer.id, reviewerTaskId: reviewer.id,
      reviewerToolCallId: review!.toolCallId, reviewHash: review!.reviewHash, artifactId: artifactRef!.artifactId,
      version: artifactRef!.version, contentHash: artifactRef!.contentHash, sourceDigest: artifactRef!.sourceDigest,
    })
    const reviewedProofHash = await hashReviewedApplicationMaterialProof({
      jobId: scenario.jobId, sourceTurnId: source.turnId, rootTaskId: sourceRootTaskId,
      graphRevision: sourceGraph.revision, writerTaskId: writer.id, reviewerTaskId: reviewer.id,
      reviewerToolCallId: review!.toolCallId, reviewHash: review!.reviewHash, artifactId: artifactRef!.artifactId,
      version: artifactRef!.version, contentHash: artifactRef!.contentHash, sourceDigest: artifactRef!.sourceDigest,
    })
    if (!reviewedProofHash) throw new Error("reviewed_application_proof_hash_invalid")
    const submissionManifest = await testDb.agentArtifact.findUniqueOrThrow({
      where: { id: `application:${applicationTaskId}` },
      select: { id: true, userId: true, jobId: true, artifactType: true, lifecycle: true, content: true },
    })
    expect(submissionManifest).toMatchObject({ id: `application:${applicationTaskId}`, userId: ids.user,
      jobId: scenario.jobId, artifactType: "application", lifecycle: "base" })
    expect(jsonRecord(submissionManifest.content)).toMatchObject({
      schemaVersion: "agent-harness.application-submission.v2", applicationTaskId, jobId: scenario.jobId,
      reviewedCoverLetterHash: reviewedProofHash,
    })
    expect(reviewedProofHash).toMatch(/^[a-f0-9]{64}$/)
    let fixtureStats = await requestFixtureStats()
    const traceDeadline = Date.now() + 20_000
    while (fixtureStats.reviewedMaterialExactCount < 1 && Date.now() < traceDeadline) {
      await delay(100)
      fixtureStats = await requestFixtureStats()
    }
    expect(fixtureStats.browserTrace).toContain("input:cover_letter")
    expect(fixtureStats.reviewedMaterialExactCount).toBeGreaterThan(0)
    expect(fixtureStats.reviewedGetCount).toBeGreaterThan(reviewedGetBaseline)
    expect(JSON.stringify(fixtureStats)).not.toContain(reviewedCoverLetter)
    expect(fixtureStats.reviewedSubmitCount).toBe(0)
    expect(fixtureStats.requests).not.toContain("POST /example-reviewed/jobs/1")

    const submitApprovals = await testDb.agentApproval.findMany({ where: {
      userId: ids.user, sessionId: scenario.sessionId, turnId: fillTurnId, taskId: applicationTaskId!,
      jobId: scenario.jobId, type: "submit_application", status: "pending",
    } })
    expect(submitApprovals).toHaveLength(1)
    const submitWaitId = `agent-wait:approval:${submitApprovals[0]!.id}`
    expect(await testDb.agentItem.findUniqueOrThrow({ where: { id: submitWaitId } })).toMatchObject({
      id: submitWaitId, sessionId: scenario.sessionId, turnId: fillTurnId, type: "approval_request", status: "started",
      content: { waitKind: "approval", approvalId: submitApprovals[0]!.id, action: "submit_application" },
    })
    expect(await testDb.agentOutbox.count({ where: { aggregateId: scenario.sessionId, topic: "application.submit.dispatch" } })).toBe(0)
    expect((await submitQueueJobs()).filter(job => jsonString(job.data, "applicationTaskId") === applicationTaskId)).toHaveLength(0)
    expect(fixtureStats.reviewedSubmitCount).toBe(0)
  }, 300_000)

  it("approves only a corrected Objective slot and fills its exact material without submission", async () => {
    const sessionId = `full-loop-objective-session-${runId}`
    const suffix = `full-loop-objective-${runId}`
    reviewedSessionIds.push(sessionId)
    await testDb.agentSession.create({ data: { id: sessionId, userId: ids.user,
      goal: "Prepare one verified Objective application for review", status: "running", source: "application_full_loop_objective" } })
    const { Pool } = workerRequire("pg") as { Pool: new (options: { connectionString: string }) => { end(): Promise<void> } }
    const sourceFixture = await import(objectiveTailorWaveSourceFixturePath) as unknown as {
      seedObjectiveTailorWaveSource(pool: unknown, owner: { userId: string; suffix: string },
        jobIdForSlot: (suffix: string, slot: number) => string): Promise<{
          jobs: readonly Readonly<{ id: string; source: string }>[]; resumeId: string
        }>
    }
    const sourcePool = new Pool({ connectionString: databaseUrl! })
    let seeded: Awaited<ReturnType<typeof sourceFixture.seedObjectiveTailorWaveSource>>
    try {
      seeded = await sourceFixture.seedObjectiveTailorWaveSource(sourcePool, { userId: ids.user, suffix },
        (ownerSuffix, slot) => `full-loop-objective-job-${ownerSuffix}-${slot}`)
    } finally { await sourcePool.end() }
    const jobIds = seeded.jobs.map(job => job.id)
    reviewedJobIds.push(...jobIds)
    await testDb.job.updateMany({ where: { id: { in: jobIds }, userId: ids.user },
      data: { url: "https://boards.greenhouse.io/example-reviewed/jobs/1" } })
    const adaptedResumeByJob = new Map<string, string>()
    for (const [index, job] of seeded.jobs.entries()) {
      const resumeId = `full-loop-objective-adapted-${suffix}-${index}`
      await testDb.resume.create({ data: { id: resumeId, userId: ids.user, name: `Synthetic adapted role ${index + 1}`,
        content: { text: "Synthetic confirmed engineering experience for this exact role." }, kind: "adapted", origin: "manual",
        targetJobId: job.id, parentResumeId: seeded.resumeId, isDefault: false, materialRevision: 1 } })
      await testDb.job.update({ where: { id: job.id }, data: { finalResumeId: resumeId, finalResumeAssignmentRevision: 1 } })
      adaptedResumeByJob.set(job.id, resumeId)
    }

    const token = await signedBearer(ids.user)
    const objective = "Find and assess current software engineering roles, then prepare tailored cover letters for the strongest matches"
    const startKey = `objective-wave-start-${runId}`
    const requirements = { schemaVersion: "agent-harness.v2.objective-requirements.v1", requirements: [
      { id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } },
      { id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } },
    ] }
    const { POST: startObjective } = await import("@/app/api/agent/sessions/[id]/start-objective/route")
    const priorWaveFlag = process.env.ENABLE_AGENT_OBJECTIVE_TAILOR_WAVES
    let sourceWorker: Child | undefined
    try {
      await stopFixture(worker)
      worker = undefined
      process.env.ENABLE_AGENT_OBJECTIVE_TAILOR_WAVES = "1"
      const startResponse = await startObjective(apiRequest(`/api/agent/sessions/${sessionId}/start-objective`, token, "POST", {
        schemaVersion, clientMessageId: startKey, objective, content: [{ type: "text", text: objective }],
        verificationRequirements: requirements,
      }, { "idempotency-key": startKey }), { params: Promise.resolve({ id: sessionId }) })
      expect(startResponse.status).toBe(202)
      const started = await jsonResponse(startResponse)
      const sourceTurnId = typeof started.turnId === "string" ? started.turnId : ""
      if (!sourceTurnId) throw new Error("ObjectiveStart returned no source Turn")
      sourceWorker = spawnObjectiveTailorWaveFixture({ userId: ids.user, sessionId, turnId: sourceTurnId })
      worker = sourceWorker
      await waitLine(sourceWorker, "TAILOR_WAVE_WORKER_READY resume", 90_000)
      const sourceTerminal = await waitForAgentTurnTerminal(sourceTurnId, 240_000)
      if (sourceTerminal.status !== "completed") {
        const diagnostic = await objectiveSourceFailureSnapshot({ sessionId, turnId: sourceTurnId,
          lines: sourceWorker.lines, errors: sourceWorker.errors })
        throw new Error(`Objective source Turn failed ${JSON.stringify(diagnostic)}`)
      }
      const sourceTurn = await testDb.agentTurn.findUniqueOrThrow({ where: { id: sourceTurnId } })
      expect(sourceTurn).toMatchObject({ userId: ids.user, sessionId, source: "user", status: "completed", executionMode: "canonical_task_graph" })
      const sourceRootTaskId = sourceTurn.rootTaskId
      if (typeof sourceRootTaskId !== "string" || !sourceRootTaskId) throw new Error("Objective source Root is missing")
      const graphRow = await testDb.agentItem.findFirstOrThrow({ where: {
        sessionId, turnId: sourceTurnId, taskId: sourceRootTaskId, type: "task_graph",
      }, select: { id: true, revision: true, content: true } })
      const graphContent = jsonRecord(graphRow.content)
      const marker = parseObjectiveTailorGraph(graphContent?.objectiveTailor, graphContent?.nodes)
      if (!marker || marker.slots.length !== 8) throw new Error("Completed Objective graph has no exact eight-slot marker")
      const graphNodes = Array.isArray(graphContent?.nodes) ? graphContent.nodes : []
      const nodeForKey = (key: string) => graphNodes.find(node => jsonString(node, "key") === key)
      const sourceSlot = marker.slots.find(slot => slot.slotId === "tailor-2")
      if (!sourceSlot?.correction) throw new Error("Corrected Objective slot 2 is missing")
      const taskIdsForSlot = (slot: typeof sourceSlot) => [slot.writerNodeKey, slot.reviewerNodeKey,
        slot.correction!.writerNodeKey, slot.correction!.reviewerNodeKey].map(key => jsonString(nodeForKey(key), "taskId"))
      const sourceTaskIds = taskIdsForSlot(sourceSlot)
      if (sourceTaskIds.some(id => !id)) throw new Error("Corrected Objective graph omitted task identities")
      const taskRows = await testDb.subAgentTask.findMany({ where: {
        id: { in: sourceTaskIds as string[] }, sessionId, turnId: sourceTurnId, rootTaskId: sourceRootTaskId,
      }, select: { id: true, role: true, taskType: true, status: true, context: true, result: true } })
      expect(taskRows).toHaveLength(4)
      const taskById = new Map(taskRows.map(task => [task.id, task] as const))
      const sourceWriter = taskById.get(sourceTaskIds[0]!)!, sourceReviewer = taskById.get(sourceTaskIds[1]!)!
      const correctionWriter = taskById.get(sourceTaskIds[2]!)!, correctionReviewer = taskById.get(sourceTaskIds[3]!)!
      expect([sourceWriter, sourceReviewer, correctionWriter, correctionReviewer].map(task => [task.role, task.taskType, task.status])).toEqual([
        ["writer", "cover_letter_draft", "completed"], ["reviewer", "cover_letter_review", "completed"],
        ["writer", "cover_letter_draft", "completed"], ["reviewer", "cover_letter_review", "completed"],
      ])
      const initialWriterResult = await reviewedSourceStructuredResult(sourceWriter.status, sourceWriter.result, "writer")
      const initialReviewerResult = await reviewedSourceStructuredResult(sourceReviewer.status, sourceReviewer.result, "reviewer")
      const correctedWriterResult = await reviewedSourceStructuredResult(correctionWriter.status, correctionWriter.result, "writer")
      const correctedReviewerResult = await reviewedSourceStructuredResult(correctionReviewer.status, correctionReviewer.result, "reviewer")
      expect(initialReviewerResult.reviewStatus).toBe("needs_revision")
      expect(correctedReviewerResult.reviewStatus).toBe("passed")
      const initialRef = jsonRecord(initialWriterResult.artifactRef), correctedRef = jsonRecord(correctedWriterResult.artifactRef)
      if (!initialRef || !correctedRef || !Number.isSafeInteger(initialRef.version) || !Number.isSafeInteger(correctedRef.version)) {
        throw new Error("Corrected Objective artifact references are invalid")
      }
      expect(correctedRef).toMatchObject({ artifactId: initialRef.artifactId, version: Number(initialRef.version) + 1,
        sourceDigest: initialRef.sourceDigest })
      const selectedJobId = jsonString(jsonRecord(sourceWriter.context)?.selectedJobPreparation, "jobId")
      const selectedResumeId = selectedJobId ? adaptedResumeByJob.get(selectedJobId) : undefined
      if (!selectedJobId || !selectedResumeId) throw new Error("Corrected Objective slot is not bound to its seeded Job and adapted Resume")
      const versions = await testDb.agentArtifactVersion.findMany({ where: {
        userId: ids.user, sessionId, jobId: selectedJobId, artifactId: String(initialRef.artifactId),
        version: { in: [Number(initialRef.version), Number(correctedRef.version)] },
      }, select: { version: true, content: true, contentHash: true, sourceDigest: true, previousHash: true, taskId: true } })
      expect(versions).toHaveLength(2)
      const initialVersion = versions.find(version => version.version === Number(initialRef.version))
      const correctedVersion = versions.find(version => version.version === Number(correctedRef.version))
      expect(initialVersion).toMatchObject({ taskId: sourceWriter.id, contentHash: initialRef.contentHash, sourceDigest: initialRef.sourceDigest })
      expect(correctedVersion).toMatchObject({ taskId: correctionWriter.id, contentHash: correctedRef.contentHash,
        sourceDigest: correctedRef.sourceDigest, previousHash: initialRef.contentHash })
      const initialReview = await testDb.agentArtifactReview.findFirst({ where: {
        userId: ids.user, sessionId, jobId: selectedJobId, artifactId: String(initialRef.artifactId),
        version: Number(initialRef.version), taskId: sourceReviewer.id,
      }, select: { status: true } })
      const correctedReview = await testDb.agentArtifactReview.findFirst({ where: {
        userId: ids.user, sessionId, jobId: selectedJobId, artifactId: String(correctedRef.artifactId),
        version: Number(correctedRef.version), taskId: correctionReviewer.id,
      }, select: { status: true } })
      expect(initialReview).toEqual({ status: "needs_revision" })
      expect(correctedReview).toEqual({ status: "passed" })
      const staleSlot = marker.slots.find(slot => slot.slotId === "tailor-6")
      if (!staleSlot?.correction) throw new Error("Corrected Objective slot 6 is missing")
      const staleWriterNode = nodeForKey(staleSlot.correction.writerNodeKey)
      const staleReviewerNode = nodeForKey(staleSlot.correction.reviewerNodeKey)
      const staleWriterTaskId = jsonString(staleWriterNode, "taskId")
      const staleReviewerTaskId = jsonString(staleReviewerNode, "taskId")
      if (!staleWriterTaskId || !staleReviewerTaskId) throw new Error("Corrected Objective slot 6 omitted task identities")
      const staleTaskRows = await testDb.subAgentTask.findMany({ where: {
        id: { in: [staleWriterTaskId, staleReviewerTaskId] }, sessionId, turnId: sourceTurnId, rootTaskId: sourceRootTaskId,
      }, select: { id: true, role: true, taskType: true, status: true, context: true, result: true } })
      expect(staleTaskRows.map(task => [task.id, task.role, task.taskType, task.status]).sort((left, right) =>
        String(left[1]).localeCompare(String(right[1])))).toEqual([
        [staleWriterTaskId, "writer", "cover_letter_draft", "completed"],
        [staleReviewerTaskId, "reviewer", "cover_letter_review", "completed"],
      ].sort((left, right) => String(left[1]).localeCompare(String(right[1]))))
      const staleWriter = staleTaskRows.find(task => task.id === staleWriterTaskId)!
      const staleReviewer = staleTaskRows.find(task => task.id === staleReviewerTaskId)!
      const staleWriterResult = await reviewedSourceStructuredResult(staleWriter.status, staleWriter.result, "writer")
      const staleReviewerResult = await reviewedSourceStructuredResult(staleReviewer.status, staleReviewer.result, "reviewer")
      expect(staleReviewerResult.reviewStatus).toBe("passed")
      const staleArtifactRef = jsonRecord(staleWriterResult.artifactRef)
      const staleJobId = jsonString(jsonRecord(staleWriter.context)?.selectedJobPreparation, "jobId")
      const staleResumeId = staleJobId ? adaptedResumeByJob.get(staleJobId) : undefined
      if (!staleArtifactRef || !staleJobId || !staleResumeId) throw new Error("Corrected Objective slot 6 source binding is incomplete")
      await stopFixture(sourceWorker)
      worker = undefined
      worker = spawnFixture("worker")
      await waitLine(worker, "WORKER_READY", 90_000)

      const staleSelection = { schema: "agent-harness.v2.objective-application-review-intent.v1", sourceTurnId,
        rootTaskId: sourceRootTaskId, graphItemId: graphRow.id, graphRevision: graphRow.revision, slotOrdinals: [6] }
      const staleReview = await startObjectiveApplicationReview({ sessionId, token, key: `objective-review-slot-6-${runId}`, selection: staleSelection })
      expect(staleReview.response.status).toBe(202)
      const staleReviewTurnId = typeof staleReview.body.turnId === "string" ? staleReview.body.turnId : ""
      if (!staleReviewTurnId) throw new Error("Objective slot 6 review returned no review Turn")
      const stalePendingSnapshot = await waitForObjectiveApplicationReviewSnapshot({ sessionId, turnId: staleReviewTurnId, token }, snapshot => {
        const members = Array.isArray(snapshot.members) ? snapshot.members : []
        const member = jsonRecord(members[0])
        return snapshot.setStatus === "pending" && members.length === 1 && member?.status === "pending"
          && member.decisionAvailable === true
      })
      const staleMember = jsonRecord(Array.isArray(stalePendingSnapshot.members) ? stalePendingSnapshot.members[0] : null)
      const staleApprovalId = typeof staleMember?.approvalId === "string" ? staleMember.approvalId : ""
      if (!staleMember || !staleApprovalId) throw new Error("Objective slot 6 has no pending durable approval")
      expect(staleMember).toMatchObject({ slotOrdinal: 6, status: "pending", decisionAvailable: true, resumeId: staleResumeId,
        artifactRef: { artifactId: staleArtifactRef.artifactId, version: staleArtifactRef.version,
          contentHash: staleArtifactRef.contentHash, sourceDigest: staleArtifactRef.sourceDigest } })
      const staleApproval = await waitForReviewedApproval(staleApprovalId)
      expect(staleApproval).toMatchObject({ userId: ids.user, sessionId, turnId: staleReviewTurnId,
        type: "review_application", status: "pending", jobId: staleJobId })
      const staleApplicationTaskId = staleApproval.taskId
      if (!staleApplicationTaskId) throw new Error("Objective slot 6 approval has no ApplicationTask")
      const staleApplicationTask = await testDb.applicationTask.findUniqueOrThrow({ where: { id: staleApplicationTaskId } })
      expect(staleApplicationTask).toMatchObject({ userId: ids.user, sessionId, jobId: staleJobId, resumeId: staleResumeId,
        status: "waiting_for_user", checkpoint: "materials_ready", fillTurnId: null })
      const staleTurnFence = await testDb.agentTurn.findUniqueOrThrow({ where: { id: staleReviewTurnId }, select: { revision: true } })
      const staleTraceBaseline = await requestFixtureStats()
      reviewedFillBridgeAttempts.length = 0
      dropNextReviewedFillAcknowledgement = false
      const deliveryHold = armObjectiveFillDeliveryHold(sessionId, staleApprovalId)
      try {
        const { POST: decideObjectiveReview } = await import("@/app/api/agent/sessions/[id]/objective-application-review/[turnId]/route")
        const staleDecision = await decideObjectiveReview(apiRequest(
          `/api/agent/sessions/${sessionId}/objective-application-review/${staleReviewTurnId}`, token, "POST", {
            approvalId: staleApprovalId, expectedRevision: staleTurnFence.revision,
            expectedReceiptRevision: staleMember.receiptRevision, idempotencyKey: `objective-review-decision-slot-6-${runId}`,
            decision: "approved",
          }), { params: Promise.resolve({ id: sessionId, turnId: staleReviewTurnId }) })
        expect(staleDecision.status).toBe(202)
        const staleOutboxId = await waitForObjectiveFillDeliveryHold(deliveryHold)
        expect(await waitForAgentTurnTerminal(staleReviewTurnId)).toMatchObject({ status: "completed" })
        const approvedStaleReceipt = await testDb.agentApproval.findUniqueOrThrow({ where: { id: staleApprovalId },
          select: { status: true, payload: true } })
        expect(approvedStaleReceipt.status).toBe("approved")
        const staleIntentEvents = await testDb.applicationTaskEvent.findMany({ where: {
          taskId: staleApplicationTaskId, type: "objective_application_review_approved", actor: "user",
        }, select: { type: true, actor: true, data: true } })
        expect(staleIntentEvents).toHaveLength(1)
        expect(staleIntentEvents[0]).toMatchObject({ type: "objective_application_review_approved", actor: "user",
          data: { approvalId: staleApprovalId, sessionId, reviewTurnId: staleReviewTurnId, applicationTaskId: staleApplicationTaskId,
            jobId: staleJobId, slotOrdinal: 6, sourceTurnId, materialProofHash: expect.stringMatching(/^[a-f0-9]{64}$/) } })
        const heldOutbox = await testDb.agentOutbox.findUniqueOrThrow({ where: { id: staleOutboxId } })
        expect(heldOutbox).toMatchObject({ topic: "agent.objective-reviewed-fill.dispatch", aggregateId: sessionId,
          idempotencyKey: `agent-objective-reviewed-fill:${staleApprovalId}`, publishedAt: null })
        expect(heldOutbox.payload).toEqual({ schemaVersion: "agent-harness.v2.objective-reviewed-fill-handoff.v1",
          userId: ids.user, sessionId, applicationTaskId: staleApplicationTaskId, approvalId: staleApprovalId,
          predecessorTurnId: staleReviewTurnId })
        const unfilledBeforeEdit = await testDb.applicationTask.findUniqueOrThrow({ where: { id: staleApplicationTaskId } })
        expect(unfilledBeforeEdit).toMatchObject({ status: "waiting_for_user", checkpoint: "materials_ready", fillTurnId: null })

        const { PATCH: patchResume } = await import("@/app/api/resume/[id]/route")
        const resumeEdit = await withObjectiveResumeAmbientAuth(token, () => patchResume(apiRequest(
          `/api/resume/${staleResumeId}`, token, "PATCH", {
            content: { text: "Synthetic authorized Resume edit after Objective review approval." },
          }), { params: Promise.resolve({ id: staleResumeId }) }))
        expect(resumeEdit.status).toBe(200)
        const editedResume = await testDb.resume.findFirstOrThrow({ where: { id: staleResumeId, userId: ids.user },
          select: { content: true, targetJobId: true, kind: true } })
        expect(editedResume).toMatchObject({ targetJobId: staleJobId, kind: "adapted",
          content: { text: "Synthetic authorized Resume edit after Objective review approval." } })
        const staleReceiptAfterEdit = await testDb.agentApproval.findUniqueOrThrow({ where: { id: staleApprovalId }, select: { payload: true } })
        const boundResumeWitness = jsonRecord(jsonRecord(staleReceiptAfterEdit.payload)?.proof)?.resumeWitness
        const { readObjectiveApplicationResumeWitness } = await import("@/lib/agent/approval/objective-application-resume-witness")
        const { acquireSourceMaterialFence } = await import("@/lib/agent/source-material-fence")
        const currentResumeWitness = await testDb.$transaction(async tx => {
          await acquireSourceMaterialFence(tx, [ids.user])
          return readObjectiveApplicationResumeWitness(tx, { userId: ids.user, jobId: staleJobId })
        })
        expect(boundResumeWitness).toBeDefined()
        expect(currentResumeWitness).not.toEqual(boundResumeWitness)

        releaseObjectiveFillDeliveryHold(deliveryHold)
        await waitForOutboxPublished(staleOutboxId)
        const staleBridgeAttempts = reviewedFillBridgeAttempts.filter(attempt => attempt.outboxId === staleOutboxId)
        expect(staleBridgeAttempts.length).toBeGreaterThan(0)
        expect(staleBridgeAttempts.every(attempt => attempt.outboxId === staleOutboxId && attempt.status === 200
          && (attempt.acknowledgement === "terminal" || attempt.acknowledgement === "deferred")
          && attempt.predecessorStatus === "completed"
          && attempt.acknowledgementDropped === false)).toBe(true)
        expect(staleBridgeAttempts.some(attempt => attempt.acknowledgement === "terminal")).toBe(true)
        const stalePublishedOutbox = await testDb.agentOutbox.findUniqueOrThrow({ where: { id: staleOutboxId },
          select: { attemptCount: true, publishedAt: true } })
        expect(stalePublishedOutbox).toMatchObject({ attemptCount: 1, publishedAt: expect.any(Date) })
        const staleTaskAfterDelivery = await testDb.applicationTask.findUniqueOrThrow({ where: { id: staleApplicationTaskId } })
        expect(staleTaskAfterDelivery).toMatchObject({ status: "waiting_for_user", checkpoint: "materials_ready",
          fillTurnId: null, workerTaskId: null })
        expect(await testDb.applicationTaskEvent.count({ where: { taskId: staleApplicationTaskId,
          type: "reviewed_application_fill_browser_started" } })).toBe(0)
        const sessionTurns = await testDb.agentTurn.findMany({ where: { userId: ids.user, sessionId }, select: { input: true } })
        expect(sessionTurns.filter(turn => jsonString(turn.input, "clientMessageId") === `agent-objective-reviewed-fill:${staleApprovalId}`)).toHaveLength(0)
        const staleTraceAfter = await requestFixtureStats()
        expect(staleTraceAfter.reviewedGetCount).toBe(staleTraceBaseline.reviewedGetCount)
        expect(staleTraceAfter.objectiveMaterialExactCount).toBe(staleTraceBaseline.objectiveMaterialExactCount)
        expect(staleTraceAfter.submitCount).toBe(staleTraceBaseline.submitCount)
        expect(staleTraceAfter.reviewedSubmitCount).toBe(0)
        expect(staleTraceAfter.requests).toEqual(staleTraceBaseline.requests)
      } finally {
        releaseObjectiveFillDeliveryHold(deliveryHold)
      }

      const selection = { schema: "agent-harness.v2.objective-application-review-intent.v1", sourceTurnId,
        rootTaskId: sourceRootTaskId, graphItemId: graphRow.id, graphRevision: graphRow.revision, slotOrdinals: [2] }
      const reviewKey = `objective-review-slot-2-${runId}`
      const startedReview = await startObjectiveApplicationReview({ sessionId, token, key: reviewKey, selection })
      expect(startedReview.response.status).toBe(202)
      const reviewTurnId = typeof startedReview.body.turnId === "string" ? startedReview.body.turnId : ""
      if (!reviewTurnId) throw new Error("Objective review route returned no review Turn")
      const pendingSnapshot = await waitForObjectiveApplicationReviewSnapshot({ sessionId, turnId: reviewTurnId, token }, snapshot => {
        const members = Array.isArray(snapshot.members) ? snapshot.members : []
        return snapshot.setStatus === "pending" && members.length === 1 && jsonRecord(members[0])?.status === "pending"
      })
      const members = Array.isArray(pendingSnapshot.members) ? pendingSnapshot.members : []
      const pendingMember = jsonRecord(members[0])
      const approvalId = typeof pendingMember?.approvalId === "string" ? pendingMember.approvalId : ""
      if (!pendingMember || !approvalId) throw new Error("Objective slot 2 has no durable approval receipt")
      const pendingArtifactRef = jsonRecord(pendingMember?.artifactRef)
      expect(pendingMember).toMatchObject({ slotOrdinal: 2, status: "pending", decisionAvailable: true,
        resumeId: selectedResumeId, artifactRef: { artifactId: correctedRef.artifactId, version: correctedRef.version,
          contentHash: correctedRef.contentHash, sourceDigest: correctedRef.sourceDigest } })
      expect(pendingArtifactRef?.version).toBe(correctedRef.version)
      const approval = await waitForReviewedApproval(approvalId)
      expect(approval).toMatchObject({ id: approvalId, userId: ids.user, sessionId, turnId: reviewTurnId,
        type: "review_application", status: "pending", jobId: selectedJobId })
      const applicationTaskId = approval.taskId
      expect(typeof applicationTaskId).toBe("string")
      const initialTask = await testDb.applicationTask.findUniqueOrThrow({ where: { id: applicationTaskId! } })
      expect(initialTask).toMatchObject({ userId: ids.user, sessionId, jobId: selectedJobId, resumeId: selectedResumeId,
        status: "waiting_for_user", checkpoint: "materials_ready" })
      expect(await testDb.applicationTask.count({ where: { userId: ids.user, sessionId, jobId: { in: jobIds } } })).toBe(2)
      expect(await testDb.agentApproval.count({ where: { userId: ids.user, sessionId, turnId: reviewTurnId, type: "review_application" } })).toBe(1)
      const turnFence = await testDb.agentTurn.findUniqueOrThrow({ where: { id: reviewTurnId }, select: {
        id: true, userId: true, sessionId: true, revision: true,
      } })
      const decisionKey = `objective-review-decision-slot-2-${runId}`
      const traceBaseline = await requestFixtureStats()
      const fillTraceOffset = worker?.lines.length ?? 0
      reviewedFillBridgeAttempts.length = 0
      dropNextReviewedFillAcknowledgement = true
      const { POST: decideObjectiveReview } = await import("@/app/api/agent/sessions/[id]/objective-application-review/[turnId]/route")
      const decision = await decideObjectiveReview(apiRequest(
        `/api/agent/sessions/${sessionId}/objective-application-review/${reviewTurnId}`, token, "POST", {
          approvalId, expectedRevision: turnFence.revision, expectedReceiptRevision: pendingMember.receiptRevision,
          idempotencyKey: decisionKey, decision: "approved",
        }), { params: Promise.resolve({ id: sessionId, turnId: reviewTurnId }) })
      expect(decision.status).toBe(202)
      expect((await waitForAgentTurnTerminal(reviewTurnId)).status).toBe("completed")
      const approvedReceipt = await testDb.agentApproval.findUniqueOrThrow({ where: { id: approvalId } })
      expect(approvedReceipt).toMatchObject({ id: approvalId, userId: ids.user, sessionId, turnId: reviewTurnId,
        taskId: applicationTaskId, jobId: selectedJobId, type: "review_application", status: "approved" })
      const approvedEvents = await testDb.applicationTaskEvent.findMany({ where: {
        taskId: applicationTaskId!, type: "objective_application_review_approved", actor: "user",
      }, select: { id: true, type: true, actor: true, body: true, data: true } })
      expect(approvedEvents).toHaveLength(1)
      const approvedIntent = jsonRecord(approvedEvents[0]?.data)
      expect(approvedIntent).toMatchObject({ schemaVersion: "objective-application-review-approved-intent.v1",
        userId: ids.user, sessionId, reviewTurnId, applicationTaskId, jobId: selectedJobId,
        approvalId, setId: expect.any(String), slotOrdinal: 2, sourceTurnId, materialProofHash: expect.stringMatching(/^[a-f0-9]{64}$/) })
      expect(JSON.stringify(approvedIntent)).not.toContain(String(correctedVersion?.content))
      const materialProofHash = typeof approvedIntent?.materialProofHash === "string" ? approvedIntent.materialProofHash : ""
      const setId = typeof approvedIntent?.setId === "string" ? approvedIntent.setId : ""
      if (!materialProofHash || !setId) throw new Error("Approved Objective slot omitted its exact material proof")
      const setItemId = objectiveApplicationApprovalSetItemId(setId)
      const setItem = await testDb.agentItem.findUniqueOrThrow({ where: { id: setItemId } })
      expect(setItem).toMatchObject({ id: setItemId, sessionId, turnId: reviewTurnId, type: "approval_request", status: "completed", revision: 1 })
      const completedEvents = await testDb.agentEvent.findMany({ where: {
        sessionId, turnId: reviewTurnId, idempotencyKey: `agent-wait:${setItemId}:completed`,
      }, select: { id: true, type: true, actor: true, itemId: true, correlationId: true, causationId: true, payload: true } })
      const wakeEvents = await testDb.agentEvent.findMany({ where: {
        sessionId, turnId: reviewTurnId, idempotencyKey: `approval-set:${setId}:wakeup`,
      }, select: { id: true, type: true, actor: true, itemId: true, correlationId: true, causationId: true, payload: true } })
      expect(completedEvents).toHaveLength(1)
      expect(wakeEvents).toHaveLength(1)
      expect(completedEvents[0]).toMatchObject({ type: "item.completed", actor: "orchestrator", itemId: setItemId,
        correlationId: setItemId, causationId: setItemId, payload: { itemId: setItemId, status: "completed" } })
      expect(wakeEvents[0]).toMatchObject({ type: "turn.wakeup", actor: "user", itemId: setItemId,
        correlationId: reviewTurnId, causationId: completedEvents[0]?.id,
        payload: { waitKind: "approval_set", waitId: setId, itemId: setItemId, turnId: reviewTurnId,
          toolCallId: null, status: "resolved" } })
      const handoff = await testDb.agentOutbox.findFirstOrThrow({ where: {
        topic: "agent.objective-reviewed-fill.dispatch", aggregateId: sessionId,
        idempotencyKey: `agent-objective-reviewed-fill:${approvalId}`,
      } })
      const handoffPayload = jsonRecord(handoff.payload)
      expect(Object.keys(handoffPayload ?? {}).sort()).toEqual([
        "approvalId", "applicationTaskId", "predecessorTurnId", "schemaVersion", "sessionId", "userId",
      ].sort())
      expect(handoffPayload).toEqual({ schemaVersion: "agent-harness.v2.objective-reviewed-fill-handoff.v1",
        userId: ids.user, sessionId, applicationTaskId, approvalId, predecessorTurnId: reviewTurnId })
      const bridgeAttempts = await waitForReviewedFillBridgeRecoveryAttempts(handoff.id)
      expect(bridgeAttempts.filter(attempt => attempt.acknowledgement !== "deferred")).toEqual([
        { outboxId: handoff.id, status: 200, acknowledgement: "queued", predecessorStatus: "completed", acknowledgementDropped: true },
        { outboxId: handoff.id, status: 200, acknowledgement: "duplicate", predecessorStatus: "completed", acknowledgementDropped: false },
      ])
      const published = await waitForOutboxPublished(handoff.id)
      expect(published.attemptCount).toBe(1)
      const firstFill = await waitForReviewedApplicationTask(selectedJobId, task => Boolean(task.fillTurnId))
      const fillTurnId = firstFill.fillTurnId!
      expect(firstFill).toMatchObject({ id: applicationTaskId, resumeId: selectedResumeId })
      const fillTurn = await testDb.agentTurn.findUniqueOrThrow({ where: { id: fillTurnId } })
      expect(jsonRecord(fillTurn.input)?.reviewedApplicationMaterialSource).toEqual({
        schemaVersion: "agent-harness.v2.objective-reviewed-fill-source.v1", approvalId, reviewTurnId, materialProofHash,
      })
      expect(await testDb.agentTurn.count({ where: { id: fillTurnId, sessionId } })).toBe(1)
      expect(await testDb.agentOutbox.count({ where: { aggregateId: sessionId, topic: "agent.turn.dispatch",
        idempotencyKey: `turn-dispatch:${fillTurnId}` } })).toBe(1)
      let completedFill: ApplicationTaskRow
      try {
        completedFill = await waitForReviewedApplicationTask(selectedJobId,
          task => task.status === "waiting_for_authorization" && task.checkpoint === "form_filled", 180_000)
      } catch {
        const snapshot = await reviewedFillTimeoutSnapshot({ sessionId, jobId: selectedJobId,
          applicationTaskId: applicationTaskId!, fillTurnId, traceOffset: fillTraceOffset,
          reviewedGetBaseline: traceBaseline.reviewedGetCount })
        throw new Error(`Objective reviewed fill timeout snapshot ${JSON.stringify(snapshot)}`)
      }
      expect(completedFill.fillTurnId).toBe(fillTurnId)
      const browserEvents = await testDb.applicationTaskEvent.findMany({ where: {
        taskId: applicationTaskId!, type: "reviewed_application_fill_browser_started", actor: "worker",
      }, select: { type: true, data: true } })
      expect(browserEvents).toHaveLength(1)
      const browserBinding = jsonRecord(browserEvents[0]?.data)
      expect(browserBinding).toMatchObject({ schemaVersion: "agent-harness.v2.objective-reviewed-fill-browser-start.v1",
        userId: ids.user, sessionId, fillTurnId, applicationTaskId, jobId: selectedJobId, sourceTurnId,
        graphRevision: graphRow.revision, writerTaskId: correctionWriter.id, reviewerTaskId: correctionReviewer.id,
        artifactId: correctedRef.artifactId, version: correctedRef.version, contentHash: correctedRef.contentHash,
        sourceDigest: correctedRef.sourceDigest, objectiveSource: { approvalId, reviewTurnId, materialProofHash } })
      expect(Object.keys(browserBinding ?? {}).sort()).toEqual([
        "applicationTaskId", "artifactId", "attemptCount", "contentHash", "fillTurnId", "fillerTaskId", "graphRevision",
        "jobId", "leaseExpiresAt", "leaseOwner", "objectiveSource", "reviewHash", "reviewerTaskId", "reviewerToolCallId", "rootTaskId",
        "schemaVersion", "sessionId", "sourceDigest", "sourceTurnId", "userId", "version", "writerTaskId",
      ].sort())
      const correctionReviewerRow = await testDb.agentArtifactReview.findFirstOrThrow({ where: {
        userId: ids.user, sessionId, jobId: selectedJobId, artifactId: String(correctedRef.artifactId),
        version: Number(correctedRef.version), taskId: correctionReviewer.id,
      }, select: { toolCallId: true, reviewHash: true, status: true } })
      expect(browserBinding).toMatchObject({ reviewerToolCallId: correctionReviewerRow.toolCallId,
        reviewHash: correctionReviewerRow.reviewHash })
      const reviewedProofHash = await hashReviewedApplicationMaterialProof({ jobId: selectedJobId, sourceTurnId,
        rootTaskId: sourceRootTaskId, graphRevision: graphRow.revision, writerTaskId: correctionWriter.id,
        reviewerTaskId: correctionReviewer.id, reviewerToolCallId: correctionReviewerRow.toolCallId,
        reviewHash: correctionReviewerRow.reviewHash, artifactId: correctedRef.artifactId, version: correctedRef.version,
        contentHash: correctedRef.contentHash, sourceDigest: correctedRef.sourceDigest })
      expect(typeof reviewedProofHash).toBe("string")
      const manifest = await testDb.agentArtifact.findUniqueOrThrow({ where: { id: `application:${applicationTaskId}` },
        select: { content: true, userId: true, jobId: true, artifactType: true, lifecycle: true } })
      expect(manifest).toMatchObject({ userId: ids.user, jobId: selectedJobId, artifactType: "application", lifecycle: "base" })
      expect(jsonRecord(manifest.content)).toMatchObject({ schemaVersion: "agent-harness.application-submission.v2",
        applicationTaskId, jobId: selectedJobId, reviewedCoverLetterHash: reviewedProofHash })
      const finalStats = await requestFixtureStats()
      expect(finalStats.reviewedGetCount).toBeGreaterThan(traceBaseline.reviewedGetCount)
      expect(finalStats.objectiveMaterialExactCount).toBeGreaterThan(traceBaseline.objectiveMaterialExactCount)
      expect(finalStats.submitCount).toBe(traceBaseline.submitCount)
      expect(finalStats.reviewedSubmitCount).toBe(0)
      expect(finalStats.requests).not.toContain("POST /example-reviewed/jobs/1")
      const submitApprovals = await testDb.agentApproval.findMany({ where: {
        userId: ids.user, sessionId, turnId: fillTurnId, taskId: applicationTaskId!, jobId: selectedJobId,
        type: "submit_application", status: "pending",
      } })
      expect(submitApprovals).toHaveLength(1)
      const submitWaitId = `agent-wait:approval:${submitApprovals[0]!.id}`
      expect(await testDb.agentItem.findUniqueOrThrow({ where: { id: submitWaitId } })).toMatchObject({
        id: submitWaitId, sessionId, turnId: fillTurnId, type: "approval_request", status: "started",
        content: { waitKind: "approval", approvalId: submitApprovals[0]!.id, action: "submit_application" },
      })
      expect(await testDb.agentOutbox.count({ where: { aggregateId: sessionId, topic: "application.submit.dispatch" } })).toBe(0)
      expect((await submitQueueJobs()).filter(job => jsonString(job.data, "applicationTaskId") === applicationTaskId)).toHaveLength(0)
      const staleSlotTaskAfterValidSiblingFill = await testDb.applicationTask.findUniqueOrThrow({ where: { id: staleApplicationTaskId } })
      expect(staleSlotTaskAfterValidSiblingFill).toMatchObject({ status: "waiting_for_user", checkpoint: "materials_ready",
        fillTurnId: null, workerTaskId: null })
      expect(await testDb.applicationTaskEvent.count({ where: { taskId: staleApplicationTaskId,
        type: "reviewed_application_fill_browser_started" } })).toBe(0)
    } finally {
      if (priorWaveFlag === undefined) delete process.env.ENABLE_AGENT_OBJECTIVE_TAILOR_WAVES
      else process.env.ENABLE_AGENT_OBJECTIVE_TAILOR_WAVES = priorWaveFlag
      if (sourceWorker && worker === sourceWorker && !exited(sourceWorker)) {
        await stopFixture(sourceWorker)
        worker = undefined
      }
      if (!worker || exited(worker)) {
        worker = spawnFixture("worker")
        await waitLine(worker, "WORKER_READY", 90_000)
      }
    }
  }, 360_000)

  it("denies reviewed approval when the selected-job source changes after Writer and Reviewer finish", async () => {
    const scenario = await createReviewedSourceScenario("stale", "Original synthetic source description.")
    const token = await signedBearer(ids.user)
    const source = await startSelectedJobSource({ ...scenario, token, key: `reviewed-source-stale-${runId}` })
    const sourceChildren = await testDb.subAgentTask.findMany({ where: {
      sessionId: scenario.sessionId, turnId: source.turnId, role: { in: ["writer", "reviewer"] }, status: "completed",
    }, select: { role: true, status: true, result: true } })
    expect(sourceChildren.map(child => child.role).sort()).toEqual(["reviewer", "writer"])
    const reviewer = sourceChildren.find(child => child.role === "reviewer")!
    const reviewerResult = await reviewedSourceStructuredResult(reviewer.status, reviewer.result, "reviewer")
    expect(reviewerResult.reviewStatus).toBe("passed")
    const before = await requestFixtureStats()
    await testDb.job.update({ where: { id: scenario.jobId }, data: { description: "Synthetic description changed after review." } })
    const started = await startReviewedApplicationReview({ ...scenario, sourceTurnId: source.turnId, token, key: `reviewed-review-stale-${runId}` })
    expect(started.response.status).toBe(202)
    expect(typeof started.body.turnId).toBe("string")
    const reviewTurnId = started.body.turnId as string
    const terminal = await waitForAgentTurnTerminal(reviewTurnId)
    expect(terminal.status).toBe("failed")
    const failedReviewTurn = await testDb.agentTurn.findFirst({ where: {
      id: reviewTurnId, userId: ids.user, sessionId: scenario.sessionId, session: { userId: ids.user }, source: "user", status: "failed",
    }, select: { rootTaskId: true, input: true } })
    expect(failedReviewTurn?.input).toMatchObject({ intent: {
      kind: "reviewed_application_review", version: 1, sourceTurnId: source.turnId, jobId: scenario.jobId,
    } })
    const rootTaskId = failedReviewTurn?.rootTaskId
    if (typeof rootTaskId !== "string" || !rootTaskId) throw new Error("reviewed_application_failed_root_missing")
    const failureReceipt = await testDb.subAgentTask.findFirst({ where: {
      id: rootTaskId, rootTaskId, sessionId: scenario.sessionId, turnId: reviewTurnId, parentTaskId: null,
      role: "orchestrator", taskType: "root", session: { userId: ids.user },
    }, select: { id: true, rootTaskId: true, sessionId: true, turnId: true, parentTaskId: true,
      role: true, taskType: true, status: true, failureReason: true, result: true } })
    expect(failureReceipt).toMatchObject({
      id: rootTaskId, rootTaskId, sessionId: scenario.sessionId, turnId: reviewTurnId, parentTaskId: null,
      role: "orchestrator", taskType: "root", status: "failed", failureReason: "reviewed_application_review_denied",
      result: { status: "failed", stepCount: 0, toolCallCount: 0, finalItemId: null, waitId: null },
    })
    expect(await testDb.agentApproval.count({ where: { userId: ids.user, sessionId: scenario.sessionId, type: "review_application" } })).toBe(0)
    expect(await testDb.applicationTask.count({ where: { userId: ids.user, sessionId: scenario.sessionId, jobId: scenario.jobId } })).toBe(0)
    expect(await testDb.agentOutbox.count({ where: { aggregateId: scenario.sessionId, topic: "agent.reviewed-fill.dispatch" } })).toBe(0)
    const after = await requestFixtureStats()
    expect(after.reviewedGetCount).toBe(before.reviewedGetCount)
    expect(after.requests.filter(path => path.includes("/example-reviewed/jobs/1"))).toEqual(
      before.requests.filter(path => path.includes("/example-reviewed/jobs/1")))
    expect(after.reviewedSubmitCount).toBe(0)
    expect(after.requests).not.toContain("POST /example-reviewed/jobs/1")
  }, 300_000)
})

async function requestFixtureStats(timeoutMs = 5_000): Promise<FixtureStats> {
  if (!site?.stdin) throw new Error("Fixture site is unavailable")
  const previous = site.lines.filter(line => line.startsWith("FIXTURE_STATE ")).length
  site.stdin.write("stats\n")
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const lines = site.lines.filter(line => line.startsWith("FIXTURE_STATE "))
    if (lines.length > previous) return JSON.parse(lines[lines.length - 1]!.slice("FIXTURE_STATE ".length)) as FixtureStats
    await delay(20)
  }
  throw new Error("Fixture site did not return its request count")
}
