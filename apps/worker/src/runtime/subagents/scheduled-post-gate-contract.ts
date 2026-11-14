import { createHash } from "node:crypto"
import type { TaskGraphProposal } from "../planning/task-graph.js"
import type { TaskGraphExecutionScope, TaskGraphReadScope } from "./task-graph-command-port.js"
import type { ScheduledGateCompletionProof, ScheduledTaskGraphExecutionOwner } from "./scheduled-gate-contract.js"
import type { SubagentTaskStatus } from "./types.js"

export const SCHEDULED_POST_GATE_EXECUTE_TEMPLATE_ID = "scheduled.application.execute" as const
export const SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID = "scheduled.post_gate_audit" as const
export const SCHEDULED_POST_GATE_EXECUTE_ROLE = "executor" as const
export const SCHEDULED_POST_GATE_EXECUTE_TASK_TYPE = "scheduled_taskgraph_execute" as const
export const SCHEDULED_POST_GATE_AUDIT_ROLE = "auditor" as const
export const SCHEDULED_POST_GATE_AUDIT_TASK_TYPE = "scheduled_taskgraph_post_gate_audit" as const
export const SCHEDULED_POST_GATE_HANDOFF_SCHEMA = "agent-harness.v2.scheduled-post-gate-handoff.v1" as const
export const SCHEDULED_POST_GATE_HANDOFF_EVENT = "agent.plan.scheduled_post_gate_handoff" as const
export const SCHEDULED_POST_GATE_EXECUTE_OUTPUT_SCHEMA = Object.freeze({
  schemaVersion: "agent-harness.v2.subagent.result", role: SCHEDULED_POST_GATE_EXECUTE_ROLE, taskType: SCHEDULED_POST_GATE_EXECUTE_TASK_TYPE,
})
export const SCHEDULED_POST_GATE_AUDIT_OUTPUT_SCHEMA = Object.freeze({
  schemaVersion: "agent-harness.v2.subagent.result", role: SCHEDULED_POST_GATE_AUDIT_ROLE, taskType: SCHEDULED_POST_GATE_AUDIT_TASK_TYPE,
})
export const SCHEDULED_POST_GATE_EXECUTE_GOAL = "Run the existing Execute stage once for only this exact Gate-approved package partition; do not submit applications." as const
export const SCHEDULED_POST_GATE_EXECUTE_CRITERIA = Object.freeze([
  "Use only the exact Gate-approved package refs attached to this server-owned Execute task.",
  "Run the existing non-submitting Execute behavior and return its bounded result.",
  "Do not submit applications, send Gmail, contact employers, or create child tasks.",
])
export const SCHEDULED_POST_GATE_AUDIT_GOAL = "Return the existing scheduled Audit report after every server-planned Execute task is terminal." as const
export const SCHEDULED_POST_GATE_AUDIT_CRITERIA = Object.freeze([
  "Run the existing scheduled Audit behavior exactly once after all Execute dependencies finish.",
  "Preserve the existing seven-field report semantics and return only the bounded report.",
  "Do not submit applications, send Gmail, contact employers, or invoke model or tool runtimes.",
])
export const SCHEDULED_POST_GATE_PLAN_REQUIRED_FEEDBACK = "The existing Gate proof is verified. Call agent.plan once to append the bounded post-Gate TaskGraph: partition every approved package ref across 1–3 Execute tasks (or one empty Execute if none were approved), then add the required Audit depending on every Execute. Do not create work through spawn or follow-up tools." as const

export type ScheduledPostGateOwner = Readonly<{
  userId: string; sessionId: string; turnId: string; rootTaskId: string; rootAttemptCount: number
  turnLeaseOwnerId: string; turnLeaseVersion: number; executionId: string; executionAttemptCount: number
}>
export type ScheduledPostGateHandoff = Readonly<{
  schemaVersion: typeof SCHEDULED_POST_GATE_HANDOFF_SCHEMA
  owner: ScheduledPostGateOwner
  snapshotDigest: string
  continuationKey: string
  gateTaskId: string
  gateAttemptCount: number
  gateCompletedEventRevision: number
  gateProofDigest: string
  gateProof: ScheduledGateCompletionProof
  gateResultDigest: string
  packageRefs: readonly string[]
  packageDigest: string
  proposalDigest: string
  gateGraphRevision: number
  graphRevision: number
  executeNodes: readonly Readonly<{ key: string; taskId: string; packageRefs: readonly string[] }>[]
  auditTaskId: string
}>
export type ScheduledPostGatePlanningContext =
  | Readonly<{ status: "not_applicable" | "invalid" }>
  | Readonly<{ status: "awaiting_plan"; scope: TaskGraphReadScope; executionOwner: ScheduledTaskGraphExecutionOwner;
      gateProof: ScheduledGateCompletionProof; packageRefs: readonly string[]; graphRevision: number; continuationKey: string; snapshotDigest: string }>
  | Readonly<{ status: "planned"; receipt: ScheduledPostGateHandoff; graphRevision: number }>
export type TaskGraphScheduledPostGatePlanInput = Readonly<{
  scope: TaskGraphExecutionScope
  proposal: TaskGraphProposal
  operation: import("./steering-reconciliation-contract.js").SteeringReconciliationOperation
}>
export type TaskGraphScheduledPostGatePlanReadInput = Readonly<{ scope: TaskGraphReadScope }>
export type ScheduledPostGateScheduleReceipt = Readonly<{
  status: "accepted" | "duplicate"
  revision: number
  nodes: readonly Readonly<{ key: string; taskId: string; status: SubagentTaskStatus }>[]
  readyTaskIds: readonly string[]
}>
export type ScheduledPostGateCompletionProof = Readonly<{
  schemaVersion: "agent-harness.v2.scheduled-post-gate-completion.v1"
  handoff: ScheduledPostGateHandoff
  graphRevision: number
  execute: readonly Readonly<{ taskId: string; attemptCount: number; resultDigest: string; completedEventRevision: number }>[]
  audit: Readonly<{ taskId: string; attemptCount: number; resultDigest: string; completedEventRevision: number;
    report: import("./scheduled-audit-contract.js").ScheduledAuditReport }>
}>

export type ScheduledPostGateExecuteOutput = Readonly<{ queued: readonly string[]; failed: readonly string[] }>

export function parseScheduledPostGateExecuteTaskEnvelope(value: unknown, taskStatus: unknown,
  packageRefs: readonly string[]): ScheduledPostGateExecuteOutput | null {
  const row = exactRecord(value, ["finalItemId", "finalText", "status", "stepCount", "toolCallCount", "taskGraphVerificationReport", "structuredResult"])
  const result = row && exactRecord(row.structuredResult, ["queued", "failed"])
  const queued = result && strings(result.queued, packageRefs), failed = result && strings(result.failed, packageRefs)
  if (!row || !result || !queued || !failed || taskStatus !== "completed" || row.status !== "completed"
    || row.finalItemId !== null || row.finalText !== "" || row.stepCount !== 0 || row.toolCallCount !== 0
    || row.taskGraphVerificationReport !== null || queued.some(id => failed.includes(id))) return null
  return { queued, failed }
}

const DIGEST = /^sha256:[a-f0-9]{64}$/
const EVENT_KEY_PREFIX = "scheduled-post-gate-handoff:"

export function scheduledPostGateDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value), "utf8").digest("hex")}`
}
export function scheduledPostGateHandoffKey(owner: Readonly<{ userId: string; sessionId: string; turnId: string; rootTaskId: string;
  rootAttemptCount: number; gateTaskId: string; gateAttemptCount: number }>): string {
  return EVENT_KEY_PREFIX + scheduledPostGateDigest([owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId,
    owner.rootAttemptCount, owner.gateTaskId, owner.gateAttemptCount]).slice("sha256:".length)
}

export function parseScheduledPostGateHandoff(value: unknown): ScheduledPostGateHandoff | null {
  const row = record(value), owner = row && record(row.owner), executeNodes = row && list(row.executeNodes, 3)
  const packageRefs = row && listStrings(row.packageRefs, 50, true)
  if (!row || !owner || !executeNodes || !packageRefs
    || !exactKeys(row, ["schemaVersion", "owner", "snapshotDigest", "continuationKey", "gateTaskId", "gateAttemptCount",
      "gateCompletedEventRevision", "gateProofDigest", "gateProof", "gateResultDigest", "packageRefs", "packageDigest", "proposalDigest",
      "gateGraphRevision", "graphRevision", "executeNodes", "auditTaskId"])
    || row.schemaVersion !== SCHEDULED_POST_GATE_HANDOFF_SCHEMA || !validOwner(owner)
    || !digest(row.snapshotDigest) || !validId(row.continuationKey) || !validId(row.gateTaskId)
    || !positive(row.gateAttemptCount) || !positive(row.gateCompletedEventRevision)
    || !digest(row.gateProofDigest) || !record(row.gateProof) || !digest(row.gateResultDigest) || !digest(row.packageDigest)
    || scheduledPostGateDigest(row.gateProof) !== row.gateProofDigest
    || !digest(row.proposalDigest) || !positive(row.gateGraphRevision) || row.gateCompletedEventRevision !== row.gateGraphRevision
    || !positive(row.graphRevision) || row.graphRevision !== row.gateGraphRevision + 1 || !validId(row.auditTaskId)
    || scheduledPostGateDigest(packageRefs) !== row.packageDigest
    || executeNodes.length < 1 || !executeNodes.every((item): item is Record<string, unknown> => {
      const node = record(item), refs = node && listStrings(node.packageRefs, 50, true)
      return !!node && exactKeys(node, ["key", "taskId", "packageRefs"]) && validId(node.key) && validId(node.taskId) && !!refs
        && new Set(refs).size === refs.length
    })) return null
  const parsedNodes = executeNodes.map(item => {
    const node = item as Record<string, unknown>
    return { key: node.key as string, taskId: node.taskId as string, packageRefs: [...node.packageRefs as string[]] }
  })
  if (new Set(parsedNodes.map(node => node.key)).size !== parsedNodes.length
    || new Set(parsedNodes.map(node => node.taskId)).size !== parsedNodes.length
    || parsedNodes.some(node => !node.packageRefs.every(ref => packageRefs.includes(ref)))
    || parsedNodes.flatMap(node => node.packageRefs).length !== packageRefs.length
    || new Set(parsedNodes.flatMap(node => node.packageRefs)).size !== packageRefs.length
    || !sameStringSet(parsedNodes.flatMap(node => node.packageRefs), packageRefs)) return null
  return Object.freeze({ schemaVersion: SCHEDULED_POST_GATE_HANDOFF_SCHEMA, owner: Object.freeze({ ...owner }) as ScheduledPostGateOwner,
    snapshotDigest: row.snapshotDigest as string, continuationKey: row.continuationKey as string, gateTaskId: row.gateTaskId as string,
    gateAttemptCount: Number(row.gateAttemptCount), gateCompletedEventRevision: Number(row.gateCompletedEventRevision),
    gateProofDigest: row.gateProofDigest as string, gateProof: row.gateProof as unknown as ScheduledGateCompletionProof,
    gateResultDigest: row.gateResultDigest as string,
    packageRefs: Object.freeze([...packageRefs]), packageDigest: row.packageDigest as string, proposalDigest: row.proposalDigest as string,
    gateGraphRevision: Number(row.gateGraphRevision), graphRevision: Number(row.graphRevision),
    executeNodes: Object.freeze(parsedNodes.map(node => Object.freeze({ ...node, packageRefs: Object.freeze(node.packageRefs) }))),
    auditTaskId: row.auditTaskId as string })
}

export function scheduledPostGateOwner(scope: TaskGraphReadScope, executionOwner: ScheduledTaskGraphExecutionOwner,
  continuation: Readonly<{ rootAttemptCount: number; turnLeaseOwnerId: string; turnLeaseVersion: number }>): ScheduledPostGateOwner {
  return { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
    rootAttemptCount: continuation.rootAttemptCount, turnLeaseOwnerId: continuation.turnLeaseOwnerId,
    turnLeaseVersion: continuation.turnLeaseVersion, executionId: executionOwner.executionId,
    executionAttemptCount: executionOwner.executionAttemptCount }
}

export function scheduledPostGateScopeMatchesOwner(scope: TaskGraphExecutionScope | TaskGraphReadScope,
  owner: ScheduledPostGateOwner): boolean {
  return scope.userId === owner.userId && scope.sessionId === owner.sessionId && scope.turnId === owner.turnId
    && scope.rootTaskId === owner.rootTaskId && scope.parentTaskId === owner.rootTaskId
    && scope.turnLeaseOwner === owner.turnLeaseOwnerId && scope.turnLeaseVersion === owner.turnLeaseVersion
    && (!('parentAttemptCount' in scope) || scope.parentAttemptCount === owner.rootAttemptCount)
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    return Reflect.ownKeys(value).every(key => typeof key === "string"
      && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
      && "value" in Object.getOwnPropertyDescriptor(value, key)!) ? value as Record<string, unknown> : null
  } catch { return null }
}
function list(value: unknown, max: number): unknown[] | null {
  return denseArray(value, max, false) ? value : null
}
function listStrings(value: unknown, max: number, allowEmpty: boolean): string[] | null {
  if (!denseArray(value, max, allowEmpty)) return null
  return value.every(item => validId(item)) ? [...value] as string[] : null
}
function denseArray(value: unknown, max: number, allowEmpty: boolean): value is unknown[] {
  if (!Array.isArray(value) || value.length > max || !allowEmpty && value.length === 0) return false
  const keys = Reflect.ownKeys(value)
  return keys.length === value.length + 1 && keys.every(key => key === "length" || typeof key === "string"
    && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length)
    && Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(Boolean)
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Reflect.ownKeys(value)
  return own.length === keys.length && own.every(key => typeof key === "string" && keys.includes(key))
}
function validOwner(value: Record<string, unknown>): boolean {
  return exactKeys(value, ["userId", "sessionId", "turnId", "rootTaskId", "rootAttemptCount", "turnLeaseOwnerId",
    "turnLeaseVersion", "executionId", "executionAttemptCount"])
    && ["userId", "sessionId", "turnId", "rootTaskId", "turnLeaseOwnerId", "executionId"].every(key => validId(value[key]))
    && positive(value.rootAttemptCount) && positive(value.turnLeaseVersion) && positive(value.executionAttemptCount)
}
function validId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256
  && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value) }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function digest(value: unknown): value is string { return typeof value === "string" && DIGEST.test(value) }
function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every(value => right.includes(value))
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  const row = record(value)
  if (row) return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${stableJson(row[key])}`).join(",")}}`
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new TypeError("scheduled_post_gate_digest_invalid")
  return encoded
}
function strings(value: unknown, allowed: readonly string[]): string[] | null {
  if (!denseArray(value, 50, true)
    || value.some(item => !validId(item) || !allowed.includes(item)) || new Set(value).size !== value.length) return null
  return [...value] as string[]
}
function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const row = record(value)
  if (!row || !exactKeys(row, keys)) return null
  return Object.keys(row).every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(row, key)
    return !!descriptor?.enumerable && "value" in descriptor
  }) ? row : null
}
