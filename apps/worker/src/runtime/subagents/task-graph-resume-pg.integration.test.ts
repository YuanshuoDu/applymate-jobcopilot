import { randomUUID } from "node:crypto"
import { rm, writeFile } from "node:fs/promises"
import { spawn, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import { Queue } from "bullmq"
import { Pool, type PoolClient } from "pg"
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
import { createAgentArtifactRepository, findCurrentDraftHeadWithClient, findReviewReceiptWithClient, type AgentArtifactTaskFence } from "../../db/agent-artifact-repo.js"
import { createArtifactToolStore } from "../tools/artifact-tools.js"
import { childContextSnapshot, createChildContextBuilder } from "./child-context.js"
import { hashArtifactContent } from "./artifact-adapters.js"
import { loadSelectedJobArtifactContext, readSelectedJobSourceDigestWithClient, resolveCoverLetterBase } from "./selected-job-artifact-context.js"
import { materializeTaskGraphDependencyContext } from "./task-graph-dependency-context.js"
import { selectedJobArtifactCompletionGate, selectedJobArtifactCompletionGateWithWitness } from "../selected-job-completion-gate.js"
import { selectedJobArtifactFinalizationGuard } from "../selected-job-finalization-guard.js"
import { commitTurnTerminal } from "../turns/turn-engine-terminal-commit.js"
import { createPgTurnEngineStore } from "../turns/turn-engine-store.js"
import { claimTurnLease } from "../turns/lease.js"
import { executionOwnerFence } from "../execution-owner.js"
import { PgCoordinationStore } from "../mailbox/store.js"
import { TASK_GRAPH_TEMPLATES, taskGraphTemplatesForSelectedJob } from "./task-graph-templates.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { TASK_GRAPH_RESULT_PROJECTION_SCHEMA } from "./task-graph-command-port.js"
import { createPgTaskGraphCommandPort } from "./pg-task-graph-command-port.js"
import { PgSubagentTaskStore } from "./pg-store.js"
import { defaultSubagentPolicy, type SubagentTaskRecord } from "./types.js"
import { drainTaskGraphStopOutbox, TASK_GRAPH_STOP_OUTBOX_TOPIC } from "./task-graph-stop-outbox.js"
import { taskGraphItemId, taskGraphLifecycleKey } from "./task-graph-snapshot.js"

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
const interactiveDiscoveryTraceArtifactPath = process.env.AGENT_INTERACTIVE_DISCOVERY_TRACE_ARTIFACT_PATH
const SELECTED_JOB_DRAFT_CALL_ID = "ac6-selected-job-draft-receipt"
const SELECTED_JOB_REVIEW_READ_CALL_ID = "ac6-selected-job-review-read"
const SELECTED_JOB_REVIEW_CALL_ID = "ac6-selected-job-review-receipt"

function selectedJobDraftCallId(attemptCount: number): string {
  return `${SELECTED_JOB_DRAFT_CALL_ID}:attempt:${attemptCount}`
}

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
  let suffix = `...[truncated ${value.length - maxCharacters} characters]`
  while (suffix.length < maxCharacters) {
    const retainedLength = maxCharacters - suffix.length
    const omittedCharacters = value.length - retainedLength
    const nextSuffix = `...[truncated ${omittedCharacters} characters]`
    if (nextSuffix.length === suffix.length) return `${value.slice(0, retainedLength)}${nextSuffix}`
    suffix = nextSuffix
  }
  return suffix.slice(0, maxCharacters)
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

function safeFailurePreflightErrorClass(error: unknown): FailurePreflightErrorClass {
  const fields = record(error)
  const code = fields?.code
  if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return "database"
  if (error instanceof Error && error.name === "AssertionError") return "assertion"
  if (error instanceof Error && error.name === "CoordinationError") return "coordination"
  if (error instanceof Error && error.name === "Error") return "generic"
  return "other"
}

type FailureDiagnosticField = {
  label: string
  value: string
  safeValue?: string
}

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
  | "follow_up_plan_receipt_lookup"
  | "follow_up_graph_task_id"
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

type FailurePreflightStage =
  | "not_started"
  | "plan_receipt"
  | "root_task_lookup"
  | "first_target_lookup"
  | "second_target_lookup"
  | "first_target_lineage"
  | "second_target_lineage"
  | "wait_tool_availability"
  | "preflight_passed"

type FailurePreflightErrorClass = "none" | "assertion" | "coordination" | "database" | "generic" | "other"

type FailurePreflightTargetScopeEvidence = Readonly<{
  lookupCompleted: boolean
  rowFound: boolean | null
  sessionMatches: boolean | null
  userMatches: boolean | null
  turnMatches: boolean | null
  rootMatches: boolean | null
  parentMatches: boolean | null
}>

type FailurePreflightTargetObservation = null | { found: false; scope: FailurePreflightTargetScopeEvidence } | {
  found: true
  taskId: string
  turnId: string | null
  rootTaskId: string | null
  parentTaskId: string | null
}

const TURN_DIAGNOSTIC_STATUSES = new Set([
  "queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user",
  "completed", "failed", "interrupted", "cancelled",
])
const ITEM_DIAGNOSTIC_STATUSES = new Set(["started", "completed", "failed", "cancelled"])
const WAIT_DIAGNOSTIC_STATUSES = new Set(["waiting", "ready", "timed_out", "consumed", "failed", "cancelled", "interrupted", "closed"])
const WAIT_HANDOFF_ERROR_CODES = new Set([
  "40P01", "40001", "55P03", "57014", "23505", "23503", "wait_handoff_unavailable",
  "wait_invalid", "wait_scope_error", "lease_lost",
])
const WAIT_HANDOFF_ERROR_NAMES = new Set([
  "Error", "error", "DurableWaitHandoffError", "TurnLeaseError", "WaitHandoffUnavailable",
])
const WAIT_HANDOFF_GATE_ERROR_NAMES = new Set([
  "Error", "error", "DurableWaitHandoffError", "TurnLeaseError", "WaitHandoffUnavailable",
])
const WAIT_HANDOFF_GATE_LABELS = new Map([
  ["waitId is required", "wait_id_required"],
  ["leaseExpiresAt is invalid", "lease_expiry_invalid"],
  ["Session is unavailable", "session_unavailable"],
  ["Session is outside the wait scope", "session_scope_mismatch"],
  ["Turn is unavailable", "turn_unavailable"],
  ["Turn is outside the wait scope", "turn_scope_mismatch"],
  ["Wait condition is unavailable", "wait_unavailable"],
  ["Wait parent is outside the root Turn scope", "wait_root_scope_mismatch"],
  ["Wait step is outside the root Turn scope", "wait_step_scope_mismatch"],
  ["Wait step is not the current attempt", "wait_step_not_current"],
  ["Wait condition is already closed", "wait_already_closed"],
  ["Wait changed during handoff", "wait_changed_during_handoff"],
  ["Session was closed during wait dispatch", "session_closed_during_dispatch"],
  ["Turn lease was fenced before wait handoff", "lease_fenced_before_handoff"],
  ["Turn lease was fenced during wait handoff", "lease_fenced_during_handoff"],
  ["Turn lease was fenced during wait requeue", "lease_fenced_during_requeue"],
  ["Production waitHandoff callback was not provided.", "handoff_callback_missing"],
  ["wait_resume_event_conflict", "resume_event_conflict"],
  ["wait_resume_session_sequence_unavailable", "resume_session_sequence_unavailable"],
  ["wait_resume_outbox_conflict", "resume_outbox_conflict"],
])
const TASK_GRAPH_DIAGNOSTIC_NODE_KEYS = new Set([
  "source", "summary", "large-source", "rejected", "verification", "prerequisite", "dependent",
])
const COMPLETED_GRAPH_STATUS_EXPECTATIONS = [
  { key: "source", status: "completed" },
  { key: "summary", status: "completed" },
  { key: "large-source", status: "completed" },
  { key: "rejected", status: "cancelled" },
  { key: "verification", status: "completed" },
] as const
const TASK_GRAPH_READINESS = new Set([
  "ready", "waiting_for_dependencies", "blocked_dependency", "active", "terminal",
])
const FAILURE_PREFLIGHT_TARGET_KEYS = ["prerequisite", "dependent"] as const
const TASK_GRAPH_DIAGNOSTIC_PROPOSAL_NODE_KEYS = new Set(["source", "summary", "verification"])
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
const RESTORED_SOURCE_PROJECTION_CATEGORIES = new Set([
  "absent", "invalid", "wrong_schema", "unavailable", "wrong_role", "wrong_status", "wrong_count",
  "candidate_identity_mismatch", "valid", "missing", "other",
])
const RESTORED_SOURCE_PROJECTION_SCHEMAS = new Set(["expected", "missing", "other"])
const RESTORED_SOURCE_PROJECTION_AVAILABILITIES = new Set(["available", "unavailable", "missing", "other"])
const RESTORED_SOURCE_PROJECTION_ROLES = new Set(["scout", "analyst", "missing", "other"])
const RESTORED_SOURCE_PROJECTION_STATUSES = new Set(["completed", "partial", "missing", "other"])
const RESTORED_SOURCE_PROJECTION_SHAPES = new Set(["not_object", "other"])
const RESTORED_SOURCE_PROJECTION_INVALID_FIELDS = new Set([
  "trust", "availability", "count_or_candidates", "candidate_shape", "other",
])
const RESTORED_SOURCE_PROJECTION_IDENTITIES = new Set(["unchecked", "match", "mismatch", "other"])
const RESTORED_SOURCE_PROJECTION_DIAGNOSTIC_COUNT_LIMIT = 99

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

function diagnosticIdListContainsAll(requested: DiagnosticIdList, available: DiagnosticIdList): boolean | null {
  if (!requested.valid || !available.valid) return null
  if (requested.values.length === 0) return false
  const availableValues = new Set(available.values)
  return requested.values.every(value => availableValues.has(value))
}

type WaitProposalCandidate = {
  payload: RecordValue
  receipt: RecordValue
  rawNodes: unknown[]
  nodes: RecordValue[]
  taskIds: DiagnosticIdList
}

function proposalReceiptCandidates(payloads: readonly unknown[]): WaitProposalCandidate[] {
  const candidates: WaitProposalCandidate[] = []
  for (const rawPayload of payloads) {
    const payload = record(rawPayload)
    const receipt = record(payload?.receipt)
    if (payload?.kind !== "proposal" || !Array.isArray(receipt?.nodes)) continue
    const rawNodes = receipt.nodes
    const nodes = rawNodes.map(record).filter((node): node is RecordValue => node !== null)
    candidates.push({
      payload, receipt, rawNodes, nodes,
      taskIds: diagnosticIdList(rawNodes.map(node => record(node)?.taskId)),
    })
  }
  return candidates
}

function proposalReceiptForWait(requestedIds: DiagnosticIdList, payloads: readonly unknown[]): WaitProposalCandidate | null {
  const candidates = proposalReceiptCandidates(payloads)
  return candidates.find(candidate => diagnosticIdListsMatch(requestedIds, candidate.taskIds) === true)
    ?? null
}

function failedWaitReceiptProjection(requestedIds: DiagnosticIdList, payloads: readonly unknown[]): Readonly<{
  exactReceiptMatchExists: boolean | null
  proposalReceiptCandidateCount: number | null
  closestReceiptNodeCount: number | null
  closestReceiptNodeKeys: readonly string[]
  requestedIdsOutsideReceiptCount: number | null
}> {
  const candidates = proposalReceiptCandidates(payloads)
  const exact = candidates.find(candidate => diagnosticIdListsMatch(requestedIds, candidate.taskIds) === true) ?? null
  let closest: WaitProposalCandidate | null = null
  let closestOverlap = -1
  for (const candidate of candidates) {
    const candidateIds = new Set(candidate.taskIds.values)
    const overlap = requestedIds.valid && candidate.taskIds.valid
      ? requestedIds.values.filter(id => candidateIds.has(id)).length
      : -1
    // Proposal receipts arrive newest-first; preserve that order for ties.
    if (!closest || overlap > closestOverlap) {
      closest = candidate
      closestOverlap = overlap
    }
  }
  const selected = exact ?? closest
  const selectedIds = selected?.taskIds
  const outsideCount = selected && requestedIds.valid && selectedIds?.valid
    ? requestedIds.values.filter(id => !new Set(selectedIds.values).has(id)).length
    : null
  return {
    exactReceiptMatchExists: requestedIds.valid ? exact !== null : null,
    proposalReceiptCandidateCount: diagnosticBoundedCount(candidates.length),
    closestReceiptNodeCount: diagnosticBoundedCount(selected?.rawNodes.length ?? null),
    closestReceiptNodeKeys: selected
      ? diagnosticEnumList(selected.nodes.map(node => node.key), TASK_GRAPH_DIAGNOSTIC_NODE_KEYS)
      : [],
    requestedIdsOutsideReceiptCount: diagnosticBoundedCount(outsideCount),
  }
}

type DiagnosticTaskGraphNodes = Readonly<{
  count: number | null
  taskIdCount: number | null
  valid: boolean
  keys: readonly string[]
  byKey: ReadonlyMap<string, string>
}>

function diagnosticTaskGraphNodes(value: unknown): DiagnosticTaskGraphNodes {
  if (!Array.isArray(value)) return { count: null, taskIdCount: null, valid: false, keys: [], byKey: new Map() }
  const nodes = value.map(record)
  const entries = nodes.flatMap(node => typeof node?.key === "string" && typeof node.taskId === "string"
    ? [[node.key, node.taskId] as const]
    : [])
  const keys = entries.map(([key]) => key)
  const ids = entries.map(([, taskId]) => taskId)
  const byKey = new Map(entries)
  const valid = value.length <= 16 && nodes.every(node => node !== null
    && typeof node.key === "string" && node.key.trim().length > 0
    && typeof node.taskId === "string" && node.taskId.trim().length > 0 && node.taskId.length <= 256)
    && keys.length === nodes.length && byKey.size === nodes.length
    && new Set(ids).size === ids.length
  return {
    count: value.length,
    taskIdCount: nodes.filter(node => typeof node?.taskId === "string").length,
    valid,
    keys: [...new Set(keys.filter(key => TASK_GRAPH_DIAGNOSTIC_NODE_KEYS.has(key)))].sort().slice(0, 8),
    byKey,
  }
}

function diagnosticTaskGraphNodeMapsMatch(left: DiagnosticTaskGraphNodes, right: DiagnosticTaskGraphNodes): boolean | null {
  if (!left.valid || !right.valid) return null
  if (left.byKey.size !== right.byKey.size) return false
  return [...left.byKey].every(([key, taskId]) => right.byKey.get(key) === taskId)
}

function diagnosticTaskGraphMismatchKeys(left: DiagnosticTaskGraphNodes, right: DiagnosticTaskGraphNodes): string[] {
  const keys = new Set([...left.byKey.keys(), ...right.byKey.keys()])
  return [...keys].filter(key => TASK_GRAPH_DIAGNOSTIC_NODE_KEYS.has(key)
    && left.byKey.get(key) !== right.byKey.get(key)).sort().slice(0, 8)
}

function diagnosticTaskGraphRevision(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_646
    ? value
    : null
}

function firstWaitPlanGraphMismatchProjection(input: {
  requestReceipt: unknown
  requestGraph: unknown
  persistedToolReceipt: unknown
  persistedToolResultItemRevision: unknown
  persistedToolResultItemStatus: unknown
  persistedReceipt: unknown
  persistedSnapshot: unknown
  persistedItemRevision: unknown
  persistedReceiptItem: unknown
}): RecordValue {
  const requestReceipt = record(input.requestReceipt)
  const requestGraph = record(input.requestGraph)
  const persistedToolReceipt = record(input.persistedToolReceipt)
  const persistedReceipt = record(input.persistedReceipt)
  const persistedSnapshot = record(input.persistedSnapshot)
  const persistedReceiptItem = record(input.persistedReceiptItem)
  const embeddedSnapshot = record(persistedReceiptItem?.content)
  const requestReceiptNodes = diagnosticTaskGraphNodes(requestReceipt?.nodes)
  const requestGraphNodes = diagnosticTaskGraphNodes(requestGraph?.nodes)
  const persistedToolReceiptNodes = diagnosticTaskGraphNodes(persistedToolReceipt?.nodes)
  const persistedReceiptNodes = diagnosticTaskGraphNodes(persistedReceipt?.nodes)
  const persistedSnapshotNodes = diagnosticTaskGraphNodes(persistedSnapshot?.nodes)
  const embeddedSnapshotNodes = diagnosticTaskGraphNodes(embeddedSnapshot?.nodes)
  const requestReceiptMatchesPersistedReceipt = diagnosticTaskGraphNodeMapsMatch(requestReceiptNodes, persistedReceiptNodes)
  const comparisons = {
    requestReceiptMatchesPersistedToolReceipt: diagnosticTaskGraphNodeMapsMatch(requestReceiptNodes, persistedToolReceiptNodes),
    persistedToolReceiptMatchesPersistedReceipt: diagnosticTaskGraphNodeMapsMatch(persistedToolReceiptNodes, persistedReceiptNodes),
    persistedToolReceiptMatchesSnapshot: diagnosticTaskGraphNodeMapsMatch(persistedToolReceiptNodes, persistedSnapshotNodes),
    requestReceiptMatchesRequestGraph: diagnosticTaskGraphNodeMapsMatch(requestReceiptNodes, requestGraphNodes),
    requestGraphMatchesPersistedSnapshot: diagnosticTaskGraphNodeMapsMatch(requestGraphNodes, persistedSnapshotNodes),
    persistedReceiptMatchesSnapshot: diagnosticTaskGraphNodeMapsMatch(persistedReceiptNodes, persistedSnapshotNodes),
    persistedReceiptMatchesEmbeddedSnapshot: diagnosticTaskGraphNodeMapsMatch(persistedReceiptNodes, embeddedSnapshotNodes),
    embeddedSnapshotMatchesCurrentSnapshot: diagnosticTaskGraphNodeMapsMatch(embeddedSnapshotNodes, persistedSnapshotNodes),
  }
  const diagnosis = comparisons.persistedReceiptMatchesSnapshot === false
    || comparisons.persistedReceiptMatchesEmbeddedSnapshot === false
    || comparisons.embeddedSnapshotMatchesCurrentSnapshot === false
    ? "persisted_receipt_snapshot_lineage_mismatch"
    : comparisons.persistedToolReceiptMatchesPersistedReceipt === false
      ? "persisted_tool_receipt_proposal_mismatch"
      : comparisons.persistedToolReceiptMatchesSnapshot === false
        ? "persisted_tool_receipt_snapshot_mismatch"
        : comparisons.requestReceiptMatchesPersistedToolReceipt === false
          ? "request_persisted_tool_receipt_mismatch"
          : comparisons.requestGraphMatchesPersistedSnapshot === false
            ? "stale_request_graph_context"
            : requestReceiptMatchesPersistedReceipt === false
              ? "stale_or_wrong_request_receipt"
              : comparisons.requestReceiptMatchesRequestGraph === false
                ? "request_receipt_graph_pairing_mismatch"
                : "request_graph_and_receipt_match_persisted_state"
  const safeKeys = (keys: string[]) => keys.filter(key => TASK_GRAPH_DIAGNOSTIC_NODE_KEYS.has(key)).slice(0, 8)
  return {
    available: true,
    diagnosis,
    request: {
      receiptStatus: requestReceipt?.status === "accepted" || requestReceipt?.status === "duplicate" ? requestReceipt.status : "other",
      receiptRevision: diagnosticTaskGraphRevision(requestReceipt?.revision),
      graphRevision: diagnosticTaskGraphRevision(requestGraph?.revision),
      receiptNodeCount: diagnosticBoundedCount(requestReceiptNodes.count),
      graphNodeCount: diagnosticBoundedCount(requestGraphNodes.count),
      receiptTaskIdCount: diagnosticBoundedCount(requestReceiptNodes.taskIdCount),
      graphTaskIdCount: diagnosticBoundedCount(requestGraphNodes.taskIdCount),
    },
    persisted: {
      toolResultItemRevision: diagnosticTaskGraphRevision(input.persistedToolResultItemRevision),
      toolResultItemStatus: diagnosticEnum(input.persistedToolResultItemStatus, ITEM_DIAGNOSTIC_STATUSES),
      toolReceiptRevision: diagnosticTaskGraphRevision(persistedToolReceipt?.revision),
      toolReceiptNodeCount: diagnosticBoundedCount(persistedToolReceiptNodes.count),
      toolReceiptTaskIdCount: diagnosticBoundedCount(persistedToolReceiptNodes.taskIdCount),
      receiptRevision: diagnosticTaskGraphRevision(persistedReceipt?.revision),
      currentItemRevision: diagnosticTaskGraphRevision(input.persistedItemRevision),
      receiptNodeCount: diagnosticBoundedCount(persistedReceiptNodes.count),
      receiptTaskIdCount: diagnosticBoundedCount(persistedReceiptNodes.taskIdCount),
      snapshotNodeCount: diagnosticBoundedCount(persistedSnapshotNodes.count),
      snapshotTaskIdCount: diagnosticBoundedCount(persistedSnapshotNodes.taskIdCount),
    },
    comparisons,
    mismatchKeys: {
      requestReceiptPersistedToolReceipt: safeKeys(diagnosticTaskGraphMismatchKeys(requestReceiptNodes, persistedToolReceiptNodes)),
      persistedToolReceiptProposal: safeKeys(diagnosticTaskGraphMismatchKeys(persistedToolReceiptNodes, persistedReceiptNodes)),
      persistedToolReceiptSnapshot: safeKeys(diagnosticTaskGraphMismatchKeys(persistedToolReceiptNodes, persistedSnapshotNodes)),
      requestReceiptGraph: safeKeys(diagnosticTaskGraphMismatchKeys(requestReceiptNodes, requestGraphNodes)),
      requestGraphPersistedSnapshot: safeKeys(diagnosticTaskGraphMismatchKeys(requestGraphNodes, persistedSnapshotNodes)),
      persistedReceiptSnapshot: safeKeys(diagnosticTaskGraphMismatchKeys(persistedReceiptNodes, persistedSnapshotNodes)),
    },
  }
}

async function collectFirstWaitPlanGraphMismatchDiagnostics(
  pool: Pool,
  turnId: string,
  request: HarnessModelRequest,
  planCallId: string,
  graph: unknown,
): Promise<string> {
  try {
    const result = await pool.query<{
      itemRevision: unknown
      content: unknown
      proposalPayload: unknown
      toolResultItemRevision: unknown
      toolResultItemStatus: unknown
      toolResultContent: unknown
    }>(`SELECT item."revision" AS "itemRevision", item."content",
         (SELECT event."payload" FROM "agent_events" AS event
          WHERE event."sessionId" = turn."sessionId" AND event."turnId" = turn."id" AND event."itemId" = item."id"
            AND event."type" IN ('item.started', 'item.delta') AND event."payload"->>'kind' = 'proposal'
            AND event."payload"->'receipt'->>'revision' = toolResult."content"->'output'->>'revision'
          ORDER BY event."sequence" DESC LIMIT 1) AS "proposalPayload",
         toolResult."revision" AS "toolResultItemRevision",
         toolResult."status" AS "toolResultItemStatus",
         toolResult."content" AS "toolResultContent"
       FROM "agent_turns" AS turn JOIN "agent_items" AS item
         ON item."sessionId" = turn."sessionId" AND item."turnId" = turn."id"
          AND item."taskId" = turn."rootTaskId" AND item."type" = 'task_graph'
       LEFT JOIN LATERAL (
         SELECT resultItem."revision", resultItem."status", resultItem."content"
         FROM "agent_items" AS resultItem
         WHERE resultItem."sessionId" = turn."sessionId" AND resultItem."turnId" = turn."id"
           AND resultItem."taskId" = turn."rootTaskId" AND resultItem."type" = 'tool_result'
           AND resultItem."content"->>'toolCallId' = $2
         ORDER BY resultItem."revision" DESC, resultItem."updatedAt" DESC LIMIT 1
       ) AS toolResult ON TRUE
       WHERE turn."id" = $1 ORDER BY item."revision" DESC, item."updatedAt" DESC LIMIT 1`, [turnId, planCallId])
    const row = result.rows[0]
    const proposalPayload = record(row?.proposalPayload)
    const proposalItem = record(proposalPayload?.item)
    const toolResultContent = record(row?.toolResultContent)
    const projection = firstWaitPlanGraphMismatchProjection({
      requestReceipt: latestToolResult(request, planCallId),
      requestGraph: graph,
      persistedToolReceipt: toolResultContent?.output,
      persistedToolResultItemRevision: row?.toolResultItemRevision,
      persistedToolResultItemStatus: row?.toolResultItemStatus,
      persistedReceipt: record(proposalPayload?.receipt),
      persistedSnapshot: record(row?.content),
      persistedItemRevision: row?.itemRevision,
      persistedReceiptItem: proposalItem,
    })
    return boundedDiagnostic(JSON.stringify(projection), 1_200)
  } catch {
    return JSON.stringify({ available: false })
  }
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
  const exactReceiptMatchExists = typeof waitLineage?.exactReceiptMatchExists === "boolean"
    ? waitLineage.exactReceiptMatchExists : null
  const proposalReceiptCandidateCount = diagnosticBoundedCount(waitLineage?.proposalReceiptCandidateCount)
  const closestReceiptNodeCount = diagnosticBoundedCount(waitLineage?.closestReceiptNodeCount)
  const closestReceiptNodeKeys = diagnosticEnumList(waitLineage?.closestReceiptNodeKeys, TASK_GRAPH_DIAGNOSTIC_NODE_KEYS)
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
      requestedTaskIdsPresentInCurrentGraph: typeof waitLineage.requestedTaskIdsPresentInCurrentGraph === "boolean"
        ? waitLineage.requestedTaskIdsPresentInCurrentGraph
        : null,
      proposalReceiptFound: waitLineage.proposalReceiptFound === true,
      ...(exactReceiptMatchExists !== null ? { exactReceiptMatchExists } : {}),
      ...(proposalReceiptCandidateCount !== null ? { proposalReceiptCandidateCount } : {}),
      ...(closestReceiptNodeCount !== null ? { closestReceiptNodeCount } : {}),
      ...(closestReceiptNodeKeys.length > 0 ? { closestReceiptNodeKeys } : {}),
      ...(typeof waitLineage.proposalReceiptHistoryMayBeTruncated === "boolean"
        ? { proposalReceiptHistoryMayBeTruncated: waitLineage.proposalReceiptHistoryMayBeTruncated }
        : {}),
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

function combineFailureDiagnostics(fields: readonly FailureDiagnosticField[], progress: string, firstWaitPlanGraph?: string | null): string {
  const direct = boundedDiagnostic(fields.map(({ label, value, safeValue }) =>
    `${label}=${safeValue ?? (value.length > 0 && value !== "<not captured>" && value !== "<none>")}`).join("; "), 2_700)
  const planGraphLabel = firstWaitPlanGraph ? "; firstWaitPlanGraph=" : ""
  const planGraph = firstWaitPlanGraph ? boundedDiagnostic(firstWaitPlanGraph, 1_200) : ""
  const snapshotLabel = "; turnTaskWaitSnapshot="
  const snapshotBudget = Math.max(0, Math.min(1_050, 3_900 - direct.length - planGraphLabel.length - planGraph.length - snapshotLabel.length - 64))
  const snapshot = compactTurnProgressDiagnostics(progress, snapshotBudget)
  return boundedDiagnostic(`${direct}${planGraphLabel}${planGraph}${snapshotLabel}${snapshot}`, 3_900)
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

async function waitHandoffTurnState(pool: Pool, userId: string, turnId: string, waitId: string): Promise<RecordValue> {
  let client: PoolClient | undefined
  let transactionStarted = false
  try {
    client = await pool.connect()
    await client.query("BEGIN")
    transactionStarted = true
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId])
    const result = await client.query<{
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
       WHERE turn."id" = $1 AND turn."userId" = $3`, [turnId, waitId, userId])
    await client.query("COMMIT")
    transactionStarted = false
    const row = result.rows[0]
    return {
      snapshotReadSucceeded: true,
      turnFound: row !== undefined,
      waitFound: row?.waitId !== null && row?.waitId !== undefined,
      turn: row ? {
        status: row.turnStatus,
        leaseOwnerPresent: row.leaseOwnerId !== null,
        leaseVersion: row.leaseVersion,
      } : null,
      wait: row?.waitId ? {
        status: row.waitStatus,
        hasSuspendedAt: row.suspendedAt !== null,
        hasResolvedAt: row.resolvedAt !== null,
        hasConsumedAt: row.consumedAt !== null,
      } : null,
    }
  } catch (error: unknown) {
    if (client && transactionStarted) await client.query("ROLLBACK").catch(() => undefined)
    return { snapshotReadSucceeded: false, turnFound: false, waitFound: false, diagnosticError: boundedErrorDetails(error) }
  } finally {
    client?.release()
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
        const before = await waitHandoffTurnState(pool, input.lease.userId, input.lease.turnId, input.waitId)
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
      const before = await waitHandoffTurnState(pool, input.lease.userId, input.lease.turnId, input.waitId)
      try {
        await options.waitHandoff(input)
      } catch (error: unknown) {
        const after = await waitHandoffTurnState(pool, input.lease.userId, input.lease.turnId, input.waitId)
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
        snapshotReadSucceeded: current.snapshotReadSucceeded === true,
        turnFound: current.turnFound === true,
        waitFound: current.waitFound === true,
        turnStatus: diagnosticEnum(turn?.status, TURN_DIAGNOSTIC_STATUSES),
        turnLeaseOwnerPresent: turn?.leaseOwnerPresent === true,
        turnLeaseVersion: typeof turn?.leaseVersion === "number" && Number.isSafeInteger(turn.leaseVersion)
          ? turn.leaseVersion
          : null,
        waitStatus: diagnosticEnum(wait?.status, WAIT_DIAGNOSTIC_STATUSES),
        hasSuspendedAt: wait?.hasSuspendedAt === true,
        hasResolvedAt: wait?.hasResolvedAt === true,
        hasConsumedAt: wait?.hasConsumedAt === true,
      }
    }
    return {
      captured: true,
      errorName: diagnosticEnum(error?.name, WAIT_HANDOFF_ERROR_NAMES) ?? "other",
      errorCode: diagnosticEnum(error?.code, WAIT_HANDOFF_ERROR_CODES) ?? "other",
      handoffGate: typeof error?.name === "string" && WAIT_HANDOFF_GATE_ERROR_NAMES.has(error.name)
        && typeof error.message === "string"
        ? WAIT_HANDOFF_GATE_LABELS.get(error.message) ?? "other"
        : "other",
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

type SelectedJobFixtureSources = { readonly jobId: string; readonly otherJobId: string; readonly resumeId: string }

function selectedJobSourceCanaries(jobId: string, worker: 1 | 2): readonly string[] {
  const prefix = "p3-selected-job-"
  if (!jobId.startsWith(prefix) || jobId.length <= prefix.length) throw new Error("Selected-job source canaries are unavailable")
  const suffix = jobId.slice(prefix.length)
  return [
    `AC6_TRANSIENT_JOB_SOURCE_W${worker}_${suffix}`,
    `AC6_TRANSIENT_RESUME_SOURCE_W${worker}_${suffix}`,
    `AC6_TRANSIENT_PERSONA_SOURCE_W${worker}_${suffix}`,
  ]
}

function selectedJobFixtureSources(value: Fixture): SelectedJobFixtureSources {
  return {
    jobId: `p3-selected-job-${value.suffix}`,
    otherJobId: `p3-other-job-${value.suffix}`,
    resumeId: `p3-selected-job-resume-${value.suffix}`,
  }
}

async function seedSelectedJobSources(pool: Pool, value: Fixture): Promise<SelectedJobFixtureSources> {
  const ids = selectedJobFixtureSources(value)
  await pool.query(`INSERT INTO "Job" ("id", "userId", "company", "role", "location", "status", "url", "description", "source", "updatedAt")
    VALUES ($1, $2, 'Fixture GmbH', 'Software Engineer', 'Berlin', 'saved', 'https://jobs.example.invalid/selected', $3, 'test', CURRENT_TIMESTAMP),
      ($4, $2, 'Other Fixture GmbH', 'Designer', 'Dublin', 'saved', 'https://jobs.example.invalid/other', 'Design clear products', 'test', CURRENT_TIMESTAMP)`, [
    ids.jobId, value.userId, `AC6_TRANSIENT_JOB_SOURCE_W1_${value.suffix}`, ids.otherJobId,
  ])
  await pool.query(`INSERT INTO "Resume" ("id", "userId", "name", "content", "kind", "origin", "isDefault", "updatedAt")
    VALUES ($1, $2, 'Selected-job integration base', $3::jsonb, 'base', 'manual', TRUE, CURRENT_TIMESTAMP)`, [
    ids.resumeId, value.userId, JSON.stringify({ text: `AC6_TRANSIENT_RESUME_SOURCE_W1_${value.suffix}` }),
  ])
  await pool.query(`INSERT INTO persona_facts
    ("id", "userId", "key", "category", "value", "normalized_value", "source", "source_ref", "confidence", "status", "allowedUses", "updated_at")
    VALUES ($1, $2, 'language', 'language', $3, 'english-c1', 'resume', $4, 0.98, 'confirmed', ARRAY['cover_letter']::text[], CURRENT_TIMESTAMP)`, [
    `p3-selected-job-fact-${value.suffix}`, value.userId, `AC6_TRANSIENT_PERSONA_SOURCE_W1_${value.suffix}`, `resume:${ids.resumeId}:language`,
  ])
  return ids
}

type SelectedJobArtifactReference = {
  readonly artifactId: string
  readonly version: number
  readonly contentHash: string
  readonly sourceDigest: string
}

type SelectedJobArtifactRestartPlan = {
  readonly store: PgSubagentTaskStore
  readonly rootTaskId: string
  readonly writerTask: SubagentTaskRecord
  readonly queueName: string
  readonly jobId: string
  readonly otherJobId: string
  readonly body: string
  readonly originalPreparation: Awaited<ReturnType<typeof loadSelectedJobArtifactContext>>
}

type SelectedJobArtifactRestartTrace = SelectedJobArtifactRestartPlan & {
  readonly writerOwnerId: string
  readonly writerAttemptCount: number
  readonly writerDraftCallId: string
  readonly writerRequestHash: string
  readonly writerFence: AgentArtifactTaskFence
  readonly artifactRef: SelectedJobArtifactReference
}

type SelectedJobArtifactReviewTrace = SelectedJobArtifactRestartTrace & {
  readonly currentPreparation: Awaited<ReturnType<typeof loadSelectedJobArtifactContext>>
  readonly reviewerTask: SubagentTaskRecord
  readonly stopReviewerTask: SubagentTaskRecord
}

function selectedJobArtifactReference(value: unknown): SelectedJobArtifactReference {
  const row = record(value)
  const ref = record(row?.artifactRef) ?? record(record(row?.structuredResult)?.artifactRef) ?? row
  if (!ref || typeof ref.artifactId !== "string" || !Number.isSafeInteger(ref.version)
    || typeof ref.contentHash !== "string" || typeof ref.sourceDigest !== "string") {
    throw new Error("Selected-job Worker did not return a valid artifact reference")
  }
  return { artifactId: ref.artifactId, version: Number(ref.version), contentHash: ref.contentHash, sourceDigest: ref.sourceDigest }
}

function selectedJobTaskFence(task: SubagentTaskRecord, leaseOwner: string, attemptCount: number): AgentArtifactTaskFence {
  if (!task.turnId || !task.parentTaskId || !leaseOwner || !Number.isSafeInteger(attemptCount)) {
    throw new Error("Selected-job task is missing its durable lease fence identity")
  }
  return {
    taskId: task.id, userId: task.userId, sessionId: task.sessionId, turnId: task.turnId,
    rootTaskId: task.rootTaskId, parentTaskId: task.parentTaskId, leaseOwner, attemptCount,
  }
}

function selectedJobTaskReceiptRequestHash(
  op: string,
  scope: {
    readonly taskFence: AgentArtifactTaskFence
    readonly [key: string]: unknown
  },
  input: unknown,
): string {
  const { taskFence, ...stableScope } = scope
  return hashArtifactContent({
    op, ...stableScope,
    turnId: taskFence.turnId, rootTaskId: taskFence.rootTaskId, parentTaskId: taskFence.parentTaskId, input,
  })
}

function selectedJobDraftRequestHash(
  scope: { readonly taskFence: AgentArtifactTaskFence; readonly [key: string]: unknown },
  input: unknown,
): string {
  return selectedJobTaskReceiptRequestHash("cover_letter.draft", scope, input)
}

async function createSelectedJobTaskGraph(
  pool: Pool,
  value: Fixture,
  sources: SelectedJobFixtureSources,
  queueName: string,
): Promise<SelectedJobArtifactRestartPlan> {
  const store = new PgSubagentTaskStore(pool, 300_000)
  const root = await store.create({
    userId: value.userId, sessionId: value.sessionId, turnId: value.turnId,
    role: "supervisor", taskType: "task_graph", goal: "Coordinate a selected-job artifact fixture",
    allowedActions: ["jobs.get", "persona.retrieve", "resume.get_base", "cover_letter.draft", "artifact.version.read", "artifact.review"],
    expectedOutputSchema: {}, toolPolicySnapshot: {}, budgetSnapshot: { limits: { maxSteps: 32, maxToolCalls: 16 } },
    policy: defaultSubagentPolicy(),
  })
  const linkedTurn = await pool.query(`UPDATE "agent_turns" SET "rootTaskId" = $2, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = $1 AND "sessionId" = $3 AND "userId" = $4 AND "status" = 'waiting_for_user' AND "rootTaskId" IS NULL`, [
    value.turnId, root.id, value.sessionId, value.userId,
  ])
  if (linkedTurn.rowCount !== 1) throw new Error("Selected-job fixture turn was not available for its root task")
  const writerTask = await store.create({
    userId: value.userId, sessionId: value.sessionId, turnId: value.turnId, parentTaskId: root.id,
    role: "writer", taskType: "cover_letter_draft", goal: "Draft a cover letter for the selected job",
    successCriteria: ["Persist one selected-job artifact version"],
    allowedActions: ["jobs.get", "persona.retrieve", "resume.get_base", "cover_letter.draft"],
    context: { selectedJobPreparation: { jobId: sources.jobId } },
    expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "writer" },
    toolPolicySnapshot: {}, policy: defaultSubagentPolicy(),
  })
  return {
    store, rootTaskId: root.id, writerTask, queueName,
    jobId: sources.jobId, otherJobId: sources.otherJobId,
    body: `AC6_PRIVATE_COVER_LETTER_${value.suffix}`,
    originalPreparation: await loadSelectedJobArtifactContext(pool, value.userId, sources.jobId),
  }
}

async function prepareSelectedJobTerminalCase(pool: Pool, value: Fixture) {
  await seed(pool, value, "waiting_for_user")
  const sources = await seedSelectedJobSources(pool, value)
  const preparation = await loadSelectedJobArtifactContext(pool, value.userId, sources.jobId)
  const tasks = new PgSubagentTaskStore(pool, 300_000)
  const root = await tasks.create({
    userId: value.userId, sessionId: value.sessionId, turnId: value.turnId, role: "supervisor", taskType: "task_graph",
    goal: "Complete the selected-job draft review before finalizing",
    allowedActions: ["jobs.get", "persona.retrieve", "resume.get_base", "cover_letter.draft", "artifact.version.read", "artifact.review"],
    expectedOutputSchema: {}, toolPolicySnapshot: {}, budgetSnapshot: { limits: { maxSteps: 16, maxToolCalls: 16 } }, policy: defaultSubagentPolicy(),
  })
  const linked = await pool.query(`UPDATE "agent_turns" SET "rootTaskId" = $2, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = $1 AND "sessionId" = $3 AND "userId" = $4 AND "status" = 'waiting_for_user' AND "rootTaskId" IS NULL`, [
    value.turnId, root.id, value.sessionId, value.userId,
  ])
  if (linked.rowCount !== 1) throw new Error("Finalization fixture root could not be linked")
  await activateFixtureTurn(pool, value)
  const lease = await claimTurnLease(pool, { turnId: value.turnId, sessionId: value.sessionId, ownerId: value.ownerId })
  const rootLease = await tasks.claim({ taskId: root.id, sessionId: value.sessionId, ownerId: value.ownerId, policy: defaultSubagentPolicy(), now: new Date() })
  if (!rootLease?.leaseOwner) throw new Error("Finalization fixture root did not acquire a live lease")
  const stepId = `p3-finalization-step-${value.suffix}`
  await pool.query(`INSERT INTO "agent_steps"
    ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
    VALUES ($1, $2, $3, $4, 0, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb)`, [stepId, value.sessionId, value.turnId, root.id])
  const commandPort = createPgTaskGraphCommandPort(pool)
  const graphScope = {
    userId: value.userId, sessionId: value.sessionId, turnId: value.turnId, rootTaskId: root.id, parentTaskId: root.id, stepId,
    turnLeaseOwner: lease.ownerId, turnLeaseVersion: lease.leaseVersion, parentLeaseOwner: value.ownerId, parentAttemptCount: rootLease.attemptCount,
  }
  const plan = await commandPort.appendAndSchedule({
    scope: graphScope,
    proposal: { expectedRevision: 0, nodes: [
      { key: "writer", templateId: "cover_letter_writer", goal: "Persist one selected-job draft", successCriteria: ["Save the draft"], dependsOn: [] },
      { key: "reviewer", templateId: "cover_letter_reviewer", goal: "Review the selected-job draft", successCriteria: ["Persist a passed review"], dependsOn: ["writer"] },
    ] },
    templates: taskGraphTemplatesForSelectedJob(preparation.preparation),
  })
  const taskId = (key: string) => {
    const found = plan.nodes.find(node => node.key === key)?.taskId
    if (!found) throw new Error(`Finalization fixture graph is missing ${key}`)
    return found
  }
  const writerOwner = `p3-finalization-writer-${value.suffix}`
  const writer = await tasks.claim({ taskId: taskId("writer"), sessionId: value.sessionId, ownerId: writerOwner, policy: defaultSubagentPolicy(), now: new Date() })
  if (!writer?.leaseOwner) throw new Error("Finalization fixture Writer did not acquire a live lease")
  const artifacts = createArtifactToolStore(pool)
  const base = await resolveCoverLetterBase(artifacts, value.userId, sources.jobId)
  const draftInput = { baseArtifactId: base.artifactId, baseHash: base.baseHash, content: `AC6_PRIVATE_FINALIZATION_DRAFT_${value.suffix}`, constraints: { maxWords: 160 } }
  const writerScope = {
    ...preparation.preparation, userId: value.userId, sessionId: value.sessionId, taskId: writer.id,
    toolCallId: `p3-finalization-writer:${writer.attemptCount}`, taskFence: selectedJobTaskFence(writer, writerOwner, writer.attemptCount),
  }
  const draft = await artifacts.writeDraft(writerScope, { ...draftInput, requestHash: selectedJobDraftRequestHash(writerScope, draftInput) })
  const artifactRef = { artifactId: draft.artifactId, version: draft.version, contentHash: draft.contentHash, sourceDigest: draft.sourceDigest }
  await tasks.finish({ taskId: writer.id, sessionId: value.sessionId, ownerId: writerOwner, attemptCount: writer.attemptCount, status: "completed",
    result: { status: "completed", finalText: "Draft saved", finalItemId: null, stepCount: 1, toolCallCount: 1,
      structuredResult: { schemaVersion: ROLE_RESULT_SCHEMA, role: "writer", status: "completed", artifactRef } }, now: new Date() })
  const reviewerOwner = `p3-finalization-reviewer-${value.suffix}`
  const reviewer = await tasks.claim({ taskId: taskId("reviewer"), sessionId: value.sessionId, ownerId: reviewerOwner, policy: defaultSubagentPolicy(), now: new Date() })
  if (!reviewer?.leaseOwner) throw new Error("Finalization fixture Reviewer did not acquire a live lease")
  const reviewInput = { artifactRef, decision: "passed", findings: [] }
  const reviewerScope = {
    ...preparation.preparation, userId: value.userId, sessionId: value.sessionId, taskId: reviewer.id,
    toolCallId: `p3-finalization-reviewer:${reviewer.attemptCount}`, taskFence: selectedJobTaskFence(reviewer, reviewerOwner, reviewer.attemptCount),
  }
  const reviewHash = hashArtifactContent({ artifactRef, currentSourceDigest: preparation.preparation.sourceDigest, status: "passed", findings: [], evidenceRefs: preparation.preparation.evidenceRefs })
  await artifacts.saveReview({
    userId: value.userId, sessionId: value.sessionId, jobId: sources.jobId, artifactId: artifactRef.artifactId, version: artifactRef.version,
    contentHash: artifactRef.contentHash, sourceDigest: artifactRef.sourceDigest, currentSourceDigest: preparation.preparation.sourceDigest,
    status: "passed", findings: [], evidenceRefs: [...preparation.preparation.evidenceRefs], taskId: reviewer.id, toolCallId: reviewerScope.toolCallId,
    requestHash: selectedJobTaskReceiptRequestHash("artifact.review", reviewerScope, reviewInput), reviewHash, taskFence: reviewerScope.taskFence,
  })
  await tasks.finish({ taskId: reviewer.id, sessionId: value.sessionId, ownerId: reviewerOwner, attemptCount: reviewer.attemptCount, status: "completed",
    result: { status: "completed", finalText: "Review passed", finalItemId: null, stepCount: 1, toolCallCount: 1,
      structuredResult: { schemaVersion: ROLE_RESULT_SCHEMA, role: "reviewer", status: "completed", artifactRef, reviewStatus: "passed", reviewHash } }, now: new Date() })
  const artifactRepository = createAgentArtifactRepository(pool)
  const gate = await selectedJobArtifactCompletionGateWithWitness({
    commandPort, lease, root: { id: root.id, attemptCount: rootLease.attemptCount }, selectedJobId: sources.jobId,
    readCurrentDraftHead: scope => artifactRepository.findCurrentDraftHead(scope),
    readCurrentSourceDigest: async () => (await loadSelectedJobArtifactContext(pool, value.userId, sources.jobId)).preparation.sourceDigest,
    readCurrentReviewReceipt: scope => artifactRepository.findReviewReceipt(scope),
  })
  if (!gate.ok) throw new Error("Finalization fixture did not produce a successful selected-job gate")
  const ownerFence = executionOwnerFence({ kind: "turn", taskId: root.id, lease })
  if (ownerFence.kind !== "turn") throw new Error("Finalization fixture owner is not a Turn lease")
  const owner = ownerFence
  const engineStore = createPgTurnEngineStore(pool)
  await engineStore.updateStep({ owner, stepId, status: "completed", finishReason: "stop", errorCode: null, inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0, now: new Date() })
  await engineStore.appendEvent({
    owner, id: `p3-finalization-step-event-${value.suffix}`, itemId: null, type: "step.completed", correlationId: stepId, causationId: null,
    idempotencyKey: `turn:${value.turnId}:event:step-completed:${stepId}`, payload: { stepId, status: "completed" },
  })
  return {
    value, sources, preparation, tasks, root, rootLease, lease, commandPort, artifacts, artifactRef, graphScope,
    acceptedGraphWitness: gate.witness, stepId,
    terminalInput: {
      owner, response: "Selected-job draft review complete", now: new Date(), stepId,
      finalItemId: `p3-finalization-item-${value.suffix}`, finalContent: { parts: [{ type: "text", text: "Selected-job draft review complete" }] },
      stepCount: 1, toolCallCount: 0, usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 },
    },
  }
}

function selectedJobFinalizationGuardForCase(prepared: Awaited<ReturnType<typeof prepareSelectedJobTerminalCase>>) {
  return (client: PoolClient) => selectedJobArtifactFinalizationGuard({
    client, commandPort: prepared.commandPort, lease: prepared.lease,
    root: { id: prepared.root.id, attemptCount: prepared.rootLease.attemptCount }, selectedJobId: prepared.sources.jobId,
    acceptedGraphWitness: prepared.acceptedGraphWitness,
    readCurrentDraftHead: findCurrentDraftHeadWithClient,
    readCurrentSourceDigest: (current, scope) => readSelectedJobSourceDigestWithClient(current, scope.userId, scope.jobId),
    readCurrentReviewReceipt: findReviewReceiptWithClient,
  })
}

async function expectNoTerminalRecords(pool: Pool, prepared: Awaited<ReturnType<typeof prepareSelectedJobTerminalCase>>): Promise<void> {
  const [turn, root, item, events, outboxes] = await Promise.all([
    pool.query<{ status: string; finalResponse: string | null }>(`SELECT "status", "finalResponse" FROM "agent_turns" WHERE "id" = $1`, [prepared.value.turnId]),
    pool.query<{ status: string }>(`SELECT "status" FROM "sub_agent_tasks" WHERE "id" = $1`, [prepared.root.id]),
    pool.query(`SELECT "id" FROM "agent_items" WHERE "id" = $1`, [prepared.terminalInput.finalItemId]),
    pool.query(`SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "itemId" = $3`, [prepared.value.sessionId, prepared.value.turnId, prepared.terminalInput.finalItemId]),
    pool.query(`SELECT "id" FROM "agent_outbox" WHERE "aggregateId" = $1 AND "payload"->>'itemId' = $2`, [prepared.value.sessionId, prepared.terminalInput.finalItemId]),
  ])
  expect(turn.rows[0]).toEqual({ status: "in_progress", finalResponse: null })
  expect(root.rows[0]?.status).toBe("running")
  expect(item.rows).toHaveLength(0)
  expect(events.rows).toHaveLength(0)
  expect(outboxes.rows).toHaveLength(0)
}

function selectedJobSettlement(line: string, taskId: string): RecordValue {
  const prefix = `P3_SELECTED_JOB_CHILD_SETTLED ${taskId} `
  if (!line.startsWith(prefix)) throw new Error("Selected-job Worker settlement marker did not match its task")
  const value = record(JSON.parse(line.slice(prefix.length)) as unknown)
  if (!value) throw new Error("Selected-job Worker settlement marker was not an object")
  return value
}

async function traceSelectedJobWriterFromWorker(
  plan: SelectedJobArtifactRestartPlan,
  line: string,
): Promise<SelectedJobArtifactRestartTrace> {
  const settlement = selectedJobSettlement(line, plan.writerTask.id)
  expect(settlement).toMatchObject({
    role: "writer", taskId: plan.writerTask.id, managerStatus: "completed", childStatus: "completed",
    observations: { sourceCanariesReloaded: { job: true, resume: true, persona: true } },
  })
  if (typeof settlement.ownerId !== "string" || !Number.isSafeInteger(settlement.attemptCount)) {
    throw new Error("Selected-job Worker did not report a valid lease identity")
  }
  const writerAttemptCount = Number(settlement.attemptCount)
  const writerDraftCallId = selectedJobDraftCallId(writerAttemptCount)
  const draftInput = {
    baseArtifactId: `cover-letter-base:${hashArtifactContent({ userId: plan.writerTask.userId, jobId: plan.jobId }).slice(7)}`,
    baseHash: hashArtifactContent({ kind: "cover_letter_base", jobId: plan.jobId }),
    content: plan.body,
    constraints: { maxWords: 160 },
  }
  const writerFence = selectedJobTaskFence(plan.writerTask, settlement.ownerId, writerAttemptCount)
  const writerScope = {
    ...plan.originalPreparation.preparation,
    userId: plan.writerTask.userId,
    sessionId: plan.writerTask.sessionId,
    taskId: plan.writerTask.id,
    toolCallId: writerDraftCallId,
    taskFence: writerFence,
  }
  const writerRequestHash = selectedJobDraftRequestHash(writerScope, draftInput)
  const artifactRef = selectedJobArtifactReference(settlement.artifactRef)
  expect(artifactRef.version).toBe(1)
  expect(artifactRef.sourceDigest).toBe(plan.originalPreparation.preparation.sourceDigest)
  const version = await plan.store.get(plan.writerTask.id, plan.writerTask.sessionId)
  expect(version).toMatchObject({ status: "completed", role: "writer", attemptCount: writerAttemptCount })
  return {
    ...plan, writerOwnerId: settlement.ownerId, writerAttemptCount, writerDraftCallId,
    writerRequestHash, writerFence, artifactRef,
  }
}

async function enqueueSelectedJobTask(
  queueName: string,
  connection: Redis,
  task: SubagentTaskRecord,
  ownerId: string,
): Promise<void> {
  const { enqueueSubagentTask } = await import("../../queue/subagent-queue.js")
  const queue = new Queue(queueName, { connection, skipVersionCheck: true })
  try {
    await enqueueSubagentTask(queue, { taskId: task.id, sessionId: task.sessionId, rootTaskId: task.rootTaskId, ownerId }, 1)
  } finally {
    await queue.close()
  }
}

async function enqueueSelectedJobReviewTasksBeforeWorkerTwo(
  pool: Pool,
  connection: Redis,
  value: Fixture,
  trace: SelectedJobArtifactReviewTrace,
): Promise<void> {
  const { SUBAGENT_DISPATCH_TOPIC, subagentDispatchKey } = await import("../../queue/subagent-queue.js")
  const tasks = [
    { task: trace.reviewerTask, ownerId: `ac6-reviewer-worker-two-${value.suffix}` },
    { task: trace.stopReviewerTask, ownerId: `ac6-stop-reviewer-worker-two-${value.suffix}` },
  ]
  for (const { task, ownerId } of tasks) {
    const payload = { taskId: task.id, sessionId: task.sessionId, rootTaskId: task.rootTaskId, ownerId }
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT ("idempotencyKey") DO NOTHING
       RETURNING "id"`,
      [randomUUID(), SUBAGENT_DISPATCH_TOPIC, task.sessionId, subagentDispatchKey(task.id), JSON.stringify(payload)],
    )
    const dispatchId = inserted.rows[0]?.id
    if (inserted.rowCount !== 1 || !dispatchId) {
      throw new Error("Selected-job fixture dispatch marker already exists or could not be persisted")
    }
    await enqueueSelectedJobTask(trace.queueName, connection, task, ownerId)
    const published = await pool.query<{ id: string }>(
      `UPDATE "agent_outbox" SET "publishedAt" = CURRENT_TIMESTAMP
       WHERE "id" = $1 AND "topic" = $2 AND "aggregateId" = $3 AND "publishedAt" IS NULL
       RETURNING "id"`,
      [dispatchId, SUBAGENT_DISPATCH_TOPIC, task.sessionId],
    )
    if (published.rowCount !== 1 || published.rows[0]?.id !== dispatchId) {
      throw new Error("Selected-job fixture dispatch marker could not be marked published after enqueue")
    }
  }
}

async function prepareSelectedJobReviewAfterRestart(
  pool: Pool,
  value: Fixture,
  trace: SelectedJobArtifactRestartTrace,
): Promise<SelectedJobArtifactReviewTrace> {
  const artifactStore = createArtifactToolStore(pool)
  const durableVersion = await artifactStore.readVersion({ userId: value.userId, sessionId: value.sessionId, jobId: trace.jobId }, trace.artifactRef)
  expect(durableVersion).toMatchObject({
    version: 1, content: trace.body, contentHash: trace.artifactRef.contentHash,
    userId: value.userId, sessionId: value.sessionId, jobId: trace.jobId,
    sourceDigest: trace.originalPreparation.preparation.sourceDigest,
    provenanceRefs: trace.originalPreparation.preparation.evidenceRefs,
    evidenceRefs: trace.originalPreparation.preparation.evidenceRefs,
    taskId: trace.writerTask.id, toolCallId: trace.writerDraftCallId, requestHash: trace.writerRequestHash,
  })

  const completedWriter = await trace.store.get(trace.writerTask.id, value.sessionId)
  expect(completedWriter).toMatchObject({ status: "completed", role: "writer", rootTaskId: trace.rootTaskId, parentTaskId: trace.rootTaskId })
  if (!completedWriter) throw new Error("Completed selected-job Writer task disappeared")
  const workerTwoSources = selectedJobSourceCanaries(trace.jobId, 2)
  const updatedSources = await Promise.all([
    pool.query(`UPDATE "Job" SET "description" = $3, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = $1 AND "userId" = $2`, [trace.jobId, value.userId, workerTwoSources[0]]),
    pool.query(`UPDATE "Resume" SET "content" = $3::jsonb, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = $1 AND "userId" = $2`, [
      selectedJobFixtureSources(value).resumeId, value.userId, JSON.stringify({ text: workerTwoSources[1] }),
    ]),
    pool.query(`UPDATE persona_facts SET "value" = $3, "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = $1 AND "userId" = $2`, [`p3-selected-job-fact-${value.suffix}`, value.userId, workerTwoSources[2]]),
  ])
  if (updatedSources.some(result => result.rowCount !== 1)) throw new Error("Selected-job transient source fixture update failed")
  const currentPreparation = await loadSelectedJobArtifactContext(pool, value.userId, trace.jobId)
  expect(currentPreparation.preparation.sourceDigest).not.toBe(trace.artifactRef.sourceDigest)
  const dependencyScope = {
    userId: value.userId, sessionId: value.sessionId, turnId: value.turnId,
    rootTaskId: trace.rootTaskId, parentTaskId: trace.rootTaskId,
  }
  const reviewerContext = materializeTaskGraphDependencyContext(
    { selectedJobPreparation: { jobId: trace.jobId } }, dependencyScope, ["writer"], [{
      ...dependencyScope, key: "writer", taskId: completedWriter.id, status: completedWriter.status,
      role: completedWriter.role, expectedOutputSchema: completedWriter.expectedOutputSchema, result: completedWriter.result,
    }],
  )
  const createReviewer = (goal: string) => trace.store.create({
    userId: value.userId, sessionId: value.sessionId, turnId: value.turnId, parentTaskId: trace.rootTaskId,
    role: "reviewer", taskType: "cover_letter_review", goal,
    successCriteria: ["Read the exact Writer artifact and persist its review result"],
    allowedActions: ["artifact.version.read", "artifact.review"], context: reviewerContext,
    expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "reviewer" },
    toolPolicySnapshot: {}, policy: defaultSubagentPolicy(),
  })
  const [reviewerTask, stopReviewerTask] = await Promise.all([
    createReviewer("Review the changed-source selected-job artifact"),
    createReviewer("Attempt selected-job review while Stop fences the write"),
  ])
  for (const child of [reviewerTask, stopReviewerTask]) {
    expect(child).toMatchObject({
      userId: value.userId, sessionId: value.sessionId, turnId: value.turnId,
      rootTaskId: trace.rootTaskId, parentTaskId: trace.rootTaskId, role: "reviewer",
    })
    const dependency = record(record(child.context)?.taskGraphDependencyResults)
    const items = Array.isArray(dependency?.items) ? dependency.items.map(record).filter((item): item is RecordValue => item !== null) : []
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ dependencyKey: "writer", role: "writer", taskStatus: "completed" })
    expect(items[0]).not.toHaveProperty("taskId")
    expect(items[0]).toMatchObject({
      result: {
        schemaVersion: "agent-harness.v2.task-graph.result-projection",
        trust: "untrusted", availability: "available", role: "writer", status: "completed",
        artifactRef: trace.artifactRef,
      },
    })
  }
  return { ...trace, currentPreparation, reviewerTask, stopReviewerTask }
}

async function reviewSelectedJobThroughRestartedWorker(
  pool: Pool,
  value: Fixture,
  trace: SelectedJobArtifactReviewTrace,
  firstWorker: ProcessFixtureChild,
  worker: ProcessFixtureChild,
): Promise<void> {
  const artifactStore = createArtifactToolStore(pool)
  const reviewLine = await waitForProcessLine(worker, `P3_SELECTED_JOB_CHILD_SETTLED ${trace.reviewerTask.id} `, 30_000)
  const reviewSettlement = selectedJobSettlement(reviewLine, trace.reviewerTask.id)
  expect(reviewSettlement).toMatchObject({
    role: "reviewer", taskId: trace.reviewerTask.id, managerStatus: "completed", childStatus: "completed",
    artifactRef: trace.artifactRef, reviewStatus: "stale",
    observations: {
      sawBody: true, privateBodyAbsentBeforeRead: true,
      sourceCanariesReloaded: { job: true, resume: true, persona: true },
      previousSourceCanariesAbsent: { job: true, resume: true, persona: true },
      preReadContextHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      reviewStatus: "stale", writerReceiptReferenceRecovered: true,
    },
  })
  const reviewAttempt = Number(reviewSettlement.attemptCount)
  const readCallId = `${SELECTED_JOB_REVIEW_READ_CALL_ID}:attempt:${reviewAttempt}`
  const reviewCallId = `${SELECTED_JOB_REVIEW_CALL_ID}:attempt:${reviewAttempt}`
  if (typeof reviewSettlement.ownerId !== "string") throw new Error("Selected-job reviewer did not report its lease owner")
  const reviewInput = { artifactRef: trace.artifactRef, decision: "passed", findings: [] }
  const reviewScope = {
    ...trace.currentPreparation.preparation,
    userId: value.userId, sessionId: value.sessionId, taskId: trace.reviewerTask.id,
    toolCallId: reviewCallId,
    taskFence: selectedJobTaskFence(trace.reviewerTask, reviewSettlement.ownerId, reviewAttempt),
  }
  const expectedReviewRequestHash = selectedJobTaskReceiptRequestHash("artifact.review", reviewScope, reviewInput)
  const persistedReview = await pool.query<{
    userId: string; sessionId: string; jobId: string; artifactId: string; version: number; contentHash: string;
    sourceDigest: string; currentSourceDigest: string; status: string; findings: unknown; evidenceRefs: unknown;
    taskId: string; toolCallId: string; requestHash: string; reviewHash: string
  }>(`SELECT "userId", "sessionId", "jobId", "artifactId", "version", "contentHash", "sourceDigest", "currentSourceDigest",
      "status", "findings", "evidenceRefs", "taskId", "toolCallId", "requestHash", "reviewHash" FROM "agent_artifact_review"
      WHERE "taskId" = $1 AND "toolCallId" = $2`, [trace.reviewerTask.id, reviewCallId])
  expect(persistedReview.rows).toHaveLength(1)
  expect(persistedReview.rows[0]).toMatchObject({
    userId: value.userId, sessionId: value.sessionId, jobId: trace.jobId,
    artifactId: trace.artifactRef.artifactId, version: trace.artifactRef.version,
    contentHash: trace.artifactRef.contentHash,
    status: "stale", sourceDigest: trace.artifactRef.sourceDigest,
    currentSourceDigest: trace.currentPreparation.preparation.sourceDigest,
    findings: [], evidenceRefs: [], taskId: trace.reviewerTask.id, toolCallId: reviewCallId,
    requestHash: expectedReviewRequestHash,
  })
  expect(persistedReview.rows[0]?.sourceDigest).not.toBe(persistedReview.rows[0]?.currentSourceDigest)
  expect(reviewSettlement.reviewHash).toBe(persistedReview.rows[0]?.reviewHash)

  const wrongUserRead = await artifactStore.readVersion({
    userId: `foreign-${value.suffix}`, sessionId: value.sessionId, jobId: trace.jobId,
  }, trace.artifactRef)
  const wrongJobRead = await artifactStore.readVersion({
    userId: value.userId, sessionId: value.sessionId, jobId: trace.otherJobId,
  }, trace.artifactRef)
  const wrongSessionRead = await artifactStore.readVersion({
    userId: value.userId, sessionId: `foreign-session-${value.suffix}`, jobId: trace.jobId,
  }, trace.artifactRef)
  expect(wrongUserRead).toBeNull()
  expect(wrongJobRead).toBeNull()
  expect(wrongSessionRead).toBeNull()
  const reviewRef = trace.artifactRef
  const scopedReview = await artifactStore.findReview({ userId: value.userId, sessionId: value.sessionId, jobId: trace.jobId }, reviewRef)
  expect(scopedReview).toMatchObject({ status: "stale", taskId: trace.reviewerTask.id, toolCallId: reviewCallId })
  await expect(artifactStore.findReview({
    userId: `foreign-user-${value.suffix}`, sessionId: value.sessionId, jobId: trace.jobId,
  }, reviewRef)).resolves.toBeNull()
  await expect(artifactStore.findReview({
    userId: value.userId, sessionId: `foreign-session-${value.suffix}`, jobId: trace.jobId,
  }, reviewRef)).resolves.toBeNull()
  await expect(artifactStore.findReview({
    userId: value.userId, sessionId: value.sessionId, jobId: trace.otherJobId,
  }, reviewRef)).resolves.toBeNull()

  await waitForProcessLine(worker, `P3_SELECTED_JOB_STOP_REVIEW_QUEUED ${trace.stopReviewerTask.id}`, 30_000)
  worker.stdin?.write(`start-selected-job-review:${trace.stopReviewerTask.id}\n`)
  await waitForProcessLine(worker, `P3_SELECTED_JOB_STOP_REVIEW_READY ${trace.stopReviewerTask.id}`, 30_000)
  const liveStopTask = await trace.store.get(trace.stopReviewerTask.id, value.sessionId)
  if (!liveStopTask?.leaseOwner || liveStopTask.status !== "running") throw new Error("Stop-review fixture did not hold a live Worker lease")
  const stopFence = selectedJobTaskFence(liveStopTask, liveStopTask.leaseOwner, liveStopTask.attemptCount)
  const interrupted = await trace.store.interruptSubtree({
    sessionId: value.sessionId, rootTaskId: trace.rootTaskId, targetPath: liveStopTask.path, now: new Date(),
  })
  expect(interrupted).toBe(1)
  const stoppedReviewInput = {
    userId: value.userId, sessionId: value.sessionId, jobId: trace.jobId,
    artifactId: trace.artifactRef.artifactId, version: trace.artifactRef.version,
    contentHash: trace.artifactRef.contentHash, sourceDigest: trace.artifactRef.sourceDigest,
    currentSourceDigest: trace.currentPreparation.preparation.sourceDigest, status: "stale" as const,
    findings: [], evidenceRefs: [], taskId: trace.stopReviewerTask.id,
    toolCallId: `ac6-stop-review-write:${trace.stopReviewerTask.id}`,
    requestHash: hashArtifactContent({ op: "artifact.review", call: trace.stopReviewerTask.id, artifactRef: trace.artifactRef }),
    reviewHash: hashArtifactContent({ status: "stale", artifactRef: trace.artifactRef }), taskFence: stopFence,
  }
  await expect(artifactStore.saveReview(stoppedReviewInput)).rejects.toMatchObject({ code: "task_fence_denied" })
  const countAfterStop = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS "count" FROM "agent_artifact_review" WHERE "taskId" = $1`, [trace.stopReviewerTask.id],
  )
  expect(countAfterStop.rows[0]?.count).toBe(0)

  worker.stdin?.write(`release-selected-job-review:${trace.stopReviewerTask.id}\n`)
  const stoppedLine = await waitForProcessLine(worker, `P3_SELECTED_JOB_CHILD_SETTLED ${trace.stopReviewerTask.id} `, 30_000)
  const stoppedSettlement = selectedJobSettlement(stoppedLine, trace.stopReviewerTask.id)
  expect(stoppedSettlement).toMatchObject({
    managerStatus: "interrupted",
    observations: {
      sawBody: true, privateBodyAbsentBeforeRead: true, writerReceiptReferenceRecovered: true,
      sourceCanariesReloaded: { job: true, resume: true, persona: true },
      previousSourceCanariesAbsent: { job: true, resume: true, persona: true },
      preReadContextHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    },
  })
  const stoppedObservations = record(stoppedSettlement.observations)
  if (stoppedObservations?.reviewWriteError !== undefined && stoppedObservations.reviewWriteError !== null) {
    expect(stoppedObservations.reviewWriteError).toBe("private_artifact_review_failed")
  }
  const countAfterInterruptedSettlement = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS "count" FROM "agent_artifact_review" WHERE "taskId" = $1`, [trace.stopReviewerTask.id],
  )
  expect(countAfterInterruptedSettlement.rows[0]?.count).toBe(0)
  const [persistedItems, persistedEvents, persistedOutbox, persistedTasks] = await Promise.all([
    pool.query<{ content: unknown }>(`SELECT "content" FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = ANY($3::text[])`, [
      value.sessionId, value.turnId, [trace.writerTask.id, trace.reviewerTask.id, trace.stopReviewerTask.id],
    ]),
    pool.query<{ payload: unknown }>(`SELECT "payload" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = ANY($3::text[])`, [
      value.sessionId, value.turnId, [trace.writerTask.id, trace.reviewerTask.id, trace.stopReviewerTask.id],
    ]),
    pool.query<{ payload: unknown }>(`SELECT "payload" FROM "agent_outbox" WHERE "topic" = 'agent.events' AND "aggregateId" = $1`, [value.sessionId]),
    pool.query<{ context: unknown; result: unknown }>(`SELECT "context", "result" FROM "sub_agent_tasks"
      WHERE "sessionId" = $1 AND ("id" = $2 OR "rootTaskId" = $2)`, [value.sessionId, trace.rootTaskId]),
  ])
  expect(persistedItems.rows.length).toBeGreaterThan(0)
  expect(persistedEvents.rows.length).toBeGreaterThan(0)
  expect(persistedTasks.rows.length).toBeGreaterThanOrEqual(3)
  const publicPersistence = JSON.stringify({
    items: persistedItems.rows.map(row => row.content),
    events: persistedEvents.rows.map(row => row.payload),
    outbox: persistedOutbox.rows.map(row => row.payload),
    tasks: persistedTasks.rows,
  })
  expect(publicPersistence).not.toContain(trace.body)
  const sourceCanaries = [...selectedJobSourceCanaries(trace.jobId, 1), ...selectedJobSourceCanaries(trace.jobId, 2)]
  for (const canary of sourceCanaries) expect(publicPersistence).not.toContain(canary)
  const processLogs = [...firstWorker.output, ...firstWorker.errors, ...worker.output, ...worker.errors].join("\n")
  expect(processLogs).not.toContain(trace.body)
  for (const canary of sourceCanaries) expect(processLogs).not.toContain(canary)
  const draftReceipts = persistedItems.rows.flatMap(row => rowsForToolCall(row.content, trace.writerDraftCallId))
    .filter(row => Object.prototype.hasOwnProperty.call(row, "output"))
  expect(draftReceipts.length).toBeGreaterThan(0)
  const readReceipts = persistedItems.rows.flatMap(row => rowsForToolCall(row.content, readCallId))
    .filter(row => Object.prototype.hasOwnProperty.call(row, "output"))
  const reviewReceipts = persistedItems.rows.flatMap(row => rowsForToolCall(row.content, reviewCallId))
    .filter(row => Object.prototype.hasOwnProperty.call(row, "output"))
  expect(readReceipts.length).toBeGreaterThan(0)
  expect(reviewReceipts.length).toBeGreaterThan(0)
  for (const receipt of draftReceipts) {
    const output = record(receipt.output)
    expect(output).not.toBeNull()
    expect(Object.keys(output ?? {}).sort()).toEqual(["artifactRef"])
  }
}

function rowsForToolCall(value: unknown, callId: string): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(item => rowsForToolCall(item, callId))
  if (!value || typeof value !== "object") return []
  const row = value as Record<string, unknown>
  const matched = row.toolCallId === callId ? [row] : []
  return [...matched, ...Object.values(row).flatMap(child => rowsForToolCall(child, callId))]
}

function latestToolResult(request: HarnessModelRequest, callId: string): unknown {
  for (let messageIndex = request.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const content = request.messages[messageIndex]!.content
    for (let partIndex = content.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = content[partIndex]!
      if (part.type !== "tool_result" || part.toolUseId !== callId) continue
      if (typeof part.content !== "string") return null
      try { return JSON.parse(part.content) as unknown } catch { return null }
    }
  }
  return null
}

function planTaskIds(request: HarnessModelRequest, callId = PLAN_CALL_ID, expectedCount = 2): string[] {
  const output = record(latestToolResult(request, callId))
  if (!output || (output.status !== "accepted" && output.status !== "duplicate") || !Array.isArray(output.nodes)) {
    throw new Error("TaskGraph plan receipt missing from the next root model request")
  }
  const ids = output.nodes.flatMap(value => {
    const node = record(value)
    return node && typeof node.taskId === "string" ? [node.taskId] : []
  })
  if (ids.length !== expectedCount) throw new Error(`Expected ${expectedCount} planned task ID(s); received ${ids.length}`)
  return ids
}

function completedGraphStatusFailureProjection(graph: unknown): RecordValue {
  const graphNodes = record(graph)?.nodes
  const nodes = Array.isArray(graphNodes) ? graphNodes.map(record) : []
  return {
    nodes: COMPLETED_GRAPH_STATUS_EXPECTATIONS.map(expected => {
      const matches = nodes.filter(node => node?.key === expected.key)
      const node = matches[0]
      const status = diagnosticEnum(node?.status, TASK_DIAGNOSTIC_STATUSES)
      const readiness = diagnosticEnum(node?.readiness, TASK_GRAPH_READINESS)
      return {
        key: expected.key,
        status,
        readiness,
        expectedMatch: matches.length === 1 && status === expected.status && readiness === "terminal",
      }
    }),
  }
}

function failurePreflightEvidenceProjection(input: {
  rootTaskLookupCompleted: boolean
  rootTaskId: string | null
  expectedTurnId: string
  expectedTaskIds: readonly string[]
  targets: readonly FailurePreflightTargetObservation[]
}): RecordValue {
  const rootTaskFound = input.rootTaskLookupCompleted ? Boolean(input.rootTaskId) : null
  return {
    rootTaskFound,
    targets: FAILURE_PREFLIGHT_TARGET_KEYS.map((key, index) => {
      const target = input.targets[index] ?? null
      if (!target) {
        return {
          key, found: null, targetMatchesReceipt: null,
          turnMatches: null, rootMatches: null, parentMatches: null,
        }
      }
      if (!target.found) {
        return {
          key, found: false, targetMatchesReceipt: null,
          turnMatches: null, rootMatches: null, parentMatches: null, scope: target.scope,
        }
      }
      return {
        key,
        found: true,
        targetMatchesReceipt: target.taskId === input.expectedTaskIds[index],
        turnMatches: target.turnId === input.expectedTurnId,
        rootMatches: rootTaskFound === true ? target.rootTaskId === input.rootTaskId : null,
        parentMatches: rootTaskFound === true ? target.parentTaskId === input.rootTaskId : null,
      }
    }),
  }
}

function missingTaskScopeEvidence(input: {
  lookupCompleted: boolean
  observed: null | {
    sessionId: string | null
    sessionUserId: string | null
    turnId: string | null
    rootTaskId: string | null
    parentTaskId: string | null
  }
  expected: { sessionId: string; userId: string; turnId: string; rootTaskId: string }
}): FailurePreflightTargetScopeEvidence {
  if (!input.lookupCompleted) {
    return { lookupCompleted: false, rowFound: null, sessionMatches: null, userMatches: null,
      turnMatches: null, rootMatches: null, parentMatches: null }
  }
  if (!input.observed) {
    return { lookupCompleted: true, rowFound: false, sessionMatches: null, userMatches: null,
      turnMatches: null, rootMatches: null, parentMatches: null }
  }
  return {
    lookupCompleted: true, rowFound: true,
    sessionMatches: input.observed.sessionId === input.expected.sessionId,
    userMatches: input.observed.sessionUserId === input.expected.userId,
    turnMatches: input.observed.turnId === input.expected.turnId,
    rootMatches: input.observed.rootTaskId === input.expected.rootTaskId,
    parentMatches: input.observed.parentTaskId === input.expected.rootTaskId,
  }
}

async function missingTaskScopeFailureDiagnostics(
  pool: Pool,
  taskId: string,
  expected: { sessionId: string; userId: string; turnId: string; rootTaskId: string },
): Promise<FailurePreflightTargetScopeEvidence> {
  try {
    const result = await pool.query<{
      sessionId: string | null
      sessionUserId: string | null
      turnId: string | null
      rootTaskId: string | null
      parentTaskId: string | null
    }>(
      `SELECT task."sessionId", session."userId" AS "sessionUserId", task."turnId", task."rootTaskId", task."parentTaskId"
       FROM "sub_agent_tasks" AS task
       LEFT JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
       WHERE task."id" = $1 LIMIT 1`,
      [taskId],
    )
    return missingTaskScopeEvidence({ lookupCompleted: true, observed: result.rows[0] ?? null, expected })
  } catch {
    return missingTaskScopeEvidence({ lookupCompleted: false, observed: null, expected })
  }
}

function sameUniqueIds(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left), rightSet = new Set(right)
  return leftSet.size === left.length && rightSet.size === right.length && leftSet.size === rightSet.size
    && [...leftSet].every(value => rightSet.has(value))
}

function planReceiptEvidenceProjection(
  request: HarnessModelRequest,
  callId: string,
  graph: unknown,
): RecordValue {
  const parts = request.messages.flatMap(message => Array.isArray(message.content) ? message.content.map(record) : [])
  const matchingCalls = parts.filter(part => part?.type === "tool_use" && part.id === callId)
  const matchingResults = parts.filter(part => part?.type === "tool_result" && part.toolUseId === callId)
  const planCalls = parts.filter(part => part?.type === "tool_use" && part.name === "agent.plan")
  const planCallIds = new Set(planCalls.flatMap(part => typeof part?.id === "string" ? [part.id] : []))
  const planResults = parts.filter(part => part?.type === "tool_result"
    && (planCallIds.has(String(part.toolUseId)) || part.toolUseId === callId))
  const currentNodes = record(graph)?.nodes
  const graphTaskIds = Array.isArray(currentNodes)
    ? currentNodes.map(record).flatMap(node => typeof node?.taskId === "string" ? [node.taskId] : [])
    : []
  const parsedResults = matchingResults.map(part => {
    if (typeof part?.content !== "string") return null
    try { return record(JSON.parse(part.content) as unknown) } catch { return null }
  })
  const output = record(parsedResults.at(-1))
  const nodes = Array.isArray(output?.nodes) ? output.nodes.map(record).filter((node): node is RecordValue => node !== null) : []
  const taskIds = nodes.flatMap(node => typeof node.taskId === "string" && node.taskId.trim().length > 0 ? [node.taskId] : [])
  const planNames = [...new Set(planCalls.map(part => part?.name === "agent.plan" ? "agent.plan" : "other"))].slice(0, 2)
  const graphTaskIdSet = new Set(graphTaskIds)
  return {
    expectedCallMatched: matchingCalls.length > 0 && matchingResults.length > 0,
    matchingToolUseCount: matchingCalls.length,
    matchingToolNameIsAgentPlan: matchingCalls.some(part => part?.name === "agent.plan"),
    planToolUseCount: planCalls.length,
    planToolNames: planNames,
    matchingToolResultCount: matchingResults.length,
    matchingResultIsError: matchingResults.length === 0 ? null : matchingResults.at(-1)?.isError === true,
    planToolResultCount: planResults.length,
    resultCallIdMatchesPlanCall: matchingResults.length > 0 && planCallIds.has(callId),
    resultContentType: matchingResults.at(-1) ? diagnosticValueType(matchingResults.at(-1)?.content) : "missing",
    resultJsonParsed: parsedResults.at(-1) !== null && parsedResults.at(-1) !== undefined,
    receiptStatus: output?.status === "accepted" || output?.status === "duplicate" ? output.status : output ? "other" : "missing",
    resultErrorCodePresent: typeof output?.errorCode === "string",
    receiptRevision: typeof output?.revision === "number" && Number.isSafeInteger(output.revision) && output.revision >= 0
      ? output.revision
      : null,
    receiptNodeCount: Array.isArray(output?.nodes) ? output.nodes.length : null,
    receiptTaskIdCount: taskIds.length,
    graphTaskIdCount: graphTaskIds.length,
    receiptTaskIdsMatchingGraphCount: taskIds.filter(taskId => graphTaskIdSet.has(taskId)).length,
    receiptTaskIdsEqualGraphSet: graphTaskIds.length === 0 ? null : sameUniqueIds(taskIds, graphTaskIds),
  }
}

async function collectPlanReceiptFailureDiagnostics(
  pool: Pool,
  turnId: string,
  request: HarnessModelRequest,
  callId: string,
  graph: unknown,
): Promise<string> {
  try {
    const persisted = await pool.query<{ type: string; status: string; revision: number; content: unknown }>(
      `SELECT "type", "status", "revision", "content" FROM "agent_items"
       WHERE "turnId" = $1 AND "type" IN ('tool_call', 'tool_result')
       ORDER BY "createdAt" DESC LIMIT 40`,
      [turnId],
    )
    const persistedItems = [...persisted.rows].reverse()
    const callItems = persistedItems.filter(row => row.type === "tool_call" && record(row.content)?.toolName === "agent.plan")
    const expectedCallItems = callItems.filter(row => record(row.content)?.toolCallId === callId)
    const planCallIds = new Set(callItems.flatMap(row => {
      const id = record(row.content)?.toolCallId
      return typeof id === "string" ? [id] : []
    }))
    const resultItems = persistedItems.filter(row => row.type === "tool_result"
      && (planCallIds.has(String(record(row.content)?.toolCallId)) || record(row.content)?.toolCallId === callId))
    const expectedResultItems = resultItems.filter(row => record(row.content)?.toolCallId === callId)
    const expectedResult = record(expectedResultItems.at(-1)?.content)
    const output = record(expectedResult?.output)
    const nodes = Array.isArray(output?.nodes) ? output.nodes.map(record).filter((node): node is RecordValue => node !== null) : []
    const taskIds = nodes.flatMap(node => typeof node.taskId === "string" && node.taskId.trim().length > 0 ? [node.taskId] : [])
    const graphNodes = record(graph)?.nodes
    const graphTaskIds = Array.isArray(graphNodes)
      ? graphNodes.map(record).flatMap(node => typeof node?.taskId === "string" ? [node.taskId] : [])
      : []
    const graphTaskIdSet = new Set(graphTaskIds)
    const requestProjection = planReceiptEvidenceProjection(request, callId, graph)
    const persistedProjection = {
      expectedCallMatched: expectedCallItems.length > 0 && expectedResultItems.length > 0,
      matchingToolUseCount: expectedCallItems.length,
      matchingToolNameIsAgentPlan: expectedCallItems.some(row => record(row.content)?.toolName === "agent.plan"),
      callItemStatus: diagnosticEnum(expectedCallItems.at(-1)?.status, ITEM_DIAGNOSTIC_STATUSES),
      planToolUseCount: callItems.length,
      planToolNames: [...new Set(callItems.map(row => record(row.content)?.toolName === "agent.plan" ? "agent.plan" : "other"))].slice(0, 2),
      matchingToolResultCount: expectedResultItems.length,
      matchingResultIsError: expectedResultItems.length === 0 ? null : expectedResultItems.at(-1)?.status !== "completed",
      planToolResultCount: resultItems.length,
      resultItemStatus: diagnosticEnum(expectedResultItems.at(-1)?.status, ITEM_DIAGNOSTIC_STATUSES),
      resultItemRevision: diagnosticBoundedCount(expectedResultItems.at(-1)?.revision),
      resultCallIdMatchesPlanCall: typeof expectedResult?.toolCallId === "string" && planCallIds.has(expectedResult.toolCallId),
      resultErrorCodePresent: typeof expectedResult?.errorCode === "string",
      receiptStatus: output?.status === "accepted" || output?.status === "duplicate" ? output.status : output ? "other" : "missing",
      receiptRevision: diagnosticBoundedCount(output?.revision),
      receiptNodeCount: Array.isArray(output?.nodes) ? output.nodes.length : null,
      receiptTaskIdCount: taskIds.length,
      graphTaskIdCount: graphTaskIds.length,
      receiptTaskIdsMatchingGraphCount: taskIds.filter(taskId => graphTaskIdSet.has(taskId)).length,
      receiptTaskIdsEqualGraphSet: graphTaskIds.length === 0 ? null : sameUniqueIds(taskIds, graphTaskIds),
    }
    const requestResultMatchesPersisted = requestProjection.expectedCallMatched === persistedProjection.expectedCallMatched
      && requestProjection.matchingToolUseCount === persistedProjection.matchingToolUseCount
      && requestProjection.matchingToolNameIsAgentPlan === persistedProjection.matchingToolNameIsAgentPlan
      && requestProjection.planToolUseCount === persistedProjection.planToolUseCount
      && JSON.stringify(requestProjection.planToolNames) === JSON.stringify(persistedProjection.planToolNames)
      && requestProjection.matchingToolResultCount === persistedProjection.matchingToolResultCount
      && requestProjection.matchingResultIsError === persistedProjection.matchingResultIsError
      && requestProjection.planToolResultCount === persistedProjection.planToolResultCount
      && requestProjection.resultCallIdMatchesPlanCall === persistedProjection.resultCallIdMatchesPlanCall
      && requestProjection.receiptStatus === persistedProjection.receiptStatus
      && requestProjection.resultErrorCodePresent === persistedProjection.resultErrorCodePresent
      && requestProjection.receiptRevision === persistedProjection.receiptRevision
      && requestProjection.receiptNodeCount === persistedProjection.receiptNodeCount
      && requestProjection.receiptTaskIdCount === persistedProjection.receiptTaskIdCount
      && requestProjection.receiptTaskIdsMatchingGraphCount === persistedProjection.receiptTaskIdsMatchingGraphCount
      && requestProjection.receiptTaskIdsEqualGraphSet === persistedProjection.receiptTaskIdsEqualGraphSet
    return boundedDiagnostic(JSON.stringify({
      available: true,
      expectedCallMatched: requestProjection.expectedCallMatched === true && persistedProjection.expectedCallMatched === true,
      request: requestProjection,
      persisted: persistedProjection,
      requestResultMatchesPersisted,
    }), 1_200)
  } catch {
    return JSON.stringify({ available: false })
  }
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

function startTaskGraphRestartWorker(
  mode: "park-parent" | "resume-parent" | "park-discovery" | "resume-discovery" | "worker2-input-guard-self-test",
  value: Record<string, unknown>,
  envOverrides: Record<string, string> = {},
): ProcessFixtureChild {
  const child = spawn(process.execPath, ["--import", "tsx", processRestartFixturePath, mode, JSON.stringify(value)], {
    cwd: processRestartWorkerCwd,
    env: {
      ...process.env,
      ...(redisUrl ? { REDIS_URL: redisUrl } : {}),
      ...(databaseUrl ? { AGENT_RUNTIME_PG_TEST_URL: databaseUrl } : {}),
      ...envOverrides,
    },
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
  const initialWaitLineage = record(source.initialWaitLineage)
  if (initialWaitLineage) {
    const lineage: RecordValue = {}
    for (const key of [
      "proposalEventFound", "requestResultTaskIdentityMapMatchesEventReceipt",
      "eventReceiptTaskIdentityMapMatchesEmbeddedContent",
      "embeddedContentTaskIdentityMapMatchesCurrentPersistedItem",
      "embeddedContentTaskIdentityMapMatchesPayloadContent",
      "proposalEventRevisionMatchesReceipt", "proposalEventRevisionMatchesEmbeddedItem",
      "proposalEventRevisionMatchesCurrentPersistedItemRow",
    ]) {
      const value = initialWaitLineage[key]
      if (typeof value === "boolean" || value === null) lineage[key] = value
    }
    for (const key of [
      "eventReceiptEmbeddedTaskIdentityMapMismatchKeys", "embeddedCurrentPersistedTaskIdentityMapMismatchKeys",
      "embeddedPayloadTaskIdentityMapMismatchKeys",
    ]) {
      const safeValues = diagnosticEnumList(initialWaitLineage[key], TASK_GRAPH_DIAGNOSTIC_PROPOSAL_NODE_KEYS)
      if (safeValues.length > 0) lineage[key] = safeValues
    }
    for (const key of [
      "proposalReceiptFound", "requestMatchesReceipt", "requestMatchesCurrentGraph",
      "proposalMatchesGraph", "proposalRevisionMatchesGraph", "persistedItemReadSucceeded",
      "persistedItemFound", "persistedItemValid", "proposalMatchesPersistedItem", "persistedItemMatchesGraph",
      "planToolPairMatches", "planExpectedRevisionMatches",
    ]) {
      if (typeof initialWaitLineage[key] === "boolean") lineage[key] = initialWaitLineage[key]
    }
    const safeNodeKeys = diagnosticEnumList(initialWaitLineage.graphNodeKeysMissingReceipt, TASK_GRAPH_DIAGNOSTIC_NODE_KEYS)
    if (safeNodeKeys.length > 0) lineage.graphNodeKeysMissingReceipt = safeNodeKeys
    for (const key of ["receiptPersistedMismatchKeys", "persistedGraphMismatchKeys"]) {
      const safeValues = diagnosticEnumList(initialWaitLineage[key], TASK_GRAPH_DIAGNOSTIC_NODE_KEYS)
      if (safeValues.length > 0) lineage[key] = safeValues
    }
    for (const key of [
      "proposalNodeCount", "graphNodeCount", "receiptRevision", "graphRevision",
      "persistedItemNodeCount", "persistedItemRevision",
      "requestedIdsOutsideReceiptCount", "requestedIdsOutsideGraphCount",
      "planToolUseCount", "planToolResultCount", "planExpectedRevision",
    ]) {
      const safeValue = diagnosticBoundedCount(initialWaitLineage[key])
      if (safeValue !== null) lineage[key] = safeValue
    }
    const proposalEventRevision = initialWaitLineage.proposalEventRevision
    if (proposalEventRevision === null) {
      lineage.proposalEventRevision = null
    } else {
      const safeRevision = diagnosticBoundedCount(proposalEventRevision)
      if (safeRevision !== null) lineage.proposalEventRevision = safeRevision
    }
    if (Object.keys(lineage).length > 0) projected.initialWaitLineage = lineage
  }
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

function jsonObjectEnd(source: string, start: number): number | null {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === "{") depth += 1
    else if (character === "}") {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  return null
}

function safeRestoredSourceProjectionEnum(value: unknown, allowed: ReadonlySet<string>): string {
  if (value === null || value === undefined) return "missing"
  return typeof value === "string" && allowed.has(value) ? value : "other"
}

function safeRestoredSourceProjectionCount(value: unknown): number | null {
  if (value === null || value === undefined) return null
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, RESTORED_SOURCE_PROJECTION_DIAGNOSTIC_COUNT_LIMIT)
    : null
}

function restoredSourceProjectionFailureSafeValue(parentModelFailure: string | null): string {
  const marker = "p3_restored_graph_source_projection_missing:"
  const markerIndex = parentModelFailure?.indexOf(marker) ?? -1
  if (markerIndex < 0 || !parentModelFailure) return "unavailable"
  const jsonStart = markerIndex + marker.length
  if (parentModelFailure[jsonStart] !== "{") return "unavailable"
  const jsonEnd = jsonObjectEnd(parentModelFailure, jsonStart)
  if (jsonEnd === null) return "unavailable"

  let parsed: unknown
  try { parsed = JSON.parse(parentModelFailure.slice(jsonStart, jsonEnd)) as unknown } catch { return "unavailable" }
  const source = record(parsed)
  if (!source) return "unavailable"

  const projection: RecordValue = {
    category: safeRestoredSourceProjectionEnum(source.category, RESTORED_SOURCE_PROJECTION_CATEGORIES),
  }
  const enumFields: ReadonlyArray<readonly [string, ReadonlySet<string>]> = [
    ["shape", RESTORED_SOURCE_PROJECTION_SHAPES],
    ["schema", RESTORED_SOURCE_PROJECTION_SCHEMAS],
    ["availability", RESTORED_SOURCE_PROJECTION_AVAILABILITIES],
    ["role", RESTORED_SOURCE_PROJECTION_ROLES],
    ["status", RESTORED_SOURCE_PROJECTION_STATUSES],
    ["invalidField", RESTORED_SOURCE_PROJECTION_INVALID_FIELDS],
    ["candidateIdentity", RESTORED_SOURCE_PROJECTION_IDENTITIES],
  ]
  for (const [field, allowed] of enumFields) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      projection[field] = safeRestoredSourceProjectionEnum(source[field], allowed)
    }
  }
  for (const field of ["candidateCount", "evidenceCount", "candidateArrayCount"]) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      projection[field] = safeRestoredSourceProjectionCount(source[field])
    }
  }
  return boundedDiagnostic(JSON.stringify(projection), 500)
}

function parentModelFailureDiagnosticFields(parentModelFailure: string | null): FailureDiagnosticField[] {
  const value = parentModelFailure ?? "<not captured>"
  return [
    { label: "parentModelFailure", value },
    {
      label: "restoredSourceProjection",
      value,
      safeValue: restoredSourceProjectionFailureSafeValue(parentModelFailure),
    },
  ]
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
          ORDER BY "sequence" DESC LIMIT 40`, [turn.sessionId, turn.id, graphResult.rows[0].id])
      : null
    const proposalPayloads = proposalResult?.rows.map(row => row.payload) ?? []
    const proposalCandidate = proposalReceiptForWait(requestedIds, proposalPayloads)
    const failureReceipt = {
      ...failedWaitReceiptProjection(requestedIds, proposalPayloads),
      proposalReceiptHistoryMayBeTruncated: proposalPayloads.length === 40,
    }
    const rawProposalNodes = proposalCandidate?.rawNodes ?? []
    const proposalNodes = proposalCandidate?.nodes ?? []
    const proposalTaskIds = proposalCandidate?.taskIds ?? diagnosticIdList(null)
    const proposalReceiptFound = proposalCandidate !== null
    const requestMatchesReceipt = proposalReceiptFound
      ? diagnosticIdListsMatch(requestedIds, proposalTaskIds)
      : null
    const requestedTaskIdsPresentInCurrentGraph = diagnosticIdListContainsAll(requestedIds, graphIds)

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
      requestedTaskIdsPresentInCurrentGraph,
      proposalReceiptFound,
      ...failureReceipt,
      proposalNodeCount: rawProposalNodes.length,
      requestMatchesReceipt,
      requestMatchesCurrentGraph: taskIdsMatchCurrentGraph,
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

  it("projects requested wait task containment separately from exact graph equality", () => {
    const projected = JSON.parse(compactTurnProgressDiagnostics(JSON.stringify({
      waitLineage: {
        taskIdsMatchCurrentGraph: false,
        requestedTaskIdsPresentInCurrentGraph: true,
      },
    }))) as RecordValue

    expect(projected).toMatchObject({
      waitLineage: { taskIdsMatchCurrentGraph: false, requestedTaskIdsPresentInCurrentGraph: true },
    })
  })

  it("selects the newest exact plan receipt when tool-use IDs repeat", () => {
    const request = {
      messages: [
        { role: "assistant", content: [{
          type: "tool_result", toolUseId: "reused-plan-call",
          content: JSON.stringify({ status: "accepted", nodes: [{ taskId: "stale-task" }] }),
        }] },
        { role: "assistant", content: [{
          type: "tool_result", toolUseId: "another-call",
          content: JSON.stringify({ status: "accepted", nodes: [{ taskId: "unrelated-task" }] }),
        }, {
          type: "tool_result", toolUseId: "reused-plan-call",
          content: JSON.stringify({ status: "accepted", nodes: [{ taskId: "latest-task" }] }),
        }] },
      ],
    } as unknown as HarnessModelRequest

    expect(planTaskIds(request, "reused-plan-call", 1)).toEqual(["latest-task"])

    const invalidLatestReceipt = {
      ...request,
      messages: [...request.messages, { role: "assistant", content: [{
        type: "tool_result", toolUseId: "reused-plan-call", content: "{invalid json",
      }] }],
    } as unknown as HarnessModelRequest
    expect(() => planTaskIds(invalidLatestReceipt, "reused-plan-call", 1)).toThrow("TaskGraph plan receipt missing")
  })

  it("accepts a replayed duplicate plan receipt while validating its task IDs", () => {
    const request = {
      messages: [{ role: "assistant", content: [{
        type: "tool_result", toolUseId: "replayed-plan-call",
        content: JSON.stringify({ status: "duplicate", nodes: [{ key: "verification", taskId: "replayed-task" }] }),
      }] }],
    } as unknown as HarnessModelRequest

    expect(planTaskIds(request, "replayed-plan-call", 1)).toEqual(["replayed-task"])

    const invalidStatus = {
      ...request,
      messages: [{ role: "assistant", content: [{
        type: "tool_result", toolUseId: "replayed-plan-call",
        content: JSON.stringify({ status: "failed", nodes: [{ key: "verification", taskId: "replayed-task" }] }),
      }] }],
    } as unknown as HarnessModelRequest
    expect(() => planTaskIds(invalidStatus, "replayed-plan-call", 1)).toThrow("TaskGraph plan receipt missing")

    const malformedDuplicate = {
      ...request,
      messages: [{ role: "assistant", content: [{
        type: "tool_result", toolUseId: "replayed-plan-call",
        content: JSON.stringify({ status: "duplicate", nodes: [{ key: "verification" }] }),
      }] }],
    } as unknown as HarnessModelRequest
    expect(() => planTaskIds(malformedDuplicate, "replayed-plan-call", 1)).toThrow("Expected 1 planned task ID(s); received 0")
  })

  it("projects plan receipt identifiers and revisions without exposing request payloads", () => {
    const privateTaskId = "private-task-verification"
    const privatePrompt = "private-plan-prompt"
    const request = {
      messages: [
        { role: "assistant", content: [{
          type: "tool_use", id: "follow-up-plan", name: "agent.plan", input: { goal: privatePrompt },
        }] },
        { role: "tool", content: [{
          type: "tool_result", toolUseId: "follow-up-plan",
          content: JSON.stringify({
            status: "accepted", revision: 12,
            nodes: [{ key: "verification", taskId: privateTaskId, goal: privatePrompt }],
          }),
        }] },
      ],
    } as unknown as HarnessModelRequest

    const evidence = planReceiptEvidenceProjection(request, "follow-up-plan", {
      nodes: [{ key: "verification", taskId: privateTaskId }],
    })

    expect(evidence).toMatchObject({
      expectedCallMatched: true, matchingToolUseCount: 1, matchingToolNameIsAgentPlan: true,
      planToolUseCount: 1, planToolNames: ["agent.plan"],
      matchingToolResultCount: 1, matchingResultIsError: false,
      planToolResultCount: 1, resultContentType: "string", resultJsonParsed: true,
      receiptStatus: "accepted", receiptRevision: 12, receiptNodeCount: 1, receiptTaskIdCount: 1,
      graphTaskIdCount: 1, receiptTaskIdsMatchingGraphCount: 1, receiptTaskIdsEqualGraphSet: true,
    })
    expect(JSON.stringify(evidence)).not.toContain(privateTaskId)
    expect(JSON.stringify(evidence)).not.toContain(privatePrompt)
    expect(JSON.stringify(evidence)).not.toContain("follow-up-plan")

    const duplicateIds = {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "duplicate-plan", name: "agent.plan", input: {} }] },
        { role: "tool", content: [{
          type: "tool_result", toolUseId: "duplicate-plan",
          content: JSON.stringify({ status: "accepted", nodes: [
            { taskId: privateTaskId }, { taskId: privateTaskId },
          ] }),
        }] },
      ],
    } as unknown as HarnessModelRequest
    const duplicateEvidence = planReceiptEvidenceProjection(duplicateIds, "duplicate-plan", {
      nodes: [{ taskId: privateTaskId }, { taskId: "private-graph-other" }],
    })
    expect(duplicateEvidence).toMatchObject({
      receiptTaskIdCount: 2, graphTaskIdCount: 2, receiptTaskIdsMatchingGraphCount: 2,
      receiptTaskIdsEqualGraphSet: false,
    })
    expect(JSON.stringify(duplicateEvidence)).not.toContain(privateTaskId)
    expect(JSON.stringify(duplicateEvidence)).not.toContain("private-graph-other")
  })

  it("matches an initial four-task wait to its receipt after a later one-node proposal", () => {
    const initialTaskIds = ["private-source", "private-summary", "private-large", "private-rejected"]
    const nodeRows = (taskIds: readonly string[]) => taskIds.map((taskId, index) => ({
      key: ["source", "summary", "large-source", "rejected", "verification"][index], taskId,
    }))
    const latestFollowUpProposal = {
      kind: "proposal", receipt: { nodes: [{ key: "verification", taskId: "private-verification" }] },
    }
    const earlierInitialProposal = {
      kind: "proposal", receipt: { nodes: nodeRows(initialTaskIds) },
    }
    const requestedIds = diagnosticIdList(initialTaskIds)
    const selected = proposalReceiptForWait(requestedIds, [latestFollowUpProposal, earlierInitialProposal])
    const currentGraphIds = diagnosticIdList([...initialTaskIds, "private-verification"])
    const safeProjection = {
      proposalNodeCount: selected?.rawNodes.length ?? null,
      requestMatchesReceipt: selected ? diagnosticIdListsMatch(requestedIds, selected.taskIds) : null,
      requestedTaskIdsPresentInCurrentGraph: diagnosticIdListContainsAll(requestedIds, currentGraphIds),
    }

    expect(safeProjection).toEqual({
      proposalNodeCount: 4, requestMatchesReceipt: true, requestedTaskIdsPresentInCurrentGraph: true,
    })
    expect(JSON.stringify(safeProjection)).not.toContain("private-")
  })

  it("projects an unmatched wait without selecting an unrelated proposal receipt", () => {
    const requestedIds = diagnosticIdList(["private-source", "private-summary"])
    const proposals = [
      { kind: "proposal", receipt: { nodes: [{ key: "verification", taskId: "private-follow-up" }] } },
      { kind: "proposal", receipt: { nodes: [{ key: "source", taskId: "private-source" }] } },
    ]
    const selected = proposalReceiptForWait(requestedIds, proposals)
    const safeProjection = {
      proposalReceiptFound: selected !== null,
      proposalNodeCount: selected?.rawNodes.length ?? 0,
      requestMatchesReceipt: selected ? diagnosticIdListsMatch(requestedIds, selected.taskIds) : null,
      requestedIdsOutsideReceiptCount: selected && requestedIds.valid && selected.taskIds.valid
        ? requestedIds.values.filter(id => !new Set(selected.taskIds.values).has(id)).length
        : null,
    }

    expect(selected).toBeNull()
    expect(safeProjection).toEqual({
      proposalReceiptFound: false, proposalNodeCount: 0, requestMatchesReceipt: null, requestedIdsOutsideReceiptCount: null,
    })
    expect(JSON.stringify(safeProjection)).not.toContain("private-")
  })

  it("projects the closest prior receipt for four unmatched wait IDs without conflating matches", () => {
    const requestedIds = diagnosticIdList([
      "private-source", "private-summary", "private-large", "private-rejected",
    ])
    const proposals = [{
      kind: "proposal",
      receipt: { nodes: [{ key: "verification", taskId: "private-unrelated" }] },
    }]
    const projection = failedWaitReceiptProjection(requestedIds, proposals)
    const waitToolResult = { matchedTaskIds: [] as string[] }
    const compact = compactTurnProgressDiagnostics(JSON.stringify({
      waitToolResult: { matchedTaskIds: { count: waitToolResult.matchedTaskIds.length } },
      waitLineage: { proposalReceiptFound: projection.exactReceiptMatchExists, ...projection },
    }))

    expect(proposalReceiptForWait(requestedIds, proposals)).toBeNull()
    expect(JSON.parse(compact)).toMatchObject({
      waitToolResult: { matchedTaskCount: 0 },
      waitLineage: {
        proposalReceiptFound: false,
        exactReceiptMatchExists: false,
        proposalReceiptCandidateCount: 1,
        closestReceiptNodeCount: 1,
        closestReceiptNodeKeys: ["verification"],
        requestedIdsOutsideReceiptCount: 4,
      },
    })
    expect(Buffer.byteLength(JSON.stringify(projection), "utf8")).toBeLessThanOrEqual(1_200)
    expect(JSON.stringify(projection)).not.toContain("private-")
  })

  it("projects only the finite preflight stage and sanitized error class", () => {
    const marker = "private-task-and-exception-message"
    const output = combineFailureDiagnostics([
      { label: "failedPrerequisitePreflight", value: "captured" },
      { label: "failurePreflightStage", value: marker, safeValue: "first_target_lineage" },
      { label: "failurePreflightErrorClass", value: marker, safeValue: "assertion" },
    ], "{}")

    expect(output).toContain("failurePreflightStage=first_target_lineage")
    expect(output).toContain("failurePreflightErrorClass=assertion")
    expect(output).not.toContain(marker)
  })

  it("surfaces only a valid restored source projection classification", () => {
    const parentFailure = "P3_PARENT_MODEL_FAILURE Error: p3_restored_graph_source_projection_missing:{"
      + '"category":"wrong_role","schema":"expected","availability":"available","role":"other",'
      + '"status":"completed","candidateCount":1,"evidenceCount":1,"candidateArrayCount":1,'
      + '"candidateIdentity":"unchecked","extra":"private-projection-payload"} at private-fixture-path'
    const safeValue = restoredSourceProjectionFailureSafeValue(parentFailure)
    const output = combineFailureDiagnostics(parentModelFailureDiagnosticFields(parentFailure), "{}")

    expect(JSON.parse(safeValue)).toEqual({
      category: "wrong_role", schema: "expected", availability: "available", role: "other",
      status: "completed", candidateIdentity: "unchecked", candidateCount: 1,
      evidenceCount: 1, candidateArrayCount: 1,
    })
    expect(output).toContain('restoredSourceProjection={"category":"wrong_role"')
    expect(output).not.toContain("private-projection-payload")
    expect(output).not.toContain("private-fixture-path")
    expect(output).not.toContain("P3_PARENT_MODEL_FAILURE")
  })

  it("projects a missing source projection category to the whitelisted missing value", () => {
    const parentFailure = "P3_PARENT_MODEL_FAILURE Error: p3_restored_graph_source_projection_missing:{"
      + '"role":"scout","candidateCount":1} at fixture'

    expect(JSON.parse(restoredSourceProjectionFailureSafeValue(parentFailure))).toEqual({
      category: "missing", role: "scout", candidateCount: 1,
    })
  })

  it("strips malformed and private restored projection diagnostic content", () => {
    const canary = "private-role-and-candidate-id"
    const privateFailure = "P3_PARENT_MODEL_FAILURE Error: p3_restored_graph_source_projection_missing:{"
      + `"category":"wrong_role","role":"${canary}","candidateIdentity":"${canary}",`
      + `"candidateCount":"${canary}","extra":"${canary}"} at ${canary}`
    const safeValue = restoredSourceProjectionFailureSafeValue(privateFailure)
    const malformed = "P3_PARENT_MODEL_FAILURE Error: p3_restored_graph_source_projection_missing:{\"category\":"
    const output = combineFailureDiagnostics([
      { label: "restoredSourceProjection", value: privateFailure, safeValue },
      { label: "malformedSourceProjection", value: malformed, safeValue: restoredSourceProjectionFailureSafeValue(malformed) },
    ], "{}")

    expect(JSON.parse(safeValue)).toEqual({ category: "wrong_role", role: "other", candidateIdentity: "other", candidateCount: null })
    expect(output).toContain("malformedSourceProjection=unavailable")
    expect(output).not.toContain(canary)
    expect(output).not.toContain("P3_PARENT_MODEL_FAILURE")
  })

  it("reports an absent restored projection marker as unavailable", () => {
    expect(restoredSourceProjectionFailureSafeValue(null)).toBe("unavailable")
    expect(restoredSourceProjectionFailureSafeValue("P3_PARENT_MODEL_FAILURE Error: p3_other_failure")).toBe("unavailable")
  })

  it("caps restored source projection diagnostic counts", () => {
    const parentFailure = "P3_PARENT_MODEL_FAILURE Error: p3_restored_graph_source_projection_missing:{"
      + `"category":"wrong_count","candidateCount":${Number.MAX_SAFE_INTEGER},`
      + '"evidenceCount":1000,"candidateArrayCount":-1} at fixture'
    const safeValue = restoredSourceProjectionFailureSafeValue(parentFailure)

    expect(JSON.parse(safeValue)).toEqual({
      category: "wrong_count", candidateCount: 99, evidenceCount: 99, candidateArrayCount: null,
    })
    expect(safeValue.length).toBeLessThan(500)
  })

  it("projects completed graph statuses by fixed node keys without exposing node payloads", () => {
    const privateIds = [
      "task-0f1d8f13-1d45-4f3d-b719-f2059186a010",
      "turn-82a86a40-736d-4460-b7b4-d67a69e6c611",
    ]
    const projection = completedGraphStatusFailureProjection({
      kind: "task_graph_current",
      nodes: [
        { key: "source", taskId: privateIds[0], goal: "private source goal", status: "completed", readiness: "terminal" },
        { key: "summary", taskId: privateIds[1], goal: "private summary goal", status: "completed", readiness: "terminal" },
        { key: "large-source", taskId: "private-large", status: "completed", readiness: "terminal" },
        { key: "rejected", taskId: "private-rejected", status: "failed", readiness: "terminal" },
        { key: "verification", taskId: "private-verification", status: "completed", readiness: "active" },
      ],
    })

    expect(projection).toEqual({ nodes: [
      { key: "source", status: "completed", readiness: "terminal", expectedMatch: true },
      { key: "summary", status: "completed", readiness: "terminal", expectedMatch: true },
      { key: "large-source", status: "completed", readiness: "terminal", expectedMatch: true },
      { key: "rejected", status: "failed", readiness: "terminal", expectedMatch: false },
      { key: "verification", status: "completed", readiness: "active", expectedMatch: false },
    ] })
    const serialized = JSON.stringify(projection)
    expect(serialized.length).toBeLessThanOrEqual(1_200)
    for (const privateId of privateIds) expect(serialized).not.toContain(privateId)
    expect(serialized).not.toContain("private-")
    expect(serialized).not.toContain("private source goal")
  })

  it("projects failed-prerequisite root and target lineage as booleans only", () => {
    const privateIds = {
      root: "root-7034c44b-a4a4-445e-a71a-adb33e095901",
      turn: "turn-8ee6dc90-f10e-4bc9-a355-0cc9ea73d109",
      targetOne: "target-32ab89f6-090b-4337-945b-cfab5a85da3b",
      targetTwo: "target-2b578e50-bdbb-4fb8-85b3-5434651b2b8e",
      mismatchedParent: "parent-c6b882f7-2af1-4bb6-8f26-b9003c96c3fe",
    }
    const projection = failurePreflightEvidenceProjection({
      rootTaskLookupCompleted: true,
      rootTaskId: privateIds.root,
      expectedTurnId: privateIds.turn,
      expectedTaskIds: [privateIds.targetOne, privateIds.targetTwo],
      targets: [
        {
          found: true, taskId: privateIds.targetOne, turnId: privateIds.turn,
          rootTaskId: privateIds.root, parentTaskId: privateIds.root,
        },
        {
          found: true, taskId: privateIds.targetTwo, turnId: privateIds.turn,
          rootTaskId: privateIds.root, parentTaskId: privateIds.mismatchedParent,
        },
      ],
    })

    expect(projection).toEqual({ rootTaskFound: true, targets: [
      {
        key: "prerequisite", found: true, targetMatchesReceipt: true,
        turnMatches: true, rootMatches: true, parentMatches: true,
      },
      {
        key: "dependent", found: true, targetMatchesReceipt: true,
        turnMatches: true, rootMatches: true, parentMatches: false,
      },
    ] })
    const serialized = JSON.stringify(projection)
    expect(serialized.length).toBeLessThanOrEqual(1_200)
    for (const privateId of Object.values(privateIds)) expect(serialized).not.toContain(privateId)
  })

  it("projects missing-task database scope evidence as bounded booleans only", () => {
    const privateIds = {
      session: "private-session-id", user: "private-user-id", turn: "private-turn-id",
      root: "private-root-id", parent: "private-parent-id",
    }
    const expected = {
      sessionId: privateIds.session, userId: privateIds.user, turnId: privateIds.turn, rootTaskId: privateIds.root,
    }
    const mismatch = missingTaskScopeEvidence({
      lookupCompleted: true,
      observed: {
        sessionId: "other-session-id", sessionUserId: "other-user-id", turnId: privateIds.turn,
        rootTaskId: privateIds.root, parentTaskId: privateIds.parent,
      },
      expected,
    })
    const projection = failurePreflightEvidenceProjection({
      rootTaskLookupCompleted: true,
      rootTaskId: privateIds.root,
      expectedTurnId: privateIds.turn,
      expectedTaskIds: ["private-target-id"],
      targets: [{ found: false, scope: mismatch }, null],
    })

    expect(projection).toEqual({ rootTaskFound: true, targets: [
      {
        key: "prerequisite", found: false, targetMatchesReceipt: null,
        turnMatches: null, rootMatches: null, parentMatches: null,
        scope: {
          lookupCompleted: true, rowFound: true, sessionMatches: false, userMatches: false,
          turnMatches: true, rootMatches: true, parentMatches: false,
        },
      },
      {
        key: "dependent", found: null, targetMatchesReceipt: null,
        turnMatches: null, rootMatches: null, parentMatches: null,
      },
    ] })
    expect(missingTaskScopeEvidence({ lookupCompleted: true, observed: null, expected })).toMatchObject({
      lookupCompleted: true, rowFound: false,
    })
    expect(missingTaskScopeEvidence({ lookupCompleted: false, observed: null, expected })).toMatchObject({
      lookupCompleted: false, rowFound: null,
    })
    const serialized = JSON.stringify(projection)
    expect(serialized.length).toBeLessThanOrEqual(1_200)
    for (const privateId of Object.values(privateIds)) expect(serialized).not.toContain(privateId)
    expect(serialized).not.toContain("other-session-id")
    expect(serialized).not.toContain("other-user-id")
    expect(serialized).not.toContain("private-target-id")
  })

  it("distinguishes stale graph context from persisted receipt/snapshot lineage mismatch without exposing IDs", () => {
    const privateTaskIds = ["private-task-source", "private-task-summary"]
    const nodeRows = (ids: readonly string[]) => ids.map((taskId, index) => ({
      key: index === 0 ? "source" : "summary", taskId,
    }))
    const receipt = { status: "duplicate", revision: 1, nodes: nodeRows(privateTaskIds) }
    const storedSnapshot = { nodes: nodeRows(privateTaskIds) }
    const staleRequestGraph = { kind: "task_graph_current", revision: 1, nodes: nodeRows([privateTaskIds[0]!, "stale-task-summary"]) }
    const staleGraph = firstWaitPlanGraphMismatchProjection({
      requestReceipt: receipt, requestGraph: staleRequestGraph, persistedToolReceipt: receipt,
      persistedToolResultItemRevision: 1, persistedToolResultItemStatus: "completed", persistedReceipt: receipt,
      persistedSnapshot: storedSnapshot, persistedItemRevision: 1,
      persistedReceiptItem: { revision: 1, content: storedSnapshot },
    })
    expect(staleGraph).toMatchObject({
      diagnosis: "stale_request_graph_context",
      comparisons: {
        requestReceiptMatchesRequestGraph: false,
        requestGraphMatchesPersistedSnapshot: false,
        persistedReceiptMatchesSnapshot: true,
      },
      mismatchKeys: { requestReceiptGraph: ["summary"], requestGraphPersistedSnapshot: ["summary"] },
    })

    const divergentSnapshot = { nodes: nodeRows([privateTaskIds[0]!, "persisted-task-summary"]) }
    const persistedLineage = firstWaitPlanGraphMismatchProjection({
      requestReceipt: receipt,
      requestGraph: { kind: "task_graph_current", revision: 1, nodes: divergentSnapshot.nodes },
      persistedToolReceipt: receipt, persistedToolResultItemRevision: 1, persistedToolResultItemStatus: "completed",
      persistedReceipt: receipt, persistedSnapshot: divergentSnapshot, persistedItemRevision: 2,
      persistedReceiptItem: { revision: 1, content: storedSnapshot },
    })
    expect(persistedLineage).toMatchObject({
      diagnosis: "persisted_receipt_snapshot_lineage_mismatch",
      comparisons: {
        requestGraphMatchesPersistedSnapshot: true,
        persistedReceiptMatchesSnapshot: false,
        persistedReceiptMatchesEmbeddedSnapshot: true,
        embeddedSnapshotMatchesCurrentSnapshot: false,
      },
      mismatchKeys: { persistedReceiptSnapshot: ["summary"] },
    })
    expect(JSON.stringify([staleGraph, persistedLineage])).not.toContain("private-task")
    expect(JSON.stringify([staleGraph, persistedLineage])).not.toContain("stale-task-summary")
    expect(JSON.stringify([staleGraph, persistedLineage])).not.toContain("persisted-task-summary")
  })

  it("locates initial plan receipt divergence at the persisted tool result without exposing task IDs", () => {
    const keys = ["source", "summary", "large-source", "rejected"] as const
    const nodes = (prefix: string) => keys.map(key => ({ key, taskId: `${prefix}-${key}` }))
    const requestReceipt = { status: "accepted", revision: 1, nodes: nodes("request-task") }
    const durableNodes = nodes("durable-task").map(node => ({
      ...node, taskId: node.key === "source" || node.key === "summary"
        ? `request-task-${node.key}` : node.taskId,
    }))
    const durableReceipt = { status: "accepted", revision: 1, nodes: durableNodes }
    const persistedSnapshot = { nodes: durableNodes }
    const request = {
      messages: [{ role: "tool", content: [{
        type: "tool_result", toolUseId: "private-plan-call",
        content: JSON.stringify(requestReceipt),
      }] }],
    } as unknown as HarnessModelRequest

    const projection = firstWaitPlanGraphMismatchProjection({
      requestReceipt: latestToolResult(request, "private-plan-call"),
      requestGraph: { kind: "task_graph_current", revision: 3, nodes: durableNodes },
      persistedToolReceipt: requestReceipt,
      persistedToolResultItemRevision: 1,
      persistedToolResultItemStatus: "completed",
      persistedReceipt: durableReceipt,
      persistedSnapshot,
      persistedItemRevision: 3,
      persistedReceiptItem: { revision: 1, content: persistedSnapshot },
    })
    const serialized = JSON.stringify(projection)

    expect(projection).toMatchObject({
      diagnosis: "persisted_tool_receipt_proposal_mismatch",
      persisted: { toolResultItemRevision: 1, toolResultItemStatus: "completed", toolReceiptNodeCount: 4 },
      comparisons: {
        requestReceiptMatchesPersistedToolReceipt: true,
        persistedToolReceiptMatchesPersistedReceipt: false,
        persistedToolReceiptMatchesSnapshot: false,
        requestGraphMatchesPersistedSnapshot: true,
        persistedReceiptMatchesSnapshot: true,
      },
      mismatchKeys: {
        requestReceiptPersistedToolReceipt: [],
        persistedToolReceiptProposal: ["large-source", "rejected"],
        persistedToolReceiptSnapshot: ["large-source", "rejected"],
      },
    })
    for (const node of [...requestReceipt.nodes, ...durableReceipt.nodes]) expect(serialized).not.toContain(node.taskId)
    expect(serialized).not.toContain("private-plan-call")
    expect(serialized).not.toContain("request-task")
    expect(serialized).not.toContain("durable-task")
    expect(serialized.length).toBeLessThanOrEqual(1_200)
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
      initialWaitLineage: {
        proposalReceiptFound: true, proposalNodeCount: 2, graphNodeCount: 2,
        receiptRevision: 3, graphRevision: 4, proposalRevisionMatchesGraph: false,
        requestMatchesReceipt: true, requestMatchesCurrentGraph: false, proposalMatchesGraph: false,
        persistedItemReadSucceeded: true, persistedItemFound: true, persistedItemValid: true,
        persistedItemNodeCount: 2, persistedItemRevision: 3,
        proposalMatchesPersistedItem: true, persistedItemMatchesGraph: false,
        requestedIdsOutsideReceiptCount: 0, requestedIdsOutsideGraphCount: 1,
        planToolUseCount: 1, planToolResultCount: 1, planExpectedRevision: 0,
        planToolPairMatches: true, planExpectedRevisionMatches: true, planCallId: markers[0],
        graphNodeKeysMissingReceipt: ["summary", markers[0], "not-allowed"],
        receiptPersistedMismatchKeys: ["source", markers[0]],
        persistedGraphMismatchKeys: ["summary", markers[0]],
        taskIds: [markers[0]], rawError: markers[1],
      },
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
      initialWaitLineage: {
        proposalReceiptFound: true, proposalNodeCount: 2, graphNodeCount: 2,
        receiptRevision: 3, graphRevision: 4, proposalRevisionMatchesGraph: false,
        requestMatchesReceipt: true, requestMatchesCurrentGraph: false, proposalMatchesGraph: false,
        persistedItemReadSucceeded: true, persistedItemFound: true, persistedItemValid: true,
        persistedItemNodeCount: 2, persistedItemRevision: 3,
        proposalMatchesPersistedItem: true, persistedItemMatchesGraph: false,
        requestedIdsOutsideReceiptCount: 0, requestedIdsOutsideGraphCount: 1,
        planToolUseCount: 1, planToolResultCount: 1, planExpectedRevision: 0,
        planToolPairMatches: true, planExpectedRevisionMatches: true,
        graphNodeKeysMissingReceipt: ["summary"],
        receiptPersistedMismatchKeys: ["source"], persistedGraphMismatchKeys: ["summary"],
      },
      missingKeys: { requestedGraph: ["source"], graphTasks: ["summary"] },
      childStatusCounts: { failed: 1, completed: 2 },
      likelyCause: "wait_row_missing_or_parent_mismatch",
    })
    expect(projected).not.toHaveProperty("latestModelStepErrorClass")
    expect(projected).not.toHaveProperty("unknownNested")
    expect(markers.some(marker => output.includes(marker)), "diagnostic output must omit marker values").toBe(false)
    expect(output.length).toBeLessThanOrEqual(1_600)
  })

  it("redacts proposal event lineage markers while retaining safe comparisons and mismatch keys", () => {
    const markers = [
      "marker-proposal-event-id", "marker-request-result-text", "marker-event-receipt-id", "marker-embedded-content",
    ]
    const projectLineage = (initialWaitLineage: RecordValue) => {
      const prefix = "P3_PARENT_SUSPENSION_DIAGNOSTICS "
      const child = {
        pid: 42, exitCode: null, signalCode: null,
        output: [prefix + JSON.stringify({ initialWaitLineage })], errors: [],
      } as unknown as ProcessFixtureChild
      const output = processFixtureDiagnostics(child)
      const projected = JSON.parse(output.slice(output.indexOf(prefix) + prefix.length)) as RecordValue
      return { output, lineage: projected.initialWaitLineage }
    }

    const safe = projectLineage({
      proposalReceiptFound: true,
      proposalEventFound: true,
      requestResultTaskIdentityMapMatchesEventReceipt: false,
      eventReceiptTaskIdentityMapMatchesEmbeddedContent: null,
      embeddedContentTaskIdentityMapMatchesCurrentPersistedItem: true,
      embeddedContentTaskIdentityMapMatchesPayloadContent: false,
      proposalEventRevisionMatchesReceipt: true,
      proposalEventRevisionMatchesEmbeddedItem: null,
      proposalEventRevisionMatchesCurrentPersistedItemRow: false,
      proposalEventRevision: 17,
      eventReceiptEmbeddedTaskIdentityMapMismatchKeys: ["source", markers[0], "verification", "not-allowed"],
      embeddedCurrentPersistedTaskIdentityMapMismatchKeys: ["summary", markers[1]],
      embeddedPayloadTaskIdentityMapMismatchKeys: ["source", "verification", markers[2]],
      privateIdentifier: markers[3],
    })
    expect(safe.lineage).toEqual({
      proposalEventFound: true,
      requestResultTaskIdentityMapMatchesEventReceipt: false,
      eventReceiptTaskIdentityMapMatchesEmbeddedContent: null,
      embeddedContentTaskIdentityMapMatchesCurrentPersistedItem: true,
      embeddedContentTaskIdentityMapMatchesPayloadContent: false,
      proposalEventRevisionMatchesReceipt: true,
      proposalEventRevisionMatchesEmbeddedItem: null,
      proposalEventRevisionMatchesCurrentPersistedItemRow: false,
      eventReceiptEmbeddedTaskIdentityMapMismatchKeys: ["source", "verification"],
      embeddedCurrentPersistedTaskIdentityMapMismatchKeys: ["summary"],
      embeddedPayloadTaskIdentityMapMismatchKeys: ["source", "verification"],
      proposalReceiptFound: true,
      proposalEventRevision: 17,
    })
    expect(markers.some(marker => safe.output.includes(marker))).toBe(false)

    const nullRevision = projectLineage({ proposalEventRevision: null })
    expect(nullRevision.lineage).toEqual({ proposalEventRevision: null })

    const unsafe = projectLineage({
      proposalReceiptFound: true,
      proposalEventFound: markers[0],
      requestResultTaskIdentityMapMatchesEventReceipt: markers[1],
      eventReceiptTaskIdentityMapMatchesEmbeddedContent: markers[2],
      embeddedContentTaskIdentityMapMatchesCurrentPersistedItem: "yes",
      embeddedContentTaskIdentityMapMatchesPayloadContent: markers[3],
      proposalEventRevisionMatchesReceipt: "true",
      proposalEventRevisionMatchesEmbeddedItem: markers[0],
      proposalEventRevisionMatchesCurrentPersistedItemRow: markers[1],
      proposalEventRevision: 10_001,
      eventReceiptEmbeddedTaskIdentityMapMismatchKeys: [markers[0], "private text"],
      embeddedCurrentPersistedTaskIdentityMapMismatchKeys: ["not-allowed"],
      embeddedPayloadTaskIdentityMapMismatchKeys: [{ key: "source" }],
      privateIdentifier: markers[2],
    })
    expect(unsafe.lineage).toEqual({ proposalReceiptFound: true })
    expect(markers.some(marker => unsafe.output.includes(marker))).toBe(false)
  })

  it("preserves first-divergence identity diagnostics within the bounded realistic process line", () => {
    const prefix = "P3_PARENT_SUSPENSION_DIAGNOSTICS "
    const child = {
      pid: 42, exitCode: null, signalCode: null, errors: [],
      output: [prefix + JSON.stringify({
        turnStatus: "failed", rootTaskStatus: "running", latestModelStepStatus: "failed",
        latestModelStepErrorClass: "database_deadlock", turnErrorCategory: "database_serialization",
        waitToolCallStatus: "completed", waitToolCallLifecycleStatus: "completed", planAccepted: true,
        waitToolResultLifecycleStatus: "completed", waitToolOutputStatus: "ready",
        waitFailureCategory: "database_serialization", likelyCause: "wait_row_missing_or_parent_mismatch",
        graphNodeCount: 3,
        initialWaitLineage: {
          proposalEventFound: true,
          requestResultTaskIdentityMapMatchesEventReceipt: true,
          eventReceiptTaskIdentityMapMatchesEmbeddedContent: false,
          embeddedContentTaskIdentityMapMatchesCurrentPersistedItem: false,
          embeddedContentTaskIdentityMapMatchesPayloadContent: true,
          proposalEventRevisionMatchesReceipt: true,
          proposalEventRevisionMatchesEmbeddedItem: true,
          proposalEventRevisionMatchesCurrentPersistedItemRow: false,
          eventReceiptEmbeddedTaskIdentityMapMismatchKeys: ["source", "summary", "verification"],
          embeddedCurrentPersistedTaskIdentityMapMismatchKeys: ["verification"],
          embeddedPayloadTaskIdentityMapMismatchKeys: ["source", "summary"],
          proposalReceiptFound: true, requestMatchesReceipt: true, requestMatchesCurrentGraph: true,
          proposalMatchesGraph: false, proposalRevisionMatchesGraph: true, persistedItemReadSucceeded: true,
          persistedItemFound: true, persistedItemValid: true, proposalMatchesPersistedItem: false,
          persistedItemMatchesGraph: true, planToolPairMatches: true, planExpectedRevisionMatches: true,
          proposalNodeCount: 3, graphNodeCount: 3, receiptRevision: 20, graphRevision: 20,
          persistedItemNodeCount: 3, persistedItemRevision: 20, requestedIdsOutsideReceiptCount: 0,
          requestedIdsOutsideGraphCount: 0, planToolUseCount: 1, planToolResultCount: 1,
          planExpectedRevision: 19, proposalEventRevision: 20,
          graphNodeKeysMissingReceipt: ["verification"],
          receiptPersistedMismatchKeys: ["source", "summary"], persistedGraphMismatchKeys: ["verification"],
        },
        waits: { count: 3, rootCount: 1, suspendedRootCount: 1 },
        targetCounts: { requested: 3, graphMatches: 3, taskRows: 3, graphRows: 3 },
        missingKeys: { requestedGraph: ["source"], graphTasks: ["summary"] },
        childStatusCounts: { failed: 1, completed: 2 },
      })],
    } as unknown as ProcessFixtureChild

    const output = processFixtureDiagnostics(child)
    const truncationMarker = output.indexOf("...[truncated ")
    const boundedLine = output.slice(0, truncationMarker)

    expect(output.length).toBeLessThanOrEqual(1_600)
    expect(truncationMarker).toBeGreaterThan(0)
    expect(boundedLine).toContain('"requestResultTaskIdentityMapMatchesEventReceipt":true')
    expect(boundedLine).toContain('"eventReceiptTaskIdentityMapMatchesEmbeddedContent":false')
    expect(boundedLine).toContain('"embeddedContentTaskIdentityMapMatchesCurrentPersistedItem":false')
    expect(boundedLine).toContain('"embeddedContentTaskIdentityMapMatchesPayloadContent":true')
    expect(boundedLine).toContain('"proposalEventRevisionMatchesCurrentPersistedItemRow":false')
    expect(boundedLine).toContain('"eventReceiptEmbeddedTaskIdentityMapMismatchKeys":["source","summary","verification"]')
    expect(boundedLine).toContain('"embeddedCurrentPersistedTaskIdentityMapMismatchKeys":["verification"]')
    expect(boundedLine).toContain('"embeddedPayloadTaskIdentityMapMismatchKeys":["source","summary"]')
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

  it.each(["wait_invalid", "wait_scope_error"])("projects DurableWaitHandoffError code %s and safe state flags", code => {
    const marker = "marker-sensitive-wait-handoff-value"
    const output = JSON.stringify(waitHandoffFailureProjection(JSON.stringify({
      waitId: marker,
      error: { name: "DurableWaitHandoffError", code, message: marker, sql: marker, details: { id: marker } },
      before: {
        snapshotReadSucceeded: true, turnFound: true, waitFound: true,
        turn: { status: "waiting_for_user", leaseOwnerPresent: true, leaseVersion: 4 },
        wait: { id: marker, status: "waiting", hasSuspendedAt: true, hasResolvedAt: false, hasConsumedAt: false },
      },
      after: {
        snapshotReadSucceeded: true, turnFound: true, waitFound: true,
        turn: { status: "failed", leaseOwnerPresent: false, leaseVersion: 5 },
        wait: { id: marker, status: "waiting", hasSuspendedAt: true, hasResolvedAt: false, hasConsumedAt: false },
      },
    })))

    expect(output).not.toContain(marker)
    expect(JSON.parse(output)).toMatchObject({
      captured: true,
      errorName: "DurableWaitHandoffError",
      errorCode: code,
      handoffGate: "other",
      before: {
        snapshotReadSucceeded: true, turnFound: true, waitFound: true,
        turnStatus: "waiting_for_user", turnLeaseOwnerPresent: true, waitStatus: "waiting", hasSuspendedAt: true,
      },
      after: {
        snapshotReadSucceeded: true, turnFound: true, waitFound: true,
        turnStatus: "failed", turnLeaseOwnerPresent: false, turnLeaseVersion: 5, waitStatus: "waiting",
      },
    })
  })

  it("projects the terminal closed wait status", () => {
    const projected = waitHandoffFailureProjection(JSON.stringify({
      error: { name: "DurableWaitHandoffError", code: "wait_scope_error", message: "private detail" },
      before: {
        snapshotReadSucceeded: true, turnFound: true, waitFound: true,
        turn: { status: "in_progress", leaseOwnerPresent: true, leaseVersion: 1 },
        wait: { status: "closed", hasSuspendedAt: true, hasResolvedAt: true, hasConsumedAt: true },
      },
    }))

    expect(projected).toMatchObject({ before: { waitStatus: "closed", hasResolvedAt: true } })
    expect(JSON.stringify(projected)).not.toContain("private detail")
  })

  it.each([
    { name: "Error", code: "40P01" }, { name: "Error", code: "40001" },
    { name: "Error", code: "55P03" }, { name: "Error", code: "57014" },
    { name: "Error", code: "23505" }, { name: "Error", code: "23503" },
    { name: "WaitHandoffUnavailable", code: "wait_handoff_unavailable" },
    { name: "DurableWaitHandoffError", code: "wait_invalid" },
    { name: "DurableWaitHandoffError", code: "wait_scope_error" },
    { name: "TurnLeaseError", code: "lease_lost" },
  ])("preserves known wait-handoff error identifiers $name/$code", ({ name, code }) => {
    const projected = waitHandoffFailureProjection(JSON.stringify({ error: { name, code, message: "unprojected" } }))
    expect(projected).toMatchObject({ errorName: name, errorCode: code })
  })

  it.each([
    ["DurableWaitHandoffError", "Session is unavailable", "session_unavailable"],
    ["DurableWaitHandoffError", "Wait parent is outside the root Turn scope", "wait_root_scope_mismatch"],
    ["DurableWaitHandoffError", "Wait step is not the current attempt", "wait_step_not_current"],
    ["DurableWaitHandoffError", "Wait condition is already closed", "wait_already_closed"],
    ["DurableWaitHandoffError", "Wait changed during handoff", "wait_changed_during_handoff"],
    ["TurnLeaseError", "Turn lease was fenced before wait handoff", "lease_fenced_before_handoff"],
    ["Error", "wait_resume_event_conflict", "resume_event_conflict"],
    ["Error", "wait_resume_session_sequence_unavailable", "resume_session_sequence_unavailable"],
    ["Error", "wait_resume_outbox_conflict", "resume_outbox_conflict"],
  ])("maps only known handoff gates to labels", (name, message, handoffGate) => {
    const projected = waitHandoffFailureProjection(JSON.stringify({
      error: { name, code: name === "TurnLeaseError" ? "lease_lost" : "wait_scope_error", message },
    }))
    expect(projected).toMatchObject({ handoffGate })
    expect(JSON.stringify(projected)).not.toContain(message)
  })

  it("distinguishes successful empty reads from failed snapshot reads", () => {
    const marker = "private-diagnostic-read-error"
    const projected = waitHandoffFailureProjection(JSON.stringify({
      error: { name: "DurableWaitHandoffError", code: "wait_scope_error", message: "unknown gate" },
      before: { snapshotReadSucceeded: true, turnFound: false, waitFound: false },
      after: {
        snapshotReadSucceeded: false, turnFound: false, waitFound: false,
        diagnosticError: { message: marker, query: marker },
      },
    }))
    const output = JSON.stringify(projected)

    expect(output).not.toContain(marker)
    expect(projected).toMatchObject({
      before: { snapshotReadSucceeded: true, turnFound: false, waitFound: false },
      after: { snapshotReadSucceeded: false, turnFound: false, waitFound: false },
    })
  })

  it("redacts unrecognized wait-handoff errors and arbitrary details", () => {
    const marker = "unapproved-wait-handoff-error-value"
    const output = JSON.stringify(waitHandoffFailureProjection(JSON.stringify({
      waitId: marker,
      error: { name: "UnrecognizedWaitHandoffError", code: marker, message: marker, sql: marker, details: { id: marker } },
      before: {
        snapshotReadSucceeded: false, turnFound: false, waitFound: false,
        diagnosticError: { message: marker, query: marker },
      },
    })))

    expect(output).not.toContain(marker)
    expect(JSON.parse(output)).toEqual({
      captured: true,
      errorName: "other",
      errorCode: "other",
      handoffGate: "other",
      before: {
        snapshotReadSucceeded: false,
        turnFound: false,
        waitFound: false,
        turnStatus: null,
        turnLeaseOwnerPresent: false,
        turnLeaseVersion: null,
        waitStatus: null,
        hasSuspendedAt: false,
        hasResolvedAt: false,
        hasConsumedAt: false,
      },
      after: null,
    })
  })
})

describe("Worker 2 private artifact fixture boundary", () => {
  it("rejects private body and artifact references at any fixture input depth", async () => {
    const worker = startTaskGraphRestartWorker("worker2-input-guard-self-test", {})
    await waitForProcessExit(worker, 45_000)
    expect(worker.exitCode).toBe(0)
    expect(worker.output).toContain("P3_PRIVATE_FIXTURE_GUARD_OK")
    expect(worker.errors).toEqual([])
  }, 60_000)
})

describe("TaskGraph restart fixture service boundary", () => {
  it("rejects unsafe PostgreSQL or Redis endpoints before production startup", async () => {
    const unsafeEnvironmentCases = [
      {
        AGENT_RUNTIME_PG_TEST_URL: "not-a-postgres-url",
        AGENT_TURN_REDIS_TEST_URL: "http://127.0.0.1:6379/14",
        REDIS_URL: "http://127.0.0.1:6379/14",
      },
      {
        AGENT_RUNTIME_PG_TEST_URL: "postgresql://postgres:postgres@127.0.0.1:5432/applymate_agent_brain_ci",
        AGENT_TURN_REDIS_TEST_URL: "http://127.0.0.1:6379/14",
        REDIS_URL: "http://127.0.0.1:6379/14",
      },
    ]
    for (const envOverrides of unsafeEnvironmentCases) {
      const worker = startTaskGraphRestartWorker("park-parent", {}, {
        CI: "true",
        AGENT_RUNTIME_PG_TEST_DISPOSABLE: "true",
        AGENT_TURN_REDIS_TEST_DISPOSABLE: "true",
        ...envOverrides,
      })
      await waitForProcessExit(worker, 45_000)
      expect(worker.exitCode).toBe(1)
      expect(worker.errors.join("\n")).toContain("p3_restart_fixture_rejects_non_disposable_service_urls")
      expect(worker.output).not.toContain("P3_FIRST_WORKER_START_RUNTIME_BEGIN")
    }
  }, 120_000)
})

describeWithServices("production TaskGraph lifecycle and root resume (disposable PostgreSQL + Redis)", () => {
  const owner = fixture()
  const failureOwner = fixture()
  const stopOwner = fixture()
  const restartOwner = fixture()
  const artifactOwner = fixture()
  const cancelledOwner = fixture()
  const discoveryOwner = fixture()
  const discoveryFailureOwner = fixture()
  const discoveryRestartOwner = fixture()
  let artifactOwnerSources: SelectedJobFixtureSources | undefined
  let pool: Pool | undefined
  let redis: Redis | undefined
  let bootstrap: ProductionWorkerBootstrap | undefined
  let turnQueueName: string | undefined
  let childQueueName: string | undefined
  let selectedJobQueueName: string | undefined

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
    await seed(pool, artifactOwner, "waiting_for_user")
    artifactOwnerSources = await seedSelectedJobSources(pool, artifactOwner)
    await seed(pool, cancelledOwner, "waiting_for_user")
    await seed(pool, discoveryOwner, "waiting_for_user")
    await seed(pool, discoveryFailureOwner, "waiting_for_user")
    await seed(pool, discoveryRestartOwner, "waiting_for_user")
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
    if (pool) for (const current of [owner, failureOwner, stopOwner, restartOwner, artifactOwner, cancelledOwner, discoveryOwner, discoveryFailureOwner, discoveryRestartOwner]) {
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
        ...(selectedJobQueueName ? [{ name: selectedJobQueueName, label: "selected-job subagent queue" }] : []),
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
          if ([owner, failureOwner, stopOwner, restartOwner, artifactOwner, cancelledOwner, discoveryOwner, discoveryFailureOwner, discoveryRestartOwner].some(current => job.data?.turnId === current.turnId || job.data?.sessionId === current.sessionId)) {
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

  it.each([
    ["selected Job source edit", "job"],
    ["new eligible Persona fact", "persona"],
    ["new selected-job draft head", "draft"],
    ["TaskGraph revision advance", "graph"],
    ["Turn lease expiry after the guard", "lease"],
    ["root Stop after the guard", "stop"],
  ] as const)("rolls back terminal writes after a gate-approved race: %s", async (_label, race) => {
    const value = fixture()
    try {
      const prepared = await prepareSelectedJobTerminalCase(pool!, value)
      let guard = selectedJobFinalizationGuardForCase(prepared)
      if (race === "job") {
        await pool!.query(`UPDATE "Job" SET "description" = $3, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1 AND "userId" = $2`,
          [prepared.sources.jobId, value.userId, `AC6_CHANGED_JOB_SOURCE_${value.suffix}`])
      } else if (race === "persona") {
        await pool!.query(`INSERT INTO persona_facts
          ("id", "userId", "key", "category", "value", "normalized_value", "source", "source_ref", "confidence", "status", "allowedUses", "updated_at")
          VALUES ($1, $2, 'new-confirmed-fact', 'experience', $3, $4, 'manual', 'resume:new-fact', 0.95, 'confirmed', ARRAY['cover_letter']::text[], CURRENT_TIMESTAMP)`,
          [`p3-finalization-persona-${value.suffix}`, value.userId, `AC6_NEW_PERSONA_FACT_${value.suffix}`, value.suffix])
      } else if (race === "draft") {
        const task = await prepared.tasks.create({
          userId: value.userId, sessionId: value.sessionId, turnId: value.turnId, parentTaskId: prepared.root.id,
          role: "writer", taskType: "cover_letter_draft", goal: "Commit an unprojected newer draft",
          allowedActions: ["cover_letter.draft"], context: { selectedJobPreparation: { jobId: prepared.sources.jobId } },
          expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "writer" }, toolPolicySnapshot: {}, policy: defaultSubagentPolicy(),
        })
        const writerOwner = `p3-finalization-race-writer-${value.suffix}`
        const writer = await prepared.tasks.claim({ taskId: task.id, sessionId: value.sessionId, ownerId: writerOwner, policy: defaultSubagentPolicy(), now: new Date() })
        if (!writer?.leaseOwner) throw new Error("Newer-draft race Writer did not acquire a lease")
        const draftInput = {
          baseArtifactId: `cover-letter-base:${hashArtifactContent({ userId: value.userId, jobId: prepared.sources.jobId }).slice(7)}`,
          baseHash: hashArtifactContent({ kind: "cover_letter_base", jobId: prepared.sources.jobId }),
          content: `AC6_PRIVATE_NEWER_DRAFT_${value.suffix}`, constraints: { maxWords: 160 },
        }
        const scope = {
          ...prepared.preparation.preparation, userId: value.userId, sessionId: value.sessionId, taskId: writer.id,
          toolCallId: `p3-finalization-race-writer:${writer.attemptCount}`,
          taskFence: selectedJobTaskFence(writer, writerOwner, writer.attemptCount),
        }
        const newer = await prepared.artifacts.writeDraft(scope, { ...draftInput, requestHash: selectedJobDraftRequestHash(scope, draftInput) })
        expect(newer.version).toBe(prepared.artifactRef.version + 1)
      } else if (race === "graph") {
        const advanced = await pool!.query(`UPDATE "agent_items" SET "revision" = "revision" + 1 WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 RETURNING "revision"`,
          [taskGraphItemId(prepared.root.id), value.sessionId, value.turnId])
        expect(advanced.rowCount).toBe(1)
      } else {
        const realGuard = guard
        guard = async client => {
          const decision = await realGuard(client)
          if (!decision.ok) return decision
          const update = race === "lease"
            ? `UPDATE "agent_turns" SET "leaseExpiresAt" = clock_timestamp() - INTERVAL '1 second' WHERE "id" = $1 AND "sessionId" = $2`
            : `UPDATE "sub_agent_tasks" SET "interruptRequestedAt" = clock_timestamp() WHERE "id" = $1 AND "sessionId" = $2`
          const changed = await client.query(update, [race === "lease" ? value.turnId : prepared.root.id, value.sessionId])
          if (changed.rowCount !== 1) throw new Error(`Could not inject terminal ${race} race`)
          return decision
        }
      }

      await expect(commitTurnTerminal(pool!, prepared.terminalInput, guard)).rejects.toMatchObject({ name: "TurnEnginePersistenceConflict" })
      await expectNoTerminalRecords(pool!, prepared)
    } finally {
      await pool!.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [value.sessionId])
      await pool!.query(`DELETE FROM "User" WHERE "id" = $1`, [value.userId])
    }
  }, 45_000)

  it("rolls back finalization while an eligible source insert holds the User foreign-key lock", async () => {
    const value = fixture()
    let inserter: PoolClient | undefined
    let insertActive = false
    try {
      const prepared = await prepareSelectedJobTerminalCase(pool!, value)

      inserter = await pool!.connect()
      await inserter.query("BEGIN")
      insertActive = true
      await inserter.query(`INSERT INTO persona_facts
        ("id", "userId", "key", "category", "value", "normalized_value", "source", "source_ref", "confidence", "status", "allowedUses", "updated_at")
        VALUES ($1, $2, 'pending-fact', 'experience', $3, $4, 'manual', 'resume:pending-fact', 0.95, 'confirmed', ARRAY['cover_letter']::text[], CURRENT_TIMESTAMP)`, [
        `p3-finalization-fk-lock-${value.suffix}`, value.userId, `AC6_PENDING_FK_FACT_${value.suffix}`, value.suffix,
      ])

      const guard = selectedJobFinalizationGuardForCase(prepared)
      await expect(commitTurnTerminal(pool!, prepared.terminalInput, guard)).rejects.toMatchObject({ name: "TurnEnginePersistenceConflict" })
      await expectNoTerminalRecords(pool!, prepared)

      await inserter.query("COMMIT")
      insertActive = false
      const after = await loadSelectedJobArtifactContext(pool!, value.userId, prepared.sources.jobId)
      expect(after.preparation.sourceDigest).not.toBe(prepared.preparation.preparation.sourceDigest)
      await expect(commitTurnTerminal(pool!, prepared.terminalInput, guard)).rejects.toMatchObject({ name: "TurnEnginePersistenceConflict" })
      await expectNoTerminalRecords(pool!, prepared)
    } finally {
      if (insertActive) await inserter?.query("ROLLBACK").catch(() => undefined)
      inserter?.release()
      await pool!.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [value.sessionId])
      await pool!.query(`DELETE FROM "User" WHERE "id" = $1`, [value.userId])
    }
  }, 45_000)

  it("waits for authority locks, then reads a newer committed Job source before finalizing", async () => {
    const value = fixture()
    let writer: PoolClient | undefined
    let writerActive = false
    let terminalOutcome: Promise<{ value: unknown } | { error: unknown }> | undefined
    try {
      const prepared = await prepareSelectedJobTerminalCase(pool!, value)
      writer = await pool!.connect()
      await writer.query("BEGIN")
      writerActive = true
      const backend = await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      const writerPid = Number(backend.rows[0]?.pid)
      if (!Number.isSafeInteger(writerPid)) throw new Error("Could not identify the disposable authority-lock writer")
      await writer.query("SELECT set_config($1, $2, true)", ["app.user_id", value.userId])
      const sessionLock = await writer.query(`SELECT "id" FROM "agent_sessions" WHERE "id" = $1 AND "userId" = $2 FOR UPDATE`, [value.sessionId, value.userId])
      const turnLock = await writer.query(`SELECT "id" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "rootTaskId" = $4 FOR UPDATE`, [value.turnId, value.sessionId, value.userId, prepared.root.id])
      const rootLock = await writer.query(`SELECT "id" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $1 AND "status" = 'running' FOR UPDATE`, [prepared.root.id, value.sessionId, value.turnId])
      expect(sessionLock.rowCount).toBe(1)
      expect(turnLock.rowCount).toBe(1)
      expect(rootLock.rowCount).toBe(1)

      terminalOutcome = commitTurnTerminal(pool!, prepared.terminalInput, selectedJobFinalizationGuardForCase(prepared))
        .then(result => ({ value: result }), error => ({ error }))
      let waiting = false
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const activity = await pool!.query<{ waiting: boolean }>(`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity AS waiter WHERE waiter.pid <> pg_backend_pid() AND waiter.state = 'active'
            AND waiter.wait_event_type = 'Lock' AND waiter.query LIKE '%FROM "agent_sessions"%' AND waiter.query LIKE '%FOR UPDATE%'
            AND $1::int = ANY(pg_blocking_pids(waiter.pid))
        ) AS "waiting"`, [writerPid])
        if (activity.rows[0]?.waiting === true) { waiting = true; break }
        await writer.query("SELECT pg_sleep(0.05)")
      }
      expect(waiting).toBe(true)
      await writer.query(`UPDATE "Job" SET "description" = $3, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1 AND "userId" = $2`,
        [prepared.sources.jobId, value.userId, `AC6_WAITED_SOURCE_COMMIT_${value.suffix}`])
      await writer.query("COMMIT")
      writerActive = false
      const outcome = await terminalOutcome
      expect("error" in outcome).toBe(true)
      if ("error" in outcome) expect(outcome.error).toMatchObject({ name: "TurnEnginePersistenceConflict" })
      await expectNoTerminalRecords(pool!, prepared)
    } finally {
      if (writerActive) await writer?.query("ROLLBACK").catch(() => undefined)
      writer?.release()
      if (terminalOutcome) await terminalOutcome
      await pool!.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [value.sessionId])
      await pool!.query(`DELETE FROM "User" WHERE "id" = $1`, [value.userId])
    }
  }, 45_000)

  it("holds selected sources stable from the final digest read through terminal commit", async () => {
    const value = fixture()
    const writers: PoolClient[] = []
    const mutationOutcomes: Array<Promise<{ label: string; rowCount: number | null } | { label: string; error: unknown }>> = []
    let terminalOutcome: Promise<{ value: unknown } | { error: unknown }> | undefined
    let releaseGuard: () => void = () => {}
    let resolveGuardPassed: (pid: number) => void = () => undefined
    const guardPassed = new Promise<number>(resolve => { resolveGuardPassed = resolve })
    const guardBarrier = new Promise<void>(resolve => { releaseGuard = resolve })
    try {
      const prepared = await prepareSelectedJobTerminalCase(pool!, value)
      const adaptedResumeId = `p3-finalization-adapted-resume-${value.suffix}`
      await pool!.query(`INSERT INTO "Resume" ("id", "userId", "name", "content", "kind", "origin", "isDefault", "updatedAt")
        VALUES ($1, $2, 'Unrelated adapted resume', '{"text":"before"}'::jsonb, 'adapted', 'ai-adapted', FALSE, CURRENT_TIMESTAMP)`, [adaptedResumeId, value.userId])
      const realGuard = selectedJobFinalizationGuardForCase(prepared)
      const guarded = async (client: PoolClient) => {
        const decision = await realGuard(client)
        if (!decision.ok) return decision
        const backend = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
        const pid = Number(backend.rows[0]?.pid)
        if (!Number.isSafeInteger(pid)) throw new Error("Could not identify terminal finalization backend")
        resolveGuardPassed(pid)
        await guardBarrier
        return decision
      }
      terminalOutcome = commitTurnTerminal(pool!, prepared.terminalInput, guarded)
        .then(result => ({ value: result }), error => ({ error }))
      const terminalPid = await guardPassed
      let adaptedTimeout: NodeJS.Timeout | undefined
      try {
        const adaptedUpdate = await Promise.race([
          pool!.query(`UPDATE "Resume" SET "content" = '{"text":"after"}'::jsonb, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1 AND "userId" = $2`, [adaptedResumeId, value.userId]),
          new Promise<never>((_, reject) => { adaptedTimeout = setTimeout(() => reject(new Error("Unselected adapted Resume update was blocked by finalization")), 3_000) }),
        ])
        expect(adaptedUpdate.rowCount).toBe(1)
      } finally { if (adaptedTimeout) clearTimeout(adaptedTimeout) }
      const newFactId = `p3-finalization-post-guard-fact-${value.suffix}`
      const changes = [
        { label: "Job update", sql: `UPDATE "Job" SET "description" = $3, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1 AND "userId" = $2`, values: [prepared.sources.jobId, value.userId, `AC6_POST_GUARD_JOB_${value.suffix}`] },
        { label: "Resume update", sql: `UPDATE "Resume" SET "content" = jsonb_build_object('text', $3::text), "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1 AND "userId" = $2`, values: [prepared.sources.resumeId, value.userId, `AC6_POST_GUARD_RESUME_${value.suffix}`] },
        { label: "PersonaFact update", sql: `UPDATE persona_facts SET "value" = $3, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = $1 AND "userId" = $2`, values: [`p3-selected-job-fact-${value.suffix}`, value.userId, `AC6_POST_GUARD_PERSONA_${value.suffix}`] },
        { label: "PersonaFact insert", sql: `INSERT INTO persona_facts
          ("id", "userId", "key", "category", "value", "normalized_value", "source", "source_ref", "confidence", "status", "allowedUses", "updated_at")
          VALUES ($1, $2, 'post-guard-fact', 'experience', $3, $4, 'manual', 'resume:post-guard', 0.95, 'confirmed', ARRAY['cover_letter']::text[], CURRENT_TIMESTAMP)`,
        values: [newFactId, value.userId, `AC6_POST_GUARD_INSERT_${value.suffix}`, value.suffix] },
      ]
      const writerPids: number[] = []
      for (const change of changes) {
        const writer = await pool!.connect()
        writers.push(writer)
        const backend = await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
        writerPids.push(Number(backend.rows[0]?.pid))
        mutationOutcomes.push(writer.query(change.sql, change.values)
          .then(result => ({ label: change.label, rowCount: result.rowCount }), error => ({ label: change.label, error })))
      }

      let allBlocked = false
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const waiting = await pool!.query<{ pid: number }>(`SELECT waiter.pid::int AS pid FROM pg_stat_activity AS waiter
          WHERE waiter.pid = ANY($1::int[]) AND waiter.state = 'active' AND waiter.wait_event_type = 'Lock'
            AND $2::int = ANY(pg_blocking_pids(waiter.pid))`, [writerPids, terminalPid])
        if (new Set(waiting.rows.map(row => Number(row.pid))).size === changes.length) { allBlocked = true; break }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      expect(allBlocked).toBe(true)

      const observer = await pool!.connect()
      try {
        const [job, resume, fact, inserted] = await Promise.all([
          observer.query<{ description: string }>(`SELECT "description" FROM "Job" WHERE "id" = $1`, [prepared.sources.jobId]),
          observer.query<{ content: { text: string } }>(`SELECT "content" FROM "Resume" WHERE "id" = $1`, [prepared.sources.resumeId]),
          observer.query<{ value: string }>(`SELECT "value" FROM persona_facts WHERE "id" = $1`, [`p3-selected-job-fact-${value.suffix}`]),
          observer.query(`SELECT "id" FROM persona_facts WHERE "id" = $1`, [newFactId]),
        ])
        expect(job.rows[0]?.description).toBe(`AC6_TRANSIENT_JOB_SOURCE_W1_${value.suffix}`)
        expect(resume.rows[0]?.content.text).toBe(`AC6_TRANSIENT_RESUME_SOURCE_W1_${value.suffix}`)
        expect(fact.rows[0]?.value).toBe(`AC6_TRANSIENT_PERSONA_SOURCE_W1_${value.suffix}`)
        expect(inserted.rows).toHaveLength(0)
      } finally { observer.release() }

      releaseGuard()
      const terminal = await terminalOutcome
      expect(terminal && "value" in terminal).toBe(true)
      const applied = await Promise.all(mutationOutcomes)
      expect(applied.every(result => "rowCount" in result && result.rowCount === 1)).toBe(true)
      const after = await loadSelectedJobArtifactContext(pool!, value.userId, prepared.sources.jobId)
      expect(after.preparation.sourceDigest).not.toBe(prepared.preparation.preparation.sourceDigest)
    } finally {
      releaseGuard()
      if (terminalOutcome) await terminalOutcome
      await Promise.all(mutationOutcomes)
      for (const writer of writers) writer.release()
      await pool!.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [value.sessionId])
      await pool!.query(`DELETE FROM "User" WHERE "id" = $1`, [value.userId])
    }
  }, 45_000)

  it("rechecks PersonaFact expiry using the wall clock after the terminal transaction starts", async () => {
    const value = fixture()
    try {
      const prepared = await prepareSelectedJobTerminalCase(pool!, value)
      const expires = await pool!.query<{ expiresAt: Date }>(`UPDATE persona_facts
        SET "expires_at" = clock_timestamp() + INTERVAL '3 seconds'
        WHERE "id" = $1 AND "userId" = $2 RETURNING "expires_at" AS "expiresAt"`, [
        `p3-selected-job-fact-${value.suffix}`, value.userId,
      ])
      const expiresAt = expires.rows[0]?.expiresAt
      if (!(expiresAt instanceof Date)) throw new Error("Could not set the PersonaFact expiry boundary")
      const realGuard = selectedJobFinalizationGuardForCase(prepared)
      const delayedGuard = async (client: PoolClient) => {
        const transaction = await client.query<{ startedAt: Date }>("SELECT transaction_timestamp() AS \"startedAt\"")
        const startedAt = transaction.rows[0]?.startedAt
        if (!(startedAt instanceof Date) || startedAt.getTime() >= expiresAt.getTime()) {
          throw new Error("Terminal transaction did not start before PersonaFact expiry")
        }
        const delay = await client.query<{ seconds: number }>(`SELECT GREATEST(0.05,
          EXTRACT(EPOCH FROM $1::timestamptz - clock_timestamp()) + 0.1)::float8 AS "seconds"`, [expiresAt])
        await client.query("SELECT pg_sleep($1::float8)", [Number(delay.rows[0]?.seconds)])
        const expired = await client.query<{ expired: boolean }>(`SELECT statement_timestamp() > $1::timestamptz AS "expired"`, [expiresAt])
        expect(expired.rows[0]?.expired).toBe(true)
        return realGuard(client)
      }

      await expect(commitTurnTerminal(pool!, prepared.terminalInput, delayedGuard)).rejects.toMatchObject({ name: "TurnEnginePersistenceConflict" })
      await expectNoTerminalRecords(pool!, prepared)
      const afterExpiry = await loadSelectedJobArtifactContext(pool!, value.userId, prepared.sources.jobId)
      expect(afterExpiry.preparation.sourceDigest).not.toBe(prepared.preparation.preparation.sourceDigest)
    } finally {
      await pool!.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [value.sessionId])
      await pool!.query(`DELETE FROM "User" WHERE "id" = $1`, [value.userId])
    }
  }, 45_000)

  it("replays one selected-job draft receipt under a reclaimed lease without duplicating its version", async () => {
    const value = fixture()
    let userSeeded = false
    try {
      await seed(pool!, value, "waiting_for_user")
      userSeeded = true
      const sources = await seedSelectedJobSources(pool!, value)
      const plan = await createSelectedJobTaskGraph(pool!, value, sources, `agent-subagents-ac6-receipt-${value.suffix}`)
      const firstOwner = `ac6-receipt-owner-one-${value.suffix}`
      const secondOwner = `ac6-receipt-owner-two-${value.suffix}`
      const firstLease = await plan.store.claim({
        taskId: plan.writerTask.id, sessionId: value.sessionId, ownerId: firstOwner,
        policy: defaultSubagentPolicy(), now: new Date(),
      })
      if (!firstLease?.leaseOwner) throw new Error("Selected-job receipt task did not acquire its first disposable lease")
      expect(firstLease).toMatchObject({ status: "running", leaseOwner: firstOwner, attemptCount: 1 })

      const toolCallId = SELECTED_JOB_DRAFT_CALL_ID
      const input = {
        baseArtifactId: `cover-letter-base:${hashArtifactContent({ userId: value.userId, jobId: sources.jobId }).slice(7)}`,
        baseHash: hashArtifactContent({ kind: "cover_letter_base", jobId: sources.jobId }),
        content: `AC6_PRIVATE_COVER_LETTER_${value.suffix}`,
        constraints: { maxWords: 160 },
      }
      const artifactStore = createArtifactToolStore(pool!)
      const base = await resolveCoverLetterBase(artifactStore, value.userId, sources.jobId)
      expect(base).toMatchObject({ artifactId: input.baseArtifactId, baseHash: input.baseHash })
      const originalScope = {
        ...plan.originalPreparation.preparation,
        userId: value.userId,
        sessionId: value.sessionId,
        taskId: firstLease.id,
        toolCallId,
        taskFence: selectedJobTaskFence(firstLease, firstOwner, firstLease.attemptCount),
      }
      const requestHash = selectedJobDraftRequestHash(originalScope, input)
      const committed = await artifactStore.writeDraft(originalScope, { ...input, requestHash })
      expect(committed).toMatchObject({
        version: 1, userId: value.userId, sessionId: value.sessionId, jobId: sources.jobId,
        sourceDigest: plan.originalPreparation.preparation.sourceDigest,
        provenanceRefs: plan.originalPreparation.preparation.evidenceRefs,
        evidenceRefs: plan.originalPreparation.preparation.evidenceRefs,
        taskId: firstLease.id, toolCallId, requestHash,
      })

      const expired = await pool!.query(`UPDATE "sub_agent_tasks" SET "leaseExpiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second'
        WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4
          AND "status" = 'running' AND "leaseOwner" = $5 AND "attemptCount" = $6`, [
        firstLease.id, value.sessionId, value.turnId, plan.rootTaskId, firstOwner, firstLease.attemptCount,
      ])
      expect(expired.rowCount).toBe(1)
      // Model the recovered task's new live lease on this fixture-owned row. The Worker restart trace separately exercises production recovery and claim.
      const reclaimed = await pool!.query(`UPDATE "sub_agent_tasks" SET "status" = 'running', "leaseOwner" = $5,
          "attemptCount" = "attemptCount" + 1, "leaseExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '1 minute',
          "nextAttemptAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4
          AND "status" = 'running' AND "leaseOwner" = $6 AND "attemptCount" = $7
          AND "leaseExpiresAt" <= CURRENT_TIMESTAMP`, [
        firstLease.id, value.sessionId, value.turnId, plan.rootTaskId, secondOwner, firstOwner, firstLease.attemptCount,
      ])
      expect(reclaimed.rowCount).toBe(1)
      const secondLease = await plan.store.get(firstLease.id, value.sessionId)
      if (!secondLease?.leaseOwner) throw new Error("Selected-job receipt task did not receive its modeled reclaimed lease")
      expect(secondLease).toMatchObject({ status: "running", leaseOwner: secondOwner, attemptCount: 2 })

      await expect(artifactStore.writeDraft(originalScope, { ...input, requestHash }))
        .rejects.toMatchObject({ code: "task_fence_denied" })
      const reclaimedScope = {
        ...originalScope,
        taskFence: selectedJobTaskFence(secondLease, secondOwner, secondLease.attemptCount),
      }
      const [firstReplay, secondReplay] = await Promise.all([
        artifactStore.writeDraft(reclaimedScope, { ...input, requestHash }),
        artifactStore.writeDraft(reclaimedScope, { ...input, requestHash }),
      ])
      expect(firstReplay).toEqual(committed)
      expect(secondReplay).toEqual(committed)

      const conflictingInput = { ...input, content: `${input.content}_conflict` }
      const conflictingHash = selectedJobDraftRequestHash(reclaimedScope, conflictingInput)
      await expect(artifactStore.writeDraft(reclaimedScope, { ...conflictingInput, requestHash: conflictingHash }))
        .rejects.toMatchObject({ code: "receipt_conflict" })
      const completed = await plan.store.finish({
        taskId: secondLease.id, sessionId: value.sessionId, ownerId: secondOwner,
        attemptCount: secondLease.attemptCount, status: "completed", result: { status: "completed" }, now: new Date(),
      })
      expect(completed).toBe("completed")
      await expect(artifactStore.writeDraft(reclaimedScope, { ...input, requestHash }))
        .rejects.toMatchObject({ code: "task_fence_denied" })
      const versions = await pool!.query<{ count: number }>(
        `SELECT COUNT(*)::int AS "count" FROM "agent_artifact_version" WHERE "taskId" = $1`, [firstLease.id],
      )
      expect(versions.rows[0]?.count).toBe(1)
    } finally {
      if (userSeeded) {
        await pool!.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [value.sessionId])
        await pool!.query(`DELETE FROM "User" WHERE "id" = $1`, [value.userId])
      }
    }
  }, 30_000)

  it("blocks completion when an unprojected failed Writer committed a newer draft head", async () => {
    const value = fixture()
    let userSeeded = false
    try {
      await seed(pool!, value, "waiting_for_user")
      userSeeded = true
      const sources = await seedSelectedJobSources(pool!, value)
      const preparation = await loadSelectedJobArtifactContext(pool!, value.userId, sources.jobId)
      const store = new PgSubagentTaskStore(pool!)
      const root = await store.create({
        userId: value.userId, sessionId: value.sessionId, turnId: value.turnId,
        role: "supervisor", taskType: "task_graph", goal: "Complete the selected-job draft review",
        allowedActions: ["jobs.get", "persona.retrieve", "resume.get_base", "cover_letter.draft", "artifact.version.read", "artifact.review"],
        expectedOutputSchema: {}, toolPolicySnapshot: {}, budgetSnapshot: { limits: { maxSteps: 8, maxToolCalls: 8 } },
        policy: defaultSubagentPolicy(),
      })
      const linkedTurn = await pool!.query(`UPDATE "agent_turns" SET "rootTaskId" = $2, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1 AND "sessionId" = $3 AND "userId" = $4 AND "status" = 'waiting_for_user' AND "rootTaskId" IS NULL`, [
        value.turnId, root.id, value.sessionId, value.userId,
      ])
      expect(linkedTurn.rowCount).toBe(1)
      await activateFixtureTurn(pool!, value)
      const lease = await claimTurnLease(pool!, { turnId: value.turnId, sessionId: value.sessionId, ownerId: value.ownerId })
      const rootLease = await store.claim({
        taskId: root.id, sessionId: value.sessionId, ownerId: value.ownerId,
        policy: defaultSubagentPolicy(), now: new Date(),
      })
      if (!rootLease?.leaseOwner) throw new Error("Stale-head fixture root did not acquire a live lease")
      expect(rootLease).toMatchObject({ status: "running", leaseOwner: lease.ownerId, attemptCount: 1 })

      const stepId = `p3-stale-head-step-${value.suffix}`
      await pool!.query(`INSERT INTO "agent_steps"
        ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
        VALUES ($1, $2, $3, $4, 1, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb)`, [
        stepId, value.sessionId, value.turnId, root.id,
      ])
      const commandPort = createPgTaskGraphCommandPort(pool!)
      const graphScope = {
        userId: value.userId, sessionId: value.sessionId, turnId: value.turnId,
        rootTaskId: root.id, parentTaskId: root.id, stepId,
        turnLeaseOwner: lease.ownerId, turnLeaseVersion: lease.leaseVersion,
        parentLeaseOwner: lease.ownerId, parentAttemptCount: rootLease.attemptCount,
      }
      const graph = await commandPort.appendAndSchedule({
        scope: graphScope,
        proposal: {
          expectedRevision: 0,
          nodes: [
            { key: "writer-v1", templateId: "cover_letter_writer", goal: "Persist the original draft", successCriteria: ["Save draft v1"], dependsOn: [] },
            { key: "reviewer-v1", templateId: "cover_letter_reviewer", goal: "Review the original draft", successCriteria: ["Persist a passed review for v1"], dependsOn: ["writer-v1"] },
            { key: "writer-v2", templateId: "cover_letter_writer", goal: "Commit a newer draft then fail", successCriteria: ["Commit draft v2 before failure"], dependsOn: ["reviewer-v1"] },
          ],
        },
        templates: taskGraphTemplatesForSelectedJob(preparation.preparation),
      })
      const taskIds = new Map(graph.nodes.map(node => [node.key, node.taskId] as const))
      const claimGraphChild = async (key: string, ownerId: string): Promise<SubagentTaskRecord> => {
        const taskId = taskIds.get(key)
        if (!taskId) throw new Error(`Stale-head fixture is missing TaskGraph node ${key}`)
        const task = await store.claim({ taskId, sessionId: value.sessionId, ownerId, policy: defaultSubagentPolicy(), now: new Date() })
        if (!task?.leaseOwner) throw new Error(`Stale-head fixture child ${key} did not acquire a live lease`)
        return task
      }
      const finishCompletedGraphChild = async (task: SubagentTaskRecord, ownerId: string, structuredResult: RecordValue) => {
        await expect(store.finish({
          taskId: task.id, sessionId: value.sessionId, ownerId, attemptCount: task.attemptCount, status: "completed",
          result: { status: "completed", finalText: "fixture receipt", finalItemId: null, stepCount: 1, toolCallCount: 1, structuredResult },
          now: new Date(),
        })).resolves.toBe("completed")
      }
      const artifactStore = createArtifactToolStore(pool!)
      const base = await resolveCoverLetterBase(artifactStore, value.userId, sources.jobId)
      const draftInput = (content: string) => ({
        baseArtifactId: `cover-letter-base:${hashArtifactContent({ userId: value.userId, jobId: sources.jobId }).slice(7)}`,
        baseHash: hashArtifactContent({ kind: "cover_letter_base", jobId: sources.jobId }),
        content, constraints: { maxWords: 160 },
      })
      expect(base).toMatchObject({ artifactId: draftInput("unused").baseArtifactId, baseHash: draftInput("unused").baseHash })
      const artifactReference = (version: Awaited<ReturnType<typeof artifactStore.writeDraft>>) => ({
        artifactId: version.artifactId, version: version.version,
        contentHash: version.contentHash, sourceDigest: version.sourceDigest,
      })

      const writerV1Owner = `p3-stale-head-writer-v1-${value.suffix}`
      const writerV1 = await claimGraphChild("writer-v1", writerV1Owner)
      const writerV1Input = draftInput(`AC6_STALE_HEAD_DRAFT_V1_${value.suffix}`)
      const writerV1Scope = {
        ...preparation.preparation, userId: value.userId, sessionId: value.sessionId,
        taskId: writerV1.id, toolCallId: `ac6-stale-head-writer-v1:${writerV1.attemptCount}`,
        taskFence: selectedJobTaskFence(writerV1, writerV1Owner, writerV1.attemptCount),
      }
      const writerV1Version = await artifactStore.writeDraft(writerV1Scope, {
        ...writerV1Input, requestHash: selectedJobDraftRequestHash(writerV1Scope, writerV1Input),
      })
      const writerV1Ref = artifactReference(writerV1Version)
      await finishCompletedGraphChild(writerV1, writerV1Owner, {
        schemaVersion: ROLE_RESULT_SCHEMA, role: "writer", status: "completed", artifactRef: writerV1Ref,
      })

      const reviewerV1Owner = `p3-stale-head-reviewer-v1-${value.suffix}`
      const reviewerV1 = await claimGraphChild("reviewer-v1", reviewerV1Owner)
      const reviewerV1CallId = `ac6-stale-head-reviewer-v1:${reviewerV1.attemptCount}`
      const reviewInput = { artifactRef: writerV1Ref, decision: "passed", findings: [] }
      const reviewerV1Scope = {
        ...preparation.preparation, userId: value.userId, sessionId: value.sessionId,
        taskId: reviewerV1.id, toolCallId: reviewerV1CallId,
        taskFence: selectedJobTaskFence(reviewerV1, reviewerV1Owner, reviewerV1.attemptCount),
      }
      const reviewHash = hashArtifactContent({
        artifactRef: writerV1Ref, currentSourceDigest: preparation.preparation.sourceDigest,
        status: "passed", findings: [], evidenceRefs: preparation.preparation.evidenceRefs,
      })
      await artifactStore.saveReview({
        userId: value.userId, sessionId: value.sessionId, jobId: sources.jobId,
        artifactId: writerV1Ref.artifactId, version: writerV1Ref.version,
        contentHash: writerV1Ref.contentHash, sourceDigest: writerV1Ref.sourceDigest,
        currentSourceDigest: preparation.preparation.sourceDigest, status: "passed", findings: [],
        evidenceRefs: [...preparation.preparation.evidenceRefs], taskId: reviewerV1.id, toolCallId: reviewerV1CallId,
        requestHash: selectedJobTaskReceiptRequestHash("artifact.review", reviewerV1Scope, reviewInput),
        reviewHash, taskFence: reviewerV1Scope.taskFence,
      })
      await finishCompletedGraphChild(reviewerV1, reviewerV1Owner, {
        schemaVersion: ROLE_RESULT_SCHEMA, role: "reviewer", status: "completed",
        artifactRef: writerV1Ref, reviewStatus: "passed", reviewHash,
      })

      const writerV2Owner = `p3-stale-head-writer-v2-${value.suffix}`
      const writerV2 = await claimGraphChild("writer-v2", writerV2Owner)
      const writerV2Input = draftInput(`AC6_STALE_HEAD_DRAFT_V2_${value.suffix}`)
      const writerV2Scope = {
        ...preparation.preparation, userId: value.userId, sessionId: value.sessionId,
        taskId: writerV2.id, toolCallId: `ac6-stale-head-writer-v2:${writerV2.attemptCount}`,
        taskFence: selectedJobTaskFence(writerV2, writerV2Owner, writerV2.attemptCount),
      }
      const writerV2Version = await artifactStore.writeDraft(writerV2Scope, {
        ...writerV2Input, requestHash: selectedJobDraftRequestHash(writerV2Scope, writerV2Input),
      })
      const writerV2Ref = artifactReference(writerV2Version)
      expect(writerV2Ref.version).toBe(2)
      expect(writerV2Ref.artifactId).toBe(writerV1Ref.artifactId)
      expect(writerV2Ref.contentHash).not.toBe(writerV1Ref.contentHash)
      await expect(store.finish({
        taskId: writerV2.id, sessionId: value.sessionId, ownerId: writerV2Owner,
        attemptCount: writerV2.attemptCount, status: "failed", retryDisposition: "terminal",
        failureReason: "fixture_writer_failed_after_draft_commit", now: new Date(),
      })).resolves.toBe("failed")
      await expect(store.get(writerV2.id, value.sessionId)).resolves.toMatchObject({
        status: "failed", result: null, failureReason: "fixture_writer_failed_after_draft_commit",
      })

      const artifactRepository = createAgentArtifactRepository(pool!)
      await expect(artifactRepository.findCurrentDraftHead({
        userId: value.userId, sessionId: value.sessionId, jobId: sources.jobId, artifactId: writerV1Ref.artifactId,
      })).resolves.toEqual(writerV2Ref)
      const committedVersions = await pool!.query<{ version: number }>(
        `SELECT "version" FROM "agent_artifact_version" WHERE "artifactId" = $1 ORDER BY "version" ASC`,
        [writerV1Ref.artifactId],
      )
      expect(committedVersions.rows.map(row => row.version)).toEqual([1, 2])
      const graphState = await commandPort.readCurrent({
        userId: value.userId, sessionId: value.sessionId, turnId: value.turnId,
        rootTaskId: root.id, parentTaskId: root.id,
        turnLeaseOwner: lease.ownerId, turnLeaseVersion: lease.leaseVersion,
        parentLeaseOwner: lease.ownerId, parentAttemptCount: rootLease.attemptCount,
      })
      expect(graphState.nodes.map(node => [node.key, node.status])).toEqual([
        ["writer-v1", "completed"], ["reviewer-v1", "completed"], ["writer-v2", "failed"],
      ])
      expect(graphState.nodes.find(node => node.key === "writer-v1")?.resultProjection).toMatchObject({
        schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted",
        availability: "available", role: "writer", status: "completed", artifactRef: writerV1Ref,
      })
      expect(graphState.nodes.find(node => node.key === "reviewer-v1")?.resultProjection).toMatchObject({
        schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted",
        availability: "available", role: "reviewer", status: "completed", reviewStatus: "passed", artifactRef: writerV1Ref,
      })
      expect(graphState.nodes.find(node => node.key === "writer-v2")?.resultProjection).toMatchObject({
        schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "unavailable",
      })

      await expect(selectedJobArtifactCompletionGate({
        commandPort, lease, root: { id: root.id, attemptCount: rootLease.attemptCount },
        selectedJobId: sources.jobId, readCurrentDraftHead: scope => artifactRepository.findCurrentDraftHead(scope),
        readCurrentReviewReceipt: scope => artifactRepository.findReviewReceipt(scope),
        readCurrentSourceDigest: async () => (await loadSelectedJobArtifactContext(pool!, value.userId, sources.jobId)).preparation.sourceDigest,
      })).resolves.toEqual({
        ok: false, blocker: "selected_job_draft_review_required",
        feedback: "Complete and review the selected job's latest cover-letter draft before finishing.",
      })
    } finally {
      if (userSeeded) {
        await pool!.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [value.sessionId])
        await pool!.query(`DELETE FROM "User" WHERE "id" = $1`, [value.userId])
      }
    }
  }, 30_000)

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
      taskGraphPlanningEnabled: true,
      childExecutionEnabled: true,
      coordinationEnabled: true,
      consumeWaitOutcomes: true,
      canonicalAutomationEnabled: false,
      turnBoundaryCompactionEnabled: false,
    }
    let rootRuntimeExecutions = 0
    let resumedGraphReachedModel = false
    let followUpGraphReachedModel = false
    let followUpExpectedRevision: number | undefined
    let rootModelStreamFailure: string | null = null
    let firstWaitPlanGraphDiagnostics: string | null = null
    let followUpPlanReceiptFailureDiagnostics: string | null = null
    let completedGraphStateFailureDiagnostics: string | null = null
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
                rootModelFailureStage = "follow_up_plan_receipt_lookup"
                let plannedTaskIds: string[]
                try {
                  plannedTaskIds = planTaskIds(request, FOLLOW_UP_PLAN_CALL_ID, 1)
                } catch (error: unknown) {
                  followUpPlanReceiptFailureDiagnostics = await collectPlanReceiptFailureDiagnostics(
                    pool!, owner.turnId, request, FOLLOW_UP_PLAN_CALL_ID, graph,
                  )
                  throw error
                }
                rootModelFailureStage = "follow_up_graph_task_id"
                try {
                  expect(nodes.find(node => node?.key === "verification")).toMatchObject({
                    key: "verification", taskId: plannedTaskIds[0],
                  })
                } catch (error: unknown) {
                  followUpPlanReceiptFailureDiagnostics = await collectPlanReceiptFailureDiagnostics(
                    pool!, owner.turnId, request, FOLLOW_UP_PLAN_CALL_ID, graph,
                  )
                  throw error
                }
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
              try {
                rootModelFailureStage = "completed_graph_statuses"
                expect(nodes.map(node => node?.status)).toEqual(["completed", "completed", "completed", "cancelled", "completed"])
                rootModelFailureStage = "completed_graph_readiness"
                expect(nodes.map(node => node?.readiness)).toEqual(["terminal", "terminal", "terminal", "terminal", "terminal"])
              } catch (error: unknown) {
                completedGraphStateFailureDiagnostics = boundedDiagnostic(
                  JSON.stringify(completedGraphStatusFailureProjection(graph)), 1_200,
                )
                throw error
              }
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
                firstWaitPlanGraphDiagnostics = await collectFirstWaitPlanGraphMismatchDiagnostics(
                  pool!, owner.turnId, request, PLAN_CALL_ID, graph,
                )
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
      const followUpReceiptDiagnostic: FailureDiagnosticField[] = followUpPlanReceiptFailureDiagnostics
        ? [{ label: "followUpPlanReceiptEvidence", value: "captured", safeValue: followUpPlanReceiptFailureDiagnostics }]
        : []
      const completedGraphStateDiagnostic: FailureDiagnosticField[] = completedGraphStateFailureDiagnostics
        ? [{ label: "completedGraphStateEvidence", value: "captured", safeValue: completedGraphStateFailureDiagnostics }]
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
        ...followUpReceiptDiagnostic,
        ...completedGraphStateDiagnostic,
        { label: "waitHandoffFailure", value: rootWaitHandoffFailure ?? "<not captured>" },
        { label: "turnFailure", value: waitTurnFailureSummary(error) },
      ], progress, firstWaitPlanGraphDiagnostics) + handoffSuffix, 4_500))
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
    let artifactPlan: SelectedJobArtifactRestartPlan | undefined
    let artifactTrace: SelectedJobArtifactRestartTrace | undefined
    let artifactReviewTrace: SelectedJobArtifactReviewTrace | undefined
    try {
      if (!artifactOwnerSources || !redis) throw new Error("Selected-job fixture sources or Redis were not initialized")
      selectedJobQueueName = `agent-subagents-ac6-${artifactOwner.suffix}`
      artifactPlan = await createSelectedJobTaskGraph(pool!, artifactOwner, artifactOwnerSources, selectedJobQueueName)
      const selectedJobForWorkerOne = {
        queueName: artifactPlan.queueName, userId: artifactOwner.userId, sessionId: artifactOwner.sessionId,
        turnId: artifactOwner.turnId, rootTaskId: artifactPlan.rootTaskId, jobId: artifactPlan.jobId,
        body: artifactPlan.body, writerTaskId: artifactPlan.writerTask.id,
      }
      workerOne = startTaskGraphRestartWorker("park-parent", { ...restartOwner, selectedJob: selectedJobForWorkerOne })
      const suspendedLine = await waitForProcessLine(workerOne, "P3_PARENT_SUSPENDED ", 45_000)
      if (workerOne.pid === undefined) throw new Error("P3 first Worker has no OS process ID")
      expect(suspendedLine).toContain("p3-process-restart-worker-" + workerOne.pid)
      await waitForProcessLine(workerOne, `P3_SELECTED_JOB_QUEUE_READY ${selectedJobQueueName}`)

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

      await enqueueSelectedJobTask(
        artifactPlan.queueName, redis!, artifactPlan.writerTask, `ac6-writer-worker-one-${artifactOwner.suffix}`,
      )
      const writerLine = await waitForProcessLine(
        workerOne, `P3_SELECTED_JOB_CHILD_SETTLED ${artifactPlan.writerTask.id} `, 30_000,
      )
      artifactTrace = await traceSelectedJobWriterFromWorker(artifactPlan, writerLine)
      const writerVersion = await pool!.query<{
        version: number; contentHash: string; sourceDigest: string; content: unknown; userId: string; sessionId: string;
        jobId: string; provenanceRefs: string[]; evidenceRefs: string[]; taskId: string; toolCallId: string; requestHash: string;
      }>(
        `SELECT "version", "contentHash", "sourceDigest", "content", "userId", "sessionId", "jobId",
          "provenanceRefs", "evidenceRefs", "taskId", "toolCallId", "requestHash" FROM "agent_artifact_version"
          WHERE "taskId" = $1 AND "toolCallId" = $2`, [artifactTrace.writerTask.id, artifactTrace.writerDraftCallId],
      )
      expect(writerVersion.rows).toHaveLength(1)
      expect(writerVersion.rows[0]).toMatchObject({
        userId: artifactOwner.userId,
        sessionId: artifactOwner.sessionId,
        jobId: artifactPlan.jobId,
        version: 1, contentHash: artifactTrace.artifactRef.contentHash,
        sourceDigest: artifactTrace.artifactRef.sourceDigest, content: artifactTrace.body,
        provenanceRefs: artifactPlan.originalPreparation.preparation.evidenceRefs,
        evidenceRefs: artifactPlan.originalPreparation.preparation.evidenceRefs,
        taskId: artifactPlan.writerTask.id,
        toolCallId: artifactTrace.writerDraftCallId,
        requestHash: artifactTrace.writerRequestHash,
      })

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

      if (!artifactTrace) throw new Error("Selected-job Writer did not settle in Worker 1")
      artifactReviewTrace = await prepareSelectedJobReviewAfterRestart(pool!, artifactOwner, artifactTrace)
      // Worker 2 also starts database-wide default-queue recovery. Publish and
      // enqueue these direct-store fixture tasks on their dedicated queue first
      // so recovery does not misroute them to the generic subagent executor.
      await enqueueSelectedJobReviewTasksBeforeWorkerTwo(pool!, redis, artifactOwner, artifactReviewTrace)

      workerTwo = startTaskGraphRestartWorker("resume-parent", {
        ...restartOwner,
        expectedRevision: graphBefore.rows[0]!.revision,
        expectedSnapshot: graphSnapshot,
        selectedJob: {
          queueName: artifactReviewTrace.queueName, userId: artifactOwner.userId, sessionId: artifactOwner.sessionId,
          turnId: artifactOwner.turnId, rootTaskId: artifactReviewTrace.rootTaskId, jobId: artifactReviewTrace.jobId,
          expectedBodyHash: hashArtifactContent(artifactReviewTrace.body), writerTaskId: artifactReviewTrace.writerTask.id,
          reviewerTaskId: artifactReviewTrace.reviewerTask.id,
          stopReviewerTaskId: artifactReviewTrace.stopReviewerTask.id,
        },
      })
      expect(workerTwo.pid).not.toBe(firstWorkerPid)
      const readyLine = await waitForProcessLine(workerTwo, "P3_SECOND_WORKER_READY ")
      expect(readyLine).toContain("p3-process-restart-worker-" + workerTwo.pid)
      await waitForProcessLine(workerTwo, `P3_SELECTED_JOB_QUEUE_READY ${selectedJobQueueName}`)
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
          ...parentModelFailureDiagnosticFields(parentModelFailure),
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
          ...parentModelFailureDiagnosticFields(parentModelFailure),
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

      if (!artifactReviewTrace || !redis) throw new Error("Selected-job review fixture was not prepared for Worker 2")
      await reviewSelectedJobThroughRestartedWorker(pool!, artifactOwner, artifactReviewTrace, workerOne!, workerTwo!)

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
      taskGraphPlanningEnabled: true,
      childExecutionEnabled: true,
      coordinationEnabled: true,
      consumeWaitOutcomes: true,
      canonicalAutomationEnabled: false,
      turnBoundaryCompactionEnabled: false,
    }
    let rootRuntimeExecutions = 0
    let descendantExecuted = false
    let resumedAfterFailure = false
    let failurePreflightStage: FailurePreflightStage = "not_started"
    let failurePreflightErrorClass: FailurePreflightErrorClass = "none"
    let failurePlanReceiptFailureDiagnostics: string | null = null
    let failurePreflightEvidenceDiagnostics: string | null = null
    let failurePreflightRootTaskLookupCompleted = false
    let failurePreflightRootTaskId: string | null = null
    let failurePreflightTargetIds: string[] = []
    const failurePreflightTargetObservations: FailurePreflightTargetObservation[] = [null, null]
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
                failurePreflightErrorClass = "none"
                const receiptTaskIds = planTaskIds(request, FAILURE_PLAN_CALL_ID)
                failurePreflightTargetIds = receiptTaskIds
                failurePreflightStage = "root_task_lookup"
                const fixtureTurn = await pool!.query<{ rootTaskId: string | null }>(
                  `SELECT "rootTaskId" FROM "agent_turns"
                   WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`,
                  [failureOwner.turnId, failureOwner.sessionId, failureOwner.userId],
                )
                const fixtureRootTaskId = fixtureTurn.rows[0]?.rootTaskId
                failurePreflightRootTaskLookupCompleted = true
                failurePreflightRootTaskId = fixtureRootTaskId ?? null
                if (!fixtureRootTaskId) {
                  throw new Error("Failed-prerequisite fixture assertion: current root task is missing from agent_turns")
                }
                const coordinationStore = new PgCoordinationStore(pool!)
                for (const [index, taskId] of receiptTaskIds.entries()) {
                  failurePreflightStage = index === 0 ? "first_target_lookup" : "second_target_lookup"
                  const target = await coordinationStore.getTask({
                    userId: failureOwner.userId, sessionId: failureOwner.sessionId, taskId,
                  })
                  if (!target) {
                    failurePreflightTargetObservations[index] = {
                      found: false,
                      scope: await missingTaskScopeFailureDiagnostics(pool!, taskId, {
                        sessionId: failureOwner.sessionId, userId: failureOwner.userId,
                        turnId: failureOwner.turnId, rootTaskId: fixtureRootTaskId,
                      }),
                    }
                    throw new Error("Failed-prerequisite fixture assertion: plan receipt target is missing from PgCoordinationStore.getTask")
                  }
                  failurePreflightTargetObservations[index] = {
                    found: true,
                    taskId: target.id,
                    turnId: target.turnId,
                    rootTaskId: target.rootTaskId,
                    parentTaskId: target.parentTaskId,
                  }
                  failurePreflightStage = index === 0 ? "first_target_lineage" : "second_target_lineage"
                  const targetLineage = failurePreflightEvidenceProjection({
                    rootTaskLookupCompleted: failurePreflightRootTaskLookupCompleted,
                    rootTaskId: failurePreflightRootTaskId,
                    expectedTurnId: failureOwner.turnId,
                    expectedTaskIds: failurePreflightTargetIds,
                    targets: failurePreflightTargetObservations,
                  }).targets as Array<RecordValue>
                  const observedLineage = targetLineage[index]
                  expect({
                    targetMatchesReceipt: observedLineage?.targetMatchesReceipt,
                    turnMatches: observedLineage?.turnMatches,
                    rootMatches: observedLineage?.rootMatches,
                    parentMatches: observedLineage?.parentMatches,
                  }, "Failed-prerequisite fixture assertion: target lineage does not match expected scope").toEqual({
                    targetMatchesReceipt: true, turnMatches: true, rootMatches: true, parentMatches: true,
                  })
                }
                failurePreflightStage = "wait_tool_availability"
                expect(request.tools.map(tool => record(tool)?.name)).toContain("agent.wait")
                failurePreflightStage = "preflight_passed"
              } catch (error: unknown) {
                failurePreflightErrorClass = safeFailurePreflightErrorClass(error)
                failurePreflightEvidenceDiagnostics = boundedDiagnostic(JSON.stringify(failurePreflightEvidenceProjection({
                  rootTaskLookupCompleted: failurePreflightRootTaskLookupCompleted,
                  rootTaskId: failurePreflightRootTaskId,
                  expectedTurnId: failureOwner.turnId,
                  expectedTaskIds: failurePreflightTargetIds,
                  targets: failurePreflightTargetObservations,
                })), 1_200)
                failurePlanReceiptFailureDiagnostics = await collectPlanReceiptFailureDiagnostics(
                  pool!, failureOwner.turnId, request, FAILURE_PLAN_CALL_ID, currentGraphFromRequest(request),
                )
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
      const progress = await turnProgressDiagnostics(pool!, failureOwner.turnId, FAILURE_WAIT_CALL_ID)
      const failureReceiptDiagnostic: FailureDiagnosticField[] = failurePlanReceiptFailureDiagnostics
        ? [{ label: "failurePlanReceiptEvidence", value: "captured", safeValue: failurePlanReceiptFailureDiagnostics }]
        : []
      const failurePreflightEvidence: FailureDiagnosticField[] = failurePreflightEvidenceDiagnostics
        ? [{ label: "failurePreflightEvidence", value: "captured", safeValue: failurePreflightEvidenceDiagnostics }]
        : []
      const waitHandoffFailureState = JSON.stringify(waitHandoffFailureProjection(failureWaitHandoffFailure))
      throw new Error(combineFailureDiagnostics([
        { label: "failedPrerequisitePreflight", value: failurePreflightErrorClass === "none" ? "" : "captured" },
        { label: "failurePreflightStage", value: failurePreflightStage, safeValue: failurePreflightStage },
        { label: "failurePreflightErrorClass", value: failurePreflightErrorClass, safeValue: failurePreflightErrorClass },
        ...failurePreflightEvidence,
        ...failureReceiptDiagnostic,
        { label: "waitHandoffFailure", value: failureWaitHandoffFailure ?? "<not captured>" },
        { label: "waitHandoffState", value: waitHandoffFailureState, safeValue: waitHandoffFailureState },
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

  it("cancels dependent descendants when a running source task is closed", async () => {
    const [
      { createProductionWorkerBootstrap },
      { createTurnQueue, enqueueTurn, TURN_QUEUE_NAME },
      subagentQueue,
      { createCanonicalTurnRuntime },
      { createPgTaskGraphCommandPort },
      { AgentTreeManager },
    ] = await Promise.all([
      import("../../queue/production-bootstrap.js"),
      import("../turns/turn-queue.js"),
      import("../../queue/subagent-queue.js"),
      import("../canonical-turn-runtime.js"),
      import("./pg-task-graph-command-port.js"),
      import("./manager.js"),
    ])
    const owner = cancelledOwner
    const taskCloser = new AgentTreeManager(new PgSubagentTaskStore(pool!))
    turnQueueName = TURN_QUEUE_NAME
    childQueueName = subagentQueue.SUBAGENT_QUEUE_NAME
    const flags: ProductionAgentFlags = {
      taskGraphPlanningEnabled: true,
      childExecutionEnabled: true,
      coordinationEnabled: true,
      consumeWaitOutcomes: true,
      canonicalAutomationEnabled: false,
      turnBoundaryCompactionEnabled: false,
    }
    const closePlanCallId = "p3-closed-source-plan"
    const closeWaitCallId = "p3-closed-source-wait"
    const sourceGoal = "Run and close the source task through its manager"
    const dependentGoal = "Must not run after its source is closed"
    const transitiveGoal = "Must not run after its ancestor is closed"
    const finalMarker = "p3-closed-source-descendants-cancelled"
    let rootRuntimeExecutions = 0
    let sourceCloseAccepted = false
    const dispatchedGoals: string[] = []
    const runtime = await createCanonicalTurnRuntime(pool!, {
      workerId: owner.ownerId,
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
          id: "p3-task-graph-closed-source-fixture-model",
          profile: {
            provider: "fixture", model: "fixture-model", nativeTools: true, structuredOutput: true, streaming: true,
            continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: false,
            supportsReasoningSummary: false, supportsResponseContinuation: false, supportsProviderConversation: false,
            supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: 128, costClass: "low",
          },
          async *stream(request) {
            modelRounds += 1
            if (execution === 1 && modelRounds === 1) {
              yield {
                type: "tool_call_completed", callId: closePlanCallId, name: "agent.plan",
                arguments: {
                  expectedRevision: 0,
                  nodes: [
                    { key: "source", templateId: "analyst", goal: sourceGoal, successCriteria: ["Close through the manager"], dependsOn: [] },
                    { key: "dependent", templateId: "analyst", goal: dependentGoal, successCriteria: ["Remain undispatched"], dependsOn: ["source"] },
                    { key: "transitive", templateId: "analyst", goal: transitiveGoal, successCriteria: ["Remain undispatched"], dependsOn: ["dependent"] },
                  ],
                },
              }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            if (execution === 1 && modelRounds === 2) {
              expect(request.tools.map(tool => record(tool)?.name)).toContain("agent.wait")
              yield {
                type: "tool_call_completed", callId: closeWaitCallId, name: "agent.wait",
                arguments: {
                  idempotencyKey: `p3-task-graph-closed-source-wait:${owner.turnId}`,
                  taskIds: planTaskIds(request, closePlanCallId, 3), mode: "all", timeoutMs: 20_000,
                },
              }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            if (execution === 2 && modelRounds === 1) {
              const graph = currentGraphFromRequest(request)
              const nodes = Array.isArray(graph?.nodes) ? graph.nodes.map(record) : []
              expect(nodes.map(node => [node?.key, node?.status])).toEqual([
                ["source", "closed"], ["dependent", "cancelled"], ["transitive", "cancelled"],
              ])
              const outcome = waitOutcomeFromRequest(request, 3)
              expect(outcome.status).toBe("ready")
              expect(outcome.tasks.map(task => record(task)?.status).sort()).toEqual(["cancelled", "cancelled", "closed"])
              yield { type: "text_delta", text: finalMarker }
              yield { type: "completed", finishReason: "stop" }
              return
            }
            throw new Error("Unexpected model execution or round in the closed-source fixture")
          },
        }
        return { adapter: model, registry: {} as never, candidates: [] }
      },
    })
    await activateFixtureTurn(pool!, owner)
    bootstrap = await createProductionWorkerBootstrap({
      pool: pool!,
      runtime,
      ownerId: owner.ownerId,
      turnQueueFactory: createTurnQueue,
      turnRecoveryIntervalMs: 100,
      waitResolver: { intervalMs: 10, batchSize: 10, ownerId: `p3-closed-source-wait-resolver-${owner.suffix}` },
      subagents: {
        intervalMs: 10,
        async execute({ lease }) {
          await waitForSuspendedParent(pool!, owner.turnId)
          dispatchedGoals.push(lease.goal)
          if (lease.goal === sourceGoal) {
            const running = await pool!.query<{ status: string }>(
              `SELECT "status" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`,
              [lease.id, owner.sessionId],
            )
            expect(running.rows[0]?.status).toBe("running")
            sourceCloseAccepted = await taskCloser.close(lease.id, owner.sessionId)
            expect(sourceCloseAccepted).toBe(true)
            return { status: "completed", result: { proof: "The manager close path closed this task." } }
          }
          return { status: "completed", result: { proof: `unexpected execution: ${lease.goal}` } }
        },
      },
    })

    await enqueueTurn(pool!, bootstrap.turns.queue, {
      turnId: owner.turnId, sessionId: owner.sessionId, ownerId: owner.ownerId,
    })
    try {
      await waitForTurnStatus(pool!, owner.turnId, "completed", 50_000, closeWaitCallId)
    } catch (error: unknown) {
      const progress = await turnProgressDiagnostics(pool!, owner.turnId, closeWaitCallId)
      throw new Error(combineFailureDiagnostics([
        { label: "closedSourceFixture", value: "failed" },
        { label: "turnFailure", value: waitTurnFailureSummary(error) },
      ], progress))
    }

    expect(rootRuntimeExecutions).toBe(2)
    expect(sourceCloseAccepted).toBe(true)
    expect(dispatchedGoals).toEqual([sourceGoal])
    const turn = await pool!.query<{ rootTaskId: string; finalResponse: string | null }>(
      `SELECT "rootTaskId", "finalResponse" FROM "agent_turns" WHERE "id" = $1`, [owner.turnId],
    )
    const rootTaskId = turn.rows[0]?.rootTaskId
    if (!rootTaskId) throw new Error("Closed-source fixture did not establish a root TaskGraph task")
    expect(turn.rows[0]?.finalResponse).toContain(finalMarker)

    const children = await pool!.query<{ id: string; goal: string; status: string }>(
      `SELECT "id", "goal", "status" FROM "sub_agent_tasks"
       WHERE "sessionId" = $1 AND "turnId" = $2 AND "parentTaskId" = $3 ORDER BY "goal"`,
      [owner.sessionId, owner.turnId, rootTaskId],
    )
    expect(children.rows).toHaveLength(3)
    expect(Object.fromEntries(children.rows.map(child => [child.goal, child.status]))).toEqual({
      [dependentGoal]: "cancelled",
      [sourceGoal]: "closed",
      [transitiveGoal]: "cancelled",
    })

    const source = children.rows.find(child => child.goal === sourceGoal)
    const dependent = children.rows.find(child => child.goal === dependentGoal)
    const transitive = children.rows.find(child => child.goal === transitiveGoal)
    if (!source || !dependent || !transitive) throw new Error("Closed-source fixture did not persist every TaskGraph child")

    const terminalReceipts = await pool!.query<{ taskId: string; idempotencyKey: string; payload: RecordValue }>(
      `SELECT "taskId", "idempotencyKey", "payload" FROM "agent_events"
       WHERE "sessionId" = $1 AND "turnId" = $2 AND "itemId" = $3
         AND "taskId" = ANY($4::text[]) AND "payload"->>'kind' = 'lifecycle'
       ORDER BY "sequence" ASC`,
      [owner.sessionId, owner.turnId, taskGraphItemId(rootTaskId), [source.id, dependent.id, transitive.id]],
    )
    const expectedTerminalReceipts = terminalReceipts.rows.flatMap(row => {
      const event = record(record(row.payload)?.event)
      if (event?.type !== "task.closed" && event?.type !== "task.cancelled") return []
      return [{
        taskId: row.taskId,
        idempotencyKey: row.idempotencyKey,
        type: event.type,
        nodeKey: event.nodeKey,
      }]
    })
    expect(expectedTerminalReceipts).toHaveLength(3)
    expect(expectedTerminalReceipts).toEqual([
      {
        taskId: source.id,
        idempotencyKey: taskGraphLifecycleKey(rootTaskId, "source", 1, "task.closed"),
        type: "task.closed",
        nodeKey: "source",
      },
      {
        taskId: dependent.id,
        idempotencyKey: taskGraphLifecycleKey(rootTaskId, "dependent", 0, "task.cancelled"),
        type: "task.cancelled",
        nodeKey: "dependent",
      },
      {
        taskId: transitive.id,
        idempotencyKey: taskGraphLifecycleKey(rootTaskId, "transitive", 0, "task.cancelled"),
        type: "task.cancelled",
        nodeKey: "transitive",
      },
    ])

    const blockedDispatches = await pool!.query(
      `SELECT "id" FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" = 'agent.subagent.dispatch'
        AND "idempotencyKey" = ANY($2::text[])`,
      [owner.sessionId, [dependent.id, transitive.id].map(taskId => `subagent-dispatch:${taskId}`)],
    )
    expect(blockedDispatches.rowCount).toBe(0)
  }, 90_000)

  it("restores interactive discovery across a real Worker restart and replays its child dispatch once", async () => {
    if (interactiveDiscoveryTraceArtifactPath) await rm(interactiveDiscoveryTraceArtifactPath, { force: true })
    const [{ TURN_QUEUE_NAME }, subagentQueue] = await Promise.all([
      import("../turns/turn-queue.js"), import("../../queue/subagent-queue.js"),
    ])
    turnQueueName = TURN_QUEUE_NAME
    childQueueName = subagentQueue.SUBAGENT_QUEUE_NAME
    const value = discoveryRestartOwner
    const jobId = `p3-discovery-restart-job-${value.suffix}`
    let workerOne: ProcessFixtureChild | undefined
    let workerTwo: ProcessFixtureChild | undefined
    try {
      await activateFixtureTurn(pool!, value)
      await pool!.query(`UPDATE "agent_turns" SET "input" = $2::jsonb WHERE "id" = $1 AND "sessionId" = $3 AND "userId" = $4`, [
        value.turnId,
        JSON.stringify({ goal: "Find and rank a software engineering role in Dublin", intent: { kind: "interactive_discovery_shortlist", version: 1 } }),
        value.sessionId, value.userId,
      ])
      await pool!.query(`INSERT INTO "Job" ("id", "userId", "company", "role", "location", "status", "url", "description", "source", "updatedAt")
        VALUES ($1, $2, 'Restart Fixture Labs', 'Software Engineer', 'Dublin', 'saved', 'https://jobs.example.invalid/restart-discovery', 'Build durable systems', 'greenhouse', CURRENT_TIMESTAMP)`, [
        jobId, value.userId,
      ])

      workerOne = startTaskGraphRestartWorker("park-discovery", { ...value, jobId })
      await waitForProcessLine(workerOne, "P3_DISCOVERY_PARENT_SUSPENDED ", 45_000)
      const waitingTurn = await pool!.query<{ status: string; leaseVersion: number; rootTaskId: string | null }>(
        `SELECT "status", "leaseVersion", "rootTaskId" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`,
        [value.turnId, value.sessionId, value.userId],
      )
      expect(waitingTurn.rows[0]).toMatchObject({ status: "waiting_for_dependency", leaseVersion: 1 })
      const rootTaskId = waitingTurn.rows[0]?.rootTaskId
      expect(rootTaskId).toBeTruthy()
      const source = await pool!.query<{ id: string; status: string }>(
        `SELECT "id", "status" FROM "sub_agent_tasks" WHERE "turnId" = $1 AND "sessionId" = $2 AND "parentTaskId" = $3 AND "role" = 'scout'`,
        [value.turnId, value.sessionId, rootTaskId],
      )
      expect(source.rows).toHaveLength(1)
      expect(source.rows[0]?.status).toBe("queued")
      const initialDispatch = await pool!.query<{ id: string; publishedAt: Date | null }>(
        `SELECT "id", "publishedAt" FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" = 'agent.subagent.dispatch' AND "idempotencyKey" = $2`,
        [value.sessionId, `subagent-dispatch:${source.rows[0]!.id}`],
      )
      expect(initialDispatch.rows).toHaveLength(1)
      expect(initialDispatch.rows[0]?.publishedAt).toBeInstanceOf(Date)

      const foreignTask = await new PgCoordinationStore(pool!).getTask({
        userId: `p3-foreign-user-${value.suffix}`, sessionId: value.sessionId, taskId: source.rows[0]!.id,
      })
      expect(foreignTask).toBeNull()
      const { requireCurrentOwnerJobs } = await import("../interactive-discovery-persistence.js")
      const foreignShortlist = await requireCurrentOwnerJobs(pool!, `p3-foreign-user-${value.suffix}`, {
        schemaVersion: 1, status: "completed", items: [{ jobId, score: 8.5, evidenceIds: [`read:job:${jobId}`] }], failures: [],
      })
      expect(foreignShortlist).toMatchObject({ status: "failed", items: [], failures: ["evidence_unverified"] })

      const firstExit = waitForProcessExit(workerOne)
      expect(workerOne.kill("SIGKILL")).toBe(true)
      await firstExit
      expect(workerOne.signalCode).toBe("SIGKILL")
      // Replay a published outbox row to model a crash between queue acceptance and publish acknowledgement.
      const resetDispatch = await pool!.query(
        `UPDATE "agent_outbox" SET "publishedAt" = NULL WHERE "id" = $1 AND "publishedAt" IS NOT NULL RETURNING "id"`,
        [initialDispatch.rows[0]!.id],
      )
      expect(resetDispatch.rowCount).toBe(1)

      workerTwo = startTaskGraphRestartWorker("resume-discovery", { ...value, jobId })
      await waitForProcessLine(workerTwo, "P3_DISCOVERY_SECOND_WORKER_READY ", 45_000)
      await waitForTurnStatus(pool!, value.turnId, "completed", 90_000)

      const root = await pool!.query<{ id: string; status: string; result: unknown }>(
        `SELECT "id", "status", "result" FROM "sub_agent_tasks" WHERE "turnId" = $1 AND "sessionId" = $2 AND "role" = 'orchestrator'`,
        [value.turnId, value.sessionId],
      )
      expect(root.rows).toHaveLength(1)
      expect(root.rows[0]?.status).toBe("completed")
      expect(record(record(root.rows[0]?.result)?.structuredResult)?.interactiveDiscoveryShortlist).toEqual({
        schemaVersion: 1, status: "completed", items: [{ jobId, score: 8.5, evidenceIds: [`read:job:${jobId}`] }], failures: [],
      })
      const children = await pool!.query<{ id: string; role: string; status: string; result: unknown }>(
        `SELECT "id", "role", "status", "result" FROM "sub_agent_tasks" WHERE "turnId" = $1 AND "sessionId" = $2 AND "parentTaskId" = $3 AND "role" = ANY($4::text[]) ORDER BY "role"`,
        [value.turnId, value.sessionId, root.rows[0]!.id, ["analyst", "scout"]],
      )
      expect(children.rows.map(child => [child.role, child.status])).toEqual([["analyst", "completed"], ["scout", "completed"]])
      expect(workerTwo.output.filter(line => line.startsWith(`P3_DISCOVERY_CHILD_SETTLED ${source.rows[0]!.id} scout `))).toHaveLength(1)
      const persistedSearchReceipts = await pool!.query<{ taskId: string; toolName: string }>(
        `SELECT "taskId", "content"->>'toolName' AS "toolName" FROM "agent_items"
         WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = ANY($3::text[]) AND "type" = 'tool_result'
           AND "content"->>'toolName' = 'jobs.search' ORDER BY "taskId"`,
        [value.sessionId, value.turnId, children.rows.map(child => child.id)],
      )
      expect(persistedSearchReceipts.rows).toHaveLength(2)
      expect(persistedSearchReceipts.rows.map(receipt => receipt.taskId).sort()).toEqual(children.rows.map(child => child.id).sort())
      const dispatches = await pool!.query<{ idempotencyKey: string; publishedAt: Date | null }>(
        `SELECT "idempotencyKey", "publishedAt" FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" = 'agent.subagent.dispatch' AND "idempotencyKey" = ANY($2::text[]) ORDER BY "idempotencyKey"`,
        [value.sessionId, children.rows.map(child => `subagent-dispatch:${child.id}`)],
      )
      expect(dispatches.rows).toHaveLength(2)
      expect(dispatches.rows.every(dispatch => dispatch.publishedAt instanceof Date)).toBe(true)
      expect(new Set(dispatches.rows.map(dispatch => dispatch.idempotencyKey)).size).toBe(2)
      const waits = await pool!.query<{ consumedAt: Date | null }>(
        `SELECT "consumedAt" FROM "agent_wait_conditions" WHERE "turnId" = $1 AND "sessionId" = $2 ORDER BY "createdAt"`,
        [value.turnId, value.sessionId],
      )
      expect(waits.rows).toHaveLength(2)
      expect(waits.rows.every(wait => wait.consumedAt instanceof Date)).toBe(true)
      const turn = await pool!.query<{ status: string; finalResponse: string | null }>(`SELECT "status", "finalResponse" FROM "agent_turns" WHERE "id" = $1`, [value.turnId])
      expect(turn.rows[0]?.finalResponse).toContain(jobId)
      expect(workerTwo.output.some(line => line.startsWith("P3_DISCOVERY_RESTORED_FINAL_GRAPH "))).toBe(true)

      if (interactiveDiscoveryTraceArtifactPath) {
        const graphRows = await pool!.query<TaskGraphItemRow>(
          `SELECT "id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "revision", "content", "startedAt", "completedAt", "createdAt", "updatedAt"
           FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "type" = 'task_graph'`,
          [value.sessionId, value.turnId, root.rows[0]!.id],
        )
        expect(graphRows.rows).toHaveLength(1)
        const graph = graphRows.rows[0]!
        const ledgerTasks = await pool!.query<{
          id: string; sessionId: string; turnId: string | null; rootTaskId: string | null; parentTaskId: string | null
          path: string; role: string; taskType: string; status: string; goal: string; confidence: number | null
          failureReason: string | null; result: RecordValue | null; createdAt: Date; updatedAt: Date
        }>(
          `SELECT "id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "role", "taskType", "status", "goal", "confidence", "failureReason", "result", "createdAt", "updatedAt"
           FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "turnId" = $2 AND ("id" = $3 OR "parentTaskId" = $3)
           ORDER BY "createdAt" ASC, "id" ASC`,
          [value.sessionId, value.turnId, root.rows[0]!.id],
        )
        const safeTasks = ledgerTasks.rows.map(row => {
          const evidencePreview = projectTaskEvidencePreview(row)
          return {
            id: row.id, sessionId: row.sessionId, turnId: row.turnId, rootTaskId: row.rootTaskId,
            parentTaskId: row.parentTaskId, path: row.path, role: row.role, taskType: row.taskType,
            status: row.status, goal: row.goal, confidence: row.confidence, failureReason: row.failureReason,
            hasResult: row.result !== null,
            ...(evidencePreview ? { structuredEvidencePreview: evidencePreview } : {}),
          }
        })
        const planLedger = projectPlanLedger({
          sessionId: value.sessionId, revision: graph.revision, rootTaskId: root.rows[0]!.id,
          graph: graph.content, tasks: safeTasks,
        })
        if (!planLedger) throw new Error("Interactive discovery restart did not project its persisted Plan Ledger")
        const shortlistValue = record(record(root.rows[0]?.result)?.structuredResult)?.interactiveDiscoveryShortlist
        const shortlist = record(shortlistValue)
        const rawItems = Array.isArray(shortlist?.items) ? shortlist.items.map(record) : []
        const safeShortlist = {
          schemaVersion: 1,
          status: shortlist?.status === "completed" || shortlist?.status === "partial" || shortlist?.status === "failed" ? shortlist.status : "failed",
          items: rawItems.flatMap(item => {
            if (typeof item?.jobId !== "string" || typeof item.score !== "number" || !Number.isFinite(item.score)) return []
            const evidenceIds = Array.isArray(item.evidenceIds) ? item.evidenceIds.filter((id): id is string => typeof id === "string") : []
            return [{ jobId: item.jobId, score: item.score, evidenceIds }]
          }).slice(0, 3),
          failures: Array.isArray(shortlist?.failures) ? shortlist.failures.filter((failure): failure is string => typeof failure === "string").slice(0, 12) : [],
        }
        const finalResponse = JSON.parse(turn.rows[0]?.finalResponse ?? "null") as RecordValue | null
        const finalShortlistText = typeof finalResponse?.response === "string" ? finalResponse.response : ""
        if (turn.rows[0]?.status !== "completed" || !finalShortlistText || JSON.stringify(JSON.parse(finalShortlistText)) !== JSON.stringify(safeShortlist)) {
          throw new Error("Interactive discovery trace final outcome does not match its persisted shortlist")
        }
        await writeFile(interactiveDiscoveryTraceArtifactPath, JSON.stringify({
          schemaVersion: "agent-harness.v2.interactive-discovery-trace",
          sessionId: value.sessionId,
          turnId: value.turnId,
          rootTaskId: root.rows[0]!.id,
          graphItemId: graph.id,
          graphRevision: graph.revision,
          graph: graph.content,
          tasks: safeTasks,
          planLedger,
          interactiveDiscoveryShortlist: safeShortlist,
          finalOutcome: { turnStatus: turn.rows[0].status, response: finalShortlistText },
        }), "utf8")
      }
    } finally {
      if (workerOne && !processFixtureExited(workerOne)) await killProcessFixture(workerOne)
      if (workerTwo) await stopProcessFixture(workerTwo)
    }
  }, 240_000)

  it("replans a canonical discovery Turn from durable child evidence and persists the owner-scoped shortlist", async () => {
    const [workerQueue, canonical, commandPortModule, subagentQueue] = await Promise.all([
      import("../../queue/production-bootstrap.js"),
      import("../canonical-turn-runtime.js"),
      import("./pg-task-graph-command-port.js"),
      import("../../queue/subagent-queue.js"),
    ])
    const { createProductionChildExecutor } = await import("./production-child-runtime.js")
    const { createTurnQueue, enqueueTurn, TURN_QUEUE_NAME } = await import("../turns/turn-queue.js")
    turnQueueName = TURN_QUEUE_NAME
    childQueueName = subagentQueue.SUBAGENT_QUEUE_NAME
    await activateFixtureTurn(pool!, discoveryOwner)

    const jobId = `p3-discovery-job-${discoveryOwner.suffix}`
    await pool!.query(`UPDATE "agent_turns" SET "input" = $2::jsonb WHERE "id" = $1 AND "sessionId" = $3 AND "userId" = $4`, [
      discoveryOwner.turnId,
      JSON.stringify({ goal: "Find a strong software engineering role in Dublin", intent: { kind: "interactive_discovery_shortlist", version: 1 } }),
      discoveryOwner.sessionId, discoveryOwner.userId,
    ])
    await pool!.query(`INSERT INTO "Job" ("id", "userId", "company", "role", "location", "status", "url", "description", "source", "updatedAt")
      VALUES ($1, $2, 'Fixture Labs', 'Software Engineer', 'Dublin', 'saved', 'https://jobs.example.invalid/discovery', 'Build reliable services', 'greenhouse', CURRENT_TIMESTAMP)`, [
      jobId, discoveryOwner.userId,
    ])

    const flags: ProductionAgentFlags = {
      taskGraphPlanningEnabled: true, childExecutionEnabled: true, coordinationEnabled: true,
      consumeWaitOutcomes: true, canonicalAutomationEnabled: false, turnBoundaryCompactionEnabled: false,
    }
    const profile = {
      provider: "fixture", model: "fixture-model", nativeTools: true, structuredOutput: true, streaming: true,
      continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: false,
      supportsReasoningSummary: false, supportsResponseContinuation: false, supportsProviderConversation: false,
      supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: 128, costClass: "low" as const,
    }
    let rootExecution = 0
    const rootRuntime = await canonical.createCanonicalTurnRuntime(pool!, {
      workerId: discoveryOwner.ownerId, productionFlags: flags,
      taskGraphCommandPort: commandPortModule.createPgTaskGraphCommandPort(pool!),
      authorizeUsage: async () => ({ settle: async () => undefined }),
      modelRuntimeFactory: () => {
        const execution = ++rootExecution
        let round = 0
        const adapter: ModelAdapter = {
          id: "p3-interactive-discovery-root-fixture", profile,
          async *stream(request) {
            round += 1
            if (execution === 1 && round === 1) {
              expect(request.tools.map(tool => record(tool)?.name)).toContain("agent.plan")
              yield { type: "tool_call_completed", callId: "p3-discovery-plan-scout", name: "agent.plan", arguments: {
                expectedRevision: 0,
                nodes: [{ key: "scout", templateId: "scout", goal: "Find matching fixture roles", successCriteria: ["Read one owner job"], dependsOn: [] }],
              } }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            if (execution === 1 && round === 2) {
              const taskIds = planTaskIds(request, "p3-discovery-plan-scout", 1)
              yield { type: "tool_call_completed", callId: "p3-discovery-wait-scout", name: "agent.wait", arguments: {
                idempotencyKey: `p3-discovery-wait-scout:${discoveryOwner.turnId}`, taskIds, mode: "all", timeoutMs: 20_000,
              } }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            if (execution === 2 && round === 1) {
              const graph = currentGraphFromRequest(request)
              const nodes = Array.isArray(graph?.nodes) ? graph.nodes.map(record) : []
              expect(nodes.map(node => node?.key)).toEqual(["scout"])
              expect(nodes[0]?.status).toBe("completed")
              const revision = graph?.revision
              if (typeof revision !== "number") throw new Error("Discovery replan did not receive the durable graph revision")
              yield { type: "tool_call_completed", callId: "p3-discovery-plan-analyst", name: "agent.plan", arguments: {
                expectedRevision: revision,
                nodes: [{ key: "analyst", templateId: "analyst", goal: "Score the discovered role", successCriteria: ["Return an evidence-bound score"], dependsOn: ["scout"] }],
              } }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            if (execution === 2 && round === 2) {
              const taskIds = planTaskIds(request, "p3-discovery-plan-analyst", 1)
              yield { type: "tool_call_completed", callId: "p3-discovery-wait-analyst", name: "agent.wait", arguments: {
                idempotencyKey: `p3-discovery-wait-analyst:${discoveryOwner.turnId}`, taskIds, mode: "all", timeoutMs: 20_000,
              } }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            if (execution === 3 && round === 1) {
              const graph = currentGraphFromRequest(request)
              const nodes = Array.isArray(graph?.nodes) ? graph.nodes.map(record) : []
              expect(nodes.map(node => node?.key)).toEqual(["scout", "analyst"])
              expect(nodes.map(node => node?.status)).toEqual(["completed", "completed"])
              const wait = waitOutcomeFromRequest(request, 1)
              expect(wait.status).toBe("ready")
              yield { type: "text_delta", text: JSON.stringify({ schemaVersion: "agent-harness.v2.final", response: "Shortlist ready" }) }
              yield { type: "completed", finishReason: "stop" }
              return
            }
            throw new Error(`Unexpected discovery root model turn ${execution}/${round}`)
          },
        }
        return { adapter, registry: {} as never, candidates: [] }
      },
    })
    const childExecutor = createProductionChildExecutor({
      pool: pool!, authorizeUsage: async () => ({ settle: async () => undefined }),
      modelRuntimeFactory: ({ task }) => {
        let round = 0
        const adapter: ModelAdapter = {
          id: `p3-interactive-discovery-${task.role}-fixture`, profile,
          async *stream(request) {
            round += 1
            if (round === 1) {
              expect(request.tools.map(tool => record(tool)?.name)).toContain("jobs.search")
              yield { type: "tool_call_completed", callId: `p3-discovery-read-${task.role}`, name: "jobs.search", arguments: { target: "Software Engineer", location: "Dublin", limit: 10 } }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            const evidence = { id: `read:job:${jobId}`, kind: "job", ref: jobId, source: "greenhouse" }
            const result = task.role === "scout"
              ? { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed", candidates: [{ jobId, source: "fixture", url: null, evidenceIds: [evidence.id] }], evidence: [evidence], summary: "Found the fixture role" }
              : { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed", findings: [{ jobId, score: 8.5, evidenceIds: [evidence.id] }], evidence: [evidence], summary: "Strong match" }
            yield { type: "text_delta", text: JSON.stringify(result) }
            yield { type: "completed", finishReason: "stop" }
          },
        }
        return adapter
      },
    })
    bootstrap = await workerQueue.createProductionWorkerBootstrap({
      pool: pool!, runtime: rootRuntime, ownerId: discoveryOwner.ownerId,
      turnQueueFactory: createTurnQueue, turnRecoveryIntervalMs: 100,
      waitResolver: { intervalMs: 10, batchSize: 10, ownerId: `p3-discovery-wait-resolver-${discoveryOwner.suffix}` },
      subagents: { execute: childExecutor, intervalMs: 10 },
    })

    await enqueueTurn(pool!, bootstrap.turns.queue, { turnId: discoveryOwner.turnId, sessionId: discoveryOwner.sessionId, ownerId: discoveryOwner.ownerId })
    await waitForTurnStatus(pool!, discoveryOwner.turnId, "completed", 50_000, "p3-discovery-wait-analyst")

    const root = await pool!.query<{ status: string; result: unknown }>(
      `SELECT "status", "result" FROM "sub_agent_tasks" WHERE "turnId" = $1 AND "sessionId" = $2 AND "role" = 'orchestrator'`,
      [discoveryOwner.turnId, discoveryOwner.sessionId],
    )
    expect(root.rows).toHaveLength(1)
    expect(root.rows[0]?.status).toBe("completed")
    expect(record(record(root.rows[0]?.result)?.structuredResult)?.interactiveDiscoveryShortlist).toEqual({
      schemaVersion: 1, status: "completed", items: [{ jobId, score: 8.5, evidenceIds: [`read:job:${jobId}`] }], failures: [],
    })
    const children = await pool!.query<{ id: string; role: string; status: string; result: unknown }>(
      `SELECT "id", "role", "status", "result" FROM "sub_agent_tasks"
       WHERE "turnId" = $1 AND "sessionId" = $2 AND "role" = ANY($3::text[]) ORDER BY "role"`,
      [discoveryOwner.turnId, discoveryOwner.sessionId, ["analyst", "scout"]],
    )
    expect(children.rows.map(child => [child.role, child.status])).toEqual([["analyst", "completed"], ["scout", "completed"]])
    expect(children.rows.map(child => record(record(child.result)?.structuredResult)?.role)).toEqual(["analyst", "scout"])
    const dispatches = await pool!.query<{ idempotencyKey: string; publishedAt: Date | null }>(
      `SELECT "idempotencyKey", "publishedAt" FROM "agent_outbox"
       WHERE "aggregateId" = $1 AND "topic" = 'agent.subagent.dispatch' AND "idempotencyKey" = ANY($2::text[]) ORDER BY "idempotencyKey"`,
      [discoveryOwner.sessionId, children.rows.map(child => `subagent-dispatch:${child.id}`)],
    )
    expect(dispatches.rows).toHaveLength(2)
    expect(dispatches.rows.every(dispatch => dispatch.publishedAt instanceof Date)).toBe(true)
    const waits = await pool!.query<{ id: string; consumedAt: Date | null }>(
      `SELECT "id", "consumedAt" FROM "agent_wait_conditions" WHERE "turnId" = $1 AND "sessionId" = $2 ORDER BY "createdAt"`,
      [discoveryOwner.turnId, discoveryOwner.sessionId],
    )
    expect(waits.rows).toHaveLength(2)
    expect(waits.rows.every(wait => wait.consumedAt instanceof Date)).toBe(true)
    const final = await pool!.query<{ finalResponse: string | null }>(`SELECT "finalResponse" FROM "agent_turns" WHERE "id" = $1`, [discoveryOwner.turnId])
    const finalResponse = JSON.parse(final.rows[0]?.finalResponse ?? "null") as RecordValue
    expect(finalResponse.response).toContain('"jobId":"' + jobId + '"')
  }, 90_000)

  it("fails an interactive shortlist when its Scout prerequisite fails and cancels dependent work", async () => {
    const [workerQueue, canonical, commandPortModule, subagentQueue] = await Promise.all([
      import("../../queue/production-bootstrap.js"),
      import("../canonical-turn-runtime.js"),
      import("./pg-task-graph-command-port.js"),
      import("../../queue/subagent-queue.js"),
    ])
    const { createProductionChildExecutor } = await import("./production-child-runtime.js")
    const { createTurnQueue, enqueueTurn, TURN_QUEUE_NAME } = await import("../turns/turn-queue.js")
    turnQueueName = TURN_QUEUE_NAME
    childQueueName = subagentQueue.SUBAGENT_QUEUE_NAME
    const value = discoveryFailureOwner
    await activateFixtureTurn(pool!, value)
    const jobId = `p3-discovery-failure-job-${value.suffix}`
    await pool!.query(`UPDATE "agent_turns" SET "input" = $2::jsonb WHERE "id" = $1 AND "sessionId" = $3 AND "userId" = $4`, [
      value.turnId,
      JSON.stringify({ goal: "Find and rank an engineering role in Dublin", intent: { kind: "interactive_discovery_shortlist", version: 1 } }),
      value.sessionId, value.userId,
    ])
    await pool!.query(`INSERT INTO "Job" ("id", "userId", "company", "role", "location", "status", "url", "description", "source", "updatedAt")
      VALUES ($1, $2, 'Failure Fixture Labs', 'Software Engineer', 'Dublin', 'saved', 'https://jobs.example.invalid/discovery-failure', 'Build durable services', 'greenhouse', CURRENT_TIMESTAMP)`, [
      jobId, value.userId,
    ])

    const flags: ProductionAgentFlags = {
      taskGraphPlanningEnabled: true, childExecutionEnabled: true, coordinationEnabled: true,
      consumeWaitOutcomes: true, canonicalAutomationEnabled: false, turnBoundaryCompactionEnabled: false,
    }
    const profile = {
      provider: "fixture", model: "fixture-model", nativeTools: true, structuredOutput: true, streaming: true,
      continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: false,
      supportsReasoningSummary: false, supportsResponseContinuation: false, supportsProviderConversation: false,
      supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: 128, costClass: "low" as const,
    }
    let rootExecution = 0
    let optimisticFinalAttempted = false
    const rootRuntime = await canonical.createCanonicalTurnRuntime(pool!, {
      workerId: value.ownerId, productionFlags: flags,
      taskGraphCommandPort: commandPortModule.createPgTaskGraphCommandPort(pool!),
      authorizeUsage: async () => ({ settle: async () => undefined }),
      modelRuntimeFactory: () => {
        const execution = ++rootExecution
        let round = 0
        const adapter: ModelAdapter = {
          id: "p3-interactive-discovery-dependency-failure-root-fixture", profile,
          async *stream(request) {
            round += 1
            if (execution === 1 && round === 1) {
              yield { type: "tool_call_completed", callId: "p3-discovery-failure-plan", name: "agent.plan", arguments: {
                expectedRevision: 0,
                nodes: [
                  { key: "scout", templateId: "scout", goal: "Find matching fixture roles", successCriteria: ["Read one owner job"], dependsOn: [] },
                  { key: "analyst", templateId: "analyst", goal: "Score the discovered fixture role", successCriteria: ["Return an evidence-bound score"], dependsOn: ["scout"] },
                ],
              } }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            if (execution === 1 && round === 2) {
              const taskIds = planTaskIds(request, "p3-discovery-failure-plan")
              yield { type: "tool_call_completed", callId: "p3-discovery-failure-wait", name: "agent.wait", arguments: {
                idempotencyKey: `p3-discovery-failure-wait:${value.turnId}`, taskIds, mode: "all", timeoutMs: 20_000,
              } }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            if (execution === 2 && round === 1) {
              const graph = currentGraphFromRequest(request)
              const nodes = Array.isArray(graph?.nodes) ? graph.nodes.map(record) : []
              const graphStates = nodes.map(node => `${String(node?.key)}:${String(node?.status)}`).sort()
              expect(graphStates).toEqual(["analyst:cancelled", "scout:failed"])
              const outcome = waitOutcomeFromRequest(request, 2)
              expect(outcome.status).toBe("ready")
              const tasks = outcome.tasks.map(record)
              const taskStates = tasks.map(task => `${String(task?.role)}:${String(task?.status)}`).sort()
              expect(taskStates).toEqual(["analyst:cancelled", "scout:failed"])
              const failedScout = tasks.find(task => task?.role === "scout")
              expect(typeof failedScout?.failureReason).toBe("string")
              expect(String(failedScout?.failureReason).length).toBeGreaterThan(0)
              optimisticFinalAttempted = true
              yield { type: "text_delta", text: JSON.stringify({ schemaVersion: "agent-harness.v2.final", response: `Shortlist ready: ${jobId}` }) }
              yield { type: "completed", finishReason: "stop" }
              return
            }
            throw new Error(`Unexpected discovery failure root model turn ${execution}/${round}`)
          },
        }
        return { adapter, registry: {} as never, candidates: [] }
      },
    })
    const childExecutor = createProductionChildExecutor({
      pool: pool!, authorizeUsage: async () => ({ settle: async () => undefined }),
      modelRuntimeFactory: ({ task }) => {
        if (task.role !== "scout") throw new Error(`Dependent discovery role executed unexpectedly: ${task.role}`)
        let round = 0
        const adapter: ModelAdapter = {
          id: "p3-interactive-discovery-invalid-scout-fixture", profile,
          async *stream(request) {
            round += 1
            if (round === 1) {
              expect(request.tools.map(tool => record(tool)?.name)).toContain("jobs.search")
              yield { type: "tool_call_completed", callId: "p3-discovery-failure-read", name: "jobs.search", arguments: { target: "Software Engineer", location: "Dublin", limit: 10 } }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            const searchResult = record(latestToolResult(request, "p3-discovery-failure-read"))
            const observedJobIds = Array.isArray(searchResult?.jobs)
              ? searchResult.jobs.map(record).flatMap(job => typeof job?.id === "string" ? [job.id] : [])
              : []
            expect(observedJobIds).toContain(jobId)
            // Exercise the production structured-result validator with a deterministic invalid Scout receipt.
            yield { type: "text_delta", text: "{}" }
            yield { type: "completed", finishReason: "stop" }
          },
        }
        return adapter
      },
    })
    bootstrap = await workerQueue.createProductionWorkerBootstrap({
      pool: pool!, runtime: rootRuntime, ownerId: value.ownerId,
      turnQueueFactory: createTurnQueue, turnRecoveryIntervalMs: 100,
      waitResolver: { intervalMs: 10, batchSize: 10, ownerId: `p3-discovery-failure-wait-resolver-${value.suffix}` },
      subagents: { execute: childExecutor, intervalMs: 10 },
    })

    await enqueueTurn(pool!, bootstrap.turns.queue, { turnId: value.turnId, sessionId: value.sessionId, ownerId: value.ownerId })
    await waitForTurnStatus(pool!, value.turnId, "failed", 50_000, "p3-discovery-failure-wait")

    const turn = await pool!.query<{ status: string; finalResponse: string | null }>(
      `SELECT "status", "finalResponse" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`,
      [value.turnId, value.sessionId, value.userId],
    )
    expect(turn.rows[0]?.status).toBe("failed")
    expect(optimisticFinalAttempted).toBe(true)
    expect(turn.rows[0]?.finalResponse ?? "").not.toContain(jobId)

    const root = await pool!.query<{ id: string; status: string; failureReason: string | null; result: unknown }>(
      `SELECT "id", "status", "failureReason", "result" FROM "sub_agent_tasks"
       WHERE "turnId" = $1 AND "sessionId" = $2 AND "role" = 'orchestrator'`, [value.turnId, value.sessionId],
    )
    expect(root.rows).toHaveLength(1)
    expect(root.rows[0]).toMatchObject({ status: "failed", failureReason: "business_precondition_failed" })
    expect(record(root.rows[0]?.result)?.status).toBe("failed")
    expect(record(record(root.rows[0]?.result)?.structuredResult)?.interactiveDiscoveryShortlist).toEqual({
      schemaVersion: 1, status: "failed", items: [], failures: ["scout_task_failed", "analyst_task_failed"],
    })
    const rejection = await pool!.query<{ payload: unknown }>(
      `SELECT "payload" FROM "agent_events" WHERE "turnId" = $1 AND "sessionId" = $2 AND "type" = 'final.rejected'
       ORDER BY "sequence" DESC LIMIT 1`, [value.turnId, value.sessionId],
    )
    expect(record(rejection.rows[0]?.payload)).toMatchObject({ blocker: "interactive_discovery_shortlist_required" })
    const children = await pool!.query<{ id: string; role: string; status: string; failureReason: string | null }>(
      `SELECT "id", "role", "status", "failureReason" FROM "sub_agent_tasks"
       WHERE "turnId" = $1 AND "sessionId" = $2 AND "parentTaskId" = $3 ORDER BY "role"`,
      [value.turnId, value.sessionId, root.rows[0]!.id],
    )
    expect(children.rows.map(child => [child.role, child.status])).toEqual([["analyst", "cancelled"], ["scout", "failed"]])
    expect(children.rows.find(child => child.role === "scout")?.failureReason).toBe("invalid_structured_result")
    expect(children.rows.find(child => child.role === "analyst")?.failureReason).toContain("prerequisite")
    const dependentDispatches = await pool!.query(
      `SELECT "id" FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" = 'agent.subagent.dispatch'
       AND "idempotencyKey" = $2`, [value.sessionId, `subagent-dispatch:${children.rows.find(child => child.role === "analyst")?.id}`],
    )
    expect(dependentDispatches.rowCount).toBe(0)
    const wait = await pool!.query<{ status: string; consumedAt: Date | null }>(
      `SELECT "status", "consumedAt" FROM "agent_wait_conditions" WHERE "turnId" = $1 AND "sessionId" = $2`,
      [value.turnId, value.sessionId],
    )
    expect(wait.rows).toHaveLength(1)
    expect(wait.rows[0]).toMatchObject({ status: "ready", consumedAt: expect.any(Date) })
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
