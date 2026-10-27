import { createHash } from "node:crypto"
import { parseScheduledAutomationSnapshot } from "./scheduled-automation-snapshot.js"
import { TaskGraphCommandError, parseScheduledPrepareProposal, type TaskGraphScheduledPrepareInput, type TaskGraphCurrentState, type TaskGraphScheduleReceipt } from "./task-graph-command-port.js"
import { scheduledTaskGraphContinuationKey } from "./scheduled-pipeline-handoff.js"
import { taskGraphFingerprint, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { parseScheduledPipelineAttestation } from "@jobcopilot/agent-protocol"
import { scheduledTaskGraphContinuationBindingDigestProjection, scheduledTaskGraphContinuationKeyVersion, scheduledTaskGraphStableKey } from "./scheduled-pipeline-continuation-key.js"
import type { Queryable } from "./pg-store-persistence.js"
import { scheduledAnalyzeGraphMatches as verifyScheduledAnalyzeGraph } from "./scheduled-analyze-graph-proof.js"
import type { GraphTaskRow } from "./task-graph-pg-state.js"
import { projectScheduledPipelineGraph } from "./scheduled-pipeline-graph-shape.js"

export const SCHEDULED_TASKGRAPH_CONTINUATION_RECEIPT_SCHEMA = "agent-harness.v2.scheduled-taskgraph-continuation-receipt.v1" as const
export const SCHEDULED_TASKGRAPH_CONTINUATION_RECEIPT_EVENT = "agent.plan.scheduled_prepare_binding" as const

const RECEIPT_KEYS = ["schemaVersion", "owner", "continuationKey", "snapshotDigest", "evidenceDigest",
  "checkpointDigest", "analyzeGraphRevision", "prepareScheduleRevision"] as const
const BINDING_KEYS = RECEIPT_KEYS.filter((key) => key !== "schemaVersion")
const OWNER_KEYS = ["userId", "sessionId", "turnId", "rootTaskId", "rootAttemptCount", "turnLeaseOwnerId",
  "turnLeaseVersion", "executionId", "executionAttemptCount"] as const
const ID = /^[^\u0000-\u001f\u007f]+$/
const CONTINUATION_KEY = /^scheduled-taskgraph:(?:v2:)?sha256:[a-f0-9]{64}$/
const SNAPSHOT_DIGEST = /^sha256:[a-f0-9]{64}$/
const HEX_DIGEST = /^[a-f0-9]{64}$/
const CLAIM_SCHEMA = "agent-harness.v2.scheduled-pipeline-claim.v1"
const CLAIM_KEYS = ["schemaVersion", "key", "claimToken", "owner", "claimedAt", "leaseExpiresAt"] as const
const PREPARE_CLAIM_DIGEST = /^sha256:[a-f0-9]{64}$/
type Row = Record<string, unknown>
export type ScheduledTaskGraphContinuationOwner = Readonly<{ userId: string; sessionId: string; turnId: string; rootTaskId: string; rootAttemptCount: number; turnLeaseOwnerId: string; turnLeaseVersion: number; executionId: string; executionAttemptCount: number }>
export type ScheduledTaskGraphContinuationBinding = Readonly<{ owner: ScheduledTaskGraphContinuationOwner; continuationKey: string; snapshotDigest: string; evidenceDigest: string; checkpointDigest: string; analyzeGraphRevision: number; prepareScheduleRevision: number }>
export type ScheduledTaskGraphContinuationReceipt = ScheduledTaskGraphContinuationBinding & Readonly<{ schemaVersion: typeof SCHEDULED_TASKGRAPH_CONTINUATION_RECEIPT_SCHEMA }>
/** Current lease-bound binding is checked live; the receipt contains immutable continuation lineage. */
export type ScheduledTaskGraphContinuationContract = Readonly<{ binding: ScheduledTaskGraphContinuationBinding; receipt: ScheduledTaskGraphContinuationReceipt; bindingDigest: string; proposalFingerprint: string; claimTokenDigest: string }>
/** The claim digest is transient proof material and is intentionally absent from the receipt/fingerprint. */
export function createScheduledTaskGraphContinuationContract(input: TaskGraphScheduledPrepareInput): ScheduledTaskGraphContinuationContract | null {
  const { scope, executionOwner, handoff } = input
  const attestation = parseScheduledPipelineAttestation(input.attestation), owner = attestation?.owner
  const version = attestation?.schemaVersion === 'agent-harness.v2.scheduled-pipeline-attestation.v2' ? 'v2' : 'v1'
  const sourceTaskIds = !attestation ? [] : attestation.schemaVersion === 'agent-harness.v2.scheduled-pipeline-attestation.v2'
    ? attestation.scouts.map(source => source.taskId) : [attestation.scout.taskId]
  const dependencyTaskIds = [...sourceTaskIds].sort()
  if (!attestation || !owner || scheduledTaskGraphContinuationKeyVersion(handoff?.continuationKey) !== version
    || !PREPARE_CLAIM_DIGEST.test(handoff?.claimTokenDigest ?? "") || handoff.status !== "analyze_checkpointed"
    || scope.parentTaskId !== scope.rootTaskId || owner.userId !== scope.userId || owner.sessionId !== scope.sessionId
    || owner.turnId !== scope.turnId || owner.rootTaskId !== scope.rootTaskId || owner.rootAttemptCount !== scope.parentAttemptCount
    || owner.turnLeaseOwnerId !== scope.turnLeaseOwner || owner.turnLeaseVersion !== scope.turnLeaseVersion
    || handoff.executionId !== executionOwner.executionId || handoff.executionAttemptCount !== executionOwner.executionAttemptCount
    || attestation.analyst.dependsOnTaskIds.length !== dependencyTaskIds.length
    || attestation.analyst.dependsOnTaskIds.some((taskId, index) => taskId !== dependencyTaskIds[index])
    || handoff.continuationKey !== scheduledTaskGraphContinuationKey(owner, attestation, executionOwner.executionId, executionOwner.executionAttemptCount)) return null
  const binding: ScheduledTaskGraphContinuationBinding = { owner: { ...owner, ...executionOwner }, continuationKey: handoff.continuationKey,
    snapshotDigest: attestation.snapshotDigest, evidenceDigest: attestation.evidenceDigest, checkpointDigest: handoff.checkpointDigest,
    analyzeGraphRevision: attestation.graphRevision, prepareScheduleRevision: attestation.graphRevision + 1 }
  const stableKey = scheduledTaskGraphStableKey(binding)
  const receipt = stableKey && buildScheduledTaskGraphContinuationReceipt({ ...binding, continuationKey: stableKey })
  const bindingDigest = receipt && scheduledTaskGraphContinuationBindingDigest(receipt)
  if (!receipt || !bindingDigest) return null
  return { binding, receipt, bindingDigest,
    proposalFingerprint: taskGraphFingerprint({ proposal: input.proposal, bindingDigest, analyzeGraphRevision: binding.analyzeGraphRevision }),
    claimTokenDigest: handoff.claimTokenDigest }
}

/** Compares transient proof against the active persisted claim while its execution row is locked. */
export function scheduledTaskGraphClaimMatches(state: unknown, binding: ScheduledTaskGraphContinuationBinding, digest: string, now: unknown): boolean {
  const root = objectRecord(state), claim = exactRecord(root?.scheduledTaskGraphClaim, CLAIM_KEYS), owner = parseOwner(claim?.owner)
  const nowMs = now instanceof Date ? now.getTime() : typeof now === "string" ? Date.parse(now) : Number.NaN
  if (!claim || !owner || !PREPARE_CLAIM_DIGEST.test(digest) || claim.schemaVersion !== CLAIM_SCHEMA
    || claim.key !== binding.continuationKey || !validId(claim.claimToken) || !ownerValuesEqual(owner, binding.owner)
    || !validTimestamp(claim.claimedAt) || !validTimestamp(claim.leaseExpiresAt)
    || Date.parse(claim.claimedAt) > nowMs || Date.parse(claim.leaseExpiresAt) <= nowMs) return false
  return `sha256:${createHash("sha256").update(claim.claimToken, "utf8").digest("hex")}` === digest
}

/** Rebinds scheduled mode and criteria to the live persisted Turn snapshot. */
export function scheduledSnapshotMatches(turnValue: unknown, digest: string): boolean {
  const turn = objectRecord(turnValue), input = objectRecord(turn?.input)
  const snapshot = parseScheduledAutomationSnapshot(input?.scheduledAutomationSnapshot)
  if (!turn || turn.source !== "automation" || turn.executionMode !== "canonical_task_graph" || input?.automationRunMode !== "scheduled" || !snapshot) return false
  const expected = `sha256:${createHash("sha256").update(JSON.stringify([snapshot.schemaVersion, snapshot.targetRoles,
    snapshot.targetLocations, snapshot.minScore, snapshot.dailyCap, snapshot.requireApproval, snapshot.autoApply]), "utf8").digest("hex")}`
  return digest === expected
}

/** Validates the persisted Analyze DAG, typed results, verification receipts, and bridge attestation. */
export function scheduledAnalyzeGraphMatches(input: TaskGraphScheduledPrepareInput, snapshot: TaskGraphSnapshot, current: TaskGraphCurrentState,
  tasks: ReadonlyMap<string, GraphTaskRow>, hasPrepare: boolean): string | null {
  return verifyScheduledAnalyzeGraph(input, snapshot, current, tasks, hasPrepare)
}

export function scheduledPrepareReplayReceipt(snapshot: TaskGraphSnapshot, current: TaskGraphCurrentState, revision: number): TaskGraphScheduleReceipt | null {
  const scoutCount = snapshot.nodes.findIndex(value => value.templateId !== "scout")
  const count = scoutCount < 0 ? snapshot.nodes.length : scoutCount
  const suffixCount = snapshot.nodes.length - count - 1
  const version = count === 1 ? "v1" : "v2"
  const stage = suffixCount === 1 ? "prepare" : suffixCount === 2 ? "gate" : suffixCount === 3 ? "audit" : null
  if (!stage || !projectScheduledPipelineGraph(snapshot.nodes, version, stage)) return null
  const prepareNodes = snapshot.nodes.filter(value => value.key === "prepare" && value.templateId === "prepare")
  const node = prepareNodes.length === 1 ? prepareNodes[0] : undefined
  const state = node && current.nodes.find(value => value.key === node.key), ready = state?.status === "queued" && state.readiness === "ready"
  if (!Number.isSafeInteger(current.revision) || !node || node.key !== "prepare" || !state || state.taskId !== node.taskId
    || !["queued", "waiting", "running", "retrying", "waiting_for_user", "completed"].includes(state.status)
    || current.revision < revision || (current.revision > revision && state.status === "queued")) return null
  return { status: "duplicate", revision: current.revision, nodes: [{ key: node.key, taskId: node.taskId, status: ready ? "queued" : "waiting" }], readyTaskIds: ready ? [node.taskId] : [] }
}

function validTimestamp(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)) }
function objectRecord(value: unknown): Row | null {
  const row = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!row || typeof row !== "object" || Array.isArray(row)) return null
  const prototype = Object.getPrototypeOf(row)
  return prototype === Object.prototype || prototype === null ? row as Row : null
}

/** Reads only an exact itemless, no-outbox private receipt for this scoped Turn. */
export async function readScheduledPrepareReceipt(client: Queryable, scope: TaskGraphScheduledPrepareInput["scope"], key: string): Promise<unknown | null> {
  const result = await client.query(`SELECT event."type", event."itemId", event."taskId", event."actor", event."payload",
    EXISTS (SELECT 1 FROM "agent_outbox" AS outbox WHERE outbox."idempotencyKey" = 'agent-event:' || event."id"
      OR outbox."payload"->>'eventId' = event."id") AS "hasOutbox" FROM "agent_events" AS event
    JOIN "agent_sessions" AS session ON session."id" = event."sessionId" JOIN "agent_turns" AS turn ON turn."id" = event."turnId"
      AND turn."sessionId" = event."sessionId" WHERE event."sessionId" = $1 AND event."turnId" = $2
      AND event."idempotencyKey" = $3 AND session."userId" = $4 AND turn."userId" = $4`, [scope.sessionId, scope.turnId, key, scope.userId])
  if (!result.rows.length) return null
  const row = result.rows.length === 1 ? result.rows[0] as Row : undefined
  if (!row || row.type !== SCHEDULED_TASKGRAPH_CONTINUATION_RECEIPT_EVENT || row.itemId !== null || row.taskId !== null || row.actor !== "system" || row.hasOutbox !== false) {
    throw new TaskGraphCommandError("scheduled_prepare_receipt_conflict", "Scheduled Prepare receipt is not private")
  }
  return row.payload
}

/** Parses the private receipt with exact top-level and owner keys; unknown fields fail closed. */
export function parseScheduledTaskGraphContinuationReceipt(value: unknown): ScheduledTaskGraphContinuationReceipt | null {
  const row = exactRecord(value, RECEIPT_KEYS)
  if (!row || row.schemaVersion !== SCHEDULED_TASKGRAPH_CONTINUATION_RECEIPT_SCHEMA) return null
  const binding = parseBinding(row)
  return binding ? { schemaVersion: SCHEDULED_TASKGRAPH_CONTINUATION_RECEIPT_SCHEMA, ...binding } : null
}

/** Builds the persisted form from only the allowlisted binding fields. */
export function buildScheduledTaskGraphContinuationReceipt(value: unknown): ScheduledTaskGraphContinuationReceipt | null {
  const row = exactRecord(value, BINDING_KEYS)
  const binding = row ? parseBinding(row) : null
  return binding ? { schemaVersion: SCHEDULED_TASKGRAPH_CONTINUATION_RECEIPT_SCHEMA, ...binding } : null
}

/** Returns the deterministic binding digest used by proposal fingerprints. */
export function scheduledTaskGraphContinuationBindingDigest(value: unknown): string | null {
  const receipt = parseScheduledTaskGraphContinuationReceipt(value)
  if (!receipt) return null
  const projection = scheduledTaskGraphContinuationBindingDigestProjection(receipt)
  return createHash("sha256").update(JSON.stringify(projection), "utf8").digest("hex")
}

export { scheduledTaskGraphContinuationKeyVersion }

/** Derives the persisted continuation receipt key from its immutable binding, excluding the transient handoff key. */
export function scheduledTaskGraphStableContinuationKey(value: unknown): string | null {
  const receipt = parseScheduledTaskGraphContinuationReceipt(value)
    ?? parseBinding(exactRecord(value, BINDING_KEYS) ?? {})
  return receipt ? scheduledTaskGraphStableKey(receipt) : null
}

/** A replay matches immutable owner lineage and proof fields; current leases are checked separately against the live claim. */
export function scheduledTaskGraphContinuationReceiptMatches(value: unknown, expected: unknown): boolean {
  const receipt = parseScheduledTaskGraphContinuationReceipt(value)
  const expectedReceipt = parseScheduledTaskGraphContinuationReceipt(expected)
  const expectedRow = expectedReceipt ? null : exactRecord(expected, BINDING_KEYS)
  const binding = expectedReceipt ?? (expectedRow ? parseBinding(expectedRow) : null)
  if (!receipt || !binding) return false
  return receipt.continuationKey === binding.continuationKey && receipt.snapshotDigest === binding.snapshotDigest
    && receipt.evidenceDigest === binding.evidenceDigest && receipt.checkpointDigest === binding.checkpointDigest
    && receipt.analyzeGraphRevision === binding.analyzeGraphRevision && receipt.prepareScheduleRevision === binding.prepareScheduleRevision
    && stableOwnerValuesEqual(receipt.owner, binding.owner)
}

function parseBinding(row: Record<string, unknown>): ScheduledTaskGraphContinuationBinding | null {
  const owner = parseOwner(row.owner)
  if (!owner || typeof row.continuationKey !== "string" || !CONTINUATION_KEY.test(row.continuationKey)
    || typeof row.snapshotDigest !== "string" || !SNAPSHOT_DIGEST.test(row.snapshotDigest)
    || typeof row.evidenceDigest !== "string" || !HEX_DIGEST.test(row.evidenceDigest)
    || typeof row.checkpointDigest !== "string" || !HEX_DIGEST.test(row.checkpointDigest)
    || !positiveInteger(row.analyzeGraphRevision) || !positiveInteger(row.prepareScheduleRevision)
    || row.prepareScheduleRevision !== row.analyzeGraphRevision + 1) return null
  return { owner, continuationKey: row.continuationKey, snapshotDigest: row.snapshotDigest, evidenceDigest: row.evidenceDigest,
    checkpointDigest: row.checkpointDigest, analyzeGraphRevision: row.analyzeGraphRevision, prepareScheduleRevision: row.prepareScheduleRevision }
}

function parseOwner(value: unknown): ScheduledTaskGraphContinuationOwner | null {
  const row = exactRecord(value, OWNER_KEYS)
  if (!row || ![row.userId, row.sessionId, row.turnId, row.rootTaskId, row.turnLeaseOwnerId, row.executionId]
    .every(validId) || !positiveInteger(row.rootAttemptCount) || !positiveInteger(row.turnLeaseVersion)
    || !safeCount(row.executionAttemptCount)) return null
  return { userId: row.userId as string, sessionId: row.sessionId as string, turnId: row.turnId as string, rootTaskId: row.rootTaskId as string,
    rootAttemptCount: row.rootAttemptCount as number, turnLeaseOwnerId: row.turnLeaseOwnerId as string, turnLeaseVersion: row.turnLeaseVersion as number,
    executionId: row.executionId as string, executionAttemptCount: row.executionAttemptCount as number }
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.length !== keys.length || !ownKeys.every((key) => typeof key === "string" && keys.includes(key))) return null
  for (const key of keys) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return null }
  return value as Record<string, unknown>
}

function validId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && ID.test(value) }
function positiveInteger(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function safeCount(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
function ownerValues(owner: ScheduledTaskGraphContinuationOwner): readonly (string | number)[] { return [owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.rootAttemptCount, owner.turnLeaseOwnerId, owner.turnLeaseVersion, owner.executionId, owner.executionAttemptCount] }
function ownerValuesEqual(left: ScheduledTaskGraphContinuationOwner, right: ScheduledTaskGraphContinuationOwner): boolean { return ownerValues(left).every((value, index) => value === ownerValues(right)[index]) }
function stableOwnerValues(owner: ScheduledTaskGraphContinuationOwner): readonly (string | number)[] { return [owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.rootAttemptCount, owner.executionId, owner.executionAttemptCount] }
function stableOwnerValuesEqual(left: ScheduledTaskGraphContinuationOwner, right: ScheduledTaskGraphContinuationOwner): boolean { return stableOwnerValues(left).every((value, index) => value === stableOwnerValues(right)[index]) }
