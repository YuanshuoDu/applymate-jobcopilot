import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { spawn, type ChildProcess } from "node:child_process"
import { createServer, type Server } from "node:http"
import { connect as connectSocket } from "node:net"
import { PassThrough } from "node:stream"
import { access, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import { Prisma, PrismaClient } from "@prisma/client"
import { hashApprovalNonce, hashApprovalScope } from "@jobcopilot/agent-protocol"
import { hashReviewedApplicationMaterialProof, matchesApplyTaskSubmitPayload } from "@jobcopilot/shared"
import { applicationSubmissionStopEventId } from "@jobcopilot/shared/application-submission-stop-protocol"
import { SignJWT } from "jose"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, onTestFailed, vi } from "vitest"

import { EXTENSION_TOKEN_AUDIENCE, EXTENSION_TOKEN_ISSUER, getAuthJwtSecret } from "@/lib/auth-secret"
import { protocolScope, type ApprovalScopeInput } from "@/lib/agent/approval/types"
import type { ApplicationPackage, PipelineCtx } from "@/lib/agent/types"

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
  "invalid_output",
  "persistence_conflict",
  "no_progress",
  "budget_exceeded",
  "tool_execution_failed",
  "tool_result_replay_uncertain",
  "tool_recovery_aborted",
  "policy_requires_approval",
  "approval_already_consumed",
  "approval_not_approved",
  "approval_expired",
  "approval_scope_mismatch",
  "approval_integrity_error",
  "approval_nonce_mismatch",
  "approval_revision_mismatch",
  "approval_reservation_conflict",
  "submission_attempt_fenced",
  "submission_scope_mismatch",
  "stale_artifact",
  "submission_guard_denied",
  "target_not_found",
  "invalid_state",
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
  reviewedHeldSubmitCount: number
  reviewedExactSubmissionCount: number
  reviewedMaterialExactCount: number
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
const socketPath = join(tmpdir(), `applymate-${runId}.sock`)
const reviewedFillRouteSocketPath = join(tmpdir(), `am-${runId.slice(0, 16)}-rf.sock`)
const tlsPaths = ["AGENT_TEST_TLS_CERT_PATH", "AGENT_TEST_TLS_KEY_PATH", "AGENT_TEST_TLS_CA_PATH"] as const
const testDb = new PrismaClient({ datasources: { db: { url: databaseUrl ?? DATABASE_URL } } })
const workerRequire = createRequire(new URL("../../../../../../worker/package.json", import.meta.url))
type Stage8ExecutionFailure = Readonly<{
  errorKind: "known_code" | "postgres" | "error" | "type_error" | "range_error" | "syntax_error" | "reference_error" | "aggregate_error" | "other" | "non_error"
  machineCode: string
  repoStage: "canonical_turn_runtime" | "canonical_turn_model" | "canonical_turn_setup" | "durable_wait" | "turn_queue" | "worker_runtime" | "other"
  sqlState: string
}>
const classifyStage8ExecutionFailure = (workerRequire("./src/queue/application-task-full-loop.trace-support.mjs") as {
  classifyStage8ExecutionFailure: (error: unknown) => Stage8ExecutionFailure
}).classifyStage8ExecutionFailure
const markerTraceSupport = workerRequire("./src/queue/application-task-full-loop.stage8-marker-trace.mjs") as {
  sanitizeStage8MarkerFenceTrace: (value: unknown) => Readonly<Record<string, string>>
  createStage8MarkerFenceTrace: (scope: Readonly<Record<string, unknown>>, writeLine: (line: string) => void) => {
    observe: (sql: string, values: readonly unknown[], result: unknown) => void
    observeError: (sql: string, values: readonly unknown[]) => void
    finish: () => void
  }
}
const { sanitizeStage8MarkerFenceTrace, createStage8MarkerFenceTrace } = markerTraceSupport
const classifyStage8StopPollError = (workerRequire("./src/queue/application-task-full-loop.stage8.fixture-support.mjs") as {
  classifyStage8StopPollError: (error: unknown) => string
}).classifyStage8StopPollError
const createStage8ExecutionFailureDiagnostics = (workerRequire("./src/queue/application-task-full-loop.trace-support.mjs") as {
  createStage8ExecutionFailureDiagnostics: (writeLine: (line: string) => void, input: PassThrough) => {
    record: (job: unknown, error: unknown) => boolean
  }
}).createStage8ExecutionFailureDiagnostics
const { Queue } = workerRequire("bullmq") as { Queue: new (name: string, options: { connection: { host: string; port: number; db: number } }) => {
  client: Promise<{ del(key: string): Promise<number>; get(key: string): Promise<string | null> }>
  toKey(value: string): string
  getJobs(states: readonly string[], start: number, end: number): Promise<Array<{ id?: string; data: unknown; attemptsMade: number; attemptsStarted: number; stalledCounter: number; opts?: { attempts?: number }; getState(): Promise<string>; remove(): Promise<void> }>>
  getJob(id: string): Promise<{ id?: string; data: unknown; attemptsMade: number; attemptsStarted: number; stalledCounter: number; opts?: { attempts?: number }; getState(): Promise<string>; remove(): Promise<void> } | undefined>
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

function spawnFixture(mode: "site" | "worker" | "worker-staged"): Child {
  const child = spawn(process.execPath, ["--import", "tsx", fixturePath, mode], {
    cwd: workerCwd,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl!, AGENT_RUNTIME_PG_TEST_URL: databaseUrl!,
      REDIS_URL: redisUrl!, AGENT_TURN_REDIS_TEST_URL: redisUrl!,
      AGENT_RUNTIME_PG_TEST_DISPOSABLE: "true", AGENT_RUNTIME_PG_TEST_REQUIRED: "true",
      AGENT_TURN_REDIS_TEST_DISPOSABLE: "true", RUN_AGENT_TURN_REDIS_INTEGRATION: "1",
      CLOAK_PROXY_URL: "http://127.0.0.1:9443", APPLICATION_TASK_FULL_LOOP_SOCKET_PATH: socketPath,
      APPLICATION_TASK_FULL_LOOP_STAGE_OBSERVER_TEST: mode !== "site" ? "true" : "false",
      APPLICATION_TASK_FULL_LOOP_REVIEWED_FILL_SOCKET_PATH: reviewedFillRouteSocketPath,
      ...(mode !== "site" ? { AGENT_WEB_URL: "", WEB_APP_URL: "", APPLYMATE_WEB_URL: "", AGENT_WORKER_SECRET: "",
        APPLICATION_TASK_FULL_LOOP_REVIEWED_FILL_ENDPOINT_URL: reviewedFillEndpointUrl,
        APPLICATION_TASK_FULL_LOOP_REVIEWED_FILL_SECRET: reviewedFillBridgeSecret } : {}),
      BULLMQ_STALLED_INTERVAL_MS: "30000",
      ...(mode !== "site" ? { APPLICATION_TASK_FULL_LOOP_USER_ID: ids.user } : {}),
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

describe("Stage8 terminal diagnostics", () => {
  it("preserves only known post-Stop checkpoints", () => {
    expect(reviewedFillDiagnosticValue("submission_uncertain", REVIEWED_FILL_DIAGNOSTIC_CHECKPOINTS)).toBe("submission_uncertain")
    expect(reviewedFillDiagnosticValue("user_takeover", REVIEWED_FILL_DIAGNOSTIC_CHECKPOINTS)).toBe("user_takeover")
    expect(reviewedFillDiagnosticValue("PRIVATE_CHECKPOINT", REVIEWED_FILL_DIAGNOSTIC_CHECKPOINTS)).toBe("other")
  })

  it("keeps marker-transaction diagnostics closed and bounded", () => {
    const traceLines: string[] = []
    const trace = createStage8MarkerFenceTrace({ sessionId: "private-session", fillTurnId: "private-turn",
      applicationTaskId: "private-task", userId: "private-user", jobId: "private-job", approvalId: "private-approval",
      constraintHash: "private-hash", workerTaskId: "private-worker" }, line => traceLines.push(line))
    trace.observe("BEGIN", [], { rows: [] })
    trace.observe(`WITH started AS (UPDATE application_tasks SET "checkpoint" = 'submission_request_started', "updatedAt" = NOW()
      WHERE "id" = $1 AND "userId" = $2 AND "jobId" = $3 AND "sessionId" = $4 AND "fillTurnId" = $5
        AND "status" = 'filling' AND "checkpoint" = 'browser_active' RETURNING "id")
      INSERT INTO application_task_events ("id", "taskId", type, actor, body, data, "createdAt")
      SELECT 'evt_' || $6, started."id", 'submission_execution_started', 'worker', 'Submit execution started', '{}'::jsonb, NOW() FROM started RETURNING "id"`,
    [], { rowCount: 1, rows: [{ id: "private-event-id" }] })
    trace.observe("ROLLBACK", [], { rows: [] })
    expect(traceLines).toHaveLength(1)
    const observed = JSON.parse(traceLines[0]!.slice("STAGE8_MARKER_TRANSACTION ".length)) as Record<string, string>
    expect(observed).toMatchObject({ transaction: "rolled_back", lastPhase: "mark_started", markStarted: "started" })
    expect(traceLines[0]).not.toMatch(/private-session|private-task|private-user|private-job|private-approval|private-hash|private-worker|private-event-id/)
    const commitLines: string[] = []
    const failedCommit = createStage8MarkerFenceTrace({}, line => commitLines.push(line))
    failedCommit.observe("BEGIN", [], { rows: [] })
    failedCommit.observeError("COMMIT", [])
    expect(commitLines).toHaveLength(0)
    failedCommit.observe("ROLLBACK", [], { rows: [] })
    const failedCommitSnapshot = JSON.parse(commitLines[0]!.slice("STAGE8_MARKER_TRANSACTION ".length)) as Record<string, string>
    expect(failedCommitSnapshot).toMatchObject({ transaction: "rolled_back", queryErrorPhase: "commit", lastPhase: "not_seen" })

    const snapshot = sanitizeStage8MarkerFenceTrace({
      transaction: "committed", lastPhase: "mark_started", queryErrorPhase: "PRIVATE_SQL", sourceReads: "multiple",
      sessionLockRows: "one", turnLockRows: "one", fillerRows: "one", taskLock: "match", jobLockRows: "one",
      taskRows: "one", taskStatus: "filling", taskCheckpoint: "browser_active", taskWorkerMatch: "match",
      attemptRows: "one", attemptState: "reserved", attemptMatch: "match", approvalRows: "one",
      approvalStatus: "consumed", approvalMatch: "match", priorStartRows: "zero", sessionStatus: "running",
      turnStatus: "completed", lease: "lease_free", interruption: "clear", markStarted: "started", stopStage: "recorded",
      sessionId: "PRIVATE_SESSION", workerTaskId: "PRIVATE_WORKER", constraintHash: "PRIVATE_HASH",
    })
    expect(snapshot).toMatchObject({ transaction: "committed", lastPhase: "mark_started", queryErrorPhase: "other",
      taskCheckpoint: "browser_active", taskWorkerMatch: "match", attemptState: "reserved", approvalStatus: "consumed",
      priorStartRows: "zero", sessionStatus: "running", turnStatus: "completed", lease: "lease_free",
      markStarted: "started", stopStage: "recorded" })
    const summary = stage8MarkerFenceSummary([
      `STAGE8_MARKER_TRANSACTION ${JSON.stringify({ ...snapshot, sessionId: "PRIVATE_SESSION", hash: "PRIVATE_HASH" })}`,
      "STAGE8_MARKER_TRANSACTION {invalid-json",
    ])
    expect(summary).toMatchObject({ transactionCount: 2, unclassifiedCount: 1, snapshot })
    expect(JSON.stringify(summary)).not.toMatch(/PRIVATE|SESSION|WORKER|HASH|SQL/)
  })

  it("summarizes only bounded first Stop-poll events and fixed error labels", () => {
    const known = classifyStage8StopPollError(new Error("Application submission request phase is unavailable."))
    const database = classifyStage8StopPollError(Object.assign(new Error("PRIVATE_DATABASE_DETAIL"), { code: "40P01" }))
    const unknown = classifyStage8StopPollError(new Error("PRIVATE_EXCEPTION_TEXT"))
    expect([known, database, unknown]).toEqual(["request_phase_unavailable", "database", "other"])
    const summary = stage8StopPollSummary([
      "STAGE8_STOP_POLL_ENTERED", "STAGE8_STOP_POLL_RETURN_CONTINUE",
      "STAGE8_STOP_POLL_CAUGHT request_phase_unavailable", "STAGE8_STOP_POLL_CAUGHT PRIVATE_EXCEPTION_TEXT",
      "STAGE8_STOP_POLL_RETURN_STOPPED private-session-id",
    ])
    expect(summary).toEqual({
      eventCounts: { entered: 1, returnedContinue: 1, returnedStopped: 0, caught: 1 },
      caughtCodeCounts: { turn_binding_unavailable: 0, task_binding_unavailable: 0, request_phase_unavailable: 1,
        turn_state_unavailable: 0, stop_state_unavailable: 0, scope_changed: 0, poll_commit_failed: 0, database: 0, other: 0 },
      unclassifiedCount: 2,
    })
    expect(JSON.stringify(summary)).not.toMatch(/PRIVATE|private|DATABASE_DETAIL|EXCEPTION_TEXT|session-id/)
    const requestSummary = stage8RequestFenceSummary([
      ...Array.from({ length: 80 }, () => "unrelated fixture output"),
      "STAGE8_EXACT_SUBMISSION_ROUTE_MATCHED", "STAGE8_START_FENCE_ENTERED", "STAGE8_START_FENCE_RESULT ready",
      "STAGE8_STOP_POLL_ENTERED",
    ])
    expect(requestSummary).toEqual({
      exactRouteMatched: true, exactFenceEntered: true,
      resultCounts: { ready: 1, stopped: 0, inactive: 0, uncertain: 0, threw: 0 }, unclassifiedCount: 0,
      stopPoll: { eventCounts: { entered: 1, returnedContinue: 0, returnedStopped: 0, caught: 0 },
        caughtCodeCounts: { turn_binding_unavailable: 0, task_binding_unavailable: 0, request_phase_unavailable: 0,
          turn_state_unavailable: 0, stop_state_unavailable: 0, scope_changed: 0, poll_commit_failed: 0, database: 0, other: 0 },
        unclassifiedCount: 0 },
      markerFence: { transactionCount: 0, snapshot: null, unclassifiedCount: 0 },
    })
  })

  it("reports approval resume evidence without exposing IDs, receipt contents, or tool inputs", () => {
    const summary = stage8FailureSummary({
      expectedApprovalId: "private-approval-id",
      expectedSessionId: "private-session-id",
      expectedTurnId: "private-turn-id",
      expectedWorkerTaskId: "private-worker-task-id",
      session: { status: "waiting_for_user" },
      turn: { status: "failed", error: "persistence_conflict", rootTaskId: "private-root-id" },
      root: { status: "failed", failureReason: "lease_lost" },
      applicationTask: { status: "failed", checkpoint: "execution_failed", workerTaskId: "private-worker-task-id",
        error: "approval_scope_mismatch" },
      approval: { status: "approved", toolCallId: "private-tool-call-id" },
      wait: { status: "completed", content: {
        waitKind: "approval", approvalId: "private-approval-id", toolCallId: "private-tool-call-id",
        decision: "approved", responseAvailable: true, receiptNonce: "private-nonce",
      } },
      steps: [{ status: "failed", errorCode: "invalid_output" }],
      tools: [{ type: "tool_call", status: "failed", content: {
        toolName: "application.submit", errorCode: "policy_requires_approval", arguments: { secret: "private-input" },
      } }],
      events: [{ type: "approval.resolved" }, { type: "turn.resumed" }, { type: "turn.failed" }],
      deadLetters: [],
      workerFailureLines: [],
    })
    expect(REVIEWED_FILL_DIAGNOSTIC_STATUSES.has("waiting_for_user")).toBe(true)
    expect(summary).toMatchObject({
      session: { present: true, status: "waiting_for_user" },
      turn: { present: true, status: "failed", errorCode: "persistence_conflict" },
      root: { present: true, status: "failed", failureCode: "lease_lost" },
      applicationTask: { status: "failed", checkpoint: "execution_failed", failureCode: "approval_scope_mismatch",
        workerTaskMatches: true },
      approval: { present: true, status: "approved" },
      wait: { present: true, status: "completed", kindMatches: true, approvalMatches: true,
        toolCallMatches: true, decision: "approved", responseAvailable: true },
      steps: [{ status: "failed", errorCode: "invalid_output" }],
      tools: [{ type: "tool_call", name: "application.submit", status: "failed", errorCode: "policy_requires_approval" }],
      events: { approval_resolved: true, turn_resumed: true, turn_failed: true },
    })
    expect(JSON.stringify(summary)).not.toMatch(/private|nonce|secret|input/)
  })

  it("keeps unknown Stage 8 task errors closed", () => {
    expect(stage8SubmissionFailureCode(null)).toBeNull()
    expect(stage8SubmissionFailureCode("approval_scope_mismatch")).toBe("approval_scope_mismatch")
    expect(stage8SubmissionFailureCode("PRIVATE_DATABASE_DETAIL")).toBe("other")
    expect(JSON.stringify(stage8SubmissionFailureCode("PRIVATE_DATABASE_DETAIL"))).not.toContain("PRIVATE")
  })

  it("keeps only exact owned Turn DLQ facts and exact-turn Worker failure codes", () => {
    const turnId = "private-fill-turn"
    const sessionId = "private-session"
    const owned = { turnId, sessionId, ownerId: "private-worker-owner", attemptsMade: 2,
      reason_code: "execution_failed", error_code: "turn_execution_error" }
    const summary = stage8FailureSummary({
      expectedApprovalId: "private-approval",
      expectedSessionId: sessionId,
      expectedTurnId: turnId,
      expectedWorkerTaskId: null,
      session: null,
      turn: { status: "failed", error: null, rootTaskId: "private-root" },
      root: null, applicationTask: null, approval: null, wait: null, steps: [], tools: [], events: [],
      deadLetters: [
        { payload: owned },
        { payload: { ...owned, sessionId: "foreign-session" } },
        { payload: { ...owned, turnId: "foreign-turn" } },
        { payload: { ...owned, error_code: "SECRET_EXCEPTION_TEXT" } },
        { payload: { ...owned, unexpected: "PRIVATE_PAYLOAD" } },
      ],
      workerFailureLines: [
        `TURN_JOB_FAILED job-1 turnId=${turnId} turn_not_owned`,
        `TURN_JOB_FAILED job-2 turnId=${turnId} PRIVATE_EXCEPTION_TEXT`,
        "TURN_JOB_FAILED foreign-job turnId=foreign-turn PRIVATE_FOREIGN_ERROR",
        `TURN_JOB_FAILED job-3 turnId=${turnId}-suffix PRIVATE_NEAR_MATCH`,
        `TURN_JOB_FAILED job-4 turnId=${turnId} SECRET_ERROR ${sessionId}`,
        `prefix TURN_JOB_FAILED job-5 turnId=${turnId} PRIVATE_MALFORMED`,
      ],
    })

    expect(summary.queueFailure).toMatchObject({
      deadLetters: { matchingCount: 3, unclassifiedCount: 2,
        records: [{ reasonCode: "execution_failed", errorCode: "turn_execution_error", attemptsMade: 2 }] },
      worker: { matchingLineCount: 3, errorCounts: {
        cognitive_agenda_resume_fence_invalid: 0, turn_not_owned: 1, archived_wait_accounting_invalid: 0,
        child_wait_claim_recovery_owner_mismatch: 0, child_resume_wait_tool_call_conflict: 0,
      }, unknownErrorCount: 2 },
    })
    expect(JSON.stringify(summary)).not.toMatch(/private|PRIVATE|SECRET|foreign|ownerId|turnId|sessionId/)
  })

  it("classifies only fixed execution labels and hides raw errors and source frames", () => {
    const known = Object.assign(new Error("cognitive_agenda_resume_fence_invalid"), {
      stack: "Error: PRIVATE_MESSAGE\n    at run (C:\\private\\apps\\worker\\src\\runtime\\canonical-turn-runtime.ts:10:2)",
    })
    const database = Object.assign(new TypeError("PRIVATE_DATABASE_DETAIL"), {
      code: "40P01", stack: "TypeError: PRIVATE_DATABASE_DETAIL\n    at claim (C:\\private\\apps\\worker\\src\\runtime\\turns\\durable-wait-control.ts:5:1)",
    })
    const unknown = Object.assign(new Error("PRIVATE_EXCEPTION_TEXT"), {
      code: "SECRET_CODE", stack: "Error: PRIVATE_EXCEPTION_TEXT\n    at private (C:\\private\\repo\\private-module.ts:1:1)",
    })
    expect(classifyStage8ExecutionFailure(known)).toEqual({ errorKind: "known_code",
      machineCode: "cognitive_agenda_resume_fence_invalid", repoStage: "canonical_turn_runtime", sqlState: "none" })
    expect(classifyStage8ExecutionFailure(database)).toEqual({ errorKind: "postgres", machineCode: "other",
      repoStage: "durable_wait", sqlState: "40P01" })
    expect(classifyStage8ExecutionFailure(unknown)).toEqual({ errorKind: "error", machineCode: "other",
      repoStage: "other", sqlState: "other" })

    const summary = stage8WorkerExecutionSummary([
      `STAGE8_TURN_EXECUTION_FAILURE ${JSON.stringify(classifyStage8ExecutionFailure(known))}`,
      `STAGE8_TURN_EXECUTION_FAILURE ${JSON.stringify(classifyStage8ExecutionFailure(database))}`,
      `STAGE8_TURN_EXECUTION_FAILURE ${JSON.stringify(classifyStage8ExecutionFailure(unknown))}`,
      'STAGE8_TURN_EXECUTION_FAILURE {"errorKind":"PRIVATE_RAW_FAILURE"}',
      "TURN_JOB_FAILED PRIVATE_RAW_FAILURE",
    ])
    expect(summary).toMatchObject({ matchingLineCount: 4, unclassifiedCount: 1,
      errorKindCounts: { known_code: 1, postgres: 1, error: 1 },
      repoStageCounts: { canonical_turn_runtime: 1, durable_wait: 1, other: 1 },
      machineCodeCounts: { cognitive_agenda_resume_fence_invalid: 1, other: 2 },
      sqlStateCounts: { "40P01": 1, other: 1, none: 1 } })
    expect(JSON.stringify(summary)).not.toMatch(/PRIVATE|SECRET|private|C:\\\\|module\.ts|PRIVATE_RAW_FAILURE/)
  })

  it("matches the canonical Session/Turn queue payload without userId and rejects foreign scope", () => {
    const input = new PassThrough()
    const lines: string[] = []
    const diagnostics = createStage8ExecutionFailureDiagnostics(line => lines.push(line), input)
    input.write("stage8-failure-target private-session private-fill-turn\n")
    expect(diagnostics.record({ data: { turnId: "private-fill-turn", sessionId: "other-session", ownerId: "agent-run:private-fill-turn" } }, new Error("PRIVATE_ERROR"))).toBe(false)
    expect(diagnostics.record({ data: { turnId: "other-turn", sessionId: "private-session", ownerId: "agent-run:other-turn" } }, new Error("PRIVATE_ERROR"))).toBe(false)
    expect(diagnostics.record({ data: { turnId: "private-fill-turn", sessionId: "private-session", ownerId: "agent-run:private-fill-turn" } }, new Error("PRIVATE_ERROR"))).toBe(true)

    expect(lines).toEqual([
      "STAGE8_FAILURE_TARGET_ARMED",
      'STAGE8_TURN_EXECUTION_FAILURE {"errorKind":"error","machineCode":"other","repoStage":"other","sqlState":"none"}',
    ])
    expect(JSON.stringify(lines)).not.toMatch(/private-session|private-fill-turn|PRIVATE_ERROR/)
    input.destroy()
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

type LegacyAckFakeJob = {
  id: string
  attemptsStarted: number
  data: { operation: string; sessionId: string; fillTurnId: string }
}
type LegacyAckFakeWorker = { processFn: (job: LegacyAckFakeJob, ...args: unknown[]) => Promise<string> }
type LegacyAckWitness = {
  arm(value: unknown): boolean
  proves(value: unknown): boolean
  wrap(worker: LegacyAckFakeWorker): void
  releaseForShutdown(): void
}

async function createLegacyAckWitnessForTest(writeLine: (line: string) => void): Promise<LegacyAckWitness> {
  const supportUrl = new URL("../../../../../../worker/src/queue/application-task-full-loop.legacy-ack.fixture-support.mjs", import.meta.url)
  const supportModule = await import(supportUrl.href) as { createLegacyQueueAckWitness: (write: (line: string) => void) => LegacyAckWitness }
  return supportModule.createLegacyQueueAckWitness(writeLine)
}

describe("legacy queue acknowledgement fixture witness", () => {
  it("holds only the exact returned submit attempt until bounded teardown", async () => {
    const markers: string[] = []
    const witness = await createLegacyAckWitnessForTest(line => markers.push(line))
    const worker: LegacyAckFakeWorker = { processFn: async () => "processed" }
    witness.wrap(worker)
    const scope = { sessionId: `full-loop-session-${"a".repeat(32)}`, fillTurnId: "turn_witness", expectedAttempt: 1 }
    expect(witness.arm({ ...scope, extraAuthority: true })).toBe(false)
    expect(witness.arm(scope)).toBe(true)
    expect(witness.arm(scope)).toBe(false)

    const unrelated: LegacyAckFakeJob = { id: "job_other", attemptsStarted: 1,
      data: { operation: "submit", sessionId: scope.sessionId, fillTurnId: "turn_other" } }
    await expect(worker.processFn(unrelated)).resolves.toBe("processed")
    const retryAttempt: LegacyAckFakeJob = { id: "job_retry", attemptsStarted: 2,
      data: { operation: "submit", sessionId: scope.sessionId, fillTurnId: scope.fillTurnId } }
    await expect(worker.processFn(retryAttempt)).resolves.toBe("processed")
    const fillJob: LegacyAckFakeJob = { id: "job_fill", attemptsStarted: 1,
      data: { operation: "fill", sessionId: scope.sessionId, fillTurnId: scope.fillTurnId } }
    await expect(worker.processFn(fillJob)).resolves.toBe("processed")
    expect(markers).toEqual([])

    const submitJob: LegacyAckFakeJob = { id: "job_submit", attemptsStarted: 1,
      data: { operation: "submit", sessionId: scope.sessionId, fillTurnId: scope.fillTurnId } }
    let processorSettled = false
    const pending = worker.processFn(submitJob).then(result => { processorSettled = true; return result })
    await vi.waitFor(() => expect(markers).toContain("LEGACY_ACK_BARRIER_REACHED attempt=1"))
    expect(processorSettled).toBe(false)
    const proof = { sessionId: scope.sessionId, fillTurnId: scope.fillTurnId, jobId: submitJob.id, attemptsStarted: 1 }
    expect(witness.proves({ ...proof, jobId: "job_other" })).toBe(false)
    expect(witness.proves(proof)).toBe(true)
    witness.releaseForShutdown()
    await expect(pending).resolves.toBe("processed")
    expect(processorSettled).toBe(true)
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

async function waitForLegacyAckMarker(child: Child, expected: string, rejected?: string, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (child.lines.includes(expected)) return
    if (rejected && child.lines.includes(rejected)) throw new Error("legacy_ack_barrier_control_rejected")
    if (exited(child)) throw new Error("legacy_ack_barrier_worker_exited")
    await delay(25)
  }
  throw new Error("legacy_ack_barrier_marker_timeout")
}

async function armLegacyQueueAckBarrier(sessionId: string, fillTurnId: string): Promise<void> {
  if (!worker?.stdin) throw new Error("legacy_ack_barrier_worker_stdin_unavailable")
  worker.stdin.write(`arm-legacy-ack-barrier ${JSON.stringify({ sessionId, fillTurnId, expectedAttempt: 1 })}\n`)
  await waitForLegacyAckMarker(worker, "LEGACY_ACK_BARRIER_ARMED", "LEGACY_ACK_BARRIER_ARM_FAILED")
}

async function proveLegacyQueueAckBarrier(proof: {
  sessionId: string; fillTurnId: string; jobId: string; attemptsStarted: number
}): Promise<void> {
  if (!worker?.stdin) throw new Error("legacy_ack_barrier_worker_stdin_unavailable")
  worker.stdin.write(`prove-legacy-ack-barrier ${JSON.stringify(proof)}\n`)
  await waitForLegacyAckMarker(worker, "LEGACY_ACK_BARRIER_PROVED", "LEGACY_ACK_BARRIER_PROOF_REJECTED")
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
    if (exited(child)) throw new Error(`BullMQ redelivery worker exited; workerLineCount=${child.lines.length}; workerErrorCount=${child.errors.length}`)
    await delay(50)
  }
  const matchingEvents = child.lines.map(parseApplyJobActiveEvent).filter((event): event is ApplyJobActiveEvent => event?.jobId === jobId)
  const maxAttemptsStarted = matchingEvents.length ? Math.max(...matchingEvents.map(event => event.attemptsStarted)) : null
  const maxStalledCounter = matchingEvents.length ? Math.max(...matchingEvents.map(event => event.stalledCounter)) : null
  throw new Error(`BullMQ did not redeliver; matchingEventCount=${matchingEvents.length}; maxAttemptsStarted=${maxAttemptsStarted}; maxStalledCounter=${maxStalledCounter}`)
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

async function waitForReviewedApplicationTask(jobId: string, predicate: (task: ApplicationTaskRow) => boolean, timeoutMs = 120_000, diagnoseStage8Prestart = false): Promise<ApplicationTaskRow> {
  const until = Date.now() + timeoutMs
  let latest: ApplicationTaskRow | null = null
  while (Date.now() < until) {
    latest = await testDb.applicationTask.findUnique({ where: { userId_jobId: { userId: ids.user, jobId } } }) as ApplicationTaskRow | null
    if (latest && predicate(latest)) return latest
    if (diagnoseStage8Prestart && latest?.status === "failed" && latest.checkpoint === "fill_prestart_failed") {
      const code = await stage8PrestartFailureCode(latest)
      throw new Error(`Reviewed ApplicationTask failed before submit approval; prestartFailureCode=${code}`)
    }
    if (worker && exited(worker)) throw new Error("Worker exited while waiting for reviewed ApplicationTask")
    await delay(100)
  }
  throw new Error(`Reviewed ApplicationTask did not reach the expected state; status=${latest?.status ?? "missing"}; checkpoint=${latest?.checkpoint ?? "missing"}`)
}

const STAGE8_PRESTART_FAILURE_CODES = new Set([
  "fill_context_unavailable", "fill_material_unavailable", "fill_rate_limited", "fill_preflight_unavailable",
])

async function stage8PrestartFailureCode(task: ApplicationTaskRow): Promise<string> {
  if (!task.sessionId || !task.fillTurnId) return "unavailable"
  try {
    const turn = await testDb.agentTurn.findFirst({ where: {
      id: task.fillTurnId, userId: ids.user, sessionId: task.sessionId, session: { userId: ids.user },
    }, select: { rootTaskId: true } })
    if (!turn?.rootTaskId) return "unavailable"
    const until = Date.now() + 3_000
    while (true) {
      const rows = await testDb.subAgentTask.findMany({ where: {
        rootTaskId: turn.rootTaskId, sessionId: task.sessionId, turnId: task.fillTurnId,
        parentTaskId: turn.rootTaskId, role: "application_filler", taskType: "application_fill_for_review",
        status: "failed", session: { userId: ids.user },
      }, take: 3, select: { failureReason: true } })
      if (rows.length > 1) return "multiple"
      if (rows.length === 1) {
        const reason = rows[0]?.failureReason
        return typeof reason === "string" && STAGE8_PRESTART_FAILURE_CODES.has(reason) ? reason : "other"
      }
      if (Date.now() >= until) return "none"
      await delay(50)
    }
  } catch { return "unavailable" }
}

const REVIEWED_FILL_DIAGNOSTIC_STATUSES = new Set([
  "queued", "in_progress", "running", "waiting", "waiting_for_user", "waiting_for_approval", "waiting_for_dependency",
  "waiting_for_authorization", "filling", "completed", "submitted", "failed", "cancelled", "interrupted", "retrying",
])
const REVIEWED_FILL_DIAGNOSTIC_CHECKPOINTS = new Set([
  "materials_ready", "taskgraph_fill_queued", "browser_active", "form_answer_required", "fill_outcome_uncertain",
  "form_filled", "submission_authorized", "submission_uncertain", "user_takeover", "queue_retry",
  "turn_stopped_before_submit", "fill_prestart_failed", "execution_failed",
])

const STAGE8_SUBMISSION_FAILURE_CODES = new Set([
  "approval_not_found", "approval_scope_mismatch", "approval_integrity_error", "approval_expired",
  "approval_not_approved", "approval_already_consumed", "approval_nonce_mismatch", "approval_revision_mismatch",
  "approval_reservation_conflict", "invalid_input", "target_not_found", "submission_attempt_fenced",
  "submission_scope_mismatch", "idempotency_conflict", "idempotency_replay", "submission_in_flight",
  "stale_artifact", "submission_guard_denied", "provider_invalid_response", "provider_error", "invalid_state",
  "not_found", "browser_412", "browser_manual", "browser_failed", "submission_failed",
])

function stage8SubmissionFailureCode(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return typeof value === "string" && STAGE8_SUBMISSION_FAILURE_CODES.has(value) ? value : "other"
}

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

async function createReviewedSourceScenario(label: "positive" | "stale" | "stage8-stop-first" | "stage8-grant-first", description: string) {
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

type Stage8PreparedScenario = {
  jobId: string
  sessionId: string
  token: string
  sourceTurnId: string
  reviewTurnId: string
  fillTurnId: string
  applicationTaskId: string
  submitApprovalId: string
}
type Stage8FailureSnapshotScope = Pick<Stage8PreparedScenario,
  "jobId" | "sessionId" | "fillTurnId" | "applicationTaskId" | "submitApprovalId">

const STAGE8_RATE_LIMIT_DOMAIN = "boards.greenhouse.io"

async function resetStage8DomainRateLimit(): Promise<void> {
  if (!enabled || !applyQueue) throw new Error("stage8_rate_limit_isolation_unavailable")
  const redis = await applyQueue.client
  await redis.del(`ratelimit:domain:${ids.user}:${STAGE8_RATE_LIMIT_DOMAIN}`)
}

type Stage8SubmitIntent = {
  applicationTaskId: string
  userId: string
  jobId: string
  sessionId: string
  fillTurnId: string
  receiptId: string
  constraintHash: string
  workerTaskId: string
}

const STAGE8_APPROVAL_STATUSES = new Set(["pending", "approved", "consumed", "rejected", "expired"])
const STAGE8_WAIT_STATUSES = new Set([...REVIEWED_FILL_DIAGNOSTIC_STATUSES, "started"])
const STAGE8_TOOL_NAMES = new Set([
  "agent.plan", "agent.wait", "wait_subagents", "application.submit", "cover_letter.draft",
  "artifact.version.read", "artifact.review",
])
const STAGE8_EVENT_TYPES = [
  "approval.resolved", "turn.resumed", "turn.failed", "turn.completed", "step.completed",
  "tool_call.failed", "tool_call.completed",
] as const
const STAGE8_DLQ_REASONS = new Set([
  "schema_invalid_payload", "max_retries_exhausted", "execution_failed", "lease_lost",
  "cognitive_agenda_resume_fence_invalid",
])
const STAGE8_DLQ_ERRORS = new Set([
  "invalid_payload", "lease_not_available", "lease_lost", "cognitive_agenda_resume_fence_invalid", "turn_execution_error",
])
const STAGE8_WORKER_FAILURE_CODES = [
  "cognitive_agenda_resume_fence_invalid", "turn_not_owned", "archived_wait_accounting_invalid",
  "child_wait_claim_recovery_owner_mismatch", "child_resume_wait_tool_call_conflict",
] as const
const STAGE8_WORKER_FAILURE_CODE_SET: ReadonlySet<string> = new Set(STAGE8_WORKER_FAILURE_CODES)
const STAGE8_EXECUTION_ERROR_KINDS = ["known_code", "postgres", "error", "type_error", "range_error", "syntax_error", "reference_error", "aggregate_error", "other", "non_error"] as const
const STAGE8_EXECUTION_REPO_STAGES = ["canonical_turn_runtime", "canonical_turn_model", "canonical_turn_setup", "durable_wait", "turn_queue", "worker_runtime", "other"] as const
const STAGE8_EXECUTION_MACHINE_CODES = [
  "cognitive_agenda_resume_fence_invalid", "turn_not_owned", "archived_wait_accounting_invalid",
  "child_wait_claim_recovery_owner_mismatch", "child_resume_wait_tool_call_conflict", "persistence_conflict",
  "turn_execution_error", "application_fill_material_unavailable", "application_fill_state_invalid",
  "application_fill_binding_invalid", "lease_lost", "none", "other",
] as const
const STAGE8_EXECUTION_SQL_STATES = ["08000", "08001", "08003", "08006", "23502", "23503", "23505", "23514",
  "40001", "40P01", "55P03", "57P01", "57P03", "none", "other"] as const

function stage8DeadLetterSummary(rows: readonly unknown[], sessionId: string, turnId: string) {
  const records: Array<{ reasonCode: string; errorCode: string; attemptsMade: number }> = []
  let unclassifiedCount = 0
  for (const row of rows.slice(0, 8)) {
    const payload = jsonRecord(jsonRecord(row)?.payload)
    if (payload?.turnId !== turnId || payload.sessionId !== sessionId) continue
    const keys = Object.keys(payload).sort()
    if (JSON.stringify(keys) !== JSON.stringify(["attemptsMade", "error_code", "ownerId", "reason_code", "sessionId", "turnId"].sort())
      || typeof payload.ownerId !== "string" || !payload.ownerId
      || !Number.isSafeInteger(payload.attemptsMade) || Number(payload.attemptsMade) < 1 || Number(payload.attemptsMade) > 5) {
      unclassifiedCount += 1
      continue
    }
    if (typeof payload.reason_code !== "string" || !STAGE8_DLQ_REASONS.has(payload.reason_code)
      || typeof payload.error_code !== "string" || !STAGE8_DLQ_ERRORS.has(payload.error_code)) {
      unclassifiedCount += 1
      continue
    }
    records.push({ reasonCode: payload.reason_code, errorCode: payload.error_code, attemptsMade: Number(payload.attemptsMade) })
  }
  return { matchingCount: records.length + unclassifiedCount, unclassifiedCount, records }
}

function stage8WorkerFailureSummary(lines: readonly string[], turnId: string) {
  const errorCounts = Object.fromEntries(STAGE8_WORKER_FAILURE_CODES.map(code => [code, 0])) as Record<typeof STAGE8_WORKER_FAILURE_CODES[number], number>
  let matchingLineCount = 0
  let unknownErrorCount = 0
  for (const line of lines.slice(-64)) {
    if (typeof line !== "string" || line.length > 2_048 || /[\r\n]/.test(line)) continue
    const match = /^TURN_JOB_FAILED \S+ turnId=(\S+) (.*)$/.exec(line)
    if (!match || match[1] !== turnId) continue
    matchingLineCount += 1
    const error = match[2]!
    if (STAGE8_WORKER_FAILURE_CODE_SET.has(error)) errorCounts[error as typeof STAGE8_WORKER_FAILURE_CODES[number]] += 1
    else unknownErrorCount += 1
  }
  return { matchingLineCount, errorCounts, unknownErrorCount }
}

function stage8WorkerExecutionSummary(lines: readonly string[]) {
  const errorKindCounts = Object.fromEntries(STAGE8_EXECUTION_ERROR_KINDS.map(value => [value, 0])) as Record<typeof STAGE8_EXECUTION_ERROR_KINDS[number], number>
  const repoStageCounts = Object.fromEntries(STAGE8_EXECUTION_REPO_STAGES.map(value => [value, 0])) as Record<typeof STAGE8_EXECUTION_REPO_STAGES[number], number>
  const machineCodeCounts = Object.fromEntries(STAGE8_EXECUTION_MACHINE_CODES.map(value => [value, 0])) as Record<typeof STAGE8_EXECUTION_MACHINE_CODES[number], number>
  const sqlStateCounts = Object.fromEntries(STAGE8_EXECUTION_SQL_STATES.map(value => [value, 0])) as Record<typeof STAGE8_EXECUTION_SQL_STATES[number], number>
  let matchingLineCount = 0
  let unclassifiedCount = 0
  for (const line of lines.slice(-64)) {
    if (typeof line !== "string" || !line.startsWith("STAGE8_TURN_EXECUTION_FAILURE ")) continue
    matchingLineCount += 1
    if (line.length > 1_024 || /[\r\n]/.test(line)) { unclassifiedCount += 1; continue }
    let value: unknown
    try { value = JSON.parse(line.slice("STAGE8_TURN_EXECUTION_FAILURE ".length)) } catch { unclassifiedCount += 1; continue }
    const record = jsonRecord(value)
    if (!record || JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(["errorKind", "machineCode", "repoStage", "sqlState"])
      || !STAGE8_EXECUTION_ERROR_KINDS.includes(record.errorKind as typeof STAGE8_EXECUTION_ERROR_KINDS[number])
      || !STAGE8_EXECUTION_MACHINE_CODES.includes(record.machineCode as typeof STAGE8_EXECUTION_MACHINE_CODES[number])
      || !STAGE8_EXECUTION_REPO_STAGES.includes(record.repoStage as typeof STAGE8_EXECUTION_REPO_STAGES[number])
      || !STAGE8_EXECUTION_SQL_STATES.includes(record.sqlState as typeof STAGE8_EXECUTION_SQL_STATES[number])) {
      unclassifiedCount += 1
      continue
    }
    errorKindCounts[record.errorKind as typeof STAGE8_EXECUTION_ERROR_KINDS[number]] += 1
    machineCodeCounts[record.machineCode as typeof STAGE8_EXECUTION_MACHINE_CODES[number]] += 1
    repoStageCounts[record.repoStage as typeof STAGE8_EXECUTION_REPO_STAGES[number]] += 1
    sqlStateCounts[record.sqlState as typeof STAGE8_EXECUTION_SQL_STATES[number]] += 1
  }
  return { matchingLineCount, unclassifiedCount, errorKindCounts, machineCodeCounts, repoStageCounts, sqlStateCounts }
}

type Stage8FailureEvidence = Readonly<{
  expectedApprovalId: string
  expectedSessionId: string
  expectedTurnId: string
  expectedWorkerTaskId: string | null
  session: { status: unknown } | null
  turn: { status: unknown; error: unknown; rootTaskId: unknown } | null
  root: { status: unknown; failureReason: unknown } | null
  applicationTask: { status: unknown; checkpoint: unknown; workerTaskId: unknown; error: unknown } | null
  approval: { status: unknown; toolCallId: unknown } | null
  wait: { status: unknown; content: unknown } | null
  steps: readonly { status: unknown; errorCode: unknown }[]
  tools: readonly { type: unknown; status: unknown; content: unknown }[]
  events: readonly { type: unknown }[]
  deadLetters: readonly unknown[]
  workerFailureLines: readonly string[]
}>

function stage8FailureSummary(evidence: Stage8FailureEvidence) {
  const waitContent = jsonRecord(evidence.wait?.content)
  const decision = waitContent?.decision
  const approvalToolCallId = evidence.approval?.toolCallId
  const eventTypes = new Set(evidence.events.map(event => event.type))
  return {
    session: { present: evidence.session !== null,
      status: reviewedFillDiagnosticValue(evidence.session?.status, REVIEWED_FILL_DIAGNOSTIC_STATUSES) },
    turn: { present: evidence.turn !== null, status: reviewedFillDiagnosticValue(evidence.turn?.status, REVIEWED_FILL_DIAGNOSTIC_STATUSES),
      errorCode: diagnosticMachineErrorCode(evidence.turn?.error) },
    root: { present: evidence.root !== null, status: reviewedFillDiagnosticValue(evidence.root?.status, REVIEWED_FILL_DIAGNOSTIC_STATUSES),
      failureCode: diagnosticMachineErrorCode(evidence.root?.failureReason) },
    applicationTask: { present: evidence.applicationTask !== null,
      status: reviewedFillDiagnosticValue(evidence.applicationTask?.status, REVIEWED_FILL_DIAGNOSTIC_STATUSES),
      checkpoint: reviewedFillDiagnosticValue(evidence.applicationTask?.checkpoint, REVIEWED_FILL_DIAGNOSTIC_CHECKPOINTS),
      failureCode: stage8SubmissionFailureCode(evidence.applicationTask?.error),
      workerTaskMatches: evidence.expectedWorkerTaskId === null ? null
        : evidence.applicationTask?.workerTaskId === evidence.expectedWorkerTaskId },
    approval: { present: evidence.approval !== null,
      status: reviewedFillDiagnosticValue(evidence.approval?.status, STAGE8_APPROVAL_STATUSES) },
    wait: {
      present: evidence.wait !== null,
      status: reviewedFillDiagnosticValue(evidence.wait?.status, STAGE8_WAIT_STATUSES),
      kindMatches: waitContent?.waitKind === "approval",
      approvalMatches: waitContent?.approvalId === evidence.expectedApprovalId,
      toolCallMatches: typeof approvalToolCallId === "string" && approvalToolCallId.length > 0
        && waitContent?.toolCallId === approvalToolCallId,
      decision: decision === "approved" || decision === "rejected" || decision === "cancelled" ? decision : "other",
      responseAvailable: waitContent?.responseAvailable === true,
    },
    steps: evidence.steps.slice(-6).map(step => ({
      status: reviewedFillDiagnosticValue(step.status, REVIEWED_FILL_DIAGNOSTIC_STATUSES),
      errorCode: diagnosticMachineErrorCode(step.errorCode),
    })),
    tools: evidence.tools.slice(-8).map(item => {
      const name = jsonString(item.content, "toolName")
      return {
        type: item.type === "tool_call" || item.type === "tool_result" ? item.type : "other",
        name: name && STAGE8_TOOL_NAMES.has(name) ? name : "other",
        status: reviewedFillDiagnosticValue(item.status, REVIEWED_FILL_DIAGNOSTIC_STATUSES),
        errorCode: diagnosticMachineErrorCode(jsonString(item.content, "errorCode")),
      }
    }),
    events: Object.fromEntries(STAGE8_EVENT_TYPES.map(type => [type.replaceAll(".", "_"), eventTypes.has(type)])),
    queueFailure: {
      deadLetters: stage8DeadLetterSummary(evidence.deadLetters, evidence.expectedSessionId, evidence.expectedTurnId),
      worker: { ...stage8WorkerFailureSummary(evidence.workerFailureLines, evidence.expectedTurnId),
        execution: stage8WorkerExecutionSummary(evidence.workerFailureLines) },
    },
  }
}

async function stage8FillFailureSnapshot(prepared: Stage8FailureSnapshotScope, expectedWorkerTaskId: string | null = null): Promise<unknown> {
  try {
    return await beforeDeadline(async () => {
      const [session, turn] = await Promise.all([
        testDb.agentSession.findFirst({ where: { id: prepared.sessionId, userId: ids.user }, select: { status: true } }),
        testDb.agentTurn.findFirst({ where: {
          id: prepared.fillTurnId, userId: ids.user, sessionId: prepared.sessionId, session: { userId: ids.user },
        }, select: { status: true, error: true, rootTaskId: true } }),
      ])
      const [root, applicationTask, approval, wait, steps, tools, events, deadLetters] = await Promise.all([
        typeof turn?.rootTaskId === "string" ? testDb.subAgentTask.findFirst({ where: {
          id: turn.rootTaskId, rootTaskId: turn.rootTaskId, sessionId: prepared.sessionId, turnId: prepared.fillTurnId,
          parentTaskId: null, role: "orchestrator", taskType: "root", session: { userId: ids.user },
        }, select: { status: true, failureReason: true } }) : Promise.resolve(null),
        testDb.applicationTask.findFirst({ where: {
          id: prepared.applicationTaskId, userId: ids.user, sessionId: prepared.sessionId,
          jobId: prepared.jobId, fillTurnId: prepared.fillTurnId,
        }, select: { status: true, checkpoint: true, workerTaskId: true, error: true } }),
        testDb.agentApproval.findFirst({ where: {
          id: prepared.submitApprovalId, userId: ids.user, sessionId: prepared.sessionId,
          taskId: prepared.applicationTaskId, turnId: prepared.fillTurnId, jobId: prepared.jobId,
          type: "submit_application",
        }, select: { status: true, toolCallId: true } }),
        testDb.agentItem.findFirst({ where: {
          id: `agent-wait:approval:${prepared.submitApprovalId}`, sessionId: prepared.sessionId,
          turnId: prepared.fillTurnId, type: "approval_request",
        }, select: { status: true, content: true } }),
        testDb.agentStep.findMany({ where: { sessionId: prepared.sessionId, turnId: prepared.fillTurnId },
          orderBy: { ordinal: "asc" }, take: 8, select: { status: true, errorCode: true } }),
        testDb.agentItem.findMany({ where: {
          sessionId: prepared.sessionId, turnId: prepared.fillTurnId, type: { in: ["tool_call", "tool_result"] },
        }, orderBy: { createdAt: "asc" }, take: 16, select: { type: true, status: true, content: true } }),
        testDb.agentEvent.findMany({ where: {
          sessionId: prepared.sessionId, turnId: prepared.fillTurnId, type: { in: [...STAGE8_EVENT_TYPES] },
        }, orderBy: { sequence: "desc" }, take: 16, select: { type: true } }),
        testDb.agentOutbox.findMany({ where: { topic: "agent.turn.dlq", aggregateId: prepared.fillTurnId },
          orderBy: { createdAt: "desc" }, take: 8, select: { payload: true } }),
      ])
      return stage8FailureSummary({ expectedApprovalId: prepared.submitApprovalId, expectedSessionId: prepared.sessionId,
        expectedTurnId: prepared.fillTurnId, expectedWorkerTaskId, session, turn, root, applicationTask, approval, wait, steps, tools, events,
        deadLetters: turn ? deadLetters : [], workerFailureLines: turn ? worker?.lines ?? [] : [] })
    }, Date.now() + 1_200)
  } catch {
    return { available: false }
  }
}

const STAGE8_BULL_STATES = new Set(["active", "completed", "delayed", "failed", "paused", "waiting", "waiting-children"])
const STAGE8_FENCE_STATES = ["ready", "stopped", "inactive", "uncertain", "threw"] as const
const STAGE8_STOP_POLL_ERRORS = ["turn_binding_unavailable", "task_binding_unavailable", "request_phase_unavailable",
  "turn_state_unavailable", "stop_state_unavailable", "scope_changed", "poll_commit_failed", "database", "other"] as const
const STAGE8_MARKER_TRACE_PREFIX = "STAGE8_MARKER_TRANSACTION "

function stage8StopPollSummary(lines: readonly string[]) {
  const eventCounts = { entered: 0, returnedContinue: 0, returnedStopped: 0, caught: 0 }
  const caughtCodeCounts = Object.fromEntries(STAGE8_STOP_POLL_ERRORS.map(code => [code, 0])) as Record<typeof STAGE8_STOP_POLL_ERRORS[number], number>
  let unclassifiedCount = 0
  const pollLines = lines.filter(line => typeof line === "string" && line.startsWith("STAGE8_STOP_POLL_")).slice(-64)
  for (const line of pollLines) {
    if (line === "STAGE8_STOP_POLL_ENTERED") eventCounts.entered += 1
    else if (line === "STAGE8_STOP_POLL_RETURN_CONTINUE") eventCounts.returnedContinue += 1
    else if (line === "STAGE8_STOP_POLL_RETURN_STOPPED") eventCounts.returnedStopped += 1
    else if (typeof line === "string" && line.startsWith("STAGE8_STOP_POLL_CAUGHT ")) {
      const match = /^STAGE8_STOP_POLL_CAUGHT ([a-z_]+)$/.exec(line)
      if (match && STAGE8_STOP_POLL_ERRORS.includes(match[1] as typeof STAGE8_STOP_POLL_ERRORS[number])) {
        eventCounts.caught += 1
        caughtCodeCounts[match[1] as typeof STAGE8_STOP_POLL_ERRORS[number]] += 1
      } else unclassifiedCount += 1
    } else if (typeof line === "string" && line.startsWith("STAGE8_STOP_POLL_")) unclassifiedCount += 1
  }
  return { eventCounts, caughtCodeCounts, unclassifiedCount }
}

function stage8MarkerFenceSummary(lines: readonly string[]) {
  const markerLines = lines.filter(line => typeof line === "string" && line.startsWith(STAGE8_MARKER_TRACE_PREFIX)).slice(-64)
  let snapshot: Readonly<Record<string, string>> | null = null
  let unclassifiedCount = 0
  for (const line of markerLines) {
    try { snapshot = sanitizeStage8MarkerFenceTrace(JSON.parse(line.slice(STAGE8_MARKER_TRACE_PREFIX.length))) }
    catch { unclassifiedCount += 1 }
  }
  return { transactionCount: markerLines.length, snapshot, unclassifiedCount }
}

function stage8RequestFenceSummary(lines: readonly string[]) {
  let routeMatched = false
  let fenceEntered = false
  let unclassifiedCount = 0
  const resultCounts = Object.fromEntries(STAGE8_FENCE_STATES.map(state => [state, 0])) as Record<typeof STAGE8_FENCE_STATES[number], number>
  for (const line of lines.slice(-64)) {
    if (line === "STAGE8_EXACT_SUBMISSION_ROUTE_MATCHED") { routeMatched = true; continue }
    if (line === "STAGE8_START_FENCE_ENTERED") { fenceEntered = true; continue }
    const match = /^STAGE8_START_FENCE_RESULT (ready|stopped|inactive|uncertain|threw)$/.exec(line)
    if (match) resultCounts[match[1] as typeof STAGE8_FENCE_STATES[number]] += 1
    else if (typeof line === "string" && line.startsWith("STAGE8_START_FENCE_RESULT ")) unclassifiedCount += 1
  }
  return { exactRouteMatched: routeMatched, exactFenceEntered: fenceEntered, resultCounts, unclassifiedCount,
    stopPoll: stage8StopPollSummary(lines), markerFence: stage8MarkerFenceSummary(lines) }
}

async function stage8ApplyQueueState(workerTaskId: string) {
  const queue = applyQueue
  if (!queue) return { available: false }
  try {
    return await beforeDeadline(async () => {
      const job = await queue.getJob(workerTaskId)
      if (!job) return { available: true, present: false, state: "missing" }
      const state = await job.getState()
      return { available: true, present: true, state: STAGE8_BULL_STATES.has(state) ? state : "other" }
    }, Date.now() + 1_200)
  } catch { return { available: false } }
}

async function throwStage8SettlementTimeout(prepared: Stage8PreparedScenario, workerTaskId: string): Promise<never> {
  const [database, queue] = await Promise.all([
    stage8FillFailureSnapshot(prepared, workerTaskId), stage8ApplyQueueState(workerTaskId),
  ])
  throw new Error("stage8_submit_worker_did_not_settle:" + JSON.stringify({
    database, queue, requestFence: stage8RequestFenceSummary(worker?.lines ?? []),
  }))
}

async function waitForStage8Arm(prepared: Stage8PreparedScenario, intent: Stage8SubmitIntent): Promise<void> {
  try { await waitLine(worker!, "STAGE8_ARM_COMMITTED " + intent.workerTaskId, 90_000) }
  catch {
    const [database, queue] = await Promise.all([
      stage8FillFailureSnapshot(prepared, intent.workerTaskId), stage8ApplyQueueState(intent.workerTaskId),
    ])
    throw new Error("stage8_arm_commit_missing:" + JSON.stringify({ database, queue, requestFence: stage8RequestFenceSummary(worker?.lines ?? []) }))
  }
}

async function prepareStage8Scenario(label: "stop-first" | "grant-first"): Promise<Stage8PreparedScenario> {
  await resetStage8DomainRateLimit()
  const scenario = await createReviewedSourceScenario(`stage8-${label}`, `Synthetic Stage 8 ${label} source description.`)
  const token = await signedBearer(ids.user)
  const source = await startSelectedJobSource({ ...scenario, token, key: `stage8-source-${label}-${runId}` })
  const sourceChildren = await testDb.subAgentTask.findMany({ where: {
    sessionId: scenario.sessionId, turnId: source.turnId, role: { in: ["writer", "reviewer"] }, status: "completed",
  }, select: { id: true, role: true, status: true, result: true } })
  expect(sourceChildren.map(child => child.role).sort()).toEqual(["reviewer", "writer"])
  const writer = sourceChildren.find(child => child.role === "writer")!
  const reviewer = sourceChildren.find(child => child.role === "reviewer")!
  const writerResult = await reviewedSourceStructuredResult(writer.status, writer.result, "writer")
  const reviewerResult = await reviewedSourceStructuredResult(reviewer.status, reviewer.result, "reviewer")
  const writerArtifact = jsonRecord(writerResult.artifactRef)
  const reviewerArtifact = jsonRecord(reviewerResult.artifactRef)
  expect(writerArtifact).toBeTruthy()
  expect(reviewerResult).toMatchObject({ role: "reviewer", status: "completed", reviewStatus: "passed" })
  expect(reviewerArtifact).toEqual(writerArtifact)
  const writerVersion = await testDb.agentArtifactVersion.findFirstOrThrow({ where: {
    userId: ids.user, sessionId: scenario.sessionId, jobId: scenario.jobId,
    artifactId: writerArtifact!.artifactId as string, version: writerArtifact!.version as number, taskId: writer.id,
  }, select: { contentHash: true, sourceDigest: true } })
  expect(writerVersion.contentHash).toBe(writerArtifact!.contentHash)
  expect(writerVersion.sourceDigest).toBe(writerArtifact!.sourceDigest)
  const review = await testDb.agentArtifactReview.findFirstOrThrow({ where: {
    userId: ids.user, sessionId: scenario.sessionId, jobId: scenario.jobId,
    artifactId: writerArtifact!.artifactId as string, version: writerArtifact!.version as number,
    taskId: reviewer.id, status: "passed",
  }, select: { reviewHash: true, taskId: true } })
  expect(review.reviewHash).toBe(reviewerResult.reviewHash)

  const reviewStart = await startReviewedApplicationReview({ ...scenario, sourceTurnId: source.turnId, token,
    key: `stage8-review-${label}-${runId}` })
  expect(reviewStart.response.status).toBe(202)
  const reviewTurnId = reviewStart.body.turnId
  if (typeof reviewTurnId !== "string" || !reviewTurnId.trim()) throw new Error("stage8_review_turn_missing")
  const reviewApprovalId = `reviewed-application-review:${reviewTurnId}`
  const reviewApproval = await waitForReviewedApproval(reviewApprovalId)
  expect(reviewApproval).toMatchObject({ userId: ids.user, sessionId: scenario.sessionId,
    turnId: reviewTurnId, type: "review_application", status: "pending", jobId: scenario.jobId })
  const { GET: getApproval } = await import("@/app/api/agent/sessions/[id]/approvals/[approvalId]/route")
  const nonceResponse = await getApproval(apiRequest(`/api/agent/sessions/${scenario.sessionId}/approvals/${reviewApprovalId}`, token, "GET"), {
    params: Promise.resolve({ id: scenario.sessionId, approvalId: reviewApprovalId }),
  })
  expect(nonceResponse.status).toBe(200)
  const nonceBody = await jsonResponse(nonceResponse)
  const receiptNonce = jsonString(nonceBody, "receiptNonce")
  expect(receiptNonce).toMatch(/^[a-f0-9]{64}$/)
  const revisionRow = await testDb.agentTurn.findUniqueOrThrow({ where: { id: reviewTurnId }, select: { revision: true } })
  expect(Number.isSafeInteger(revisionRow.revision)).toBe(true)
  const clientMessageId = `stage8-review-decision-${label}-${runId}`
  const { POST: decideApprovalWait } = await import("@/app/api/agent/sessions/[id]/approvals/[approvalId]/route")
  const decision = await decideApprovalWait(apiRequest(
    `/api/agent/sessions/${scenario.sessionId}/approvals/${reviewApprovalId}`, token, "POST", {
      clientMessageId, expectedTurnId: reviewTurnId, expectedRevision: revisionRow.revision,
      decision: "approved", receiptNonce,
    }, { "idempotency-key": clientMessageId }), {
    params: Promise.resolve({ id: scenario.sessionId, approvalId: reviewApprovalId }),
  })
  expect(decision.status).toBe(202)
  expect((await waitForAgentTurnTerminal(reviewTurnId)).status).toBe("completed")
  expect(await testDb.agentItem.findUniqueOrThrow({ where: { id: `agent-wait:approval:${reviewApprovalId}` }, select: { status: true } }))
    .toEqual({ status: "completed" })

  const reviewTask = await testDb.applicationTask.findFirstOrThrow({ where: {
    userId: ids.user, sessionId: scenario.sessionId, jobId: scenario.jobId,
  }, select: { id: true } })
  const fill = await waitForReviewedApplicationTask(scenario.jobId,
    task => task.status === "waiting_for_authorization" && task.checkpoint === "form_filled" && Boolean(task.fillTurnId),
    180_000, label === "stop-first")
  const fillTurnId = fill.fillTurnId
  if (typeof fillTurnId !== "string" || !fillTurnId.trim() || fill.id !== reviewTask.id) throw new Error("stage8_fill_identity_missing")
  const browserStarted = await testDb.applicationTaskEvent.findMany({ where: {
    taskId: reviewTask.id, type: "reviewed_application_fill_browser_started", actor: "worker",
  }, select: { id: true } })
  expect(browserStarted).toHaveLength(1)
  const approvalWaitDeadline = Date.now() + 90_000
  let submitApprovals = [] as Awaited<ReturnType<typeof testDb.agentApproval.findMany>>
  let waitItems = [] as Awaited<ReturnType<typeof testDb.agentItem.findMany>>
  while (Date.now() < approvalWaitDeadline) {
    submitApprovals = await testDb.agentApproval.findMany({ where: {
      userId: ids.user, sessionId: scenario.sessionId, turnId: fillTurnId, taskId: reviewTask.id,
      jobId: scenario.jobId, type: "submit_application", status: "pending",
    } })
    if (submitApprovals.length === 1) {
      waitItems = await testDb.agentItem.findMany({ where: {
        id: `agent-wait:approval:${submitApprovals[0]!.id}`, sessionId: scenario.sessionId, turnId: fillTurnId,
        type: "approval_request", status: "started",
      } })
      if (waitItems.length === 1) break
    }
    await delay(100)
  }
  expect(submitApprovals).toHaveLength(1)
  const submitApprovalId = submitApprovals[0]!.id
  expect(waitItems).toHaveLength(1)
  expect(await testDb.agentTurn.findUniqueOrThrow({ where: { id: fillTurnId }, select: { status: true } }))
    .toEqual({ status: "waiting_for_approval" })
  expect(jsonRecord(waitItems[0]!.content)).toMatchObject({ waitKind: "approval", approvalId: submitApprovalId,
    action: "submit_application" })
  expect(await testDb.agentOutbox.count({ where: { aggregateId: scenario.sessionId, topic: "application.submit.dispatch" } })).toBe(0)
  expect((await requestFixtureStats()).reviewedSubmitCount).toBe(0)
  return { ...scenario, token, sourceTurnId: source.turnId, reviewTurnId, fillTurnId,
    applicationTaskId: reviewTask.id, submitApprovalId }
}

async function armStage8ExecutionFailureTarget(prepared: Stage8PreparedScenario) {
  if (!worker?.stdin) throw new Error("Stage8 Worker is unavailable")
  worker.stdin.write(`stage8-failure-target ${prepared.sessionId} ${prepared.fillTurnId}\n`)
  await waitLine(worker, "STAGE8_FAILURE_TARGET_ARMED", 5_000)
}

async function approveStage8Submit(prepared: Stage8PreparedScenario): Promise<Stage8SubmitIntent> {
  const approval = await testDb.agentApproval.findUniqueOrThrow({ where: { id: prepared.submitApprovalId } })
  expect(approval).toMatchObject({ id: prepared.submitApprovalId, userId: ids.user, sessionId: prepared.sessionId,
    taskId: prepared.applicationTaskId, turnId: prepared.fillTurnId, jobId: prepared.jobId,
    type: "submit_application", status: "pending" })
  const { GET: getApproval } = await import("@/app/api/agent/sessions/[id]/approvals/[approvalId]/route")
  const nonceResponse = await getApproval(apiRequest(`/api/agent/sessions/${prepared.sessionId}/approvals/${prepared.submitApprovalId}`,
    prepared.token, "GET"), { params: Promise.resolve({ id: prepared.sessionId, approvalId: prepared.submitApprovalId }) })
  expect(nonceResponse.status).toBe(200)
  const receiptNonce = jsonString(await jsonResponse(nonceResponse), "receiptNonce")
  expect(receiptNonce).toMatch(/^[a-f0-9]{64}$/)
  const { POST: approvalAction } = await import("@/app/api/agent/sessions/[id]/actions/route")
  const response = await approvalAction(apiRequest(`/api/agent/sessions/${prepared.sessionId}/actions`, prepared.token, "POST", {
    type: "approval_response", approvalId: prepared.submitApprovalId, decision: "approved", receiptNonce,
  }), { params: Promise.resolve({ id: prepared.sessionId }) })
  if (response.status !== 200) {
    const body = jsonRecord(await response.clone().json().catch(() => null))
    const [approvalAfter, taskAfter] = await Promise.all([
      testDb.agentApproval.findFirst({ where: { id: prepared.submitApprovalId, userId: ids.user,
        sessionId: prepared.sessionId, taskId: prepared.applicationTaskId, turnId: prepared.fillTurnId,
        jobId: prepared.jobId }, select: { status: true } }).catch(() => null),
      testDb.applicationTask.findFirst({ where: { id: prepared.applicationTaskId, userId: ids.user,
        sessionId: prepared.sessionId, jobId: prepared.jobId, fillTurnId: prepared.fillTurnId },
        select: { checkpoint: true } }).catch(() => null),
    ])
    const routeError = jsonString(body, "error")
    const routeCode = jsonString(body, "code") ?? jsonString(body, "errorCode")
    const errorCategories: Record<string, string> = {
      "Approval is no longer pending": "approval_not_pending",
      "Approval receipt is no longer pending": "approval_not_pending",
      "Approval receipt is not approved": "approval_not_approved",
      "Approval receipt has expired": "approval_expired",
      "Approval receipt nonce does not match": "approval_nonce_mismatch",
      "Approval receipt scope does not match the requested action": "approval_scope_mismatch",
      "Approval receipt scope integrity check failed": "approval_integrity_error",
      "Approval receipt request event is unavailable": "approval_request_event_unavailable",
      "Approval receipt is stale after a goal revision": "approval_revision_mismatch",
      "Approval session is no longer available": "approval_session_unavailable",
      "Approval turn is no longer available": "approval_turn_unavailable",
      "The requested Agent wait was not found": "wait_not_found",
      "The requested Agent wait is no longer pending": "wait_not_pending",
      "The Agent wait is not owned by this session": "wait_scope_mismatch",
      "The Agent wait revision is stale": "wait_revision_mismatch",
      "The Agent wait has expired": "wait_expired",
      "The previous wait command has incomplete state": "wait_state_incomplete",
      "Account is not active.": "account_inactive",
      "This feature is not included in your current plan.": "auto_apply_not_entitled",
      "Monthly AI credits exhausted.": "ai_credits_exhausted",
      "Unattended applications are temporarily unavailable.": "unattended_apply_unavailable",
      "This job has no application URL.": "job_url_missing",
      "The application URL is invalid.": "job_url_invalid",
      "Automatic applications require an HTTPS destination.": "https_destination_required",
      "Automatic application requires a direct supported ATS link, not a job-board or unknown destination.": "ats_destination_unsupported",
      "Application preflight was denied by policy.": "job_preflight_denied",
      "Submission policy denied this application.": "submission_policy_denied",
      "A current, explicit approval is required before this application can be submitted.": "submit_receipt_or_reviewed_material_mismatch",
      "The approval expired before its submit intent was committed.": "approval_expired_before_queue",
      "The job could not be found for application preflight.": "job_preflight_missing",
      "The submit payload does not match the current approved application attempt.": "submit_identity_mismatch",
      "The approved submission receipt changed before its intent was committed.": "submit_receipt_changed",
      "This application is no longer ready for the approved submission step.": "submit_task_or_job_state_conflict",
    }
    const knownCodes = new Set([
      "approval_wait_active", "approval_not_found", "approval_not_approved", "approval_already_consumed",
      "approval_expired", "approval_scope_mismatch", "approval_integrity_error", "approval_nonce_mismatch",
      "approval_revision_mismatch", "approval_reservation_conflict", "wait_not_found", "wait_not_pending",
      "wait_scope_mismatch", "wait_revision_mismatch", "wait_expired",
    ])
    const approvalStatus = ["pending", "approved", "consumed"].includes(approvalAfter?.status ?? "")
      ? approvalAfter!.status : "other"
    const taskCheckpoint = taskAfter?.checkpoint === "form_filled" || taskAfter?.checkpoint === "queue_retry"
      ? taskAfter.checkpoint : "other"
    const routeErrorCategory = routeError && Object.prototype.hasOwnProperty.call(errorCategories, routeError)
      ? errorCategories[routeError] : "unclassified"
    throw new Error(`stage8_submit_action_failure:${JSON.stringify({
      httpStatus: response.status,
      bodyKeys: Object.keys(body ?? {}).filter(key => ["error", "code", "errorCode"].includes(key)).sort(),
      routeErrorCategory,
      routeCode: routeCode && knownCodes.has(routeCode) ? routeCode : null,
      approvalStatus,
      taskCheckpoint,
    })}`)
  }
  expect(response.status).toBe(200)
  const terminal = await waitForAgentTurnTerminal(prepared.fillTurnId)
  if (terminal.status !== "completed") {
    const snapshot = await stage8FillFailureSnapshot(prepared)
    throw new Error(`stage8_fill_turn_terminal_failure:${JSON.stringify(snapshot)}`)
  }
  expect(terminal.status).toBe("completed")

  const resolvedApproval = await testDb.agentApproval.findUniqueOrThrow({ where: { id: prepared.submitApprovalId }, select: { status: true } })
  expect(resolvedApproval.status).toBe("approved")
  const resolvedWait = await testDb.agentItem.findUniqueOrThrow({
    where: { id: `agent-wait:approval:${prepared.submitApprovalId}` }, select: { status: true },
  })
  expect(resolvedWait.status).toBe("completed")
  const fillTurn = await testDb.agentTurn.findUniqueOrThrow({ where: { id: prepared.fillTurnId }, select: {
    id: true, userId: true, sessionId: true, source: true, executionMode: true, input: true, status: true,
    leaseOwnerId: true, leaseStartedAt: true, leaseExpiresAt: true,
  } })
  expect(fillTurn).toMatchObject({ id: prepared.fillTurnId, userId: ids.user, sessionId: prepared.sessionId,
    source: "user", executionMode: null, status: "completed",
    leaseOwnerId: null, leaseStartedAt: null, leaseExpiresAt: null })
  expect(jsonRecord(fillTurn.input)?.reviewedApplicationMaterialSource).toEqual({
    schemaVersion: "agent-harness.v2.selected-job-reviewed-fill-source.v1", sourceTurnId: prepared.sourceTurnId,
  })
  const outboxRows = await testDb.agentOutbox.findMany({ where: {
    aggregateId: prepared.sessionId, topic: "application.submit.dispatch",
  }, select: { payload: true, publishedAt: true } })
  const matching = outboxRows.filter(row => jsonString(row.payload, "applicationTaskId") === prepared.applicationTaskId)
  expect(matching).toHaveLength(1)
  expect(matching[0]!.publishedAt).toBeNull()
  const payload = jsonRecord(matching[0]!.payload)
  expect(Object.keys(payload ?? {}).sort()).toEqual([
    "applicationTaskId", "constraintHash", "fillTurnId", "jobId", "receiptId", "sessionId", "submitPayload", "userId", "workerTaskId",
  ].sort())
  expect(payload).toMatchObject({ applicationTaskId: prepared.applicationTaskId, userId: ids.user,
    jobId: prepared.jobId, sessionId: prepared.sessionId, fillTurnId: prepared.fillTurnId,
    receiptId: prepared.submitApprovalId })
  const intent = payload as unknown as Stage8SubmitIntent
  expect(typeof intent.workerTaskId).toBe("string")
  const queuedTask = await testDb.applicationTask.findUniqueOrThrow({ where: { id: prepared.applicationTaskId }, select: {
    status: true, checkpoint: true, workerTaskId: true,
  } })
  expect(queuedTask).toEqual({ status: "filling", checkpoint: "submission_authorized", workerTaskId: intent.workerTaskId })
  return intent
}

async function waitForStage8ApplyJob(prepared: Stage8PreparedScenario, intent: Stage8SubmitIntent): Promise<void> {
  const until = Date.now() + 30_000
  let published: Date | null = null
  while (Date.now() < until) {
    const rows = await testDb.agentOutbox.findMany({ where: {
      aggregateId: prepared.sessionId, topic: "application.submit.dispatch",
    }, select: { payload: true, publishedAt: true } })
    const matching = rows.filter(row => jsonString(row.payload, "applicationTaskId") === prepared.applicationTaskId)
    expect(matching).toHaveLength(1)
    if (matching[0]!.publishedAt) { published = matching[0]!.publishedAt; break }
    await delay(100)
  }
  expect(published).toBeInstanceOf(Date)
  await waitLine(worker!, `APPLY_JOB_ACTIVE ${intent.workerTaskId}`, 90_000)
}

async function readStage8StopTarget(prepared: Stage8PreparedScenario): Promise<string> {
  const { GET: getSession } = await import("@/app/api/agent/sessions/[id]/route")
  const until = Date.now() + 15_000
  while (Date.now() < until) {
    const response = await getSession(apiRequest(`/api/agent/sessions/${prepared.sessionId}`, prepared.token, "GET"), {
      params: Promise.resolve({ id: prepared.sessionId }),
    })
    expect(response.status).toBe(200)
    const body = await jsonResponse(response)
    const session = jsonRecord(body.session)
    const tasks = Array.isArray(session?.applicationTasks) ? session.applicationTasks : []
    const current = tasks.map(jsonRecord).find(task => task?.id === prepared.applicationTaskId)
    if (current?.status === "filling" && current.checkpoint === "submission_request_started"
      && typeof current.submissionStopTarget === "string" && /^ast1_[a-f0-9]{64}$/.test(current.submissionStopTarget)) {
      return current.submissionStopTarget
    }
    await delay(75)
  }
  throw new Error("stage8_exact_stop_target_not_projected")
}

async function postStage8Stop(prepared: Stage8PreparedScenario, target: string): Promise<Response> {
  const { POST } = await import("@/app/api/agent/application-tasks/submission-stop/route")
  return POST(apiRequest("/api/agent/application-tasks/submission-stop", prepared.token, "POST", {
    sessionId: prepared.sessionId, applicationTaskId: prepared.applicationTaskId, expectedAttemptTarget: target,
  }))
}

async function readStage8Protocol(prepared: Stage8PreparedScenario, intent: Stage8SubmitIntent) {
  const starts = await testDb.applicationTaskEvent.findMany({ where: {
    taskId: prepared.applicationTaskId, type: "submission_execution_started", actor: "worker",
  }, select: { id: true, taskId: true, type: true, actor: true, body: true, data: true } })
  expect(starts).toHaveLength(1)
  const start = starts[0]!
  const startData = jsonRecord(start.data)
  const executionId = typeof startData?.executionId === "string" ? startData.executionId : ""
  expect(start.id).toBe(`evt_${executionId}`)
  expect(start.body).toBe("Submit execution started")
  expect(startData).toMatchObject({ executionId, workerTaskId: intent.workerTaskId,
    applicationTaskId: prepared.applicationTaskId, userId: ids.user, jobId: prepared.jobId,
    sessionId: prepared.sessionId, fillTurnId: prepared.fillTurnId,
    approvalId: prepared.submitApprovalId, constraintHash: intent.constraintHash })
  const key = { sessionId: prepared.sessionId, fillTurnId: prepared.fillTurnId,
    applicationTaskId: prepared.applicationTaskId, userId: ids.user, jobId: prepared.jobId,
    approvalId: prepared.submitApprovalId, receiptId: prepared.submitApprovalId,
    constraintHash: intent.constraintHash, workerTaskId: intent.workerTaskId }
  const rows = await testDb.applicationTaskEvent.findMany({ where: {
    taskId: prepared.applicationTaskId, type: "submission_stop_protocol",
  }, orderBy: { id: "asc" }, select: { id: true, taskId: true, type: true, actor: true, body: true, data: true } })
  const expectedKeys = ["approvalId", "applicationTaskId", "constraintHash", "executionId", "fillTurnId", "jobId",
    "receiptId", "schemaVersion", "sessionId", "stage", "userId", "workerTaskId"].sort()
  for (const row of rows) {
    const data = jsonRecord(row.data)
    const stage = data?.stage
    expect(["armed", "stop_requested", "dispatch_granted"]).toContain(stage)
    expect(Object.keys(data ?? {}).sort()).toEqual(expectedKeys)
    expect(row).toMatchObject({ taskId: prepared.applicationTaskId, type: "submission_stop_protocol",
      actor: stage === "stop_requested" ? "user" : "worker",
      body: "Application submission Stop protocol state recorded." })
    expect(row.id).toBe(applicationSubmissionStopEventId(key, stage as "armed" | "stop_requested" | "dispatch_granted"))
    expect(data).toMatchObject({ schemaVersion: "agent-harness.v2.application-submission-stop.v1", ...key, executionId })
  }
  return rows.map(row => jsonString(row.data, "stage")).sort()
}

async function waitForStage8StopBlockingPid(workerPid: number, timeoutMs = 5_000): Promise<number> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const rows = await testDb.$queryRaw<Array<{ pid: number }>>(Prisma.sql`
      SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock' AND query ILIKE '%agent_sessions%'
        AND ${workerPid} = ANY(pg_blocking_pids(pid))
    `)
    if (rows.length) return rows[0]!.pid
    await delay(25)
  }
  throw new Error("stage8_stop_did_not_wait_on_exact_worker_fence")
}

/** Missing Bull state is accepted only after the exact terminal execution and attempt are durable. */
async function stage8ExecutionSettled(
  prepared: Stage8PreparedScenario,
  intent: Stage8SubmitIntent,
) {
  const queue = applyQueue
  if (!queue) return null
  const [task, approval, attempts, events, job] = await Promise.all([
    testDb.applicationTask.findMany({ where: { id: prepared.applicationTaskId, userId: intent.userId,
      jobId: intent.jobId, sessionId: intent.sessionId, fillTurnId: intent.fillTurnId },
    select: { id: true, userId: true, jobId: true, sessionId: true, fillTurnId: true, workerTaskId: true,
      status: true, checkpoint: true, completedAt: true } }),
    testDb.agentApproval.findMany({ where: { id: intent.receiptId, userId: intent.userId,
      jobId: intent.jobId, sessionId: intent.sessionId, turnId: intent.fillTurnId,
      taskId: intent.applicationTaskId, type: "submit_application" },
    select: { id: true, userId: true, jobId: true, sessionId: true, turnId: true, taskId: true, type: true, status: true } }),
    testDb.submissionAttempt.findMany({ where: { userId: intent.userId, jobId: intent.jobId,
      receiptId: intent.receiptId, constraintHash: intent.constraintHash },
    select: { userId: true, jobId: true, receiptId: true, constraintHash: true, state: true, responseRef: true } }),
    testDb.applicationTaskEvent.findMany({ where: { taskId: prepared.applicationTaskId,
      type: { in: ["submission_execution_started", "submission_execution_settled"] } },
    select: { id: true, taskId: true, type: true, actor: true, data: true } }),
    queue.getJob(intent.workerTaskId),
  ])
  const executionKeys = ["applicationTaskId", "approvalId", "constraintHash", "executionId", "fillTurnId",
    "jobId", "sessionId", "userId", "workerTaskId"].sort().join(",")
  const start = events.find(event => event.type === "submission_execution_started")
  const settled = events.find(event => event.type === "submission_execution_settled")
  const startData = jsonRecord(start?.data)
  const settledData = jsonRecord(settled?.data)
  const executionId = jsonString(startData, "executionId")
  const exactExecutionIdentity = (data: Record<string, unknown> | null) => Boolean(data && executionId
    && Object.keys(data).sort().join(",") === executionKeys
    && data.applicationTaskId === intent.applicationTaskId && data.approvalId === intent.receiptId
    && data.constraintHash === intent.constraintHash && data.executionId === executionId
    && data.fillTurnId === intent.fillTurnId && data.jobId === intent.jobId
    && data.sessionId === intent.sessionId && data.userId === intent.userId
    && data.workerTaskId === intent.workerTaskId)
  const exactExecutionPair = events.length === 2 && start?.actor === "worker" && settled?.actor === "worker"
    && start.taskId === intent.applicationTaskId && settled.taskId === intent.applicationTaskId
    && start.id === `evt_${executionId}` && exactExecutionIdentity(startData) && exactExecutionIdentity(settledData)
  const exactTaskIdentity = task.length === 1 && task[0]?.id === intent.applicationTaskId
    && task[0].userId === intent.userId && task[0].jobId === intent.jobId
    && task[0].sessionId === intent.sessionId && task[0].fillTurnId === intent.fillTurnId
    && task[0].workerTaskId === intent.workerTaskId && task[0].completedAt instanceof Date
  const exactStoppedTask = exactTaskIdentity && task[0]?.status === "failed"
    && task[0]?.checkpoint === "turn_stopped_before_submit"
  const exactConsumedApproval = approval.length === 1 && approval[0]?.id === intent.receiptId
    && approval[0].userId === intent.userId && approval[0].jobId === intent.jobId
    && approval[0].sessionId === intent.sessionId && approval[0].turnId === intent.fillTurnId
    && approval[0].taskId === intent.applicationTaskId && approval[0].type === "submit_application"
    && approval[0].status === "consumed"
  const exactAttemptIdentity = attempts.length === 1 && attempts[0]?.userId === intent.userId
    && attempts[0].jobId === intent.jobId && attempts[0].receiptId === intent.receiptId
    && attempts[0].constraintHash === intent.constraintHash
  const exactStoppedAttempt = exactAttemptIdentity && attempts[0]?.state === "failed" && attempts[0]?.responseRef === null
  const lock = await (await queue.client).get(queue.toKey(`${intent.workerTaskId}:lock`))
  if (!exactExecutionPair || !exactStoppedTask || !exactConsumedApproval || !exactStoppedAttempt || lock !== null) return null
  if (!job) return "removed_after_exact_stop_settlement" as const
  if (job.id !== intent.workerTaskId || !matchesApplyTaskSubmitPayload(job.data, intent)) return "mismatched_job" as const
  const state = await job.getState()
  return state === "completed" || state === "failed" ? state : null
}

async function waitForStage8StoppedExecutionSettlement(
  prepared: Stage8PreparedScenario,
  intent: Stage8SubmitIntent,
  timeoutMs = 30_000,
): Promise<"completed" | "failed" | "removed_after_exact_stop_settlement" | "mismatched_job"> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const outcome = await stage8ExecutionSettled(prepared, intent)
    if (outcome) return outcome
    await delay(100)
  }
  return throwStage8SettlementTimeout(prepared, intent.workerTaskId)
}

async function waitForStage8GrantJobSettled(
  prepared: Stage8PreparedScenario,
  intent: Stage8SubmitIntent,
  timeoutMs = 30_000,
): Promise<"completed" | "failed" | "removed_after_exact_terminal_proof" | "mismatched_job"> {
  const until = Date.now() + timeoutMs
  const expected = {
    taskId: intent.applicationTaskId, userId: intent.userId, jobId: intent.jobId,
    sessionId: intent.sessionId, fillTurnId: intent.fillTurnId, workerTaskId: intent.workerTaskId,
    approvalId: intent.receiptId, constraintHash: intent.constraintHash,
  }
  const queue = applyQueue
  if (!queue) throw new Error("stage8_apply_queue_unavailable")
  while (Date.now() < until) {
    const [job, lock] = await Promise.all([
      queue.getJob(intent.workerTaskId),
      (async () => (await queue.client).get(queue.toKey(`${intent.workerTaskId}:lock`)))(),
    ])
    if (lock === null) {
      if (job) {
        if (job.id !== intent.workerTaskId || !matchesApplyTaskSubmitPayload(job.data, intent)) return "mismatched_job"
        const state = await job.getState()
        if (state === "completed") return state
        if (state === "failed" && job.attemptsMade >= (job.opts?.attempts ?? 1)) return state
      } else {
        try {
          await waitForSubmissionTerminalProof(expected, Math.min(100, until - Date.now()))
          return "removed_after_exact_terminal_proof"
        } catch { /* Continue polling until the shared deadline, then emit bounded diagnostics. */ }
      }
    }
    await delay(100)
  }
  return throwStage8SettlementTimeout(prepared, intent.workerTaskId)
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
    onTestFailed(async () => {
      let snapshot: unknown
      try {
        if (dbConnected) {
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
    await armLegacyQueueAckBarrier(ids.session, successorTurnId)
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
    const legacyFailureScope = {
      jobId: ids.job, sessionId: ids.session, fillTurnId: successorTurnId,
      applicationTaskId: gateTaskId!, submitApprovalId: submitApproval.id,
    } satisfies Stage8FailureSnapshotScope
    let legacyPhase: "release_synthetic_response" | "await_queue_ack" | "await_task_uncertainty"
      | "verify_session_wait" | "verify_live_fill_owner" | "await_fill_terminal" = "release_synthetic_response"
    try {
      if (!site?.stdin) throw new Error("synthetic_response_unavailable")
      // The fixture's plain-text response is deliberately not a submission confirmation.
      site.stdin.write("release-held\n")
      legacyPhase = "await_queue_ack"
      await waitForLegacyAckMarker(worker!, "LEGACY_ACK_BARRIER_REACHED attempt=1")
      legacyPhase = "await_task_uncertainty"
      await waitForTask(task => task.userId === ids.user && task.jobId === ids.job
        && task.sessionId === ids.session && task.fillTurnId === successorTurnId && task.workerTaskId === workerTaskId
        && task.status === "waiting_for_user" && task.checkpoint === "submission_uncertain")
      legacyPhase = "verify_session_wait"
      const uncertainSession = await testDb.agentSession.findUnique({ where: { id: ids.session }, select: {
        userId: true, status: true, completedAt: true,
      } })
      if (uncertainSession?.userId !== ids.user || uncertainSession.status !== "waiting_for_user"
        || uncertainSession.completedAt !== null) throw new Error("session_wait_mismatch")
      legacyPhase = "verify_live_fill_owner"
      if (await expectLegacyFillTurnLeased(successorTurnId) !== successorRootTaskId) throw new Error("fill_owner_changed")
      legacyPhase = "await_fill_terminal"
      await releaseLegacyFinalResponseGate()
      if ((await waitForAgentTurnTerminal(successorTurnId, 30_000)).status !== "completed") {
        throw new Error("fill_turn_not_completed")
      }
    } catch {
      const snapshot = await stage8FillFailureSnapshot(legacyFailureScope, workerTaskId)
      throw new Error(`legacy_fill_lifecycle_miss:${JSON.stringify({ phase: legacyPhase, snapshot })}`)
    }
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
    const legacyReceiverStats = await requestFixtureStats()
    expect(legacyReceiverStats.submitCount).toBe(1)
    const heldAckJob = await applyQueue!.getJob(workerTaskId)
    expect(Boolean(heldAckJob)).toBe(true)
    expect(heldAckJob?.id === workerTaskId).toBe(true)
    expect(await heldAckJob!.getState()).toBe("active")
    expect(heldAckJob!.attemptsStarted).toBe(1)
    const heldAckPayload = jsonRecord(heldAckJob!.data)
    expect(Boolean(heldAckPayload && heldAckPayload.operation === "submit" && heldAckPayload.sessionId === ids.session
      && heldAckPayload.fillTurnId === successorTurnId && heldAckPayload.applicationTaskId === gateTaskId
      && heldAckPayload.receiptId === submitApproval.id)).toBe(true)
    await proveLegacyQueueAckBarrier({ sessionId: ids.session, fillTurnId: successorTurnId,
      jobId: workerTaskId, attemptsStarted: heldAckJob!.attemptsStarted })
    const uncertainBeforeKill = await testDb.applicationTask.findUnique({ where: { id: gateTaskId },
      select: { userId: true, jobId: true, sessionId: true, status: true, checkpoint: true, fillTurnId: true, workerTaskId: true } })
    const uncertaintyChecks = {
      ownedRowPresent: uncertainBeforeKill?.userId === ids.user && uncertainBeforeKill.jobId === ids.job
        && uncertainBeforeKill.sessionId === ids.session,
      statusMatches: uncertainBeforeKill?.status === "waiting_for_user",
      checkpointMatches: uncertainBeforeKill?.checkpoint === "submission_uncertain",
      fillTurnMatches: uncertainBeforeKill?.fillTurnId === successorTurnId,
      workerTaskMatches: uncertainBeforeKill?.workerTaskId === workerTaskId,
    }
    if (!Object.values(uncertaintyChecks).every(Boolean)) {
      let exactStartReceiptCount: number | null = null
      let exactSettledReceiptCount: number | null = null
      let exactExecutionPairCount: number | null = null
      let requestStartedCheckpointStillPresent: boolean | null = null
      try {
        const executionReceipts = await testDb.applicationTaskEvent.findMany({ where: {
          taskId: gateTaskId, actor: "worker",
          type: { in: ["submission_execution_started", "submission_execution_settled"] },
        }, select: { type: true, data: true } })
        let startCount = 0
        let settledCount = 0
        const startExecutionIds = new Set<string>()
        const settledExecutionIds = new Set<string>()
        for (const event of executionReceipts) {
          const data = jsonRecord(event.data)
          const exactIdentity = data !== null && typeof data.executionId === "string" && data.executionId.length > 0
            && data.workerTaskId === workerTaskId && data.applicationTaskId === gateTaskId
            && data.userId === ids.user && data.jobId === ids.job && data.sessionId === ids.session
            && data.fillTurnId === successorTurnId && data.approvalId === submitApproval.id
            && data.constraintHash === intent.constraintHash
          if (!exactIdentity) continue
          if (event.type === "submission_execution_started") {
            startCount++
            startExecutionIds.add(data.executionId as string)
          }
          if (event.type === "submission_execution_settled") {
            settledCount++
            settledExecutionIds.add(data.executionId as string)
          }
        }
        exactStartReceiptCount = startCount
        exactSettledReceiptCount = settledCount
        const pairedExecutionCount = [...startExecutionIds].filter(id => settledExecutionIds.has(id)).length
        exactExecutionPairCount = Math.min(2, pairedExecutionCount)
        const exactTaskIdentity = uncertaintyChecks.ownedRowPresent && uncertaintyChecks.fillTurnMatches
          && uncertaintyChecks.workerTaskMatches
        requestStartedCheckpointStillPresent = exactTaskIdentity && startCount === 1 && settledCount === 1
          && pairedExecutionCount === 1 && uncertainBeforeKill?.checkpoint === "submission_request_started"
      } catch {
        exactStartReceiptCount = null
        exactSettledReceiptCount = null
        exactExecutionPairCount = null
        requestStartedCheckpointStillPresent = null
      }
      const taskOutcomeClass = !uncertainBeforeKill ? "row_missing"
        : uncertainBeforeKill.status === "waiting_for_user" && uncertainBeforeKill.checkpoint === "submission_uncertain" ? "uncertain"
        : uncertainBeforeKill.status === "submitted" && uncertainBeforeKill.checkpoint === "submission_verified" ? "verified_submitted"
        : uncertainBeforeKill.status === "waiting_for_user" && uncertainBeforeKill.checkpoint === "user_takeover" ? "takeover_wait"
        : uncertainBeforeKill.status === "failed" ? "terminal_failed"
        : uncertainBeforeKill.status === "cancelled" && uncertainBeforeKill.checkpoint === "turn_stopped_before_submit" ? "stopped_before_submit"
        : uncertainBeforeKill.status === "filling" && uncertainBeforeKill.checkpoint === "submission_request_started" ? "request_started"
        : uncertainBeforeKill.status === "filling" && uncertainBeforeKill.checkpoint === "browser_active" ? "browser_active"
        : uncertainBeforeKill.status === "waiting_for_authorization" && uncertainBeforeKill.checkpoint === "form_filled" ? "form_filled"
        : "other"
      const boundedCount = (value: number): number => Math.min(20, Math.max(0, Number.isSafeInteger(value) ? value : 0))
      const receiverCounts = {
        submitCount: boundedCount(legacyReceiverStats.submitCount),
        matchingPostCount: boundedCount(legacyReceiverStats.requests.filter(request => request === "POST /example/jobs/1").length),
        blockedCount: boundedCount(legacyReceiverStats.blocked.length),
      }
      throw new Error(`legacy_uncertainty_predicate_mismatch ${JSON.stringify({
        ...uncertaintyChecks, taskOutcomeClass, exactStartReceiptCount, exactSettledReceiptCount,
        exactExecutionPairCount, requestStartedCheckpointStillPresent, receiverCounts,
      })}`)
    }
    worker!.kill("SIGKILL")
    expect(await waitExit(worker!, 5_000)).toBe(true)
    worker = spawnFixture("worker")
    await waitLine(worker, "WORKER_READY", 90_000)
    const redeliveryEvent = await waitForWorkerRedelivery(worker, workerTaskId)
    expect(redeliveryEvent.jobId === workerTaskId).toBe(true)
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

  it("proves authenticated Stop wins before grant and is too late after the final browser continuation", async () => {
    const before = await requestFixtureStats()
    const priorReviewedPostCount = before.requests.filter(path => path === "POST /example-reviewed/jobs/1").length
    const stopFirst = await prepareStage8Scenario("stop-first")
    await stopFixture(worker)
    worker = spawnFixture("worker-staged")
    await waitLine(worker, "WORKER_READY", 90_000)
    try {
      await armStage8ExecutionFailureTarget(stopFirst)
      const firstIntent = await approveStage8Submit(stopFirst)
      worker.stdin?.write("stage8-release-publisher\n")
      await waitForStage8ApplyJob(stopFirst, firstIntent)
      await waitForStage8Arm(stopFirst, firstIntent)
      expect(await readStage8Protocol(stopFirst, firstIntent)).toEqual(["armed"])
      const firstTarget = await readStage8StopTarget(stopFirst)
      const firstStop = await postStage8Stop(stopFirst, firstTarget)
      expect(firstStop.status).toBe(200)
      await expect(jsonResponse(firstStop)).resolves.toEqual({ outcome: "stop_requested" })
      const duplicateFirstStop = await postStage8Stop(stopFirst, firstTarget)
      expect(duplicateFirstStop.status).toBe(200)
      await expect(jsonResponse(duplicateFirstStop)).resolves.toEqual({ outcome: "stop_requested" })
      expect(await readStage8Protocol(stopFirst, firstIntent)).toEqual(["armed", "stop_requested"])

      worker.stdin?.write("stage8-release-arm\n")
      const stoppedSettlement = await waitForStage8StoppedExecutionSettlement(stopFirst, firstIntent)
      expect(["completed", "removed_after_exact_stop_settlement"]).toContain(stoppedSettlement)
      const settledDuplicateStop = await postStage8Stop(stopFirst, firstTarget)
      expect(settledDuplicateStop.status).toBe(200)
      await expect(jsonResponse(settledDuplicateStop)).resolves.toEqual({ outcome: "stop_requested" })
      expect(await readStage8Protocol(stopFirst, firstIntent)).toEqual(["armed", "stop_requested"])
      expect(worker.lines.some(line => line === `STAGE8_FINAL_FENCE_READY ${firstIntent.workerTaskId}`)).toBe(false)
      const afterStopFirst = await requestFixtureStats()
      expect(afterStopFirst.reviewedSubmitCount).toBe(before.reviewedSubmitCount)
      expect(afterStopFirst.reviewedHeldSubmitCount).toBe(before.reviewedHeldSubmitCount)
      expect(afterStopFirst.reviewedExactSubmissionCount).toBe(before.reviewedExactSubmissionCount)
      expect(afterStopFirst.blocked).toEqual([])
      expect(afterStopFirst.requests.filter(path => path === "POST /example-reviewed/jobs/1"))
        .toHaveLength(priorReviewedPostCount)

      await stopFixture(worker)
      worker = spawnFixture("worker")
      await waitLine(worker, "WORKER_READY", 90_000)
      const grantFirst = await prepareStage8Scenario("grant-first")
      await stopFixture(worker)
      worker = spawnFixture("worker-staged")
      await waitLine(worker, "WORKER_READY", 90_000)
      await armStage8ExecutionFailureTarget(grantFirst)
      const secondIntent = await approveStage8Submit(grantFirst)
      worker.stdin?.write("stage8-release-publisher\n")
      await waitForStage8ApplyJob(grantFirst, secondIntent)
      await waitForStage8Arm(grantFirst, secondIntent)
      expect(await readStage8Protocol(grantFirst, secondIntent)).toEqual(["armed"])
      const secondTarget = await readStage8StopTarget(grantFirst)
      worker.stdin?.write("stage8-release-arm\n")
      await waitLine(worker, `STAGE8_FINAL_FENCE_READY ${secondIntent.workerTaskId}`, 30_000)
      const pidLine = worker.lines.filter(line => line.startsWith(`STAGE8_DB_PID ${secondIntent.workerTaskId} `)).at(-1)
      const workerPid = Number(pidLine?.split(" ").at(-1))
      if (!Number.isSafeInteger(workerPid) || workerPid < 1) throw new Error("stage8_final_fence_pid_missing")

      let stopSettled = false
      const blockedStop = postStage8Stop(grantFirst, secondTarget).then(response => {
        stopSettled = true
        return response
      })
      const blockedWebPid = await waitForStage8StopBlockingPid(workerPid)
      expect(blockedWebPid).not.toBe(workerPid)
      expect(stopSettled).toBe(false)
      expect(await readStage8Protocol(grantFirst, secondIntent)).toEqual(["armed", "dispatch_granted"])
      expect((await requestFixtureStats()).reviewedSubmitCount).toBe(before.reviewedSubmitCount)

      worker.stdin?.write("stage8-release-final\n")
      await waitLine(worker, `STAGE8_CONTINUE_ACK ${secondIntent.workerTaskId}`, 15_000)
      await waitLine(worker, `STAGE8_FINAL_FENCE_RELEASED ${secondIntent.workerTaskId}`, 15_000)
      const sendDeadline = Date.now() + 15_000
      let afterGrant = await requestFixtureStats()
      while ((afterGrant.reviewedSubmitCount !== before.reviewedSubmitCount + 1
        || afterGrant.reviewedExactSubmissionCount !== before.reviewedExactSubmissionCount + 1) && Date.now() < sendDeadline) {
        await delay(50)
        afterGrant = await requestFixtureStats()
      }
      expect(afterGrant.reviewedSubmitCount).toBe(before.reviewedSubmitCount + 1)
      expect(afterGrant.reviewedHeldSubmitCount).toBe(before.reviewedHeldSubmitCount + 1)
      expect(afterGrant.reviewedExactSubmissionCount).toBe(before.reviewedExactSubmissionCount + 1)
      expect(afterGrant.blocked).toEqual([])

      const tooLate = await blockedStop
      expect(tooLate.status).toBe(200)
      await expect(jsonResponse(tooLate)).resolves.toEqual({ outcome: "too_late" })
      const duplicateTooLate = await postStage8Stop(grantFirst, secondTarget)
      expect(duplicateTooLate.status).toBe(200)
      await expect(jsonResponse(duplicateTooLate)).resolves.toEqual({ outcome: "too_late" })
      expect(await readStage8Protocol(grantFirst, secondIntent)).toEqual(["armed", "dispatch_granted"])
      expect(afterGrant.requests.filter(path => path === "POST /example-reviewed/jobs/1"))
        .toHaveLength(priorReviewedPostCount + 1)

      site?.stdin?.write("release-held\n")
      const releaseDeadline = Date.now() + 15_000
      let releasedStats = await requestFixtureStats()
      while (releasedStats.reviewedHeldSubmitCount !== 0 && Date.now() < releaseDeadline) {
        await delay(50)
        releasedStats = await requestFixtureStats()
      }
      expect(releasedStats.reviewedHeldSubmitCount).toBe(before.reviewedHeldSubmitCount)
      const grantSettlement = await waitForStage8GrantJobSettled(grantFirst, secondIntent, 30_000)
      expect(["completed", "removed_after_exact_terminal_proof"]).toContain(grantSettlement)
    } finally {
      site?.stdin?.write("release-held\n")
    }
  }, 900_000)
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
