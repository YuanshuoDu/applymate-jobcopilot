import { createHash } from "node:crypto"
import type { ScheduledAutomationPipelineAttestation } from "./scheduled-automation-pipeline-bridge.js"
import type { TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { scheduledTaskGraphContinuationKey } from "./scheduled-pipeline-handoff.js"
import type { ScheduledPrepareOwner } from "../tools/scheduled-application-prepare.js"
import { scheduledTaskGraphStableContinuationKey, type ScheduledTaskGraphContinuationBinding,
  scheduledTaskGraphContinuationKeyVersion, type ScheduledTaskGraphContinuationReceipt } from "./scheduled-taskgraph-continuation-receipt.js"

type Row = Record<string, unknown>

export function scheduledPrepareAnalyzeSnapshot(snapshot: TaskGraphSnapshot): TaskGraphSnapshot {
  const analyst = snapshot.nodes.findIndex(node => node.templateId === "analyst")
  const count = analyst >= 0 ? analyst + 1 : Math.min(2, snapshot.nodes.length)
  return { schemaVersion: snapshot.schemaVersion, nodes: snapshot.nodes.slice(0, count),
    ...(snapshot.rootSuccessCriteria ? { rootSuccessCriteria: snapshot.rootSuccessCriteria } : {}) }
}

export function scheduledPrepareCohortJobIds(attestation: ScheduledAutomationPipelineAttestation): ReadonlySet<string> {
  return new Set("scouts" in attestation ? attestation.analyst.jobIds : attestation.scout.candidateJobIds)
}

export function scheduledPrepareLiveCheckpointBinding(
  receipt: ScheduledTaskGraphContinuationReceipt, currentOwner: ScheduledPrepareOwner,
  attestation: ScheduledAutomationPipelineAttestation,
): ScheduledTaskGraphContinuationBinding | null {
  const version = scheduledTaskGraphContinuationKeyVersion(receipt.continuationKey)
  if (!version || ("scouts" in attestation ? "v2" : "v1") !== version
    || receipt.continuationKey !== scheduledTaskGraphStableContinuationKey(receipt) || !sameTurnLineage(receipt.owner, currentOwner)
    || !sameTurnLineage(receipt.owner, attestation.owner) || receipt.snapshotDigest !== attestation.snapshotDigest
    || receipt.evidenceDigest !== attestation.evidenceDigest || receipt.analyzeGraphRevision !== attestation.graphRevision) return null
  const continuationKey = scheduledTaskGraphContinuationKey(currentOwner, attestation,
    receipt.owner.executionId, receipt.owner.executionAttemptCount)
  if (scheduledTaskGraphContinuationKeyVersion(continuationKey) !== version) return null
  return { ...receipt, continuationKey, owner: { ...receipt.owner,
    turnLeaseOwnerId: currentOwner.turnLeaseOwnerId, turnLeaseVersion: currentOwner.turnLeaseVersion } }
}

export function scheduledPrepareCheckpointDigest(
  state: Row, receipt: ScheduledTaskGraphContinuationReceipt, handoffKey: string, expectedJobIds: readonly string[],
): string | null {
  const marker = record(state.scheduledTaskGraphContinuation), markerOwner = record(marker?.owner)
  const scouted = state.scoutedJobs, scored = state.scoredJobs, owner = receipt.owner
  if (state.nextStage !== "prepare" || !marker || !Array.isArray(scouted) || !Array.isArray(scored)
    || !Number.isSafeInteger(state.analysisFailed) || Number(state.analysisFailed) < 0 || marker.key !== handoffKey
    || marker.snapshotDigest !== receipt.snapshotDigest || marker.graphRevision !== receipt.analyzeGraphRevision
    || marker.evidenceDigest !== receipt.evidenceDigest || !markerOwner || !sameOwner(markerOwner, owner)) return null
  const expected = new Set(expectedJobIds)
  if (expected.size !== expectedJobIds.length) return null
  const ids = new Set<string>()
  for (const value of scouted) {
    const job = record(value)
    if (!job || !validId(job.id) || job.userId !== owner.userId || ids.has(job.id)) return null
    ids.add(job.id)
  }
  if (ids.size !== expected.size || [...ids].some(id => !expected.has(id))
    || Number(state.analysisFailed) + scored.length !== ids.size) return null
  const rows: Row[] = [], seen = new Set<string>()
  for (const value of scored) {
    const row = record(value), job = record(row?.job)
    if (!row || !job || !validId(job.id) || job.userId !== owner.userId || !ids.has(job.id) || seen.has(job.id)
      || !Number.isSafeInteger(row.score) || Number(row.score) < 0 || Number(row.score) > 100 || !stringArray(row.matchedKeywords)
      || !stringArray(row.missingKeywords) || typeof row.recommendation !== "string" || row.recommendation.length > 8192) return null
    const required = ["job", "score", "matchedKeywords", "missingKeywords", "recommendation"], allowed = [...required, "analysisFenceAt"]
    if (Object.keys(row).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(row, key))
      || Object.hasOwn(row, "analysisFenceAt") && (typeof row.analysisFenceAt !== "string" || !Number.isFinite(Date.parse(row.analysisFenceAt)))) return null
    seen.add(job.id); rows.push({ jobId: job.id, score: row.score, matchedKeywords: [...row.matchedKeywords],
      missingKeywords: [...row.missingKeywords], recommendation: row.recommendation,
      ...(Object.hasOwn(row, "analysisFenceAt") ? { analysisFenceAt: row.analysisFenceAt } : {}) })
  }
  return createHash("sha256").update(JSON.stringify({
    owner: [owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.rootAttemptCount, owner.executionId, owner.executionAttemptCount],
    snapshotDigest: receipt.snapshotDigest, evidenceDigest: receipt.evidenceDigest, analyzeGraphRevision: receipt.analyzeGraphRevision,
    analysisFailed: state.analysisFailed, scoredJobs: rows,
  }), "utf8").digest("hex")
}

function sameOwner(left: Row, right: ScheduledTaskGraphContinuationReceipt["owner"]): boolean {
  return left.userId === right.userId && left.sessionId === right.sessionId && left.turnId === right.turnId
    && left.rootTaskId === right.rootTaskId && left.rootAttemptCount === right.rootAttemptCount
    && left.executionId === right.executionId && left.executionAttemptCount === right.executionAttemptCount
}
function sameTurnLineage(left: ScheduledPrepareOwner | ScheduledAutomationPipelineAttestation["owner"],
  right: ScheduledPrepareOwner | ScheduledAutomationPipelineAttestation["owner"]): boolean {
  return left.userId === right.userId && left.sessionId === right.sessionId && left.turnId === right.turnId
    && left.rootTaskId === right.rootTaskId && left.rootAttemptCount === right.rootAttemptCount
}
function validId(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value) }
function stringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === "string") }
function record(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null ? value as Row : null
}
