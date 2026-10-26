import { createHash } from "node:crypto"

import { canonicalTaskGraphJson } from "./task-graph-snapshot.js"
import type { GraphIdentityScope } from "./task-graph-pg-state.js"
import type { Queryable } from "./pg-store-persistence.js"
import type { ScheduledGateCompletionProof } from "./scheduled-gate-contract.js"
import {
  SCHEDULED_AUDIT_REGISTRATION_RECEIPT_EVENT,
  SCHEDULED_AUDIT_TEMPLATE_ID,
  parseScheduledAuditRegistrationReceipt,
  type ScheduledAuditAppendReceipt,
  type ScheduledAuditOwner,
  type TaskGraphScheduledAuditCompletionInput,
  type TaskGraphScheduledAuditInput,
} from "./scheduled-audit-contract.js"
import type { ScheduledTaskGraphContinuationContract } from "./scheduled-taskgraph-continuation-receipt.js"

export type ScheduledAuditRegistration = NonNullable<ReturnType<typeof parseScheduledAuditRegistrationReceipt>>

export async function hasOrphanScheduledAuditRegistration(
  client: Queryable, scope: GraphIdentityScope, continuationKey: string,
): Promise<boolean> {
  const rows = await client.query(`SELECT event."id" FROM "agent_events" AS event
    JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."type" = $3
      AND event."payload"->>'continuationKey' = $4 AND session."userId" = $5 AND turn."userId" = $5 LIMIT 2`,
  [scope.sessionId, scope.turnId, SCHEDULED_AUDIT_REGISTRATION_RECEIPT_EVENT, continuationKey, scope.userId])
  return rows.rows.length !== 0
}

export function sameScheduledAuditRegistration(
  receipt: ScheduledAuditRegistration, input: TaskGraphScheduledAuditInput,
  contract: ScheduledTaskGraphContinuationContract, proof: ScheduledGateCompletionProof,
): boolean {
  return same(receipt.owner, stableScheduledAuditOwner(contract.binding.owner))
    && receipt.continuationKey === contract.receipt.continuationKey
    && receipt.snapshotDigest === contract.binding.snapshotDigest
    && receipt.evidenceDigest === contract.binding.evidenceDigest
    && receipt.checkpointDigest === contract.binding.checkpointDigest
    && receipt.analyzeGraphRevision === contract.binding.analyzeGraphRevision
    && receipt.prepareScheduleRevision === contract.binding.prepareScheduleRevision
    && receipt.prepareWaitId === proof.prepareProof.completion.wait.waitId && receipt.gateTaskId === proof.gate.taskId
    && receipt.gateAttemptCount === proof.gate.attemptCount && receipt.gateResultDigest === proof.gate.resultDigest
    && receipt.gateCompletedEventRevision === proof.gate.completedEventRevision && receipt.gateProofDigest === scheduledAuditDigest(proof)
    && receipt.scheduledWaitId === (input.scheduledWaitId ?? null)
}

export function sameScheduledAuditCompletionRegistration(
  receipt: ScheduledAuditRegistration, input: TaskGraphScheduledAuditCompletionInput,
): boolean {
  return receipt.auditTaskId === input.auditTaskId && receipt.owner.userId === input.scope.userId
    && receipt.owner.sessionId === input.scope.sessionId && receipt.owner.turnId === input.scope.turnId
    && receipt.owner.rootTaskId === input.scope.rootTaskId && receipt.owner.executionId === input.executionOwner.executionId
    && receipt.owner.executionAttemptCount === input.executionOwner.executionAttemptCount
    && receipt.gateProofDigest === scheduledAuditDigest(input.gateProof) && receipt.gateTaskId === input.gateProof.gate.taskId
    && receipt.gateGraphRevision === input.gateProof.graphRevision
}

export function stableScheduledAuditOwner(owner: ScheduledAuditOwner): ScheduledAuditOwner {
  return {
    userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
    rootAttemptCount: owner.rootAttemptCount, executionId: owner.executionId,
    executionAttemptCount: owner.executionAttemptCount,
  }
}

export function stableScheduledAuditOwnerForScope(
  scope: Pick<TaskGraphScheduledAuditCompletionInput["scope"], "userId" | "sessionId" | "turnId" | "rootTaskId" | "parentAttemptCount">,
  executionOwner: Pick<TaskGraphScheduledAuditCompletionInput["executionOwner"], "executionId" | "executionAttemptCount">,
): ScheduledAuditOwner {
  return {
    userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
    rootAttemptCount: scope.parentAttemptCount, executionId: executionOwner.executionId,
    executionAttemptCount: executionOwner.executionAttemptCount,
  }
}

export function scheduledAuditDigest(value: unknown): string | null {
  try { return `sha256:${createHash("sha256").update(canonicalTaskGraphJson(value), "utf8").digest("hex")}` } catch { return null }
}

export function scheduledAuditAppendReceipt(
  receipt: ScheduledAuditRegistration, status: "accepted" | "duplicate", expectedAttemptCount: number,
): ScheduledAuditAppendReceipt {
  return {
    status, revision: receipt.auditAppendRevision,
    nodes: [{ key: SCHEDULED_AUDIT_TEMPLATE_ID, taskId: receipt.auditTaskId, status: "queued" }],
    readyTaskIds: [receipt.auditTaskId], auditTaskId: receipt.auditTaskId, expectedAttemptCount,
  }
}

function same(left: unknown, right: unknown): boolean {
  try { return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) } catch { return false }
}
