import { randomUUID } from "node:crypto"
import { rm, writeFile } from "node:fs/promises"
import { spawn, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import { Queue } from "bullmq"
import { Pool } from "pg"
import { Redis } from "ioredis"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { HarnessModelRequest, ModelAdapter } from "@jobcopilot/agent-model"
import {
  PLAN_LEDGER_SCHEMA_VERSION,
  parsePlanLedger,
  projectPlanLedger,
  projectTaskEvidencePreview,
  schemaVersion,
} from "@jobcopilot/agent-protocol"

import type { ProductionAgentFlags } from "../production-agent-flags.js"
import type { ProductionWorkerBootstrap, createProductionWorkerBootstrap } from "../../queue/production-bootstrap.js"
import { childContextSnapshot, createChildContextBuilder } from "./child-context.js"
import { executionOwnerFence } from "../execution-owner.js"
import { PgCoordinationStore } from "../mailbox/store.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { TASK_GRAPH_RESULT_PROJECTION_SCHEMA } from "./task-graph-command-port.js"
import { createPgTaskGraphCommandPort } from "./pg-task-graph-command-port.js"
import { PgSubagentTaskStore } from "./pg-store.js"
import { drainTaskGraphStopOutbox, TASK_GRAPH_STOP_OUTBOX_TOPIC } from "./task-graph-stop-outbox.js"
import { taskGraphLifecycleKey } from "./task-graph-snapshot.js"

const DATABASE_NAME = "applymate_agent_brain_ci"
const PLAN_CALL_ID = "p3-resume-plan"
const WAIT_CALL_ID = "p3-resume-wait"
const FOLLOW_UP_PLAN_CALL_ID = "p3-resume-follow-up-plan"
const FOLLOW_UP_WAIT_CALL_ID = "p3-resume-follow-up-wait"
const RESTART_FOLLOW_UP_GOAL = "Verify the restored TaskGraph summary after restart"
const RESTART_FOLLOW_UP_KEY = "verification"
const RESULT_PREFIX = "p3-task-graph-child-result"
const FOLLOW_UP_GOAL = "Verify the completed summary with a follow-up check"
const OVERSIZED_SOURCE_GOAL = "Complete with an oversized structured summary"
const REJECTED_DEPENDENT_GOAL = "Must be cancelled when dependency evidence is oversized"
const FINAL_MARKER = "p3-task-graph-resumed-with-current-graph"
const FAILURE_PLAN_CALL_ID = "p3-failure-plan"
const FAILURE_WAIT_CALL_ID = "p3-failure-wait"
const FAILURE_GOAL = "Read a source and report a terminal failure"
const BLOCKED_GOAL = "Summarize only after the source succeeds"
const FAILURE_FINAL_MARKER = "p3-failed-prerequisite-cancelled-descendant"
const SOURCE_DEPENDENCY_PROJECTION_ITEM = {
  dependencyKey: "source", role: "scout", taskStatus: "completed",
  result: {
    schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "available",
    role: "scout", status: "completed", candidateCount: 1, evidenceCount: 1,
    candidates: [{ jobId: "fixture-job-1", source: "other", evidenceKinds: ["job"] }],
  },
} as const
const SUMMARY_DEPENDENCY_PROJECTION_ITEM = {
  dependencyKey: "summary", role: "analyst", taskStatus: "completed",
  result: {
    schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "available",
    role: "analyst", status: "completed", findingCount: 1, evidenceCount: 1,
    findings: [{ jobId: "fixture-job-1", score: 8, evidenceKinds: ["job"] }],
  },
} as const
const planLedgerTraceArtifactPath = process.env.AGENT_PLAN_LEDGER_TRACE_ARTIFACT_PATH

function dedicatedDatabaseUrl(): string | null {
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!value) return null
  const url = new URL(value)
  if (
    process.env.CI !== "true"
    || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true"
    || url.protocol !== "postgresql:"
    || url.hostname !== "127.0.0.1"
    || url.port !== "5432"
    || url.username !== "postgres"
    || url.password !== "postgres"
    || url.pathname !== `/${DATABASE_NAME}`
    || url.search !== ""
    || url.hash !== ""
  ) throw new Error("TaskGraph resume integration requires the dedicated disposable CI PostgreSQL service URL")
  return value
}

function dedicatedRedisUrl(): string | null {
  const value = process.env.AGENT_TURN_REDIS_TEST_URL
  if (!value) return null
  const url = new URL(value)
  if (
    process.env.CI !== "true"
    || process.env.AGENT_TURN_REDIS_TEST_DISPOSABLE !== "true"
    || url.protocol !== "redis:"
    || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)
    || url.port !== "6379"
    || url.pathname !== "/15"
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
  ) throw new Error("TaskGraph resume integration accepts only the dedicated disposable CI Redis DB 15 URL")
  return value
}

const databaseUrl = dedicatedDatabaseUrl()
const redisUrl = dedicatedRedisUrl()
const describeWithServices = databaseUrl && redisUrl ? describe : describe.skip

type Fixture = { userId: string; sessionId: string; turnId: string; ownerId: string; suffix: string }
type RecordValue = Record<string, unknown>
type TaskGraphItemRow = {
  id: string; sessionId: string; turnId: string; stepId: string | null; taskId: string | null
  type: string; status: string; phase: string | null; revision: number; content: RecordValue
  startedAt: Date | null; completedAt: Date | null; createdAt: Date; updatedAt: Date
}
type TurnQueueFactory = NonNullable<Parameters<typeof createProductionWorkerBootstrap>[0]["turnQueueFactory"]>

function record(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null
}

function diagnosticValueType(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

function boundedDiagnostic(value: string, maxCharacters = 4_000): string {
  if (value.length <= maxCharacters) return value
  return `${value.slice(0, maxCharacters)}...[truncated ${value.length - maxCharacters} characters]`
}

function captureModelStreamFailure(model: ModelAdapter, onFailure: (error: unknown) => void): ModelAdapter {
  return {
    ...model,
    stream(request: HarnessModelRequest) {
      return (async function* () {
        try {
          for await (const event of model.stream(request)) yield event
        } catch (error: unknown) {
          onFailure(error)
          throw error
        }
      })()
    },
  }
}

function boundedErrorText(error: unknown, maxCharacters = 1_000): string {
  const value = error instanceof Error ? error.stack ?? `${error.name}: ${error.message}` : String(error)
  return boundedDiagnostic(value, maxCharacters)
}

type FailureDiagnosticField = { label: string; value: string }

type RootModelFailureStage =
  | "not_started"
  | "initial_plan_tool"
  | "initial_wait_plan_receipt"
  | "initial_wait_plan_uniqueness"
  | "initial_wait_graph_count"
  | "initial_wait_graph_uniqueness"
  | "initial_wait_plan_graph_set_mismatch"
  | "initial_wait_tool"
  | "unexpected_root_model_round"
  | "resumed_graph_kind"
  | "resumed_graph_keys"
  | "resumed_graph_statuses"
  | "resumed_graph_readiness"
  | "large_source_projection"
  | "wait_outcome_status"
  | "wait_task_statuses"
  | "source_wait_summary"
  | "summary_wait_summary"
  | "resumed_graph_revision"
  | "follow_up_plan_tool"
  | "follow_up_graph_keys"
  | "follow_up_graph_statuses"
  | "follow_up_graph_readiness"
  | "follow_up_plan_receipt"
  | "follow_up_wait_tool"
  | "completed_graph_kind"
  | "completed_graph_keys"
  | "completed_graph_statuses"
  | "completed_graph_readiness"
  | "completed_wait_outcome"
  | "completed_wait_status"
  | "completed_wait_summary"

type ChildFixtureFailureStage =
  | "parent_wait"
  | "source_dependency_schema"
  | "source_dependency_items"
  | "source_child_context_build"
  | "source_profile_trust"
  | "source_profile_schema"
  | "source_profile_items"
  | "source_profile_redaction"
  | "source_system_boundary"
  | "follow_up_dependency_schema"
  | "follow_up_dependency_items"
  | "follow_up_dependency_redaction"
  | "structured_result"
  | "oversized_result"
  | "unexpected_role"

const TURN_DIAGNOSTIC_STATUSES = new Set([
  "queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user",
  "completed", "failed", "interrupted", "cancelled",
])
const ITEM_DIAGNOSTIC_STATUSES = new Set(["started", "completed", "failed", "cancelled"])
const WAIT_DIAGNOSTIC_STATUSES = new Set(["waiting", "ready", "timed_out", "consumed", "failed", "cancelled", "interrupted"])
const WAIT_HANDOFF_ERROR_CODES = new Set(["40P01", "40001", "55P03", "57014", "23505", "23503", "wait_handoff_unavailable"])
const WAIT_HANDOFF_ERROR_NAMES = new Set(["Error", "error", "WaitHandoffUnavailable"])
const TASK_GRAPH_DIAGNOSTIC_NODE_KEYS = new Set([
  "source", "summary", "large-source", "rejected", "verification", "prerequisite", "dependent",
])
const TASK_DIAGNOSTIC_STATUSES = new Set([
  "queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed",
])
const PROCESS_FIXTURE_TURN_STATUSES = new Set([...TURN_DIAGNOSTIC_STATUSES, "none", "other"])
const PROCESS_FIXTURE_TASK_STATUSES = new Set([...TASK_DIAGNOSTIC_STATUSES, "none", "other"])
const PROCESS_FIXTURE_STEP_STATUSES = new Set([
  "completed", "failed", "interrupted", "waiting_for_tool", "waiting_for_approval", "waiting_for_user", "none", "other",
])
const PROCESS_FIXTURE_TOOL_STATUSES = new Set([...ITEM_DIAGNOSTIC_STATUSES, "interrupted", "none", "other"])
const PROCESS_FIXTURE_WAIT_OUTPUT_STATUSES = new Set(["waiting", "ready", "timed_out", "none", "other"])
const PROCESS_FIXTURE_FAILURE_CATEGORIES = new Set([
  "none", "other", "tool_result_missing", "database_deadlock", "database_serialization", "database_lock_wait",
  "coordination_invalid_input", "coordination_task_not_found", "coordination_scope_error",
  "coordination_wait_unavailable", "wait_handoff_state", "turn_lease_state", "generic_tool_execution_failed",
])
const PROCESS_FIXTURE_CAUSES = new Set([
  "turn_missing", "model_never_ran", "plan_not_called", "plan_failed_or_incomplete", "graph_shape_mismatch",
  "wait_call_missing", "wait_result_missing_or_unknown", "wait_target_ids_unreadable", "requested_ids_not_in_graph",
  "requested_graph_tasks_missing_child_rows", "wait_tool_failed_before_wait_persistence",
  "wait_row_missing_or_parent_mismatch", "turn_failed", "wait_row_not_suspended", "suspension_predicate_not_met",
])

function diagnosticText(value: unknown, maxCharacters = 64): string | null {
  return typeof value === "string" ? boundedDiagnostic(value, maxCharacters) : null
}

function diagnosticEnum(value: unknown, allowed: ReadonlySet<string>): string | null {
  return typeof value === "string" && allowed.has(value) ? value : null
}

function diagnosticEnumList(value: unknown, allowed: ReadonlySet<string>, maxItems = 8): string[] {
  if (!Array.isArray(value)) return []
  const projected: string[] = []
  for (const item of value.slice(0, maxItems * 2)) {
    const safeValue = diagnosticEnum(item, allowed)
    if (safeValue && !projected.includes(safeValue)) projected.push(safeValue)
    if (projected.length >= maxItems) break
  }
  return projected
}

function diagnosticCount(value: unknown): number | null {
  if (Array.isArray(value)) return value.length
  if (typeof value !== "string") return null
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.length : null
  } catch {
    return null
  }
}

function diagnosticBoundedCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 10_000 ? value : null
}

function diagnosticStatusCounts(value: unknown): RecordValue {
  const counts = record(value)
  if (!counts) return {}
  const projected: RecordValue = {}
  for (const [status, count] of Object.entries(counts).slice(0, 10)) {
    const safeStatus = diagnosticEnum(status, TASK_DIAGNOSTIC_STATUSES)
    const safeCount = diagnosticBoundedCount(count)
    if (safeStatus && safeCount !== null) projected[safeStatus] = safeCount
  }
  return projected
}

type DiagnosticIdList = { values: string[]; count: number | null; valid: boolean }

function diagnosticIdList(value: unknown, maxItems = 50): DiagnosticIdList {
  if (!Array.isArray(value)) return { values: [], count: null, valid: false }
  const valid = value.length <= maxItems && value.every(item => typeof item === "string" && item.trim().length > 0 && item.length <= 256)
    && new Set(value).size === value.length
  return { values: valid ? value as string[] : [], count: value.length, valid }
}

function diagnosticIdListsMatch(left: DiagnosticIdList, right: DiagnosticIdList): boolean | null {
  if (!left.valid || !right.valid) return null
  if (left.values.length !== right.values.length) return false
  const rightValues = new Set(right.values)
  return left.values.every(value => rightValues.has(value))
}

function compactTurnProgressDiagnostics(progress: string, maxCharacters = 1_600): string {
  let parsed: RecordValue | null = null
  try { parsed = record(JSON.parse(progress) as unknown) } catch { return JSON.stringify({ available: false }) }
  if (!parsed) return JSON.stringify({ available: false })

  const turn = record(parsed.turn)
  const tool = record(parsed.waitToolResult)
  const waitLineage = record(parsed.waitLineage)
  const targetRows = record(waitLineage?.targetRows)
  const targetMismatchCounts = record(targetRows?.mismatchCounts)
  const parentMismatchCounts = record(waitLineage?.parentMismatchCounts)
  const toolFailure = record(parsed.diagnosticToolFailure)
  const fixtureNodeKeysMissingRows = waitLineage?.fixtureNodeKeysMissingRows
  const tasks = Array.isArray(parsed.tasks) ? parsed.tasks.map(record).filter((item): item is RecordValue => item !== null) : []
  const waits = Array.isArray(parsed.waits) ? parsed.waits.map(record).filter((item): item is RecordValue => item !== null) : []
  const snapshot = {
    turn: turn ? {
      status: diagnosticEnum(turn.status, TURN_DIAGNOSTIC_STATUSES),
      errorPresent: turn.error !== null && turn.error !== undefined,
      revision: typeof turn.revision === "number" ? turn.revision : null,
      leaseVersion: typeof turn.leaseVersion === "number" ? turn.leaseVersion : null,
      leaseOwnerPresent: turn.leaseOwnerId !== null,
    } : null,
    waitToolResult: tool ? {
      status: diagnosticEnum(tool.status, ITEM_DIAGNOSTIC_STATUSES),
      errorCodePresent: typeof tool.errorCode === "string",
      outputStatus: diagnosticEnum(tool.outputStatus, WAIT_DIAGNOSTIC_STATUSES),
      waitIdPresent: typeof tool.waitId === "string",
      matchedTaskCount: typeof record(tool.matchedTaskIds)?.count === "number" ? record(tool.matchedTaskIds)?.count : null,
      truncatedTaskResultCount: typeof record(tool.truncated)?.truncatedTaskResultCount === "number"
        ? record(tool.truncated)?.truncatedTaskResultCount
        : null,
    } : null,
    waitLineage: waitLineage ? {
      available: waitLineage.available !== false,
      taskIdsMatchCurrentGraph: typeof waitLineage.taskIdsMatchCurrentGraph === "boolean"
        ? waitLineage.taskIdsMatchCurrentGraph
        : null,
      proposalReceiptFound: waitLineage.proposalReceiptFound === true,
      proposalNodeCount: diagnosticBoundedCount(waitLineage.proposalNodeCount),
      requestMatchesReceipt: typeof waitLineage.requestMatchesReceipt === "boolean"
        ? waitLineage.requestMatchesReceipt
        : null,
      requestMatchesCurrentGraph: typeof waitLineage.requestMatchesCurrentGraph === "boolean"
        ? waitLineage.requestMatchesCurrentGraph
        : null,
      requestedIdsOutsideReceiptCount: diagnosticBoundedCount(waitLineage.requestedIdsOutsideReceiptCount),
      requestedTaskCount: typeof waitLineage.requestedTaskCount === "number" ? waitLineage.requestedTaskCount : null,
      graphNodeCount: typeof waitLineage.graphNodeCount === "number" ? waitLineage.graphNodeCount : null,
      fixtureNodeKeysMissingRows: diagnosticEnumList(fixtureNodeKeysMissingRows, TASK_GRAPH_DIAGNOSTIC_NODE_KEYS),
      graphNodeKeysMissingRows: diagnosticEnumList(waitLineage.graphNodeKeysMissingRows, TASK_GRAPH_DIAGNOSTIC_NODE_KEYS),
      waitItemFound: waitLineage.waitItemFound === true,
      waitItemMatchesRoot: waitLineage.waitItemMatchesRoot === true,
      parentTaskFound: waitLineage.parentTaskFound === true,
      parentIdIsTurnRoot: waitLineage.parentIdIsTurnRoot === true,
      parentSameSession: waitLineage.parentSameSession === true,
      parentSameTurn: waitLineage.parentSameTurn === true,
      parentRootIsTurnRoot: waitLineage.parentRootIsTurnRoot === true,
      parentHasNoParent: waitLineage.parentHasNoParent === true,
      parentMismatchCounts: parentMismatchCounts ? {
        id: typeof parentMismatchCounts.id === "number" ? parentMismatchCounts.id : null,
        session: typeof parentMismatchCounts.session === "number" ? parentMismatchCounts.session : null,
        turn: typeof parentMismatchCounts.turn === "number" ? parentMismatchCounts.turn : null,
        root: typeof parentMismatchCounts.root === "number" ? parentMismatchCounts.root : null,
        parent: typeof parentMismatchCounts.parent === "number" ? parentMismatchCounts.parent : null,
        user: typeof parentMismatchCounts.user === "number" ? parentMismatchCounts.user : null,
      } : null,
      parentTaskMatchesUser: waitLineage.parentTaskMatchesUser === true,
      parentUserMismatchCount: typeof waitLineage.parentUserMismatchCount === "number" ? waitLineage.parentUserMismatchCount : null,
      targetRows: targetRows ? {
        requestedCount: typeof targetRows.requestedCount === "number" ? targetRows.requestedCount : null,
        foundCount: typeof targetRows.foundCount === "number" ? targetRows.foundCount : null,
        allInExpectedScope: targetRows.allInExpectedScope === true,
        allSameUser: targetRows.allSameUser === true,
        allSameSession: targetRows.allSameSession === true,
        allSameTurn: targetRows.allSameTurn === true,
        allSameRoot: targetRows.allSameRoot === true,
        allSameParent: targetRows.allSameParent === true,
        mismatchCounts: targetMismatchCounts ? {
          missing: typeof targetMismatchCounts.missing === "number" ? targetMismatchCounts.missing : null,
          user: typeof targetMismatchCounts.user === "number" ? targetMismatchCounts.user : null,
          session: typeof targetMismatchCounts.session === "number" ? targetMismatchCounts.session : null,
          turn: typeof targetMismatchCounts.turn === "number" ? targetMismatchCounts.turn : null,
          root: typeof targetMismatchCounts.root === "number" ? targetMismatchCounts.root : null,
          parent: typeof targetMismatchCounts.parent === "number" ? targetMismatchCounts.parent : null,
        } : null,
      } : null,
    } : null,
    toolFailure: toolFailure ? {
      toolNameIsAgentWait: toolFailure.toolName === "agent.wait",
      status: diagnosticEnum(toolFailure.status, ITEM_DIAGNOSTIC_STATUSES),
      errorCodePresent: typeof toolFailure.errorCode === "string",
      failureDetailPresent: typeof toolFailure.failureDetail === "string",
    } : null,
    tasks: tasks.slice(0, 6).map(task => ({
      goalPresent: typeof task.goal === "string",
      status: diagnosticEnum(task.status, TASK_DIAGNOSTIC_STATUSES),
      attempts: typeof task.attemptCount === "number" ? task.attemptCount : null,
      failureReasonPresent: typeof task.failureReason === "string",
    })),
    waits: waits.slice(0, 6).map(wait => ({
      keyPresent: typeof wait.idempotencyKey === "string",
      status: diagnosticEnum(wait.status, WAIT_DIAGNOSTIC_STATUSES),
      targetCount: diagnosticCount(wait.targetTaskIds),
      matchedCount: diagnosticCount(wait.matchedTaskIds),
      suspended: wait.suspendedAt !== null,
      resolved: wait.resolvedAt !== null,
      consumed: wait.consumedAt !== null,
    })),
  }
  return boundedDiagnostic(JSON.stringify(snapshot), maxCharacters)
}

function combineFailureDiagnostics(fields: readonly FailureDiagnosticField[], progress: string): string {
  const direct = boundedDiagnostic(fields.map(({ label, value }) =>
    `${label}=${value.length > 0 && value !== "<not captured>" && value !== "<none>"}`).join("; "), 2_700)
  const snapshotLabel = "; turnTaskWaitSnapshot="
  const snapshotBudget = Math.max(0, Math.min(1_050, 3_900 - direct.length - snapshotLabel.length - 64))
  const snapshot = compactTurnProgressDiagnostics(progress, snapshotBudget)
  return boundedDiagnostic(`${direct}${snapshotLabel}${snapshot}`, 3_900)
}

function waitTurnFailureSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const progressMarker = message.indexOf("; progress=")
  return boundedDiagnostic(progressMarker >= 0 ? message.slice(0, progressMarker) : message, 320)
}

function boundedErrorDetails(error: unknown): RecordValue {
  const fields = record(error)
  const errorName = error instanceof Error ? error.name : fields?.name
  const errorMessage = error instanceof Error
    ? error.message
    : typeof fields?.message === "string" ? fields.message : String(error)
  const errorCode = fields?.code
  return {
    name: boundedDiagnostic(typeof errorName === "string" ? errorName : "UnknownError", 120),
    code: typeof errorCode === "string" || typeof errorCode === "number"
      ? boundedDiagnostic(String(errorCode), 160)
      : null,
    message: boundedDiagnostic(errorMessage, 500),
  }
}

async function waitHandoffTurnState(pool: Pool, turnId: string, waitId: string): Promise<RecordValue> {
  try {
    const result = await pool.query<{
      turnStatus: string
      leaseOwnerId: string | null
      leaseVersion: number
      waitId: string | null
      waitStatus: string | null
      suspendedAt: Date | null
      resolvedAt: Date | null
      consumedAt: Date | null
    }>(`SELECT turn."status" AS "turnStatus", turn."leaseOwnerId", turn."leaseVersion",
         wait."id" AS "waitId", wait."status" AS "waitStatus", wait."suspendedAt", wait."resolvedAt", wait."consumedAt"
       FROM "agent_turns" AS turn LEFT JOIN "agent_wait_conditions" AS wait
         ON wait."turnId" = turn."id" AND wait."id" = $2
       WHERE turn."id" = $1`, [turnId, waitId])
    const row = result.rows[0]
    return {
      turn: row ? {
        status: row.turnStatus,
        leaseOwnerPresent: row.leaseOwnerId !== null,
        leaseVersion: row.leaseVersion,
      } : null,
      wait: row?.waitId ? {
        id: row.waitId,
        status: row.waitStatus,
        suspendedAt: row.suspendedAt?.toISOString() ?? null,
        resolvedAt: row.resolvedAt?.toISOString() ?? null,
        consumedAt: row.consumedAt?.toISOString() ?? null,
      } : null,
    }
  } catch (error: unknown) {
    return { diagnosticError: boundedErrorDetails(error) }
  }
}

function withWaitHandoffDiagnostics(
  pool: Pool,
  createQueue: TurnQueueFactory,
  onFailure: (diagnostic: string) => void,
): TurnQueueFactory {
  return options => createQueue({
    ...options,
    waitHandoff: async input => {
      if (!options.waitHandoff) {
        const before = await waitHandoffTurnState(pool, input.lease.turnId, input.waitId)
        const unavailable = new Error("Production waitHandoff callback was not provided.")
        unavailable.name = "WaitHandoffUnavailable"
        const unavailableWithCode = Object.assign(unavailable, { code: "wait_handoff_unavailable" })
        onFailure(boundedDiagnostic(JSON.stringify({
          waitId: input.waitId,
          error: boundedErrorDetails(unavailableWithCode),
          before,
          after: before,
        }), 1_800))
        throw unavailableWithCode
      }
      const before = await waitHandoffTurnState(pool, input.lease.turnId, input.waitId)
      try {
        await options.waitHandoff(input)
      } catch (error: unknown) {
        const after = await waitHandoffTurnState(pool, input.lease.turnId, input.waitId)
        onFailure(boundedDiagnostic(JSON.stringify({
          waitId: input.waitId,
          error: boundedErrorDetails(error),
          before,
          after,
        }), 1_800))
        throw error
      }
    },
  })
}

function waitHandoffFailureProjection(diagnostic: string | null): RecordValue {
  if (!diagnostic) return { captured: false }
  try {
    const value = record(JSON.parse(diagnostic))
    const error = record(value?.error)
    const state = (candidate: unknown): RecordValue | null => {
      const current = record(candidate)
      if (!current) return null
      const turn = record(current.turn)
      const wait = record(current.wait)
      return {
        turnStatus: diagnosticEnum(turn?.status, TURN_DIAGNOSTIC_STATUSES),
        turnLeaseOwnerPresent: turn?.leaseOwnerPresent === true,
        turnLeaseVersion: typeof turn?.leaseVersion === "number" && Number.isSafeInteger(turn.leaseVersion)
          ? turn.leaseVersion
          : null,
        waitStatus: diagnosticEnum(wait?.status, WAIT_DIAGNOSTIC_STATUSES),
        hasSuspendedAt: typeof wait?.suspendedAt === "string",
        hasResolvedAt: typeof wait?.resolvedAt === "string",
        hasConsumedAt: typeof wait?.consumedAt === "string",
      }
    }
    return {
      captured: true,
      errorName: diagnosticEnum(error?.name, WAIT_HANDOFF_ERROR_NAMES) ?? "other",
      errorCode: diagnosticEnum(error?.code, WAIT_HANDOFF_ERROR_CODES) ?? "other",
      before: state(value?.before),
      after: state(value?.after),
    }
  } catch {
    return { captured: true, available: false }
  }
}

function fixture(): Fixture {
  const suffix = randomUUID()
  return {
    suffix,
    userId: `p3-task-graph-resume-user-${suffix}`,
    sessionId: `p3-task-graph-resume-session-${suffix}`,
    turnId: `p3-task-graph-resume-turn-${suffix}`,
    ownerId: `p3-task-graph-resume-owner-${suffix}`,
  }
}

async function seed(pool: Pool, value: Fixture, turnStatus: "queued" | "waiting_for_user" = "queued"): Promise<void> {
  await pool.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`, [
    value.userId, `${value.userId}@example.invalid`,
  ])
  await pool.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
    VALUES ($1, $2, 'Resume after a TaskGraph dependency completes', 'running', 'test', CURRENT_TIMESTAMP)`, [
    value.sessionId, value.userId,
  ])
  await pool.query(`INSERT INTO "agent_turns"
    ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "updatedAt")
    VALUES ($1, $2, $3, $4, 'user', $5::jsonb, $6::jsonb, '{}'::jsonb, $7::jsonb, CURRENT_TIMESTAMP)`, [
    value.turnId,
    value.sessionId,
    value.userId,
    turnStatus,
    JSON.stringify({ goal: "Research and summarize the fixture source" }),
    JSON.stringify({ provider: "fixture", model: "fixture-model" }),
    JSON.stringify({ limits: { maxSteps: 8, maxToolCalls: 8 } }),
  ])
}

async function activateFixtureTurn(pool: Pool, value: Fixture): Promise<void> {
  const activated = await pool.query(`UPDATE "agent_turns" SET "status" = 'queued', "completedAt" = NULL,
      "leaseOwnerId" = NULL, "leaseExpiresAt" = NULL, "leaseStartedAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "status" = 'waiting_for_user'`, [
    value.turnId, value.sessionId, value.userId,
  ])
  if (activated.rowCount !== 1) throw new Error("TaskGraph fixture turn was not parked before activation")
}

function toolResult(request: HarnessModelRequest, callId: string): unknown {
  for (const message of request.messages) {
    for (const part of message.content) {
      if (part.type !== "tool_result" || part.toolUseId !== callId || typeof part.content !== "string") continue
      try { return JSON.parse(part.content) as unknown } catch { return null }
    }
  }
  return null
}

function planTaskIds(request: HarnessModelRequest, callId = PLAN_CALL_ID, expectedCount = 2): string[] {
  const output = record(toolResult(request, callId))
  if (!output || output.status !== "accepted" || !Array.isArray(output.nodes)) throw new Error("TaskGraph plan receipt missing from the next root model request")
  const ids = output.nodes.flatMap(value => {
    const node = record(value)
    return node && typeof node.taskId === "string" ? [node.taskId] : []
  })
  if (ids.length !== expectedCount) throw new Error(`Expected ${expectedCount} planned task ID(s); received ${ids.length}`)
  return ids
}

function waitOutcomeFromRequest(request: HarnessModelRequest, taskCount: number): RecordValue & { tasks: unknown[] } {
  const outcomes = request.messages.flatMap(message => message.content.flatMap(part => {
    if (part.type !== "tool_result" || !part.toolUseId.startsWith("wait:") || typeof part.content !== "string") return []
    try {
      const outcome = record(JSON.parse(part.content) as unknown)
      return outcome && Array.isArray(outcome.tasks) && outcome.tasks.length === taskCount ? [outcome] : []
    } catch { return [] }
  }))
  const outcome = outcomes[0]
  if (!outcome) throw new Error(`Expected a hydrated wait result with ${taskCount} child task(s)`)
  if (Buffer.byteLength(JSON.stringify(outcome), "utf8") > 8 * 1024) throw new Error("Hydrated child wait result exceeded its byte limit")
  return outcome as RecordValue & { tasks: unknown[] }
}

function currentGraphFromRequest(request: HarnessModelRequest): RecordValue | null {
  for (let messageIndex = request.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const content = request.messages[messageIndex]!.content
    for (let partIndex = content.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = content[partIndex]!
      if (part.type !== "text" || !part.text.includes('"kind":"task_graph_current"')) continue
      const json = part.text.slice(part.text.indexOf("\n") + 1)
      try { return record(JSON.parse(json) as unknown) } catch { return null }
    }
  }
  return null
}

type ProcessFixtureChild = ChildProcess & { output: string[]; errors: string[] }
const processRestartFixturePath = fileURLToPath(new URL("./task-graph-resume-process-restart.fixture.mjs", import.meta.url))
const processRestartWorkerCwd = fileURLToPath(new URL("../../../", import.meta.url))

function startTaskGraphRestartWorker(mode: "park-parent" | "resume-parent", value: Record<string, unknown>): ProcessFixtureChild {
  const child = spawn(process.execPath, ["--import", "tsx", processRestartFixturePath, mode, JSON.stringify(value)], {
    cwd: processRestartWorkerCwd,
    env: { ...process.env, REDIS_URL: redisUrl!, AGENT_RUNTIME_PG_TEST_URL: databaseUrl! },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ProcessFixtureChild
  child.output = []
  child.errors = []
  let stdout = ""
  let stderr = ""
  child.stdout?.setEncoding("utf8")
  child.stderr?.setEncoding("utf8")
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk
    const lines = stdout.split("\n")
    stdout = lines.pop() ?? ""
    child.output.push(...lines.map(line => line.trim()).filter(Boolean))
  })
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk
    const lines = stderr.split("\n")
    stderr = lines.pop() ?? ""
    child.errors.push(...lines.map(line => line.trim()).filter(Boolean))
  })
  return child
}

function processFixtureDiagnosticProjection(value: unknown): RecordValue | null {
  const source = record(value)
  if (!source) return null

  const projected: RecordValue = {}
  const projectEnum = (key: string, allowed: ReadonlySet<string>) => {
    const safeValue = diagnosticEnum(source[key], allowed)
    if (safeValue !== null) projected[key] = safeValue
  }
  const projectCount = (key: string) => {
    const safeValue = diagnosticBoundedCount(source[key])
    if (safeValue !== null) projected[key] = safeValue
  }
  const projectCountRecord = (key: string, fields: readonly string[]) => {
    const input = record(source[key])
    if (!input) return
    const counts: RecordValue = {}
    for (const field of fields) {
      const safeValue = diagnosticBoundedCount(input[field])
      if (safeValue !== null) counts[field] = safeValue
    }
    if (Object.keys(counts).length > 0) projected[key] = counts
  }
  const projectNodeKeys = (key: string, fields: readonly string[]) => {
    const input = record(source[key])
    if (!input) return
    const nodeKeys: RecordValue = {}
    for (const field of fields) {
      const safeValues = diagnosticEnumList(input[field], TASK_GRAPH_DIAGNOSTIC_NODE_KEYS)
      if (safeValues.length > 0) nodeKeys[field] = safeValues
    }
    if (Object.keys(nodeKeys).length > 0) projected[key] = nodeKeys
  }

  projectEnum("turnStatus", PROCESS_FIXTURE_TURN_STATUSES)
  projectEnum("rootTaskStatus", PROCESS_FIXTURE_TASK_STATUSES)
  projectEnum("latestModelStepStatus", PROCESS_FIXTURE_STEP_STATUSES)
  projectEnum("latestModelStepErrorClass", PROCESS_FIXTURE_FAILURE_CATEGORIES)
  projectEnum("turnErrorCategory", PROCESS_FIXTURE_FAILURE_CATEGORIES)
  projectEnum("waitToolCallStatus", PROCESS_FIXTURE_TOOL_STATUSES)
  projectEnum("waitToolCallLifecycleStatus", PROCESS_FIXTURE_TOOL_STATUSES)
  if (typeof source.planAccepted === "boolean") projected.planAccepted = source.planAccepted
  projectEnum("waitToolResultLifecycleStatus", PROCESS_FIXTURE_TOOL_STATUSES)
  projectEnum("waitToolOutputStatus", PROCESS_FIXTURE_WAIT_OUTPUT_STATUSES)
  projectEnum("waitFailureCategory", PROCESS_FIXTURE_FAILURE_CATEGORIES)
  projectEnum("likelyCause", PROCESS_FIXTURE_CAUSES)

  projectCount("graphNodeCount")
  projectCountRecord("waits", ["count", "rootCount", "suspendedRootCount"])
  projectCountRecord("targetCounts", ["requested", "graphMatches", "taskRows", "graphRows"])
  projectNodeKeys("missingKeys", ["requestedGraph", "graphTasks"])

  const childStatusCounts = diagnosticStatusCounts(source.childStatusCounts)
  if (Object.keys(childStatusCounts).length > 0) projected.childStatusCounts = childStatusCounts
  return projected
}

function processFixtureDiagnostics(child: ProcessFixtureChild): string {
  const prefix = "P3_PARENT_SUSPENSION_DIAGNOSTICS "
  const processState = "pid=" + (Number.isSafeInteger(child.pid) ? child.pid : "unavailable")
    + " exitCode=" + (child.exitCode === null ? "null"
      : typeof child.exitCode === "number" && Number.isInteger(child.exitCode) ? child.exitCode : "unavailable")
    + " signal=" + (child.signalCode === null ? "none" : "received")
    + " stdoutLineCount=" + child.output.length + " stderrLineCount=" + child.errors.length
  let safeLine: string | null = null
  for (const line of child.output) {
    if (!line.startsWith(prefix)) continue
    try {
      const projected = processFixtureDiagnosticProjection(JSON.parse(line.slice(prefix.length)) as unknown)
      if (projected) {
        safeLine = prefix + JSON.stringify(projected)
        break
      }
    } catch {
      // Ignore malformed fixture diagnostics and keep looking for a valid line.
    }
  }
  const diagnostic = processState + (safeLine ? " " + safeLine : " fixtureDiagnostics=unavailable")
  return boundedDiagnostic(diagnostic, 1_600)
}

async function waitForProcessLine(child: ProcessFixtureChild, prefix: string, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const line = child.output.find(value => value.startsWith(prefix))
    if (line) return line
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Worker exited before " + prefix + "; " + processFixtureDiagnostics(child))
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error("Timed out waiting for " + prefix + "; " + processFixtureDiagnostics(child))
}

function waitForProcessExit(child: ProcessFixtureChild, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      child.off("exit", onExit)
      child.off("error", onError)
    }
    const onExit = () => { cleanup(); resolve() }
    const onError = (error: Error) => { cleanup(); reject(error) }
    child.once("exit", onExit)
    child.once("error", onError)
    if (child.exitCode !== null || child.signalCode !== null) {
      cleanup()
      resolve()
      return
    }
    timer = setTimeout(() => {
      cleanup()
      reject(new Error("Worker process did not exit; " + processFixtureDiagnostics(child)))
    }, timeoutMs)
  })
}

function processFixtureExited(child: ProcessFixtureChild): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

async function killProcessFixture(child: ProcessFixtureChild, signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
  if (processFixtureExited(child)) return
  const exited = waitForProcessExit(child)
  if (!child.kill(signal)) throw new Error("Worker process kill was rejected; " + processFixtureDiagnostics(child))
  await exited
}

async function stopProcessFixture(child: ProcessFixtureChild): Promise<void> {
  if (processFixtureExited(child)) {
    if (child.exitCode !== 0 || child.signalCode !== null) {
      throw new Error("Worker exited unsuccessfully during cleanup; " + processFixtureDiagnostics(child))
    }
    return
  }
  const exited = waitForProcessExit(child, 5_000)
  child.stdin?.write("shutdown\n")
  try {
    await exited
  } catch (gracefulError) {
    try {
      await killProcessFixture(child)
    } catch (forcedError) {
      throw new Error("Worker cleanup failed; graceful=" + String(gracefulError) + "; forced=" + String(forcedError))
    }
    throw new Error("Worker required forced termination during cleanup; graceful=" + String(gracefulError)
      + "; " + processFixtureDiagnostics(child))
  }
  if (child.exitCode !== 0 || child.signalCode !== null) {
    throw new Error("Worker exited unsuccessfully during cleanup; " + processFixtureDiagnostics(child))
  }
}

function structuredChildResult(role: "scout" | "analyst", summary: string): RecordValue {
  const jobId = "fixture-job-1"
  const evidence = [{ id: "fixture-job-evidence", kind: "job", ref: jobId, source: "fixture" }]
  const structuredResult = role === "scout"
    ? { schemaVersion: ROLE_RESULT_SCHEMA, role, status: "completed", candidates: [{ jobId, source: "fixture", url: null, evidenceIds: ["fixture-job-evidence"] }], evidence, summary }
    : { schemaVersion: ROLE_RESULT_SCHEMA, role, status: "completed", findings: [{ jobId, score: 8, evidenceIds: ["fixture-job-evidence"] }], evidence, summary }
  return { status: "completed", stepCount: 2, toolCallCount: 1, finalItemId: "fixture-final-item", finalText: summary, structuredResult }
}

async function waitForSuspendedParent(pool: Pool, turnId: string, minimumWaitCount = 1, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await pool.query<{ turnStatus: string; waitStatus: string | null; suspendedAt: Date | null; waitCount: string }>(
      `SELECT turn."status" AS "turnStatus", wait."status" AS "waitStatus", wait."suspendedAt",
         (SELECT COUNT(*)::text FROM "agent_wait_conditions" AS all_waits
          WHERE all_waits."turnId" = turn."id" AND all_waits."parentTaskId" = turn."rootTaskId") AS "waitCount"
       FROM "agent_turns" AS turn LEFT JOIN "agent_wait_conditions" AS wait
         ON wait."turnId" = turn."id" AND wait."parentTaskId" = turn."rootTaskId"
       WHERE turn."id" = $1 ORDER BY wait."createdAt" DESC LIMIT 1`,
      [turnId],
    )
    const row = result.rows[0]
    if (row?.turnStatus === "waiting_for_dependency" && row.waitStatus === "waiting" && row.suspendedAt
      && Number(row.waitCount) >= minimumWaitCount) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error("TaskGraph parent wait was not durably suspended before child completion")
}

async function initialWaitLineageDiagnostics(
  pool: Pool,
  turn: { id: string; sessionId: string; userId: string; rootTaskId: string | null },
  toolCallId: string | undefined,
): Promise<RecordValue | null> {
  if (!toolCallId) return null
  try {
    const [toolItemResult, graphResult] = await Promise.all([
      pool.query<{ sessionId: string; turnId: string; taskId: string | null; content: unknown }>(`SELECT "sessionId", "turnId", "taskId", "content"
        FROM "agent_items" WHERE "type" = 'tool_call' AND "content"->>'toolCallId' = $1
          AND "content"->>'toolName' = 'agent.wait'
          AND ("sessionId" = $2 OR "turnId" = $3 OR "taskId" = $4)
        ORDER BY "createdAt" DESC LIMIT 1`, [toolCallId, turn.sessionId, turn.id, turn.rootTaskId]),
      turn.rootTaskId
        ? pool.query<{ id: string; content: unknown }>(`SELECT "id", "content" FROM "agent_items"
            WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "type" = 'task_graph'
            ORDER BY "revision" DESC, "updatedAt" DESC LIMIT 1`, [turn.sessionId, turn.id, turn.rootTaskId])
        : Promise.resolve(null),
    ])
    const toolItem = toolItemResult.rows[0]
    const toolContent = record(toolItem?.content)
    const waitInput = record(toolContent?.input)
    const requestedIds = diagnosticIdList(waitInput?.taskIds)
    const graphContent = record(graphResult?.rows[0]?.content)
    const graphNodes = Array.isArray(graphContent?.nodes) ? graphContent.nodes : null
    const graphIds = diagnosticIdList(graphNodes?.map(node => record(node)?.taskId))
    const taskIdsMatchCurrentGraph = diagnosticIdListsMatch(requestedIds, graphIds)
    const proposalResult = graphResult?.rows[0]?.id
      ? await pool.query<{ payload: unknown }>(`SELECT "payload" FROM "agent_events"
          WHERE "sessionId" = $1 AND "turnId" = $2 AND "itemId" = $3
            AND "type" IN ('item.started', 'item.delta') AND "payload"->>'kind' = 'proposal'
          ORDER BY "sequence" DESC LIMIT 1`, [turn.sessionId, turn.id, graphResult.rows[0].id])
      : null
    const proposalPayload = record(proposalResult?.rows[0]?.payload)
    const proposalReceipt = record(proposalPayload?.receipt)
    const rawProposalNodes = Array.isArray(proposalReceipt?.nodes) ? proposalReceipt.nodes : []
    const proposalNodes = rawProposalNodes.map(record).filter((node): node is RecordValue => node !== null)
    const proposalTaskIds = diagnosticIdList(proposalNodes.map(node => node.taskId))
    const proposalReceiptFound = proposalPayload?.kind === "proposal" && Array.isArray(proposalReceipt?.nodes)
    const requestMatchesReceipt = proposalReceiptFound
      ? diagnosticIdListsMatch(requestedIds, proposalTaskIds)
      : null
    const proposalTaskIdSet = new Set(proposalTaskIds.values)
    const requestedIdsOutsideReceiptCount = proposalReceiptFound && requestedIds.valid && proposalTaskIds.valid
      ? requestedIds.values.filter(id => !proposalTaskIdSet.has(id)).length
      : null

    const expectedParentId = toolItem?.taskId ?? turn.rootTaskId
    const parentResult = typeof expectedParentId === "string"
      ? await pool.query<{
        id: string; sessionId: string; turnId: string | null; rootTaskId: string | null; parentTaskId: string | null
        userId: string | null
      }>(`SELECT task."id", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId", session."userId" AS "userId"
          FROM "sub_agent_tasks" AS task LEFT JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
          WHERE task."id" = $1 LIMIT 1`, [expectedParentId])
      : null
    const parent = parentResult?.rows[0]
    const parentIdMismatchCount = parent ? Number(typeof turn.rootTaskId !== "string" || parent.id !== turn.rootTaskId) : null
    const parentSessionMismatchCount = parent ? Number(parent.sessionId !== turn.sessionId) : null
    const parentTurnMismatchCount = parent ? Number(parent.turnId !== turn.id) : null
    const parentRootMismatchCount = parent
      ? Number(typeof turn.rootTaskId !== "string" || parent.rootTaskId !== turn.rootTaskId)
      : null
    const parentLineageMismatchCount = parent ? Number(parent.parentTaskId !== null) : null
    const parentUserMismatchCount = parent ? Number(parent.userId !== turn.userId) : null
    const idsToCheck = [...new Set([
      ...(requestedIds.valid ? requestedIds.values : []),
      ...(graphIds.valid ? graphIds.values : []),
    ])]
    const targetResult = idsToCheck.length > 0
      ? await pool.query<{
        id: string; sessionId: string; turnId: string | null; rootTaskId: string | null; parentTaskId: string | null
        userId: string | null
      }>(`SELECT task."id", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId", session."userId" AS "userId"
          FROM "sub_agent_tasks" AS task LEFT JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
          WHERE task."id" = ANY($1::text[])`, [idsToCheck])
      : null
    const targets = targetResult?.rows ?? []
    const requestedIdSet = new Set(requestedIds.values)
    const foundTargetIdSet = new Set(targets.map(target => target.id))
    const fixtureNodeKeysMissingRows = requestedIds.valid
      ? [...new Set(proposalNodes.flatMap(node =>
        typeof node.key === "string" && TASK_GRAPH_DIAGNOSTIC_NODE_KEYS.has(node.key)
          && typeof node.taskId === "string" && requestedIdSet.has(node.taskId) && !foundTargetIdSet.has(node.taskId)
          ? [node.key]
          : []
      ))].slice(0, 8)
      : []
    const graphNodeKeysMissingRows = graphIds.valid && Array.isArray(graphNodes)
      ? [...new Set(graphNodes.flatMap(value => {
        const node = record(value)
        return node && typeof node.key === "string" && TASK_GRAPH_DIAGNOSTIC_NODE_KEYS.has(node.key)
          && typeof node.taskId === "string" && !foundTargetIdSet.has(node.taskId)
          ? [node.key]
          : []
      }))].slice(0, 8)
      : []
    const requestedTargets = targets.filter(target => requestedIdSet.has(target.id))
    const requestedFoundCount = requestedIds.valid
      ? requestedIds.values.filter(id => foundTargetIdSet.has(id)).length
      : null
    const userMismatchCount = targetResult
      ? requestedTargets.filter(target => target.userId !== turn.userId).length
      : null
    const parentMismatchCount = targetResult
      ? requestedTargets.filter(target => typeof expectedParentId !== "string" || target.parentTaskId !== expectedParentId).length
      : null
    const sessionMismatchCount = targetResult
      ? requestedTargets.filter(target => target.sessionId !== turn.sessionId).length
      : null
    const turnMismatchCount = targetResult
      ? requestedTargets.filter(target => target.turnId !== turn.id).length
      : null
    const rootMismatchCount = targetResult
      ? requestedTargets.filter(target => typeof turn.rootTaskId !== "string" || target.rootTaskId !== turn.rootTaskId).length
      : null
    const missingCount = requestedFoundCount === null ? null : Math.max(0, requestedIds.values.length - requestedFoundCount)
    const allTargetsFound = requestedFoundCount !== null && requestedFoundCount === requestedIds.values.length
    const allTargetsInExpectedScope = requestedIds.values.length > 0 && allTargetsFound
      && userMismatchCount === 0 && sessionMismatchCount === 0 && turnMismatchCount === 0
      && rootMismatchCount === 0 && parentMismatchCount === 0

    return {
      available: true,
      taskIdsMatchCurrentGraph,
      proposalReceiptFound,
      proposalNodeCount: rawProposalNodes.length,
      requestMatchesReceipt,
      requestMatchesCurrentGraph: taskIdsMatchCurrentGraph,
      requestedIdsOutsideReceiptCount,
      requestedTaskCount: requestedIds.count,
      graphNodeCount: graphIds.count,
      fixtureNodeKeysMissingRows,
      graphNodeKeysMissingRows,
      waitItemFound: Boolean(toolItem),
      waitItemMatchesRoot: Boolean(toolItem && turn.rootTaskId
        && toolItem.sessionId === turn.sessionId && toolItem.turnId === turn.id && toolItem.taskId === turn.rootTaskId),
      parentTaskFound: Boolean(parent),
      parentIdIsTurnRoot: Boolean(parent && turn.rootTaskId && parent.id === turn.rootTaskId),
      parentSameSession: Boolean(parent && parent.sessionId === turn.sessionId),
      parentSameTurn: Boolean(parent && parent.turnId === turn.id),
      parentRootIsTurnRoot: Boolean(parent && turn.rootTaskId && parent.rootTaskId === turn.rootTaskId),
      parentHasNoParent: Boolean(parent && parent.parentTaskId === null),
      parentMismatchCounts: {
        id: parentIdMismatchCount,
        session: parentSessionMismatchCount,
        turn: parentTurnMismatchCount,
        root: parentRootMismatchCount,
        parent: parentLineageMismatchCount,
        user: parentUserMismatchCount,
      },
      parentTaskMatchesUser: Boolean(parent && parent.userId === turn.userId),
      parentUserMismatchCount,
      targetRows: {
        requestedCount: requestedIds.count,
        foundCount: requestedFoundCount,
        allInExpectedScope: allTargetsInExpectedScope,
        allSameUser: Boolean(allTargetsFound && userMismatchCount === 0),
        allSameSession: Boolean(allTargetsFound && sessionMismatchCount === 0),
        allSameTurn: Boolean(allTargetsFound && turnMismatchCount === 0),
        allSameRoot: Boolean(allTargetsFound && rootMismatchCount === 0),
        allSameParent: Boolean(allTargetsFound && parentMismatchCount === 0),
        mismatchCounts: {
          missing: missingCount,
          user: userMismatchCount,
          session: sessionMismatchCount,
          turn: turnMismatchCount,
          root: rootMismatchCount,
          parent: parentMismatchCount,
        },
      },
    }
  } catch {
    return { available: false }
  }
}

async function turnProgressDiagnostics(pool: Pool, turnId: string, diagnosticToolCallId?: string): Promise<string> {
  const turnResult = await pool.query<{
    id: string
    sessionId: string
    userId: string
    status: string
    error: string | null
    rootTaskId: string | null
    revision: number
    leaseOwnerId: string | null
    leaseVersion: number
    leaseExpiresAt: Date | null
  }>(`SELECT "id", "sessionId", "userId", "status", "error", "rootTaskId", "revision", "leaseOwnerId", "leaseVersion", "leaseExpiresAt"
    FROM "agent_turns" WHERE "id" = $1`, [turnId])
  const turn = turnResult.rows[0]
  if (!turn) return JSON.stringify({ turnId, missing: true })

  const [toolResultItem, tasks, waits, events, dispatches, lifecycleFailure] = await Promise.all([
    diagnosticToolCallId
      ? pool.query<{ status: string; content: unknown }>(`SELECT "status", "content" FROM "agent_items"
        WHERE "turnId" = $1 AND "type" = 'tool_result' AND "content"->>'toolCallId' = $2
        ORDER BY "createdAt" DESC LIMIT 1`, [turnId, diagnosticToolCallId])
      : Promise.resolve(null),
    pool.query<{
      id: string; goal: string; status: string; failureReason: string | null; attemptCount: number
      leaseOwner: string | null; leaseExpiresAt: Date | null
    }>(`SELECT "id", "goal", "status", "failureReason", "attemptCount", "leaseOwner", "leaseExpiresAt"
      FROM "sub_agent_tasks" WHERE "turnId" = $1 ORDER BY "createdAt"`, [turnId]),
    pool.query<{
      id: string; idempotencyKey: string; status: string; targetTaskIds: unknown; matchedTaskIds: unknown
      deadlineAt: Date; suspendedAt: Date | null; resolvedAt: Date | null; consumedAt: Date | null
    }>(`SELECT "id", "idempotencyKey", "status", "targetTaskIds", "matchedTaskIds", "deadlineAt", "suspendedAt", "resolvedAt", "consumedAt"
      FROM "agent_wait_conditions" WHERE "turnId" = $1 ORDER BY "createdAt"`, [turnId]),
    pool.query<{
      sequence: string; type: string; actor: string; taskId: string | null; idempotencyKey: string | null; payload: unknown
    }>(`SELECT "sequence"::text, "type", "actor", "taskId", "idempotencyKey", "payload"
      FROM "agent_events" WHERE "turnId" = $1 ORDER BY "sequence" DESC LIMIT 20`, [turnId]),
    pool.query<{
      topic: string; idempotencyKey: string; publishedAt: Date | null; attemptCount: number; lastError: string | null
    }>(`SELECT "topic", "idempotencyKey", "publishedAt", "attemptCount", "lastError"
      FROM "agent_outbox" WHERE "aggregateId" = $1 ORDER BY "createdAt" DESC LIMIT 30`, [turn.sessionId]),
    diagnosticToolCallId
      ? pool.query<{ type: string; idempotencyKey: string | null; payload: unknown }>(`SELECT "type", "idempotencyKey", "payload" FROM "agent_events"
        WHERE "turnId" = $1 AND POSITION($2 IN "idempotencyKey") > 0
        ORDER BY "sequence" DESC LIMIT 1`, [turnId, `:tool-lifecycle:${diagnosticToolCallId}:failed:`])
      : Promise.resolve(null),
  ])
  const resultItem = toolResultItem?.rows[0]
  const resultContent = record(resultItem?.content)
  const resultOutput = record(resultContent?.output)
  const resultReference = resultOutput?.$ref ?? resultOutput?.ref
  const resultTruncated = resultOutput?.$truncated ?? resultOutput?.truncated
  const resultTasks = Array.isArray(resultOutput?.tasks) ? resultOutput.tasks : null
  const waitToolResult = resultItem
    ? {
      status: resultItem.status.slice(0, 32),
      errorCode: typeof resultContent?.errorCode === "string" ? resultContent.errorCode.slice(0, 128) : null,
      outputStatus: typeof resultOutput?.status === "string" ? resultOutput.status.slice(0, 32) : null,
      waitId: typeof resultOutput?.waitId === "string" ? resultOutput.waitId.slice(0, 128) : null,
      deadlineAt: {
        present: Object.prototype.hasOwnProperty.call(resultOutput ?? {}, "deadlineAt"),
        type: diagnosticValueType(resultOutput?.deadlineAt),
      },
      matchedTaskIds: {
        type: diagnosticValueType(resultOutput?.matchedTaskIds),
        count: Array.isArray(resultOutput?.matchedTaskIds) ? resultOutput.matchedTaskIds.length : null,
      },
      reference: {
        present: resultReference !== undefined,
        type: diagnosticValueType(resultReference),
        sizeBytesType: diagnosticValueType(resultOutput?.sizeBytes),
        sha256Present: typeof resultOutput?.sha256 === "string",
      },
      truncated: {
        present: resultTruncated !== undefined,
        type: diagnosticValueType(resultTruncated),
        value: typeof resultTruncated === "boolean" ? resultTruncated : null,
        taskResultCount: resultTasks?.length ?? null,
        truncatedTaskResultCount: resultTasks?.filter(task => {
          const result = record(record(task)?.result)
          return result?.truncated === true || result?.$truncated === true
        }).length ?? null,
      },
    }
    : null
  const lifecycleEvent = lifecycleFailure?.rows[0]
  const lifecyclePayload = record(lifecycleEvent?.payload)
  const lifecycleOutput = record(lifecyclePayload?.output)
  const diagnosticToolFailure = lifecycleEvent
    ? {
      eventType: typeof lifecycleEvent.type === "string" ? lifecycleEvent.type.slice(0, 64) : null,
      idempotencyKey: typeof lifecycleEvent.idempotencyKey === "string" ? lifecycleEvent.idempotencyKey.slice(0, 256) : null,
      toolCallId: typeof lifecyclePayload?.toolCallId === "string" ? lifecyclePayload.toolCallId.slice(0, 128) : null,
      toolName: typeof lifecyclePayload?.toolName === "string" ? lifecyclePayload.toolName.slice(0, 128) : null,
      status: typeof lifecyclePayload?.status === "string" ? lifecyclePayload.status.slice(0, 32) : null,
      errorCode: typeof lifecyclePayload?.errorCode === "string" ? lifecyclePayload.errorCode.slice(0, 128) : null,
      failureDetail: typeof lifecycleOutput?.message === "string" && lifecycleOutput.message.length > 0
        ? lifecycleOutput.message.slice(0, 500)
        : null,
    }
    : null
  const waitLineage = await initialWaitLineageDiagnostics(pool, turn, diagnosticToolCallId)
  const recentEvents = events.rows.map(({ payload: _payload, ...event }) => event)
  return JSON.stringify({ turn, waitToolResult, waitLineage, tasks: tasks.rows, waits: waits.rows, recentEvents, diagnosticToolFailure, recentOutbox: dispatches.rows })
}

async function waitForTurnStatus(pool: Pool, turnId: string, wanted: string, timeoutMs = 50_000, diagnosticToolCallId?: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await pool.query<{ status: string; error: string | null }>(
      `SELECT "status", "error" FROM "agent_turns" WHERE "id" = $1`, [turnId],
    )
    const status = result.rows[0]?.status
    if (status === wanted) return
    if (status && ["failed", "interrupted", "cancelled"].includes(status)) {
      const progress = await turnProgressDiagnostics(pool, turnId, diagnosticToolCallId)
      const turnError = boundedDiagnostic(result.rows[0]?.error ?? "<none>", 300)
      throw new Error(`TaskGraph root turn entered ${status}; error=${turnError}; progress=${compactTurnProgressDiagnostics(progress, 900)}`)
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  const progress = await turnProgressDiagnostics(pool, turnId, diagnosticToolCallId)
  throw new Error(`TaskGraph root turn did not reach ${wanted}; progress=${compactTurnProgressDiagnostics(progress, 900)}`)
}

async function waitForPersistedTaskWait(pool: Pool, turnId: string, idempotencyKey: string, timeoutMs = 20_000): Promise<{ id: string }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await pool.query<{ id: string; status: string; suspendedAt: Date | null }>(
      `SELECT "id", "status", "suspendedAt" FROM "agent_wait_conditions" WHERE "turnId" = $1 AND "idempotencyKey" = $2`,
      [turnId, idempotencyKey],
    )
    const row = result.rows[0]
    if (row?.status === "waiting" && row.suspendedAt instanceof Date) return { id: row.id }
    if (row?.status === "ready") throw new Error("Follow-up child completed before its durable parent wait suspended")
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error("Follow-up parent wait was not durably suspended")
}

async function restartFollowUpWaitDiagnostics(
  pool: Pool,
  turnId: string,
  waitKey: string,
  toolCallId: string,
): Promise<RecordValue> {
  try {
    const [wait, turn, graph, toolCall, toolResult] = await Promise.all([
      pool.query<{ status: string; suspendedAt: Date | null; consumedAt: Date | null }>(
        `SELECT "status", "suspendedAt", "consumedAt" FROM "agent_wait_conditions"
         WHERE "turnId" = $1 AND "idempotencyKey" = $2 LIMIT 1`, [turnId, waitKey],
      ),
      pool.query<{ status: string; leaseOwnerId: string | null }>(
        `SELECT "status", "leaseOwnerId" FROM "agent_turns" WHERE "id" = $1 LIMIT 1`, [turnId],
      ),
      pool.query<{ revision: number; content: unknown }>(
        `SELECT "revision", "content" FROM "agent_items" WHERE "turnId" = $1 AND "type" = 'task_graph'
         ORDER BY "revision" DESC, "updatedAt" DESC LIMIT 1`, [turnId],
      ),
      pool.query<{ status: string }>(
        `SELECT "status" FROM "agent_items" WHERE "turnId" = $1 AND "type" = 'tool_call'
         AND "content"->>'toolCallId' = $2 AND "content"->>'toolName' = 'agent.wait'
         ORDER BY "createdAt" DESC LIMIT 1`, [turnId, toolCallId],
      ),
      pool.query<{ status: string }>(
        `SELECT "status" FROM "agent_items" WHERE "turnId" = $1 AND "type" = 'tool_result'
         AND "content"->>'toolCallId' = $2 ORDER BY "createdAt" DESC LIMIT 1`, [turnId, toolCallId],
      ),
    ])
    const waitRow = wait.rows[0]
    const turnRow = turn.rows[0]
    const graphRow = graph.rows[0]
    const graphContent = record(graphRow?.content)
    const graphNodes = Array.isArray(graphContent?.nodes) ? graphContent.nodes : null
    const waitStatus = waitRow
      ? waitRow.status === "waiting" ? "waiting" : waitRow.status === "ready" ? "ready" : "other"
      : "missing"
    return {
      waitStatus,
      hasSuspendedAt: waitRow?.suspendedAt instanceof Date,
      hasConsumedAt: waitRow?.consumedAt instanceof Date,
      turnStatus: diagnosticEnum(turnRow?.status, TURN_DIAGNOSTIC_STATUSES),
      turnLeaseOwnerPresent: typeof turnRow?.leaseOwnerId === "string",
      graphRevision: typeof graphRow?.revision === "number" && Number.isSafeInteger(graphRow.revision)
        ? graphRow.revision
        : null,
      graphNodeCount: graphNodes?.length ?? null,
      followUpWaitCallPresent: toolCall.rows.length > 0,
      followUpWaitCallStatus: diagnosticEnum(toolCall.rows[0]?.status, ITEM_DIAGNOSTIC_STATUSES),
      followUpWaitResultPresent: toolResult.rows.length > 0,
      followUpWaitResultStatus: diagnosticEnum(toolResult.rows[0]?.status, ITEM_DIAGNOSTIC_STATUSES),
    }
  } catch {
    return { available: false }
  }
}

describe("compact TaskGraph wait failure diagnostics", () => {
  it("selects the latest TaskGraph observation from a multi-step model request", () => {
    const request = {
      messages: [
        { role: "user", content: [{ type: "text", text: '[context]\n{"kind":"task_graph_current","revision":0,"nodes":[]}' }] },
        { role: "assistant", content: [{ type: "text", text: '[context]\n{"kind":"task_graph_current","revision":1,"nodes":[{"key":"source","taskId":"child-1"}]}' }] },
      ],
    } as unknown as HarnessModelRequest

    expect(currentGraphFromRequest(request)).toMatchObject({
      kind: "task_graph_current", revision: 1,
      nodes: [{ key: "source", taskId: "child-1" }],
    })
  })

  it("keeps the safe process diagnostics line without raw stdout or stderr", () => {
    const prefix = "P3_PARENT_SUSPENSION_DIAGNOSTICS "
    const safeLine = prefix + JSON.stringify({
      graphNodeCount: 2, missingKeys: { graphTasks: ["summary"] },
      likelyCause: "wait_row_missing_or_parent_mismatch",
    })
    const child = {
      pid: 42, exitCode: null, signalCode: null,
      output: ["marker-arbitrary-stdout", safeLine], errors: ["marker-raw-stderr"],
    } as unknown as ProcessFixtureChild

    const output = processFixtureDiagnostics(child)

    expect(output).toContain("pid=42 exitCode=null signal=none stdoutLineCount=2 stderrLineCount=1")
    expect(output.slice(output.indexOf(prefix) + prefix.length)).toBe(JSON.stringify({
      likelyCause: "wait_row_missing_or_parent_mismatch", graphNodeCount: 2,
      missingKeys: { graphTasks: ["summary"] },
    }))
    expect(output).not.toContain("marker-arbitrary-stdout")
    expect(output).not.toContain("marker-raw-stderr")
    expect(output.length).toBeLessThanOrEqual(1_600)
  })

  it("keeps safe statuses and counts while dropping markers from allowed-shaped and unknown fields", () => {
    const markers = ["marker-task-id", "marker-raw-error", "marker-nested-error", "marker-extra-id"]
    const safeLine = "P3_PARENT_SUSPENSION_DIAGNOSTICS " + JSON.stringify({
      turnStatus: "failed", rootTaskStatus: "running", latestModelStepStatus: "failed",
      latestModelStepErrorClass: markers[1], turnErrorCategory: "database_deadlock",
      waitToolCallStatus: "completed", waitToolCallLifecycleStatus: "started",
      planAccepted: true,
      waitToolResultLifecycleStatus: "completed",
      waitToolOutputStatus: "ready", waitFailureCategory: "database_serialization",
      waits: { count: 3, rootCount: 1, suspendedRootCount: 1, markerExtra: markers[2] },
      graphNodeCount: 2,
      targetCounts: { requested: 2, graphMatches: 2, taskRows: 2, graphRows: 2, markerExtra: markers[3] },
      missingKeys: { requestedGraph: ["source", markers[0]], graphTasks: ["summary"] },
      childStatusCounts: { failed: 1, completed: 2, [markers[0]]: 9 },
      likelyCause: "wait_row_missing_or_parent_mismatch",
      unknownNested: { id: markers[3], error: markers[2], deep: { raw: markers[1] } },
    })
    const child = {
      pid: 42, exitCode: null, signalCode: null, output: [safeLine], errors: [],
    } as unknown as ProcessFixtureChild

    const output = processFixtureDiagnostics(child)
    const projected = JSON.parse(output.slice(output.indexOf("P3_PARENT_SUSPENSION_DIAGNOSTICS ")
      + "P3_PARENT_SUSPENSION_DIAGNOSTICS ".length)) as RecordValue

    expect(projected).toMatchObject({
      turnStatus: "failed", rootTaskStatus: "running", latestModelStepStatus: "failed",
      turnErrorCategory: "database_deadlock", waitToolCallStatus: "completed",
      planAccepted: true,
      waitToolCallLifecycleStatus: "started",
      waitToolResultLifecycleStatus: "completed", waitToolOutputStatus: "ready",
      waitFailureCategory: "database_serialization", waits: { count: 3, rootCount: 1, suspendedRootCount: 1 },
      graphNodeCount: 2, targetCounts: { requested: 2, graphMatches: 2, taskRows: 2, graphRows: 2 },
      missingKeys: { requestedGraph: ["source"], graphTasks: ["summary"] },
      childStatusCounts: { failed: 1, completed: 2 },
      likelyCause: "wait_row_missing_or_parent_mismatch",
    })
    expect(projected).not.toHaveProperty("latestModelStepErrorClass")
    expect(projected).not.toHaveProperty("unknownNested")
    expect(markers.some(marker => output.includes(marker)), "diagnostic output must omit marker values").toBe(false)
    expect(output.length).toBeLessThanOrEqual(1_600)
  })

  it("discards a long unknown JSON payload while keeping bounded safe diagnostics", () => {
    const longPayload = "marker-long-nested-payload-" + "x".repeat(1_700)
    const safeLine = "P3_PARENT_SUSPENSION_DIAGNOSTICS " + JSON.stringify({
      turnStatus: "failed", graphNodeCount: 2, likelyCause: "turn_failed",
      unknownNested: { payload: longPayload },
    })
    const child = {
      pid: 42, exitCode: null, signalCode: null,
      output: [safeLine, "marker-arbitrary-stdout"], errors: ["marker-raw-stderr"],
    } as unknown as ProcessFixtureChild

    const output = processFixtureDiagnostics(child)

    expect(output).toContain('"turnStatus":"failed"')
    expect(output).toContain('"graphNodeCount":2')
    expect(output).toContain('"likelyCause":"turn_failed"')
    expect(output).not.toContain(longPayload)
    expect(output).not.toContain("marker-arbitrary-stdout")
    expect(output).not.toContain("marker-raw-stderr")
    expect(output.length).toBeLessThanOrEqual(1_600)
  })

  it("redacts identifiers and arbitrary text while retaining safe status and counts", () => {
    const markers = [
      "marker-turn-id", "marker-session-id", "marker-task-id", "marker-wait-id", "marker-user-id",
      "marker-goal-text", "marker-idempotency-key", "marker-arbitrary-failure-message",
    ]
    const output = compactTurnProgressDiagnostics(JSON.stringify({
      turn: {
        id: markers[0], sessionId: markers[1], userId: markers[4], rootTaskId: markers[2],
        status: "failed", error: markers[7], revision: 7, leaseVersion: 3, leaseOwnerId: markers[5],
      },
      waitToolResult: {
        status: "failed", errorCode: markers[7], outputStatus: "waiting", waitId: markers[3],
        idempotencyKey: markers[6], matchedTaskIds: { count: 2 },
        truncated: { truncatedTaskResultCount: 1 },
      },
      waitLineage: {
        available: true, taskIdsMatchCurrentGraph: false, requestedTaskCount: 2, graphNodeCount: 2,
        proposalReceiptFound: true, proposalNodeCount: 4,
        requestMatchesReceipt: false, requestMatchesCurrentGraph: false,
        requestedIdsOutsideReceiptCount: 1,
        graphNodeKeysMissingRows: ["source", markers[2], "rejected"],
        fixtureNodeKeysMissingRows: ["source", markers[2], "summary", markers[5], "rejected"],
        waitItemFound: true, waitItemMatchesRoot: true, parentTaskFound: true,
        parentIdIsTurnRoot: true, parentSameSession: true, parentSameTurn: true,
        parentRootIsTurnRoot: true, parentHasNoParent: true, parentTaskMatchesUser: true,
        parentMismatchCounts: { id: 0, session: 0, turn: 0, root: 0, parent: 0, user: 0 },
        parentUserMismatchCount: 0,
        targetRows: {
          requestedCount: 2, foundCount: 2, allInExpectedScope: true, allSameUser: true,
          allSameSession: true, allSameTurn: true, allSameRoot: true, allSameParent: true,
          mismatchCounts: { missing: 0, user: 0, session: 0, turn: 0, root: 0, parent: 0 },
        },
      },
      diagnosticToolFailure: {
        toolName: "agent.wait", status: "failed", errorCode: markers[7], failureDetail: markers[7],
        idempotencyKey: markers[6],
      },
      tasks: [{ id: markers[2], goal: markers[5], status: "failed", attemptCount: 2, failureReason: markers[7] }],
      waits: [{ id: markers[3], idempotencyKey: markers[6], status: "waiting", targetTaskIds: [markers[2]], matchedTaskIds: [] }],
      recentEvents: [{ taskId: markers[2], idempotencyKey: markers[6], error: markers[7] }],
      recentOutbox: [{ idempotencyKey: markers[6], lastError: markers[7] }],
    }))

    expect(markers.some(marker => output.includes(marker)), "diagnostic output must omit marker values").toBe(false)
    expect(JSON.parse(output)).toMatchObject({
      turn: { status: "failed", revision: 7, leaseVersion: 3, errorPresent: true },
      waitToolResult: { status: "failed", outputStatus: "waiting", matchedTaskCount: 2, truncatedTaskResultCount: 1 },
      waitLineage: {
        taskIdsMatchCurrentGraph: false, requestedTaskCount: 2, graphNodeCount: 2,
        proposalReceiptFound: true, proposalNodeCount: 4,
        requestMatchesReceipt: false, requestMatchesCurrentGraph: false,
        requestedIdsOutsideReceiptCount: 1,
        graphNodeKeysMissingRows: ["source", "rejected"],
        fixtureNodeKeysMissingRows: ["source", "summary", "rejected"],
        targetRows: { requestedCount: 2, foundCount: 2, allInExpectedScope: true },
      },
      tasks: [{ goalPresent: true, status: "failed", attempts: 2, failureReasonPresent: true }],
      waits: [{ keyPresent: true, status: "waiting", targetCount: 1, matchedCount: 0 }],
    })
  })

  it("projects wait-handoff errors to fixed enums and state flags", () => {
    const marker = "marker-sensitive-wait-handoff-value"
    const output = JSON.stringify(waitHandoffFailureProjection(JSON.stringify({
      waitId: marker,
      error: { name: "Error", code: "40P01", message: marker },
      before: {
        turn: { status: "waiting_for_user", leaseOwnerPresent: true, leaseVersion: 4 },
        wait: { id: marker, status: "waiting", suspendedAt: marker, resolvedAt: null, consumedAt: null },
      },
      after: {
        turn: { status: "failed", leaseOwnerPresent: false, leaseVersion: 5 },
        wait: { id: marker, status: "waiting", suspendedAt: marker, resolvedAt: null, consumedAt: null },
      },
    })))

    expect(output).not.toContain(marker)
    expect(JSON.parse(output)).toMatchObject({
      captured: true,
      errorName: "Error",
      errorCode: "40P01",
      before: { turnStatus: "waiting_for_user", turnLeaseOwnerPresent: true, waitStatus: "waiting", hasSuspendedAt: true },
      after: { turnStatus: "failed", turnLeaseOwnerPresent: false, turnLeaseVersion: 5, waitStatus: "waiting" },
    })
  })
})

describeWithServices("production TaskGraph lifecycle and root resume (disposable PostgreSQL + Redis)", () => {
  const owner = fixture()
  const failureOwner = fixture()
  const stopOwner = fixture()
  const restartOwner = fixture()
  let pool: Pool | undefined
  let redis: Redis | undefined
  let bootstrap: ProductionWorkerBootstrap | undefined
  let turnQueueName: string | undefined
  let childQueueName: string | undefined

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl!, max: 6 })
    redis = new Redis(redisUrl!, {
      maxRetriesPerRequest: null,
      connectTimeout: 2_000,
      retryStrategy: attempt => attempt > 3 ? null : 100,
    })
    await redis.ping()
    vi.doMock("../../redis.js", () => ({
      redisConnection: redis,
      redisCommandConnection: redis,
      closeSharedRedisConnections: async () => undefined,
    }))
    // Each production bootstrap runs database-wide turn recovery; keep inactive fixtures out of its queue scan.
    await seed(pool, owner)
    await seed(pool, failureOwner, "waiting_for_user")
    await seed(pool, stopOwner, "waiting_for_user")
    await seed(pool, restartOwner, "waiting_for_user")
  }, 15_000)

  afterEach(async () => {
    if (bootstrap) await bootstrap.close()
    bootstrap = undefined
  })

  afterAll(async () => {
    const cleanupFailures: string[] = []
    const attempt = async (label: string, action: () => Promise<unknown>) => {
      try { await action() } catch (error: unknown) {
        cleanupFailures.push(label + ": " + (error instanceof Error ? error.stack ?? error.message : String(error)))
      }
    }
    await attempt("bootstrap close", async () => { await bootstrap?.close() })
    if (pool) for (const current of [owner, failureOwner, stopOwner, restartOwner]) {
      await attempt("delete outbox for " + current.sessionId, () => pool!.query(
        "DELETE FROM \"agent_outbox\" WHERE \"aggregateId\" = $1", [current.sessionId],
      ))
      await attempt("delete user " + current.userId, () => pool!.query(
        "DELETE FROM \"User\" WHERE \"id\" = $1", [current.userId],
      ))
    }
    if (redis && turnQueueName && childQueueName) {
      const queueSpecs = [
        { name: turnQueueName, label: "turn queue" },
        { name: childQueueName, label: "subagent queue" },
      ]
      const queues: Array<{ name: string; label: string; queue: Queue }> = []
      for (const spec of queueSpecs) {
        await attempt("create " + spec.label, async () => {
          queues.push({ ...spec, queue: new Queue(spec.name, { connection: redis!, skipVersionCheck: true }) })
        })
      }
      for (const currentQueue of queues) {
        const { queue, label } = currentQueue
        await attempt("wait for " + label, () => queue.waitUntilReady())
        let jobs: Awaited<ReturnType<typeof queue.getJobs>> = []
        await attempt("list jobs from " + label, async () => {
          jobs = await queue.getJobs(["completed", "failed", "waiting", "delayed", "paused", "waiting-children", "active"])
        })
        for (const job of jobs) {
          if ([owner, failureOwner, stopOwner, restartOwner].some(current => job.data?.turnId === current.turnId || job.data?.sessionId === current.sessionId)) {
            await attempt("remove " + label + " job " + job.id, () => job.remove())
          }
        }
        await attempt("close " + label, () => queue.close())
      }
    }
    await attempt("PostgreSQL pool close", async () => { await pool?.end() })
    if (redis && redis.status !== "end") await attempt("Redis connection close", async () => {
      try { await redis!.quit() } catch (error: unknown) { redis!.disconnect(); throw error }
    })
    vi.doUnmock("../../redis.js")
    if (cleanupFailures.length > 0) throw new Error("TaskGraph integration cleanup failed:\n" + cleanupFailures.join("\n"))
  })

  it("plans, waits, promotes dependencies, resumes with bounded evidence, appends a follow-up plan, and resumes again", async () => {
    const [
      { createProductionWorkerBootstrap },
      { createTurnQueue, enqueueTurn, TURN_QUEUE_NAME },
      subagentQueue,
      { createCanonicalTurnRuntime },
      { createPgTaskGraphCommandPort },
      { taskGraphItemId, taskGraphProposalKey },
    ] = await Promise.all([
      import("../../queue/production-bootstrap.js"),
      import("../turns/turn-queue.js"),
      import("../../queue/subagent-queue.js"),
      import("../canonical-turn-runtime.js"),
      import("./pg-task-graph-command-port.js"),
      import("./task-graph-snapshot.js"),
    ])
    turnQueueName = TURN_QUEUE_NAME
    childQueueName = subagentQueue.SUBAGENT_QUEUE_NAME
    const flags: ProductionAgentFlags = {
      cognitiveLoopEnabled: false,
      planningEnabled: true,
      planningExecutionEnabled: true,
      taskGraphPlanningEnabled: true,
      childExecutionEnabled: true,
      coordinationEnabled: true,
      consumeWaitOutcomes: true,
      canonicalAutomationEnabled: false,
    }
    let rootRuntimeExecutions = 0
    let resumedGraphReachedModel = false
    let followUpGraphReachedModel = false
    let followUpExpectedRevision: number | undefined
    let rootModelStreamFailure: string | null = null
    let rootModelFailureStage: RootModelFailureStage = "not_started"
    let childFixtureFailureStage: ChildFixtureFailureStage | null = null
    let rootWaitHandoffFailure: string | null = null
    const runtime = await createCanonicalTurnRuntime(pool!, {
      workerId: owner.ownerId,
      productionFlags: flags,
      taskGraphCommandPort: createPgTaskGraphCommandPort(pool!),
      taskGraphTemplates: {
        ...TASK_GRAPH_TEMPLATES,
      },
      authorizeUsage: async () => ({ settle: async () => undefined }),
      modelRuntimeFactory: () => {
        const execution = ++rootRuntimeExecutions
        let modelRounds = 0
        const model: ModelAdapter = {
          id: "p3-task-graph-fixture-model",
          profile: {
            provider: "fixture", model: "fixture-model", nativeTools: true, structuredOutput: true, streaming: true,
            continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: false,
            supportsReasoningSummary: false, supportsResponseContinuation: false, supportsProviderConversation: false,
            supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: 128, costClass: "low",
          },
          async *stream(request) {
            modelRounds += 1
            if (execution === 2) {
              rootModelFailureStage = "resumed_graph_kind"
              const graph = currentGraphFromRequest(request)
              const nodes = Array.isArray(graph?.nodes) ? graph.nodes.map(record) : []
              expect(graph?.kind).toBe("task_graph_current")
              if (modelRounds === 1) {
                rootModelFailureStage = "resumed_graph_keys"
                expect(nodes.map(node => node?.key)).toEqual(["source", "summary", "large-source", "rejected"])
                rootModelFailureStage = "resumed_graph_statuses"
                expect(nodes.map(node => node?.status)).toEqual(["completed", "completed", "completed", "cancelled"])
                rootModelFailureStage = "resumed_graph_readiness"
                expect(nodes.map(node => node?.readiness)).toEqual(["terminal", "terminal", "terminal", "terminal"])
                rootModelFailureStage = "large_source_projection"
                const largeSourceProjection = nodes.find(node => node?.key === "large-source")?.resultProjection
                expect(largeSourceProjection).toMatchObject({
                  schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA,
                  trust: "untrusted", availability: "unavailable",
                })
                expect(JSON.stringify(largeSourceProjection)).not.toContain("x".repeat(100))
                resumedGraphReachedModel = true
                rootModelFailureStage = "wait_outcome_status"
                const waitOutcome = waitOutcomeFromRequest(request, 4)
                const waitTasks = waitOutcome.tasks.map(record)
                expect(waitOutcome.status).toBe("ready")
                const waitTaskForNode = (key: string) => {
                  const taskId = nodes.find(node => node?.key === key)?.taskId
                  return waitTasks.find(task => task?.taskId === taskId)
                }
                const sourceWaitTask = waitTaskForNode("source")
                const summaryWaitTask = waitTaskForNode("summary")
                const largeSourceWaitTask = waitTaskForNode("large-source")
                const rejectedWaitTask = waitTaskForNode("rejected")
                rootModelFailureStage = "wait_task_statuses"
                expect(sourceWaitTask).toMatchObject({ status: "completed" })
                expect(summaryWaitTask).toMatchObject({ status: "completed" })
                expect(largeSourceWaitTask).toMatchObject({ status: "completed" })
                expect(rejectedWaitTask).toMatchObject({ status: "cancelled" })
                rootModelFailureStage = "source_wait_summary"
                expect(record(record(sourceWaitTask?.result)?.structuredResult)?.summary).toBe("Read the fixture source")
                rootModelFailureStage = "summary_wait_summary"
                expect(record(record(summaryWaitTask?.result)?.structuredResult)?.summary).toBe("Summarize the fixture source")
                const revision = graph?.revision
                rootModelFailureStage = "resumed_graph_revision"
                if (typeof revision !== "number" || !Number.isSafeInteger(revision)) throw new Error("Resumed current graph revision is invalid")
                followUpExpectedRevision = revision
                rootModelFailureStage = "follow_up_plan_tool"
                expect(request.tools.map(tool => record(tool)?.name)).toContain("agent.plan")
                yield {
                  type: "tool_call_completed", callId: FOLLOW_UP_PLAN_CALL_ID, name: "agent.plan",
                  arguments: {
                    expectedRevision: followUpExpectedRevision,
                    nodes: [{
                      key: "verification", templateId: "analyst", goal: FOLLOW_UP_GOAL,
                      successCriteria: ["Verify the completed summary evidence"], dependsOn: ["summary"],
                    }],
                  },
                }
                yield { type: "completed", finishReason: "tool_calls" }
                return
              }
              if (modelRounds === 2) {
                rootModelFailureStage = "follow_up_graph_keys"
                expect(nodes.map(node => node?.key)).toEqual(["source", "summary", "large-source", "rejected", "verification"])
                rootModelFailureStage = "follow_up_graph_statuses"
                expect(nodes.slice(0, 4).map(node => node?.status)).toEqual(["completed", "completed", "completed", "cancelled"])
                rootModelFailureStage = "follow_up_graph_readiness"
                expect(nodes.slice(0, 4).map(node => node?.readiness)).toEqual(["terminal", "terminal", "terminal", "terminal"])
                rootModelFailureStage = "follow_up_plan_receipt"
                const plannedTaskIds = planTaskIds(request, FOLLOW_UP_PLAN_CALL_ID, 1)
                expect(nodes.find(node => node?.key === "verification")).toMatchObject({
                  key: "verification", taskId: plannedTaskIds[0],
                })
                rootModelFailureStage = "follow_up_wait_tool"
                expect(request.tools.map(tool => record(tool)?.name)).toContain("agent.wait")
                yield {
                  type: "tool_call_completed", callId: FOLLOW_UP_WAIT_CALL_ID, name: "agent.wait",
                  arguments: {
                    idempotencyKey: `p3-task-graph-follow-up-wait:${owner.turnId}`,
                    taskIds: plannedTaskIds, mode: "all", timeoutMs: 20_000,
                  },
                }
                yield { type: "completed", finishReason: "tool_calls" }
                return
              }
              throw new Error("Unexpected model round before the follow-up TaskGraph wait")
            }
            if (execution === 3) {
              rootModelFailureStage = "completed_graph_kind"
              const graph = currentGraphFromRequest(request)
              const nodes = Array.isArray(graph?.nodes) ? graph.nodes.map(record) : []
              expect(graph?.kind).toBe("task_graph_current")
              rootModelFailureStage = "completed_graph_keys"
              expect(nodes.map(node => node?.key)).toEqual(["source", "summary", "large-source", "rejected", "verification"])
              rootModelFailureStage = "completed_graph_statuses"
              expect(nodes.map(node => node?.status)).toEqual(["completed", "completed", "completed", "cancelled", "completed"])
              rootModelFailureStage = "completed_graph_readiness"
              expect(nodes.map(node => node?.readiness)).toEqual(["terminal", "terminal", "terminal", "terminal", "terminal"])
              followUpGraphReachedModel = true
              rootModelFailureStage = "completed_wait_outcome"
              const waitOutcome = waitOutcomeFromRequest(request, 1)
              const waitTasks = waitOutcome.tasks.map(record)
              expect(waitOutcome.status).toBe("ready")
              rootModelFailureStage = "completed_wait_status"
              expect(waitTasks.map(task => task?.status)).toEqual(["completed"])
              rootModelFailureStage = "completed_wait_summary"
              expect(record(record(waitTasks[0]?.result)?.structuredResult)?.summary).toBe(FOLLOW_UP_GOAL)
              yield { type: "text_delta", text: FINAL_MARKER }
              yield { type: "completed", finishReason: "stop" }
              return
            }
            if (execution === 1 && modelRounds === 1) {
              rootModelFailureStage = "initial_plan_tool"
              expect(request.tools.map(tool => record(tool)?.name)).toContain("agent.plan")
              yield {
                type: "tool_call_completed", callId: PLAN_CALL_ID, name: "agent.plan",
                arguments: {
                  expectedRevision: 0,
                  nodes: [
                    { key: "source", templateId: "scout", goal: "Read the fixture source", successCriteria: ["Capture source evidence"], dependsOn: [] },
                    { key: "summary", templateId: "analyst", goal: "Summarize the fixture source", successCriteria: ["Write a source summary"], dependsOn: ["source"] },
                    { key: "large-source", templateId: "scout", goal: OVERSIZED_SOURCE_GOAL, successCriteria: ["Return structured source evidence"], dependsOn: [] },
                    { key: "rejected", templateId: "analyst", goal: REJECTED_DEPENDENT_GOAL, successCriteria: ["Never dispatch oversized evidence"], dependsOn: ["large-source"] },
                  ],
                },
              }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            if (execution === 1 && modelRounds === 2) {
              rootModelFailureStage = "initial_wait_tool"
              expect(request.tools.map(tool => record(tool)?.name)).toContain("agent.wait")
              rootModelFailureStage = "initial_wait_plan_receipt"
              const plannedTaskIds = planTaskIds(request, PLAN_CALL_ID, 4)
              const graph = currentGraphFromRequest(request)
              const graphNodes = Array.isArray(graph?.nodes) ? graph.nodes.map(record) : []
              const graphTaskIds = graphNodes.flatMap(node => typeof node?.taskId === "string" ? [node.taskId] : [])
              const plannedIdSet = new Set(plannedTaskIds)
              const graphIdSet = new Set(graphTaskIds)
              if (plannedIdSet.size !== 4) {
                rootModelFailureStage = "initial_wait_plan_uniqueness"
                throw new Error("p3_task_graph_wait_ids_mismatch")
              }
              if (graphTaskIds.length !== 4) {
                rootModelFailureStage = "initial_wait_graph_count"
                throw new Error("p3_task_graph_wait_ids_mismatch")
              }
              if (graphIdSet.size !== 4) {
                rootModelFailureStage = "initial_wait_graph_uniqueness"
                throw new Error("p3_task_graph_wait_ids_mismatch")
              }
              if (plannedIdSet.size !== graphIdSet.size
                || [...plannedIdSet].some(taskId => !graphIdSet.has(taskId))) {
                rootModelFailureStage = "initial_wait_plan_graph_set_mismatch"
                throw new Error("p3_task_graph_wait_ids_mismatch")
              }
              rootModelFailureStage = "initial_wait_tool"
              yield {
                type: "tool_call_completed", callId: WAIT_CALL_ID, name: "agent.wait",
                arguments: {
                  idempotencyKey: `p3-task-graph-wait:${owner.turnId}`,
                  taskIds: plannedTaskIds, mode: "all", timeoutMs: 20_000,
                },
              }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            rootModelFailureStage = "unexpected_root_model_round"
            throw new Error("Unexpected root model execution or round in the TaskGraph resume fixture")
          },
        }
        return {
          adapter: captureModelStreamFailure(model, error => { rootModelStreamFailure = boundedErrorText(error) }),
          registry: {} as never,
          candidates: [],
        }
      },
    })
    bootstrap = await createProductionWorkerBootstrap({
      pool: pool!,
      runtime,
      ownerId: owner.ownerId,
      turnQueueFactory: withWaitHandoffDiagnostics(pool!, createTurnQueue, diagnostic => {
        rootWaitHandoffFailure = diagnostic
      }),
      turnRecoveryIntervalMs: 100,
      waitResolver: { intervalMs: 10, batchSize: 10, ownerId: `p3-wait-resolver-${owner.suffix}` },
      subagents: {
        intervalMs: 10,
        async execute({ lease }) {
          let stage: ChildFixtureFailureStage = "parent_wait"
          try {
            const minimumWaitCount = lease.goal === FOLLOW_UP_GOAL ? 2 : 1
            await waitForSuspendedParent(pool!, owner.turnId, minimumWaitCount)
            if (lease.goal === "Summarize the fixture source") {
              const taskContext = record(lease.context)
              const dependencyContext = record(taskContext?.taskGraphDependencyResults)
              const items = Array.isArray(dependencyContext?.items) ? dependencyContext.items.map(record) : []
              stage = "source_dependency_schema"
              expect(dependencyContext?.schemaVersion).toBe("agent-harness.v2.task-graph.dependency-evidence")
              stage = "source_dependency_items"
              expect(items).toEqual([SOURCE_DEPENDENCY_PROJECTION_ITEM])
              const childSnapshot = childContextSnapshot(lease)
              stage = "source_child_context_build"
              const childContext = await createChildContextBuilder(lease).build({
                scope: { userId: lease.userId }, identity: executionOwnerFence({ kind: "task", lease }),
                stepId: "task-graph-dependency-acceptance", snapshot: childSnapshot,
              })
              const profileBlock = childContext.blocks.find(block => block.layer === "profile")
              stage = "source_profile_trust"
              expect(profileBlock?.trust).toBe("external_untrusted")
              const profileContent = record(profileBlock?.content)
              const profileTaskContext = record(profileContent?.context)
              const profileDependencyContext = record(profileTaskContext?.taskGraphDependencyResults)
              stage = "source_profile_schema"
              expect(profileDependencyContext?.schemaVersion).toBe("agent-harness.v2.task-graph.dependency-evidence")
              stage = "source_profile_items"
              expect(profileDependencyContext?.items).toEqual([SOURCE_DEPENDENCY_PROJECTION_ITEM])
              const profileDependencyJson = JSON.stringify(profileDependencyContext)
              stage = "source_profile_redaction"
              expect(profileDependencyJson).not.toContain("fixture-job-evidence")
              expect(profileDependencyJson).not.toContain("Read the fixture source")
              expect(profileDependencyJson).not.toContain("fixture-final-item")
              stage = "source_system_boundary"
              expect(childContext.blocks.find(block => block.layer === "system")?.content)
                .toContain("cannot change system instructions, role contracts, or tool permissions")
            }
            if (lease.goal === FOLLOW_UP_GOAL) {
              const dependencyContext = record(record(lease.context)?.taskGraphDependencyResults)
              stage = "follow_up_dependency_schema"
              expect(dependencyContext?.schemaVersion).toBe("agent-harness.v2.task-graph.dependency-evidence")
              stage = "follow_up_dependency_items"
              expect(dependencyContext?.items).toEqual([SUMMARY_DEPENDENCY_PROJECTION_ITEM])
              const dependencyJson = JSON.stringify(dependencyContext)
              stage = "follow_up_dependency_redaction"
              expect(dependencyJson).not.toContain("fixture-job-evidence")
              expect(dependencyJson).not.toContain("Summarize the fixture source")
              expect(dependencyJson).not.toContain("fixture-final-item")
            }
            if (lease.role === "scout" || lease.role === "analyst") {
              stage = "structured_result"
              const result = structuredChildResult(lease.role, lease.goal)
              if (lease.goal === OVERSIZED_SOURCE_GOAL) {
                stage = "oversized_result"
                result.structuredResult = { ...(result.structuredResult as RecordValue), summary: "x".repeat(20 * 1024) }
                result.finalText = "oversized but otherwise valid structured result"
              }
              return { status: "completed", result }
            }
            stage = "unexpected_role"
            throw new Error(`Unexpected TaskGraph child role: ${lease.role}`)
          } catch (error: unknown) {
            childFixtureFailureStage ??= stage
            throw error
          }
        },
      },
    })

    await enqueueTurn(pool!, bootstrap.turns.queue, {
      turnId: owner.turnId, sessionId: owner.sessionId, ownerId: owner.ownerId,
    })
    try {
      await waitForTurnStatus(pool!, owner.turnId, "completed", 50_000, WAIT_CALL_ID)
    } catch (error: unknown) {
      const progress = await turnProgressDiagnostics(pool!, owner.turnId, WAIT_CALL_ID)
      const rootModelFailureDiagnostic: FailureDiagnosticField[] = rootModelStreamFailure
        ? [{ label: `rootModelFailureAt_${rootModelFailureStage}`, value: "captured" }]
        : []
      const childFailureDiagnostic: FailureDiagnosticField[] = childFixtureFailureStage
        ? [{ label: `childFixtureFailureAt_${childFixtureFailureStage}`, value: "captured" }]
        : []
      const handoffSuffix = rootWaitHandoffFailure
        ? `; waitHandoffState=${JSON.stringify(waitHandoffFailureProjection(rootWaitHandoffFailure))}`
        : ""
      throw new Error(boundedDiagnostic(combineFailureDiagnostics([
        ...childFailureDiagnostic,
        { label: "rootModelStreamFailure", value: rootModelStreamFailure ?? "<not captured>" },
        ...rootModelFailureDiagnostic,
        { label: "waitHandoffFailure", value: rootWaitHandoffFailure ?? "<not captured>" },
        { label: "turnFailure", value: waitTurnFailureSummary(error) },
      ], progress) + handoffSuffix, 4_500))
    }
    const parkedTurns = await pool!.query<{ id: string; status: string }>(
      `SELECT "id", "status" FROM "agent_turns" WHERE "id" = ANY($1::text[]) ORDER BY "id"`,
      [[failureOwner.turnId, stopOwner.turnId, restartOwner.turnId]],
    )
    expect(new Map(parkedTurns.rows.map(({ id, status }) => [id, status]))).toEqual(new Map([
      failureOwner.turnId, stopOwner.turnId, restartOwner.turnId,
    ].map(id => [id, "waiting_for_user"])))

    const turn = await pool!.query<{ rootTaskId: string; leaseVersion: number; finalResponse: string | null }>(
      `SELECT "rootTaskId", "leaseVersion", "finalResponse" FROM "agent_turns" WHERE "id" = $1`, [owner.turnId],
    )
    const rootTaskId = turn.rows[0]?.rootTaskId
    expect(rootTaskId).toBeTruthy()
    expect(turn.rows[0]).toMatchObject({ leaseVersion: 3 })
    expect(rootRuntimeExecutions).toBe(3)
    expect(resumedGraphReachedModel).toBe(true)
    expect(followUpGraphReachedModel).toBe(true)
    expect(JSON.stringify(turn.rows[0]?.finalResponse)).toContain(FINAL_MARKER)

    const children = await pool!.query<{ id: string; goal: string; status: string; result: RecordValue | null; context: RecordValue; role: string; failureReason: string | null }>(
      `SELECT "id", "goal", "status", "result", "context", "role", "failureReason" FROM "sub_agent_tasks"
       WHERE "sessionId" = $1 AND "turnId" = $2 AND "parentTaskId" = $3 ORDER BY "goal"`,
      [owner.sessionId, owner.turnId, rootTaskId],
    )
    expect(children.rows).toHaveLength(5)
    const childByGoal = new Map(children.rows.map(child => [child.goal, child] as const))
    expect(childByGoal.get("Read the fixture source")).toMatchObject({ status: "completed", role: "scout" })
    expect(record(childByGoal.get("Read the fixture source")?.result?.structuredResult)?.candidates).toMatchObject([{ jobId: "fixture-job-1" }])
    expect(childByGoal.get("Summarize the fixture source")).toMatchObject({ status: "completed", role: "analyst" })
    expect(record(childByGoal.get("Summarize the fixture source")?.result?.structuredResult)?.findings).toMatchObject([{ jobId: "fixture-job-1", score: 8 }])
    expect(childByGoal.get(FOLLOW_UP_GOAL)).toMatchObject({ status: "completed", role: "analyst" })
    expect(childByGoal.get(OVERSIZED_SOURCE_GOAL)).toMatchObject({ status: "completed", role: "scout" })
    expect(Buffer.byteLength(JSON.stringify(childByGoal.get(OVERSIZED_SOURCE_GOAL)?.result ?? {}), "utf8")).toBeGreaterThan(16 * 1024)
    expect(childByGoal.get(REJECTED_DEPENDENT_GOAL)).toMatchObject({
      status: "cancelled", failureReason: "Prerequisite results could not be safely materialized.",
    })
    const summarizeDependencyContext = record(childByGoal.get("Summarize the fixture source")?.context.taskGraphDependencyResults)
    expect(summarizeDependencyContext?.schemaVersion).toBe("agent-harness.v2.task-graph.dependency-evidence")
    expect(summarizeDependencyContext?.items).toEqual([SOURCE_DEPENDENCY_PROJECTION_ITEM])
    const summarizeDependencyJson = JSON.stringify(summarizeDependencyContext)
    expect(summarizeDependencyJson).not.toContain("fixture-job-evidence")
    expect(summarizeDependencyJson).not.toContain("Read the fixture source")
    expect(summarizeDependencyJson).not.toContain("fixture-final-item")

    const followUpDependencyContext = record(childByGoal.get(FOLLOW_UP_GOAL)?.context.taskGraphDependencyResults)
    expect(followUpDependencyContext?.schemaVersion).toBe("agent-harness.v2.task-graph.dependency-evidence")
    expect(followUpDependencyContext?.items).toEqual([SUMMARY_DEPENDENCY_PROJECTION_ITEM])
    const followUpDependencyJson = JSON.stringify(followUpDependencyContext)
    expect(followUpDependencyJson).not.toContain("fixture-job-evidence")
    expect(followUpDependencyJson).not.toContain("Summarize the fixture source")
    expect(followUpDependencyJson).not.toContain("fixture-final-item")
    const childDispatches = await pool!.query<{ idempotencyKey: string; publishedAt: Date | null; payload: RecordValue }>(
      `SELECT "idempotencyKey", "publishedAt", "payload" FROM "agent_outbox"
       WHERE "aggregateId" = $1 AND "topic" = 'agent.subagent.dispatch' ORDER BY "createdAt"`,
      [owner.sessionId],
    )
    expect(childDispatches.rows).toHaveLength(4)
    expect(childDispatches.rows.map(row => row.payload.taskId)).toEqual(expect.arrayContaining(
      children.rows.filter(child => child.status === "completed").map(child => child.id),
    ))
    expect(childDispatches.rows.map(row => row.payload.taskId)).not.toContain(childByGoal.get(REJECTED_DEPENDENT_GOAL)?.id)
    expect(childDispatches.rows.every(row => row.publishedAt instanceof Date)).toBe(true)

    const item = await pool!.query<{ revision: number }>(
      `SELECT "revision" FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "type" = 'task_graph'`,
      [owner.sessionId, owner.turnId, rootTaskId],
    )
    expect(item.rows[0]?.revision).toBeGreaterThanOrEqual(6)
    const graphEvents = await pool!.query<{ idempotencyKey: string; payload: RecordValue }>(
      `SELECT "idempotencyKey", "payload" FROM "agent_events"
       WHERE "sessionId" = $1 AND "turnId" = $2 AND "itemId" = $3 ORDER BY "sequence"`,
      [owner.sessionId, owner.turnId, taskGraphItemId(rootTaskId!)],
    )
    expect(graphEvents.rows.some(event => event.idempotencyKey === taskGraphProposalKey(rootTaskId!, 0))).toBe(true)
    expect(followUpExpectedRevision).toEqual(expect.any(Number))
    expect(graphEvents.rows.some(event => event.idempotencyKey === taskGraphProposalKey(rootTaskId!, followUpExpectedRevision!))).toBe(true)
    const lifecycleTypes = graphEvents.rows.flatMap(event => {
      const payload = record(event.payload)
      const lifecycle = record(payload?.event)
      return payload?.kind === "lifecycle" && typeof lifecycle?.type === "string" ? [lifecycle.type] : []
    })
    expect(lifecycleTypes).toEqual(expect.arrayContaining(["task.started", "task.queued", "task.completed"]))

    const wait = await pool!.query<{ id: string; status: string; suspendedAt: Date | null; consumedAt: Date | null; matchedTaskIds: string[] }>(
      `SELECT "id", "status", "suspendedAt", "consumedAt", "matchedTaskIds" FROM "agent_wait_conditions" WHERE "turnId" = $1 ORDER BY "createdAt" ASC`,
      [owner.turnId],
    )
    expect(wait.rows).toHaveLength(2)
    expect(wait.rows.every(row => row.status === "ready" && row.suspendedAt instanceof Date && row.consumedAt instanceof Date)).toBe(true)
    // The first all-mode wait targets four tasks; terminal cancellations count as matched.
    expect(wait.rows.map(row => row.matchedTaskIds.length)).toEqual([4, 1])
    for (const row of wait.rows) {
      const wakeEvents = await pool!.query<{ count: string }>(
        `SELECT COUNT(*)::text AS "count" FROM "agent_events" WHERE "sessionId" = $1 AND "idempotencyKey" = $2`,
        [owner.sessionId, `agent-wait:${row.id}:resumed`],
      )
      expect(wakeEvents.rows[0]?.count).toBe("1")
    }
    const wakeDispatch = await pool!.query<{ idempotencyKey: string; publishedAt: Date | null; payload: RecordValue }>(
      `SELECT "idempotencyKey", "publishedAt", "payload" FROM "agent_outbox"
       WHERE "aggregateId" = $1 AND "topic" = 'agent.turn.dispatch' AND "idempotencyKey" = $2`,
      [owner.sessionId, `turn-dispatch:${owner.turnId}`],
    )
    expect(wakeDispatch.rows).toHaveLength(1)
    expect(wakeDispatch.rows[0]).toMatchObject({
      idempotencyKey: `turn-dispatch:${owner.turnId}`,
      publishedAt: expect.any(Date),
      payload: { turnId: owner.turnId, sessionId: owner.sessionId },
    })
  }, 90_000)

  it("restores the TaskGraph after a real Worker restart and completes a follow-up plan", async () => {
    if (planLedgerTraceArtifactPath) await rm(planLedgerTraceArtifactPath, { force: true })
    const [turnModule, subagentModule] = await Promise.all([
      import("../turns/turn-queue.js"),
      import("../../queue/subagent-queue.js"),
    ])
    turnQueueName = turnModule.TURN_QUEUE_NAME
    childQueueName = subagentModule.SUBAGENT_QUEUE_NAME
    let workerOne: ProcessFixtureChild | undefined
    let workerTwo: ProcessFixtureChild | undefined
    try {
      workerOne = startTaskGraphRestartWorker("park-parent", restartOwner)
      const suspendedLine = await waitForProcessLine(workerOne, "P3_PARENT_SUSPENDED ", 45_000)
      if (workerOne.pid === undefined) throw new Error("P3 first Worker has no OS process ID")
      expect(suspendedLine).toContain("p3-process-restart-worker-" + workerOne.pid)

      const beforeTurn = await pool!.query<{ status: string; leaseOwnerId: string | null; leaseVersion: number; rootTaskId: string | null }>(
        "SELECT \"status\", \"leaseOwnerId\", \"leaseVersion\", \"rootTaskId\" FROM \"agent_turns\" WHERE \"id\" = $1",
        [restartOwner.turnId],
      )
      expect(beforeTurn.rows[0]).toMatchObject({
        status: "waiting_for_dependency", leaseOwnerId: null, leaseVersion: 1,
      })
      const rootTaskId = beforeTurn.rows[0]?.rootTaskId
      expect(rootTaskId).toBeTruthy()

      const graphBefore = await pool!.query<TaskGraphItemRow>(
        "SELECT \"id\", \"sessionId\", \"turnId\", \"stepId\", \"taskId\", \"type\", \"status\", \"phase\", \"revision\", \"content\", \"startedAt\", \"completedAt\", \"createdAt\", \"updatedAt\" FROM \"agent_items\" WHERE \"sessionId\" = $1 AND \"turnId\" = $2 AND \"taskId\" = $3 AND \"type\" = 'task_graph'",
        [restartOwner.sessionId, restartOwner.turnId, rootTaskId],
      )
      expect(graphBefore.rows).toHaveLength(1)
      const graphSnapshot = record(graphBefore.rows[0]?.content)
      const graphNodes = Array.isArray(graphSnapshot?.nodes) ? graphSnapshot.nodes.map(record) : []
      expect(graphSnapshot?.schemaVersion).toBe("agent-harness.v2.task-graph")
      expect(graphNodes.map(node => node?.key)).toEqual(["source", "summary"])
      expect(graphBefore.rows[0]?.revision).toBeGreaterThan(0)

      const waitsBefore = await pool!.query<{ id: string; status: string; suspendedAt: Date | null; consumedAt: Date | null; targetTaskIds: unknown }>(
        "SELECT \"id\", \"status\", \"suspendedAt\", \"consumedAt\", \"targetTaskIds\" FROM \"agent_wait_conditions\" WHERE \"turnId\" = $1",
        [restartOwner.turnId],
      )
      expect(waitsBefore.rows).toHaveLength(1)
      expect(waitsBefore.rows[0]).toMatchObject({ status: "waiting", consumedAt: null })
      expect(waitsBefore.rows[0]?.suspendedAt).toBeInstanceOf(Date)
      const targetTaskIds = Array.isArray(waitsBefore.rows[0]?.targetTaskIds)
        ? waitsBefore.rows[0]?.targetTaskIds as string[]
        : JSON.parse(String(waitsBefore.rows[0]?.targetTaskIds)) as string[]
      expect(targetTaskIds).toHaveLength(2)
      const pendingTasks = await pool!.query<{ goal: string; status: string }>(
        "SELECT \"goal\", \"status\" FROM \"sub_agent_tasks\" WHERE \"turnId\" = $1 AND \"parentTaskId\" = $2 ORDER BY \"goal\"",
        [restartOwner.turnId, rootTaskId],
      )
      expect(pendingTasks.rows).toEqual([
        { goal: "Read the durable TaskGraph source", status: "queued" },
        { goal: "Summarize the restored TaskGraph source", status: "waiting" },
      ])

      const firstWorkerPid = workerOne.pid
      const firstExit = waitForProcessExit(workerOne)
      const killAccepted = workerOne.kill("SIGKILL")
      await firstExit
      expect(killAccepted).toBe(true)
      expect(workerOne.signalCode).toBe("SIGKILL")
      expect(workerOne.exitCode).toBeNull()

      const afterKillTurn = await pool!.query<{ status: string; leaseOwnerId: string | null; leaseVersion: number }>(
        "SELECT \"status\", \"leaseOwnerId\", \"leaseVersion\" FROM \"agent_turns\" WHERE \"id\" = $1",
        [restartOwner.turnId],
      )
      expect(afterKillTurn.rows[0]).toEqual({ status: "waiting_for_dependency", leaseOwnerId: null, leaseVersion: 1 })
      const graphAfterKill = await pool!.query<TaskGraphItemRow>(
        "SELECT \"id\", \"sessionId\", \"turnId\", \"stepId\", \"taskId\", \"type\", \"status\", \"phase\", \"revision\", \"content\", \"startedAt\", \"completedAt\", \"createdAt\", \"updatedAt\" FROM \"agent_items\" WHERE \"sessionId\" = $1 AND \"turnId\" = $2 AND \"taskId\" = $3 AND \"type\" = 'task_graph'",
        [restartOwner.sessionId, restartOwner.turnId, rootTaskId],
      )
      expect(graphAfterKill.rows).toEqual(graphBefore.rows)
      const waitAfterKill = await pool!.query<{ id: string; status: string; suspendedAt: Date | null; consumedAt: Date | null; targetTaskIds: unknown }>(
        "SELECT \"id\", \"status\", \"suspendedAt\", \"consumedAt\", \"targetTaskIds\" FROM \"agent_wait_conditions\" WHERE \"turnId\" = $1",
        [restartOwner.turnId],
      )
      expect(waitAfterKill.rows).toEqual(waitsBefore.rows)

      workerTwo = startTaskGraphRestartWorker("resume-parent", {
        ...restartOwner,
        expectedRevision: graphBefore.rows[0]!.revision,
        expectedSnapshot: graphSnapshot,
      })
      expect(workerTwo.pid).not.toBe(firstWorkerPid)
      const readyLine = await waitForProcessLine(workerTwo, "P3_SECOND_WORKER_READY ")
      expect(readyLine).toContain("p3-process-restart-worker-" + workerTwo.pid)
      try {
        await waitForProcessLine(workerTwo, "P3_DEPENDENCY_CONTEXT_OK")
      } catch (error) {
        const children = await pool!.query<{ goal: string; status: string; failureReason: string | null; dependencies: unknown }>(
          `SELECT "goal", "status", "failureReason", "context"->'taskGraphDependencyResults' AS "dependencies"
           FROM "sub_agent_tasks" WHERE "turnId" = $1 ORDER BY "createdAt"`, [restartOwner.turnId],
        )
        const compactChildren = children.rows.map(child => {
          const dependencyContext = record(child.dependencies)
          const items = Array.isArray(dependencyContext?.items)
            ? dependencyContext.items.map(record).filter((item): item is RecordValue => item !== null)
            : []
          return {
            goal: diagnosticText(child.goal, 48),
            status: diagnosticText(child.status, 24),
            failureReason: diagnosticText(child.failureReason, 96),
            dependencies: items.slice(0, 2).map(item => ({
              key: diagnosticText(item.dependencyKey, 32),
              status: diagnosticText(item.taskStatus, 24),
              role: diagnosticText(item.role, 24),
              availability: diagnosticText(record(item.result)?.availability, 24),
            })),
          }
        })
        const progress = await turnProgressDiagnostics(pool!, restartOwner.turnId, "p3-process-restart-wait")
        const parentModelFailure = workerTwo.output.find(line => line.startsWith("P3_PARENT_MODEL_FAILURE")) ?? null
        const processErrorText = error instanceof Error ? error.message : String(error)
        const processError = parentModelFailure
          ? processErrorText.replace(parentModelFailure, "<parent model failure captured separately>")
          : processErrorText
        throw new Error(combineFailureDiagnostics([
          { label: "parentModelFailure", value: parentModelFailure ?? "<not captured>" },
          { label: "processError", value: processError },
          { label: "childContexts", value: JSON.stringify(compactChildren) },
        ], progress))
      }
      try {
        await waitForProcessLine(workerTwo, "P3_RESTORED_GRAPH_OK")
      } catch (error: unknown) {
        const progress = await turnProgressDiagnostics(pool!, restartOwner.turnId, "p3-process-restart-wait")
        const processErrorText = error instanceof Error ? error.message : String(error)
        const parentModelFailure = workerTwo.output.find(line => line.startsWith("P3_PARENT_MODEL_FAILURE")) ?? null
        const processError = parentModelFailure
          ? processErrorText.replace(parentModelFailure, "<parent model failure captured separately>")
          : processErrorText
        throw new Error(combineFailureDiagnostics([
          { label: "parentModelFailure", value: parentModelFailure ?? "<not captured>" },
          { label: "processError", value: processError },
        ], progress))
      }
      await waitForProcessLine(workerTwo, "P3_PARENT_RESUME_CONTEXT_OK")
      await waitForProcessLine(workerTwo, "P3_FOLLOW_UP_DEPENDENCY_CONTEXT_OK")
      let persistedFollowUpWait: { id: string }
      try {
        persistedFollowUpWait = await waitForPersistedTaskWait(
          pool!, restartOwner.turnId, "p3-process-restart-follow-up-wait:" + restartOwner.turnId,
        )
      } catch {
        const persistence = await restartFollowUpWaitDiagnostics(
          pool!, restartOwner.turnId,
          "p3-process-restart-follow-up-wait:" + restartOwner.turnId,
          "p3-process-restart-follow-up-wait",
        )
        const workerMarkers = {
          ready: workerTwo.output.some(line => line.startsWith("P3_SECOND_WORKER_READY ")),
          dependencyContext: workerTwo.output.some(line => line === "P3_DEPENDENCY_CONTEXT_OK"),
          parentResumeContext: workerTwo.output.some(line => line === "P3_PARENT_RESUME_CONTEXT_OK"),
          followUpDependencyContext: workerTwo.output.some(line => line === "P3_FOLLOW_UP_DEPENDENCY_CONTEXT_OK"),
          parentModelFailureMarkerPresent: workerTwo.output.some(line => line.startsWith("P3_PARENT_MODEL_FAILURE ")),
        }
        throw new Error(boundedDiagnostic(JSON.stringify({
          secondWorkerOutputPresent: workerTwo.output.length > 0,
          secondWorkerErrorPresent: workerTwo.errors.length > 0,
          workerMarkers,
          persistence,
        }), 1_500))
      }
      expect(persistedFollowUpWait.id).toBeTruthy()
      workerTwo.stdin?.write("complete-follow-up-child\n")
      const followUpReadyLine = await waitForProcessLine(workerTwo, "P3_FOLLOW_UP_GRAPH_READY ")

      const preFinalGraph = await pool!.query<{ id: string; revision: number; content: RecordValue }>(
        "SELECT \"id\", \"revision\", \"content\" FROM \"agent_items\" WHERE \"sessionId\" = $1 AND \"turnId\" = $2 AND \"taskId\" = $3 AND \"type\" = 'task_graph'",
        [restartOwner.sessionId, restartOwner.turnId, rootTaskId],
      )
      expect(preFinalGraph.rows).toHaveLength(1)
      const preFinalSnapshot = record(preFinalGraph.rows[0]?.content)
      const preFinalNodes = Array.isArray(preFinalSnapshot?.nodes) ? preFinalSnapshot.nodes.map(record) : []
      expect(preFinalNodes.map(node => node?.key)).toEqual(["source", "summary", RESTART_FOLLOW_UP_KEY])
      const preFinalFollowUpId = preFinalNodes[2]?.taskId
      expect(typeof preFinalFollowUpId).toBe("string")
      expect(followUpReadyLine).toContain(String(preFinalFollowUpId))

      const preFinalChildResult = await pool!.query<{ status: string; role: string; result: RecordValue | null; context: RecordValue | null }>(
        "SELECT \"status\", \"role\", \"result\", \"context\" FROM \"sub_agent_tasks\" WHERE \"id\" = $1 AND \"sessionId\" = $2 AND \"turnId\" = $3 AND \"rootTaskId\" = $4 AND \"parentTaskId\" = $4",
        [preFinalFollowUpId, restartOwner.sessionId, restartOwner.turnId, rootTaskId],
      )
      expect(preFinalChildResult.rows[0]).toMatchObject({ status: "completed", role: "analyst" })
      expect(JSON.stringify(preFinalChildResult.rows[0]?.result)).toContain(RESTART_FOLLOW_UP_GOAL)
      const preFinalContext = record(record(preFinalChildResult.rows[0]?.context)?.taskGraphDependencyResults)
      const preFinalDependencies = Array.isArray(preFinalContext?.items) ? preFinalContext.items.map(record) : []
      expect(preFinalDependencies[0]).toMatchObject({ dependencyKey: "summary", role: "analyst", taskStatus: "completed" })
      expect(record(preFinalDependencies[0]?.result)).toMatchObject({ availability: "available", role: "analyst" })

      const preFinalEvents = await pool!.query<{ taskId: string | null; idempotencyKey: string; payload: RecordValue }>(
        "SELECT \"taskId\", \"idempotencyKey\", \"payload\" FROM \"agent_events\" WHERE \"sessionId\" = $1 AND \"turnId\" = $2 AND \"itemId\" = $3 ORDER BY \"sequence\"",
        [restartOwner.sessionId, restartOwner.turnId, preFinalGraph.rows[0]!.id],
      )
      const preFinalProposal = preFinalEvents.rows.find(event => {
        const payload = record(event.payload)
        const receipt = record(payload?.receipt)
        const receiptNodes = Array.isArray(receipt?.nodes) ? receipt.nodes.map(record) : []
        return payload?.kind === "proposal" && receiptNodes.some(node => node?.key === RESTART_FOLLOW_UP_KEY && node.taskId === preFinalFollowUpId)
      })
      expect(record(record(preFinalProposal?.payload)?.receipt)).toMatchObject({
        status: "accepted", nodes: [{ key: RESTART_FOLLOW_UP_KEY, taskId: preFinalFollowUpId, status: "queued" }],
      })
      expect(preFinalEvents.rows.some(event => event.taskId === preFinalFollowUpId
        && record(event.payload)?.kind === "lifecycle"
        && record(record(event.payload)?.event)?.type === "task.completed")).toBe(true)
      const preFinalWaits = await pool!.query<{ status: string; consumedAt: Date | null; targetTaskIds: unknown; result: unknown }>(
        "SELECT \"status\", \"consumedAt\", \"targetTaskIds\", \"result\" FROM \"agent_wait_conditions\" WHERE \"turnId\" = $1 AND \"parentTaskId\" = $2",
        [restartOwner.turnId, rootTaskId],
      )
      const preFinalFollowUpWait = preFinalWaits.rows.find(row => {
        const ids = Array.isArray(row.targetTaskIds) ? row.targetTaskIds : JSON.parse(String(row.targetTaskIds)) as unknown[]
        return ids.includes(preFinalFollowUpId)
      })
      expect(preFinalFollowUpWait).toMatchObject({ status: "ready", consumedAt: expect.any(Date) })
      expect(JSON.stringify(preFinalFollowUpWait?.result)).toContain(RESTART_FOLLOW_UP_GOAL)

      workerTwo.stdin?.write("finalize-parent\n")
      await waitForProcessLine(workerTwo, "P3_FOLLOW_UP_GRAPH_OK ")
      await waitForTurnStatus(pool!, restartOwner.turnId, "completed", 60_000)

      const resumedTurn = await pool!.query<{ status: string; leaseVersion: number; rootTaskId: string | null; finalResponse: string | null }>(
        "SELECT \"status\", \"leaseVersion\", \"rootTaskId\", \"finalResponse\" FROM \"agent_turns\" WHERE \"id\" = $1",
        [restartOwner.turnId],
      )
      expect(resumedTurn.rows[0]).toMatchObject({ status: "completed", leaseVersion: 3, rootTaskId })
      expect(resumedTurn.rows[0]?.finalResponse).toContain("p3-process-restart-parent-resumed-after-follow-up")

      const graphAfterResume = await pool!.query<TaskGraphItemRow>(
        "SELECT \"id\", \"sessionId\", \"turnId\", \"stepId\", \"taskId\", \"type\", \"status\", \"phase\", \"revision\", \"content\", \"startedAt\", \"completedAt\", \"createdAt\", \"updatedAt\" FROM \"agent_items\" WHERE \"sessionId\" = $1 AND \"turnId\" = $2 AND \"taskId\" = $3 AND \"type\" = 'task_graph'",
        [restartOwner.sessionId, restartOwner.turnId, rootTaskId],
      )
      expect(graphAfterResume.rows).toHaveLength(1)
      expect(graphAfterResume.rows[0]?.id).toBe(graphBefore.rows[0]?.id)
      const graphAfterSnapshot = record(graphAfterResume.rows[0]?.content)
      const graphAfterNodes = Array.isArray(graphAfterSnapshot?.nodes) ? graphAfterSnapshot.nodes.map(record) : []
      expect(graphAfterSnapshot?.schemaVersion).toBe("agent-harness.v2.task-graph")
      expect(graphAfterNodes.map(node => node?.key)).toEqual(["source", "summary", RESTART_FOLLOW_UP_KEY])
      expect(graphAfterNodes.slice(0, 2)).toEqual(graphNodes)
      expect(graphAfterNodes[2]).toMatchObject({
        key: RESTART_FOLLOW_UP_KEY,
        templateId: "analyst",
        goal: RESTART_FOLLOW_UP_GOAL,
        successCriteria: ["Verify the restored summary evidence"],
        dependsOn: ["summary"],
        depth: 3,
      })
      expect(graphAfterResume.rows[0]?.revision).toBeGreaterThan(graphBefore.rows[0]!.revision)
      const resumedWaits = await pool!.query<{ id: string; status: string; consumedAt: Date | null; result: unknown; targetTaskIds: unknown }>(
        "SELECT \"id\", \"status\", \"consumedAt\", \"result\", \"targetTaskIds\" FROM \"agent_wait_conditions\" WHERE \"turnId\" = $1 ORDER BY \"createdAt\" ASC",
        [restartOwner.turnId],
      )
      expect(resumedWaits.rows).toHaveLength(2)
      const originalWaitAfterResume = resumedWaits.rows.find(row => row.id === waitsBefore.rows[0]?.id)
      expect(originalWaitAfterResume).toMatchObject({ status: "ready", consumedAt: expect.any(Date) })
      expect(JSON.stringify(originalWaitAfterResume?.result)).toContain("p3-process-restart-source-result")
      const followUpTaskId = graphAfterNodes[2]?.taskId
      expect(typeof followUpTaskId).toBe("string")
      const targetIds = (value: unknown): string[] => {
        if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string")
        try {
          const parsed = JSON.parse(String(value)) as unknown
          return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []
        } catch { return [] }
      }
      const followUpWait = resumedWaits.rows.find(row => targetIds(row.targetTaskIds).includes(String(followUpTaskId)))
      expect(followUpWait).toMatchObject({ status: "ready", consumedAt: expect.any(Date) })
      expect(followUpWait?.id).not.toBe(originalWaitAfterResume?.id)
      expect(JSON.stringify(followUpWait?.result)).toContain(RESTART_FOLLOW_UP_GOAL)
      const childrenAfterResume = await pool!.query<{ id: string; goal: string; status: string; result: RecordValue | null; context: RecordValue | null; role: string }>(
        "SELECT \"id\", \"goal\", \"status\", \"result\", \"context\", \"role\" FROM \"sub_agent_tasks\" WHERE \"turnId\" = $1 AND \"parentTaskId\" = $2 ORDER BY \"goal\"",
        [restartOwner.turnId, rootTaskId],
      )
      expect(childrenAfterResume.rows.map(row => [row.goal, row.status])).toEqual([
        ["Read the durable TaskGraph source", "completed"],
        ["Summarize the restored TaskGraph source", "completed"],
        [RESTART_FOLLOW_UP_GOAL, "completed"],
      ])
      // Match Worker 2's projection query, including its root row and public goal.
      const persistedPlanLedgerTasks = await pool!.query<{
        id: string; sessionId: string; turnId: string | null; rootTaskId: string | null; parentTaskId: string | null
        path: string; role: string; taskType: string; status: string; goal: string; confidence: number | null
        failureReason: string | null; result: RecordValue | null; createdAt: Date; updatedAt: Date
      }>(
        `SELECT "id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "role", "taskType", "status", "goal", "confidence", "failureReason", "result", "createdAt", "updatedAt" FROM "sub_agent_tasks"
         WHERE "sessionId" = $1 AND "turnId" = $2 AND ("id" = $3 OR "parentTaskId" = $3)
         ORDER BY "createdAt" ASC, "id" ASC`,
        [restartOwner.sessionId, restartOwner.turnId, rootTaskId],
      )
      expect(persistedPlanLedgerTasks.rows.map(row => row.id)).toContain(rootTaskId)
      const fixtureLedgerLine = await waitForProcessLine(workerTwo, "P3_PLAN_LEDGER_PROJECTION ")
      const fixtureLedger = parsePlanLedger(fixtureLedgerLine.slice("P3_PLAN_LEDGER_PROJECTION ".length))
      const persistedLedger = projectPlanLedger({
        sessionId: restartOwner.sessionId,
        revision: graphAfterResume.rows[0]!.revision,
        rootTaskId,
        graph: graphAfterResume.rows[0]!.content,
        tasks: persistedPlanLedgerTasks.rows,
      })
      expect(fixtureLedger).not.toBeNull()
      expect(persistedLedger).toEqual(fixtureLedger)
      expect(persistedLedger).toMatchObject({
        schemaVersion: PLAN_LEDGER_SCHEMA_VERSION,
        sessionId: restartOwner.sessionId,
        revision: graphAfterResume.rows[0]!.revision,
        nodes: [
          { key: "source", status: "completed", readiness: "terminal", evidencePreview: { role: "scout", itemCount: 1 } },
          { key: "summary", status: "completed", readiness: "terminal", evidencePreview: { role: "analyst", itemCount: 1 } },
          { key: RESTART_FOLLOW_UP_KEY, status: "completed", readiness: "terminal", evidencePreview: { role: "analyst", itemCount: 1 } },
        ],
      })
      const publicLedgerJson = JSON.stringify(persistedLedger)
      for (const secret of ["fixture-job-restart", "p3-process-restart-source-result", "p3-process-restart-final", "jobId", "score", "url", "task-graph.result-projection"]) {
        expect(publicLedgerJson).not.toContain(secret)
      }
      expect(parsePlanLedger(publicLedgerJson)).toEqual(persistedLedger)
      expect(JSON.stringify(childrenAfterResume.rows[0]?.result)).toContain("p3-process-restart-source-result")
      const followUpChild = childrenAfterResume.rows.find(row => row.id === followUpTaskId)
      expect(followUpChild).toMatchObject({ goal: RESTART_FOLLOW_UP_GOAL, status: "completed", role: "analyst" })
      expect(JSON.stringify(followUpChild?.result)).toContain(RESTART_FOLLOW_UP_GOAL)
      const followUpDependency = record(record(followUpChild?.context)?.taskGraphDependencyResults)
      const followUpDependencyItems = Array.isArray(followUpDependency?.items) ? followUpDependency.items.map(record) : []
      expect(followUpDependencyItems[0]).toMatchObject({
        dependencyKey: "summary",
        role: "analyst",
        taskStatus: "completed",
        result: {
          schemaVersion: "agent-harness.v2.task-graph.result-projection",
          trust: "untrusted",
          availability: "available",
          role: "analyst",
          findings: [{ jobId: "fixture-job-restart", score: 8, evidenceKinds: ["job"] }],
        },
      })
      const graphEvents = await pool!.query<{
        id: string; sessionId: string; turnId: string; itemId: string | null; taskId: string | null
        sequence: string | bigint; type: string; actor: string; correlationId: string
        causationId: string | null; idempotencyKey: string | null; payload: RecordValue
      }>(
        "SELECT \"id\", \"sessionId\", \"turnId\", \"itemId\", \"taskId\", \"sequence\", \"type\", \"actor\", \"correlationId\", \"causationId\", \"idempotencyKey\", \"payload\" FROM \"agent_events\" WHERE \"sessionId\" = $1 AND \"turnId\" = $2 AND \"itemId\" = $3 ORDER BY \"sequence\"",
        [restartOwner.sessionId, restartOwner.turnId, graphAfterResume.rows[0]!.id],
      )
      const proposalEvents = graphEvents.rows.filter(event => record(event.payload)?.kind === "proposal")
      expect(proposalEvents).toHaveLength(2)
      const followUpReceiptEvent = proposalEvents[1]!
      const followUpReceiptPayload = record(followUpReceiptEvent.payload)
      const followUpReceipt = record(followUpReceiptPayload?.receipt)
      expect(followUpReceipt).toMatchObject({
        status: "accepted",
        nodes: [{ key: RESTART_FOLLOW_UP_KEY, taskId: followUpTaskId, status: "queued" }],
        readyTaskIds: [followUpTaskId],
      })
      const proposalKeyPrefix = graphAfterResume.rows[0]!.id + ":proposal:"
      const followUpIdempotencyKey = followUpReceiptEvent.idempotencyKey
      if (!followUpIdempotencyKey) throw new Error("Persisted follow-up proposal event has no idempotency key.")
      expect(followUpIdempotencyKey.startsWith(proposalKeyPrefix)).toBe(true)
      const expectedRevision = Number(followUpIdempotencyKey.slice(proposalKeyPrefix.length))
      expect(Number.isSafeInteger(expectedRevision)).toBe(true)
      expect(followUpReceiptPayload?.revision).toBe(expectedRevision + 1)
      expect(expectedRevision).toBeGreaterThan(graphBefore.rows[0]!.revision)
      const followUpLifecycle = graphEvents.rows.flatMap(event => {
        if (event.taskId !== followUpTaskId) return []
        const payload = record(event.payload)
        const lifecycle = record(payload?.event)
        return payload?.kind === "lifecycle" && lifecycle?.nodeKey === RESTART_FOLLOW_UP_KEY
          && typeof lifecycle.type === "string" ? [lifecycle.type] : []
      })
      expect(followUpLifecycle).toEqual(expect.arrayContaining(["task.started", "task.completed"]))
      const initialGraphRevision = graphBefore.rows[0]!.revision
      const persistedGraphDeltas = graphEvents.rows.filter(event => {
        const payload = record(event.payload)
        const item = record(payload?.item)
        return event.type === "item.delta"
          && typeof item?.revision === "number" && Number.isSafeInteger(item.revision)
          && item.revision > initialGraphRevision
      })
      const persistedGraphRevisions = persistedGraphDeltas.map(event => Number(record(record(event.payload)?.item)?.revision))
      expect(persistedGraphRevisions).toEqual(Array.from(
        { length: graphAfterResume.rows[0]!.revision - initialGraphRevision },
        (_, index) => initialGraphRevision + index + 1,
      ))
      expect(persistedGraphDeltas.every(event => {
        const payload = record(event.payload)
        return payload !== null && payload.revision === record(payload.item)?.revision
      })).toBe(true)
      expect(persistedGraphDeltas.length).toBeGreaterThan(0)
      const finalGraphDelta = persistedGraphDeltas[persistedGraphDeltas.length - 1]!
      const finalGraphDeltaPayload = record(finalGraphDelta.payload)
      const finalGraphDeltaItem = record(finalGraphDeltaPayload?.item)
      if (typeof rootTaskId !== "string") throw new Error("Restarted TaskGraph has no root task ID.")
      let expectedFinalGraphEventTaskId: string
      if (finalGraphDeltaPayload?.kind === "proposal") {
        expectedFinalGraphEventTaskId = rootTaskId
      } else if (finalGraphDeltaPayload?.kind === "lifecycle") {
        const lifecycle = record(finalGraphDeltaPayload.event)
        const lifecycleNode = graphAfterNodes.find(node => node?.key === lifecycle?.nodeKey)
        if (typeof lifecycleNode?.taskId !== "string") throw new Error("Final TaskGraph lifecycle event has no matching node task.")
        expectedFinalGraphEventTaskId = lifecycleNode.taskId
      } else {
        throw new Error("Final TaskGraph delta has an unknown event kind.")
      }
      expect(finalGraphDelta).toMatchObject({
        type: "item.delta",
        sessionId: restartOwner.sessionId,
        turnId: restartOwner.turnId,
        itemId: graphAfterResume.rows[0]!.id,
        taskId: expectedFinalGraphEventTaskId,
      })
      expect(finalGraphDeltaPayload?.revision).toBe(graphAfterResume.rows[0]!.revision)
      expect(finalGraphDeltaItem).toMatchObject({
        id: graphAfterResume.rows[0]!.id,
        sessionId: restartOwner.sessionId,
        turnId: restartOwner.turnId,
        taskId: rootTaskId,
        revision: graphAfterResume.rows[0]!.revision,
        content: graphAfterResume.rows[0]!.content,
      })
      const graphDeltaSequences = persistedGraphDeltas.map(event => event.sequence.toString())
      expect(graphDeltaSequences.every(sequence => /^(0|[1-9]\d*)$/.test(sequence))).toBe(true)
      for (let index = 1; index < graphDeltaSequences.length; index += 1) {
        expect(BigInt(graphDeltaSequences[index]!)).toBeGreaterThan(BigInt(graphDeltaSequences[index - 1]!))
      }
      const resumedEvents = await pool!.query<{ count: string }>(
        "SELECT COUNT(*)::text AS \"count\" FROM \"agent_events\" WHERE \"sessionId\" = $1 AND \"idempotencyKey\" = $2",
        [restartOwner.sessionId, "agent-wait:" + waitsBefore.rows[0]!.id + ":resumed"],
      )
      expect(resumedEvents.rows[0]?.count).toBe("1")
      const followUpResumedEvents = await pool!.query<{ count: string }>(
        "SELECT COUNT(*)::text AS \"count\" FROM \"agent_events\" WHERE \"sessionId\" = $1 AND \"idempotencyKey\" = $2",
        [restartOwner.sessionId, "agent-wait:" + followUpWait?.id + ":resumed"],
      )
      expect(followUpResumedEvents.rows[0]?.count).toBe("1")
      if (planLedgerTraceArtifactPath) {
        if (!persistedLedger) throw new Error("Cannot export a missing persisted PlanLedger.")
        expect(Buffer.byteLength(publicLedgerJson, "utf8")).toBeLessThanOrEqual(16_000)
        const graphItem = graphAfterResume.rows[0]!
        const graphSnapshot = record(graphItem.content)
        const graphNodes = Array.isArray(graphSnapshot?.nodes) ? graphSnapshot.nodes.map(record) : []
        const taskRouteRows = persistedPlanLedgerTasks.rows.map(row => {
          const evidencePreview = projectTaskEvidencePreview(row)
          return {
            schemaVersion,
            id: row.id,
            sessionId: row.sessionId,
            turnId: row.turnId,
            rootTaskId: row.rootTaskId,
            parentTaskId: row.parentTaskId,
            path: row.path,
            role: row.role,
            taskType: row.taskType,
            status: row.status === "completed" ? "passed" : row.status,
            goal: row.goal,
            confidence: row.confidence,
            failureReason: row.failureReason,
            hasResult: row.result !== null,
            ...(evidencePreview ? { structuredEvidencePreview: evidencePreview } : {}),
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
          }
        })
        expect(graphItem.sessionId).toBe(restartOwner.sessionId)
        expect(graphItem.turnId).toBe(restartOwner.turnId)
        expect(graphItem.taskId).toBe(rootTaskId)
        expect(graphItem.revision).toBe(persistedLedger.revision)
        expect(taskRouteRows.map(row => row.id).sort()).toEqual([
          rootTaskId,
          ...graphNodes.map(node => String(node?.taskId)),
        ].sort())
        expect(taskRouteRows.every(row => row.sessionId === restartOwner.sessionId
          && row.turnId === restartOwner.turnId && row.rootTaskId === rootTaskId)).toBe(true)
        expect(taskRouteRows.find(row => row.id === rootTaskId)?.parentTaskId).toBeNull()
        expect(taskRouteRows.every(row => !("result" in row))).toBe(true)
        const toGraphItemDto = (row: TaskGraphItemRow) => ({
          schemaVersion,
          id: row.id,
          sessionId: row.sessionId,
          turnId: row.turnId,
          stepId: row.stepId,
          taskId: row.taskId,
          type: row.type,
          status: row.status,
          phase: row.phase,
          revision: row.revision,
          content: row.content,
          startedAt: row.startedAt?.toISOString() ?? null,
          completedAt: row.completedAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        })
        const traceEnvelope = {
          schemaVersion: "agent-harness.v2.plan-ledger-trace",
          planLedger: persistedLedger,
          rootTaskId,
          graphItem: toGraphItemDto(graphItem),
          initialGraphItem: toGraphItemDto(graphBefore.rows[0]!),
          graphEvents: persistedGraphDeltas.map(durableGraphEvent => ({
            schemaVersion,
            id: durableGraphEvent.id,
            sessionId: durableGraphEvent.sessionId,
            turnId: durableGraphEvent.turnId,
            itemId: durableGraphEvent.itemId,
            taskId: durableGraphEvent.taskId,
            type: durableGraphEvent.type,
            actor: durableGraphEvent.actor,
            correlationId: durableGraphEvent.correlationId,
            causationId: durableGraphEvent.causationId,
            idempotencyKey: durableGraphEvent.idempotencyKey,
            sequence: durableGraphEvent.sequence.toString(),
            payload: durableGraphEvent.payload,
          })),
          tasks: taskRouteRows,
        }
        const traceEnvelopeJson = JSON.stringify(traceEnvelope)
        expect(Buffer.byteLength(traceEnvelopeJson, "utf8")).toBeLessThanOrEqual(64_000)
        await writeFile(planLedgerTraceArtifactPath, traceEnvelopeJson, "utf8")
      }
    } finally {
      const teardownFailures: string[] = []
      if (workerOne && !processFixtureExited(workerOne)) {
        try { await killProcessFixture(workerOne) } catch (error) { teardownFailures.push("Worker 1: " + String(error)) }
      }
      if (workerTwo) {
        try { await stopProcessFixture(workerTwo) } catch (error) { teardownFailures.push("Worker 2: " + String(error)) }
      }
      if (teardownFailures.length > 0) throw new Error("P3 Worker process teardown failed:\n" + teardownFailures.join("\n"))
    }
  }, 240_000)

  it("cancels a dependent node after prerequisite failure without dispatching it", async () => {
    const [
      { createProductionWorkerBootstrap },
      { createTurnQueue, enqueueTurn, TURN_QUEUE_NAME },
      subagentQueue,
      { createCanonicalTurnRuntime },
      { createPgTaskGraphCommandPort },
      { taskGraphItemId },
    ] = await Promise.all([
      import("../../queue/production-bootstrap.js"),
      import("../turns/turn-queue.js"),
      import("../../queue/subagent-queue.js"),
      import("../canonical-turn-runtime.js"),
      import("./pg-task-graph-command-port.js"),
      import("./task-graph-snapshot.js"),
    ])
    turnQueueName = TURN_QUEUE_NAME
    childQueueName = subagentQueue.SUBAGENT_QUEUE_NAME
    const flags: ProductionAgentFlags = {
      cognitiveLoopEnabled: false,
      planningEnabled: true,
      planningExecutionEnabled: true,
      taskGraphPlanningEnabled: true,
      childExecutionEnabled: true,
      coordinationEnabled: true,
      consumeWaitOutcomes: true,
      canonicalAutomationEnabled: false,
    }
    let rootRuntimeExecutions = 0
    let descendantExecuted = false
    let resumedAfterFailure = false
    let failurePreflightStage = "not_started"
    let failurePreflightError: string | null = null
    let failureWaitHandoffFailure: string | null = null
    const runtime = await createCanonicalTurnRuntime(pool!, {
      workerId: failureOwner.ownerId,
      productionFlags: flags,
      taskGraphCommandPort: createPgTaskGraphCommandPort(pool!),
      taskGraphTemplates: {
        analyst: { role: "analyst", taskType: "research", allowedActions: ["jobs.search"] },
      },
      authorizeUsage: async () => ({ settle: async () => undefined }),
      modelRuntimeFactory: () => {
        const execution = ++rootRuntimeExecutions
        let modelRounds = 0
        const model: ModelAdapter = {
          id: "p3-task-graph-failure-fixture-model",
          profile: {
            provider: "fixture", model: "fixture-model", nativeTools: true, structuredOutput: true, streaming: true,
            continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: false,
            supportsReasoningSummary: false, supportsResponseContinuation: false, supportsProviderConversation: false,
            supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: 128, costClass: "low",
          },
          async *stream(request) {
            modelRounds += 1
            if (execution === 1 && modelRounds === 1) {
              expect(request.tools.map(tool => record(tool)?.name)).toContain("agent.plan")
              yield {
                type: "tool_call_completed", callId: FAILURE_PLAN_CALL_ID, name: "agent.plan",
                arguments: {
                  expectedRevision: 0,
                  nodes: [
                    { key: "prerequisite", templateId: "analyst", goal: FAILURE_GOAL, successCriteria: ["Record a terminal failure"], dependsOn: [] },
                    { key: "dependent", templateId: "analyst", goal: BLOCKED_GOAL, successCriteria: ["Do not execute after source failure"], dependsOn: ["prerequisite"] },
                  ],
                },
              }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            if (execution === 1 && modelRounds === 2) {
              try {
                failurePreflightStage = "plan_receipt"
                failurePreflightError = null
                const receiptTaskIds = planTaskIds(request, FAILURE_PLAN_CALL_ID)
                failurePreflightStage = "root_task_lookup"
                const fixtureTurn = await pool!.query<{ rootTaskId: string | null }>(
                  `SELECT "rootTaskId" FROM "agent_turns"
                   WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`,
                  [failureOwner.turnId, failureOwner.sessionId, failureOwner.userId],
                )
                const fixtureRootTaskId = fixtureTurn.rows[0]?.rootTaskId
                if (!fixtureRootTaskId) {
                  throw new Error("Failed-prerequisite fixture assertion: current root task is missing from agent_turns")
                }
                const coordinationStore = new PgCoordinationStore(pool!)
                for (const [index, taskId] of receiptTaskIds.entries()) {
                  failurePreflightStage = `lineage_lookup_${index + 1}`
                  const target = await coordinationStore.getTask({
                    userId: failureOwner.userId, sessionId: failureOwner.sessionId, taskId,
                  })
                  if (!target) {
                    const scopedTask = await pool!.query<{
                      sessionId: string | null; turnId: string | null; rootTaskId: string | null; sessionUserId: string | null
                    }>(`SELECT task."sessionId", task."turnId", task."rootTaskId", session."userId" AS "sessionUserId"
                      FROM "sub_agent_tasks" AS task LEFT JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
                      WHERE task."id" = $1 LIMIT 1`, [taskId])
                    const observed = scopedTask.rows[0]
                    const diagnostic = boundedDiagnostic(JSON.stringify({
                      task: observed ? {
                        sessionId: observed.sessionId, turnId: observed.turnId,
                        rootTaskId: observed.rootTaskId, sessionUserId: observed.sessionUserId,
                      } : null,
                      expected: {
                        sessionId: failureOwner.sessionId, turnId: failureOwner.turnId, userId: failureOwner.userId,
                      },
                    }), 700)
                    throw new Error(`Failed-prerequisite fixture assertion: plan receipt target ${taskId} is missing from PgCoordinationStore.getTask; scope=${diagnostic}`)
                  }
                  failurePreflightStage = `lineage_assertion_${index + 1}`
                  expect({
                    id: target.id, turnId: target.turnId, rootTaskId: target.rootTaskId, parentTaskId: target.parentTaskId,
                  }, `Failed-prerequisite fixture assertion: plan receipt target ${taskId} has unexpected lineage`).toEqual({
                    id: taskId, turnId: failureOwner.turnId, rootTaskId: fixtureRootTaskId, parentTaskId: fixtureRootTaskId,
                  })
                }
                failurePreflightStage = "agent.wait_tool_availability"
                expect(request.tools.map(tool => record(tool)?.name)).toContain("agent.wait")
                failurePreflightStage = "preflight_passed"
              } catch (error: unknown) {
                failurePreflightError = (error instanceof Error ? error.message : String(error)).slice(0, 500)
                throw error
              }
              yield {
                type: "tool_call_completed", callId: FAILURE_WAIT_CALL_ID, name: "agent.wait",
                arguments: {
                  idempotencyKey: `p3-task-graph-failure-wait:${failureOwner.turnId}`,
                  taskIds: planTaskIds(request, FAILURE_PLAN_CALL_ID), mode: "all", timeoutMs: 20_000,
                },
              }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            if (execution === 2 && modelRounds === 1) {
              const graph = currentGraphFromRequest(request)
              const nodes = Array.isArray(graph?.nodes) ? graph.nodes.map(record) : []
              expect(nodes.map(node => [node?.key, node?.status])).toEqual([
                ["prerequisite", "failed"], ["dependent", "cancelled"],
              ])
              const outcome = waitOutcomeFromRequest(request, 2)
              expect(outcome.status).toBe("ready")
              expect(outcome.tasks.map(task => record(task)?.status).sort()).toEqual(["cancelled", "failed"])
              resumedAfterFailure = true
              yield { type: "text_delta", text: FAILURE_FINAL_MARKER }
              yield { type: "completed", finishReason: "stop" }
              return
            }
            throw new Error("Unexpected model execution or round in the failed-prerequisite fixture")
          },
        }
        return { adapter: model, registry: {} as never, candidates: [] }
      },
    })
    await activateFixtureTurn(pool!, failureOwner)
    bootstrap = await createProductionWorkerBootstrap({
      pool: pool!,
      runtime,
      ownerId: failureOwner.ownerId,
      turnQueueFactory: withWaitHandoffDiagnostics(pool!, createTurnQueue, diagnostic => {
        failureWaitHandoffFailure = diagnostic
      }),
      // The resume intent is durably queued by the wait resolver and delivered
      // by turn recovery; poll promptly so this acceptance does not outwait it.
      turnRecoveryIntervalMs: 100,
      waitResolver: { intervalMs: 10, batchSize: 10, ownerId: `p3-failure-wait-resolver-${failureOwner.suffix}` },
      subagents: {
        intervalMs: 10,
        async execute({ lease }) {
          await waitForSuspendedParent(pool!, failureOwner.turnId)
          if (lease.goal === FAILURE_GOAL) {
            return { status: "failed", failureReason: "Fixture prerequisite failed permanently.", retryDisposition: "terminal" }
          }
          if (lease.goal === BLOCKED_GOAL) descendantExecuted = true
          return { status: "completed", result: { proof: `unexpected execution: ${lease.goal}` } }
        },
      },
    })

    await enqueueTurn(pool!, bootstrap.turns.queue, {
      turnId: failureOwner.turnId, sessionId: failureOwner.sessionId, ownerId: failureOwner.ownerId,
    })
    try {
      await waitForTurnStatus(pool!, failureOwner.turnId, "completed", 50_000, FAILURE_WAIT_CALL_ID)
    } catch (error: unknown) {
      const diagnostic = boundedDiagnostic(JSON.stringify({ stage: failurePreflightStage, error: failurePreflightError }), 700)
      const progress = await turnProgressDiagnostics(pool!, failureOwner.turnId, FAILURE_WAIT_CALL_ID)
      throw new Error(combineFailureDiagnostics([
        { label: "failedPrerequisitePreflight", value: diagnostic },
        { label: "waitHandoffFailure", value: failureWaitHandoffFailure ?? "<not captured>" },
        { label: "turnFailure", value: waitTurnFailureSummary(error) },
      ], progress))
    }

    const turn = await pool!.query<{ rootTaskId: string; finalResponse: string | null }>(
      `SELECT "rootTaskId", "finalResponse" FROM "agent_turns" WHERE "id" = $1`, [failureOwner.turnId],
    )
    const rootTaskId = turn.rows[0]?.rootTaskId
    expect(rootTaskId).toBeTruthy()
    expect(rootRuntimeExecutions).toBe(2)
    expect(resumedAfterFailure).toBe(true)
    expect(descendantExecuted).toBe(false)
    expect(turn.rows[0]?.finalResponse).toContain(FAILURE_FINAL_MARKER)

    const children = await pool!.query<{ id: string; goal: string; status: string }>(
      `SELECT "id", "goal", "status" FROM "sub_agent_tasks"
       WHERE "sessionId" = $1 AND "turnId" = $2 AND "parentTaskId" = $3 ORDER BY "id"`,
      [failureOwner.sessionId, failureOwner.turnId, rootTaskId],
    )
    expect(children.rows).toHaveLength(2)
    const prerequisite = children.rows.find(child => child.goal === FAILURE_GOAL)
    const dependent = children.rows.find(child => child.goal === BLOCKED_GOAL)
    expect(prerequisite?.status).toBe("failed")
    expect(dependent?.status).toBe("cancelled")

    const graphItemId = taskGraphItemId(rootTaskId!)
    const cancellationEvidence = await pool!.query<{ itemId: string; taskId: string; payload: RecordValue }>(
      `SELECT "itemId", "taskId", "payload" FROM "agent_events"
       WHERE "sessionId" = $1 AND "turnId" = $2 AND "itemId" = $3 AND "taskId" = $4`,
      [failureOwner.sessionId, failureOwner.turnId, graphItemId, dependent?.id],
    )
    expect(cancellationEvidence.rows).toHaveLength(1)
    expect(cancellationEvidence.rows[0]).toMatchObject({
      itemId: graphItemId,
      taskId: dependent?.id,
      payload: { kind: "lifecycle", event: { type: "task.cancelled", nodeKey: "dependent" } },
    })
    const descendantDispatch = await pool!.query(
      `SELECT 1 FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" = 'agent.subagent.dispatch'
       AND "idempotencyKey" = $2`,
      [failureOwner.sessionId, `subagent-dispatch:${dependent?.id}`],
    )
    expect(descendantDispatch.rowCount).toBe(0)
  }, 90_000)

  it("stops an exact TaskGraph Turn, projects interrupted receipts, and removes every unpublished graph dispatch", async () => {
    const { taskGraphItemId } = await import("./task-graph-snapshot.js")
    const rootTaskId = "p3-task-graph-stop-root-" + stopOwner.suffix
    const stepId = "p3-task-graph-stop-step-" + stopOwner.suffix
    const runningOwnerId = "p3-task-graph-stop-child-owner-" + stopOwner.suffix
    const now = new Date()
    const unrelatedTurnBefore = await pool!.query<{ status: string; revision: number }>(
      `SELECT "status", "revision" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`,
      [owner.turnId, owner.sessionId, owner.userId],
    )
    expect(unrelatedTurnBefore.rowCount).toBe(1)
    await activateFixtureTurn(pool!, stopOwner)

    await pool!.query(`INSERT INTO "sub_agent_tasks"
      ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
       "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot",
       "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "leaseOwner", "leaseExpiresAt", "updatedAt")
      VALUES ($1, $2, $3, NULL, NULL, '/root', 0, 'orchestrator', 'root', 'running', 'Stop acceptance root',
        '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
        '{"subagentPolicy":{"maxConcurrency":8,"maxDepth":8,"maxFanOut":8,"maxAttempts":2}}'::jsonb,
        1, 2, $4, CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP)`,
    [rootTaskId, stopOwner.sessionId, stopOwner.turnId, stopOwner.ownerId])
    await pool!.query(`UPDATE "sub_agent_tasks" SET "rootTaskId" = $1 WHERE "id" = $1`, [rootTaskId])
    const activeTurn = await pool!.query<{ revision: number }>(
      `UPDATE "agent_turns" SET "status" = 'in_progress', "rootTaskId" = $4, "leaseOwnerId" = $5,
        "leaseExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '5 minutes', "leaseStartedAt" = CURRENT_TIMESTAMP,
        "leaseVersion" = 1, "updatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "status" = 'queued'
       RETURNING "revision"`,
      [stopOwner.turnId, stopOwner.sessionId, stopOwner.userId, rootTaskId, stopOwner.ownerId],
    )
    expect(activeTurn.rowCount).toBe(1)
    await pool!.query(`INSERT INTO "agent_steps"
      ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
      VALUES ($1, $2, $3, $4, 1, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb)`,
    [stepId, stopOwner.sessionId, stopOwner.turnId, rootTaskId])

    const commandPort = createPgTaskGraphCommandPort(pool!)
    const receipt = await commandPort.appendAndSchedule({
      scope: {
        userId: stopOwner.userId, sessionId: stopOwner.sessionId, turnId: stopOwner.turnId,
        rootTaskId, parentTaskId: rootTaskId, stepId,
        turnLeaseOwner: stopOwner.ownerId, turnLeaseVersion: 1,
        parentLeaseOwner: stopOwner.ownerId, parentAttemptCount: 1,
      },
      proposal: {
        expectedRevision: 0,
        nodes: [
          { key: "running", templateId: "analyst", goal: "Run until the Turn is stopped", successCriteria: ["Observe the Stop marker"], dependsOn: [] },
          { key: "pending-root", templateId: "analyst", goal: "Start a pending dependency chain", successCriteria: ["Remain queued"], dependsOn: [] },
          { key: "pending-child", templateId: "analyst", goal: "Wait for the chain root", successCriteria: ["Remain waiting"], dependsOn: ["pending-root"] },
          { key: "pending-grandchild", templateId: "analyst", goal: "Wait for the chain child", successCriteria: ["Remain waiting"], dependsOn: ["pending-child"] },
        ],
      },
      templates: { analyst: { role: "analyst", taskType: "research", allowedActions: [] } },
    })
    expect(receipt.status).toBe("accepted")
    expect(receipt.nodes.map(node => [node.key, node.status])).toEqual([
      ["running", "queued"], ["pending-root", "queued"], ["pending-child", "waiting"], ["pending-grandchild", "waiting"],
    ])
    const graphTaskIds = receipt.nodes.map(node => node.taskId)
    const taskIdByKey = new Map(receipt.nodes.map(node => [node.key, node.taskId] as const))

    const subagents = new PgSubagentTaskStore(pool!)
    const runningTask = await subagents.claim({
      taskId: taskIdByKey.get("running")!, sessionId: stopOwner.sessionId, ownerId: runningOwnerId,
      policy: { maxConcurrency: 8, maxDepth: 8, maxFanOut: 8, maxAttempts: 2 }, now,
    })
    expect(runningTask).toMatchObject({ status: "running", attemptCount: 1, leaseOwner: runningOwnerId })

    const unrelatedOutboxIds = [
      "p3-stop-unrelated-same-session-" + stopOwner.suffix,
      "p3-stop-unrelated-other-session-" + stopOwner.suffix,
    ]
    await pool!.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
      VALUES ($1, 'agent.subagent.dispatch', $2, $3, $4::jsonb), ($5, 'agent.subagent.dispatch', $6, $7, $8::jsonb)`,
    [
      unrelatedOutboxIds[0], stopOwner.sessionId, "subagent-dispatch:unrelated-" + stopOwner.suffix,
      JSON.stringify({ taskId: "unrelated-" + stopOwner.suffix, sessionId: stopOwner.sessionId, rootTaskId, ownerId: "fixture-owner" }),
      unrelatedOutboxIds[1], owner.sessionId, "subagent-dispatch:unrelated-other-" + stopOwner.suffix,
      JSON.stringify({ taskId: "unrelated-other-" + stopOwner.suffix, sessionId: owner.sessionId, rootTaskId: "other-root", ownerId: "fixture-owner" }),
    ])

    const client = await pool!.connect()
    const requestedAt = new Date()
    let priorTurnRevision = 0
    try {
      await client.query("BEGIN")
      await client.query("SELECT set_config('app.user_id', $1, true)", [stopOwner.userId])
      const current = await client.query<{ revision: number }>(
        `SELECT "revision" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 FOR UPDATE`,
        [stopOwner.turnId, stopOwner.sessionId, stopOwner.userId],
      )
      expect(current.rowCount).toBe(1)
      priorTurnRevision = Number(current.rows[0]?.revision)
      const interruptedTurn = await client.query(
        `UPDATE "agent_turns" SET "status" = 'interrupted', "revision" = "revision" + 1,
          "completedAt" = $5, "updatedAt" = $5
         WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3
           AND "status" IN ('queued', 'in_progress', 'waiting_for_dependency', 'waiting_for_approval', 'waiting_for_user')
           AND "revision" = $4`,
        [stopOwner.turnId, stopOwner.sessionId, stopOwner.userId, priorTurnRevision, requestedAt],
      )
      expect(interruptedTurn.rowCount).toBe(1)
      const markedTasks = await client.query<{ id: string; status: string; interruptRequestedAt: Date | null }>(
        `UPDATE "sub_agent_tasks" AS task
         SET "interruptRequestedAt" = COALESCE(task."interruptRequestedAt", $4),
             "status" = CASE WHEN task."status" IN ('queued', 'retrying', 'waiting', 'waiting_for_user') THEN 'interrupted' ELSE task."status" END,
             "nextAttemptAt" = CASE WHEN task."status" IN ('queued', 'retrying', 'waiting', 'waiting_for_user') THEN NULL ELSE task."nextAttemptAt" END,
             "completedAt" = CASE WHEN task."status" IN ('queued', 'retrying', 'waiting', 'waiting_for_user') THEN $4 ELSE task."completedAt" END,
             "updatedAt" = $4
         WHERE task."sessionId" = $1 AND task."turnId" = $2
           AND task."status" IN ('queued', 'running', 'retrying', 'waiting', 'waiting_for_user')
           AND EXISTS (SELECT 1 FROM "agent_sessions" AS session
             WHERE session."id" = task."sessionId" AND session."userId" = $3)
           AND EXISTS (SELECT 1 FROM "agent_turns" AS turn
             WHERE turn."id" = task."turnId" AND turn."sessionId" = task."sessionId" AND turn."userId" = $3)
         RETURNING task."id", task."status", task."interruptRequestedAt"`,
        [stopOwner.sessionId, stopOwner.turnId, stopOwner.userId, requestedAt],
      )
      expect(markedTasks.rows).toHaveLength(graphTaskIds.length + 1)
      const stopIntent = await client.query<{ id: string; topic: string; aggregateId: string; idempotencyKey: string; payload: RecordValue }>(
        `INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
         VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT ("idempotencyKey") DO NOTHING
         RETURNING "id", "topic", "aggregateId", "idempotencyKey", "payload"`,
        [
          "task-graph-stop-" + stopOwner.turnId, TASK_GRAPH_STOP_OUTBOX_TOPIC, stopOwner.sessionId,
          "agent-task-graph-stop:" + stopOwner.sessionId + ":" + stopOwner.turnId,
          JSON.stringify({ sessionId: stopOwner.sessionId, turnId: stopOwner.turnId }),
        ],
      )
      expect(stopIntent.rows).toEqual([{
        id: "task-graph-stop-" + stopOwner.turnId,
        topic: TASK_GRAPH_STOP_OUTBOX_TOPIC,
        aggregateId: stopOwner.sessionId,
        idempotencyKey: "agent-task-graph-stop:" + stopOwner.sessionId + ":" + stopOwner.turnId,
        payload: { sessionId: stopOwner.sessionId, turnId: stopOwner.turnId },
      }])
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined)
      throw error
    } finally {
      client.release()
    }

    expect(await drainTaskGraphStopOutbox(pool!, 10)).toBe(1)
    const stopIntentState = await pool!.query<{ topic: string; aggregateId: string; idempotencyKey: string; payload: RecordValue; publishedAt: Date | null }>(
      `SELECT "topic", "aggregateId", "idempotencyKey", "payload", "publishedAt" FROM "agent_outbox"
       WHERE "id" = $1`,
      ["task-graph-stop-" + stopOwner.turnId],
    )
    expect(stopIntentState.rows[0]).toMatchObject({
      topic: TASK_GRAPH_STOP_OUTBOX_TOPIC,
      aggregateId: stopOwner.sessionId,
      idempotencyKey: "agent-task-graph-stop:" + stopOwner.sessionId + ":" + stopOwner.turnId,
      payload: { sessionId: stopOwner.sessionId, turnId: stopOwner.turnId },
      publishedAt: expect.any(Date),
    })

    expect(runningTask).not.toBeNull()
    await expect(subagents.heartbeat({
      taskId: runningTask!.id, sessionId: stopOwner.sessionId, ownerId: runningOwnerId,
      attemptCount: runningTask!.attemptCount, now: new Date(),
    })).resolves.toBe("interrupted")
    await expect(subagents.finish({
      taskId: runningTask!.id, sessionId: stopOwner.sessionId, ownerId: runningOwnerId,
      attemptCount: runningTask!.attemptCount, status: "completed", result: { proof: "stop marker observed" }, now: new Date(),
    })).resolves.toBe("interrupted")

    const turn = await pool!.query<{ status: string; revision: number }>(
      `SELECT "status", "revision" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`,
      [stopOwner.turnId, stopOwner.sessionId, stopOwner.userId],
    )
    expect(turn.rows[0]).toEqual({ status: "interrupted", revision: priorTurnRevision + 1 })
    const stoppedTasks = await pool!.query<{ id: string; status: string; interruptRequestedAt: Date | null }>(
      `SELECT "id", "status", "interruptRequestedAt" FROM "sub_agent_tasks"
       WHERE "id" = ANY($1::text[]) AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4 AND "parentTaskId" = $4
       ORDER BY "id"`,
      [graphTaskIds, stopOwner.sessionId, stopOwner.turnId, rootTaskId],
    )
    expect(stoppedTasks.rows).toHaveLength(graphTaskIds.length)
    expect(stoppedTasks.rows.every(task => task.status === "interrupted" && task.interruptRequestedAt instanceof Date)).toBe(true)
    const rootMarker = await pool!.query<{ status: string; interruptRequestedAt: Date | null }>(
      `SELECT "status", "interruptRequestedAt" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3`,
      [rootTaskId, stopOwner.sessionId, stopOwner.turnId],
    )
    expect(rootMarker.rows[0]?.status).toBe("running")
    expect(rootMarker.rows[0]?.interruptRequestedAt).toBeInstanceOf(Date)
    const unrelatedTurnAfter = await pool!.query<{ status: string; revision: number }>(
      `SELECT "status", "revision" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`,
      [owner.turnId, owner.sessionId, owner.userId],
    )
    expect(unrelatedTurnAfter.rows).toEqual(unrelatedTurnBefore.rows)

    const graphItemId = taskGraphItemId(rootTaskId)
    const graphItem = await pool!.query<{ revision: number }>(
      `SELECT "revision" FROM "agent_items" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "taskId" = $4 AND "type" = 'task_graph'`,
      [graphItemId, stopOwner.sessionId, stopOwner.turnId, rootTaskId],
    )
    expect(graphItem.rows[0]?.revision).toBe(receipt.revision + 1 + graphTaskIds.length)
    const graphEvents = await pool!.query<{ taskId: string | null; idempotencyKey: string; payload: RecordValue }>(
      `SELECT "taskId", "idempotencyKey", "payload" FROM "agent_events"
       WHERE "sessionId" = $1 AND "turnId" = $2 AND "itemId" = $3 AND "type" = 'item.delta'
       ORDER BY "sequence" ASC`,
      [stopOwner.sessionId, stopOwner.turnId, graphItemId],
    )
    const interruptedReceipts = graphEvents.rows.flatMap(row => {
      const payload = record(row.payload)
      const event = record(payload?.event)
      return payload?.kind === "lifecycle" && event?.type === "task.interrupted"
        ? [{ taskId: row.taskId, idempotencyKey: row.idempotencyKey, revision: payload.revision, expectedRevision: event.expectedRevision, nodeKey: event.nodeKey }]
        : []
    })
    expect(interruptedReceipts).toHaveLength(graphTaskIds.length)
    expect(interruptedReceipts.map(receipt => receipt.nodeKey)).toEqual(["pending-root", "pending-child", "pending-grandchild", "running"])
    expect(interruptedReceipts.map(receipt => receipt.expectedRevision)).toEqual([
      receipt.revision + 1, receipt.revision + 2, receipt.revision + 3, receipt.revision + 4,
    ])
    expect(interruptedReceipts.map(receipt => receipt.revision)).toEqual([
      receipt.revision + 2, receipt.revision + 3, receipt.revision + 4, receipt.revision + 5,
    ])
    expect(interruptedReceipts.map(receipt => receipt.idempotencyKey)).toEqual([
      taskGraphLifecycleKey(rootTaskId, "pending-root", 0, "task.interrupted"),
      taskGraphLifecycleKey(rootTaskId, "pending-child", 0, "task.interrupted"),
      taskGraphLifecycleKey(rootTaskId, "pending-grandchild", 0, "task.interrupted"),
      taskGraphLifecycleKey(rootTaskId, "running", 1, "task.interrupted"),
    ])

    const graphDispatches = await pool!.query(
      `SELECT "id" FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch'
       AND "aggregateId" = $1 AND "idempotencyKey" = ANY($2::text[]) AND "publishedAt" IS NULL`,
      [stopOwner.sessionId, graphTaskIds.map(taskId => "subagent-dispatch:" + taskId)],
    )
    expect(graphDispatches.rowCount).toBe(0)
    const unrelatedOutbox = await pool!.query<{ id: string; aggregateId: string; publishedAt: Date | null }>(
      `SELECT "id", "aggregateId", "publishedAt" FROM "agent_outbox" WHERE "id" = ANY($1::text[]) ORDER BY "id"`,
      [unrelatedOutboxIds],
    )
    expect(unrelatedOutbox.rows).toHaveLength(unrelatedOutboxIds.length)
    expect(unrelatedOutbox.rows.map(row => row.id)).toEqual([...unrelatedOutboxIds].sort())
    expect(unrelatedOutbox.rows.every(row => row.publishedAt === null)).toBe(true)
    const unrelatedAggregateById = new Map(unrelatedOutbox.rows.map(row => [row.id, row.aggregateId] as const))
    expect(unrelatedAggregateById.get(unrelatedOutboxIds[0]!)).toBe(stopOwner.sessionId)
    expect(unrelatedAggregateById.get(unrelatedOutboxIds[1]!)).toBe(owner.sessionId)
  }, 30_000)
})
