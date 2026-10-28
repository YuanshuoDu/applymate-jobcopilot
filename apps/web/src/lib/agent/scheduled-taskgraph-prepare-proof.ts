import { createHash } from "node:crypto"
import { Prisma } from "@prisma/client"
import { parseScheduledPipelineAttestation, scheduledPipelineContinuationKeyVersion, scheduledPipelinePrepareReceiptKeyMaterial } from "@jobcopilot/agent-protocol"
import type { ScheduledTaskGraphPipelineOwner } from "./scheduled-taskgraph-pipeline-checkpoint"

const COMPLETION_SCHEMA = "agent-harness.v2.scheduled-taskgraph-prepare-completion.v1"
const PREPARE_RESULT_SCHEMA = "agent-harness.v2.subagent.result"
const RECEIPT_SCHEMA = "agent-harness.v2.scheduled-taskgraph-continuation-receipt.v1"

export type ScheduledTaskGraphArtifactReference = Readonly<{ artifactId: string; version: number; contentHash: string; sourceDigest: string }>
export type ScheduledTaskGraphPrepareProofNode = Readonly<{ taskId: string; attemptCount: number; role: "scout" | "analyst" | "prepare"; taskType: string; status: "completed"; verification: "passed"; dependsOnTaskIds: string[]; tool?: string; resultDigest?: string }>
export type ScheduledTaskGraphPrepareProofResult = Readonly<{ raw: Record<string, unknown>; taskId: string; attemptCount: number; snapshotDigest: string; checkpointDigest: string; jobs: Array<{ jobId: string; status: "prepared" | "skipped" }>; materials: Array<{ jobId: string; kind: "resume" | "cover_letter"; artifactRef: ScheduledTaskGraphArtifactReference }> }>
export type ParsedScheduledTaskGraphPrepareProof = Readonly<{ receipt: Record<string, unknown>; completion: Record<string, unknown>; graphRevision: number; nodes: readonly ScheduledTaskGraphPrepareProofNode[]; result: ScheduledTaskGraphPrepareProofResult }>

export function scheduledTaskGraphPrepareReceiptKey(owner: ScheduledTaskGraphPipelineOwner, receipt: Record<string, unknown>): string {
  const material = scheduledPipelinePrepareReceiptKeyMaterial({
    owner: { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
      rootAttemptCount: owner.rootAttemptCount, executionId: owner.executionId, executionAttemptCount: owner.executionAttemptCount },
    continuationKey: String(receipt.continuationKey), snapshotDigest: String(receipt.snapshotDigest),
    evidenceDigest: String(receipt.evidenceDigest), checkpointDigest: String(receipt.checkpointDigest),
    analyzeGraphRevision: Number(receipt.analyzeGraphRevision), prepareScheduleRevision: Number(receipt.prepareScheduleRevision),
  })
  return material ? material.keyPrefix + createHash("sha256").update(material.serializedPreimage, "utf8").digest("hex") : ""
}

export function parseScheduledTaskGraphPipelineOwner(value: unknown): ScheduledTaskGraphPipelineOwner | null {
  const row = exactRecord(value, ["userId", "sessionId", "turnId", "rootTaskId", "rootAttemptCount", "turnLeaseOwnerId", "turnLeaseVersion", "executionId", "executionAttemptCount"])
  return row && [row.userId, row.sessionId, row.turnId, row.rootTaskId, row.turnLeaseOwnerId, row.executionId].every(validId)
    && positive(row.rootAttemptCount) && positive(row.turnLeaseVersion) && nonNegative(row.executionAttemptCount)
    ? row as unknown as ScheduledTaskGraphPipelineOwner : null
}
export function sameScheduledTaskGraphLineageOwner(a: ScheduledTaskGraphPipelineOwner | null, b: ScheduledTaskGraphPipelineOwner): boolean {
  return Boolean(a && ["userId", "sessionId", "turnId", "rootTaskId", "rootAttemptCount", "executionId", "executionAttemptCount"]
    .every(key => a[key as keyof ScheduledTaskGraphPipelineOwner] === b[key as keyof ScheduledTaskGraphPipelineOwner]))
}

/** Binds the registered Gate to its exact private, ready Prepare dependency wait. */
export async function scheduledTaskGraphGateBindingIsCurrent(input: Readonly<{
  reader: Prisma.TransactionClient; owner: ScheduledTaskGraphPipelineOwner; marker: Record<string, unknown>
  checkpointDigest: string; proof: ParsedScheduledTaskGraphPrepareProof
  gate: Readonly<{ taskId: string; attemptCount: number; phase: "running" | "completed"; completionProof?: unknown }>
}>): Promise<boolean> {
  const { reader, owner, marker, checkpointDigest, proof, gate } = input
  const eventRows = await reader.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT event."itemId", event."taskId", event."actor", event."idempotencyKey", event."payload",
      EXISTS (SELECT 1 FROM "agent_outbox" AS outbox WHERE outbox."idempotencyKey" = 'agent-event:' || event."id"
        OR outbox."payload"->>'eventId' = event."id") AS "hasOutbox"
    FROM "agent_events" AS event JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
      JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    WHERE event."sessionId" = ${owner.sessionId} AND event."turnId" = ${owner.turnId}
      AND event."type" = 'agent.plan.scheduled_gate_binding' AND session."userId" = ${owner.userId}
      AND turn."userId" = ${owner.userId} AND turn."rootTaskId" = ${owner.rootTaskId}
    ORDER BY event."sequence" ASC LIMIT 2 FOR UPDATE OF event
  `)
  const event = eventRows[0], receipt = exactRecord(event?.payload, ["schemaVersion", "owner", "continuationKey", "snapshotDigest",
    "evidenceDigest", "checkpointDigest", "analyzeGraphRevision", "prepareScheduleRevision", "prepareWaitId", "gateTaskId", "gateAppendRevision"])
  const stableOwner = exactRecord(receipt?.owner, ["userId", "sessionId", "turnId", "rootTaskId", "rootAttemptCount", "executionId", "executionAttemptCount"])
  const eventKey = receipt && `scheduled-gate-binding:${createHash("sha256").update(JSON.stringify([receipt.continuationKey, gate.taskId]), "utf8").digest("hex")}`
  if (eventRows.length !== 1 || !event || event.itemId !== null || event.taskId !== null || event.actor !== "system" || event.hasOutbox !== false
    || !receipt || !stableOwner || event.idempotencyKey !== eventKey || receipt.schemaVersion !== "agent-harness.v2.scheduled-taskgraph-gate-binding.v1"
    || !["userId", "sessionId", "turnId", "rootTaskId", "rootAttemptCount", "executionId", "executionAttemptCount"]
      .every(key => stableOwner[key] === owner[key as keyof ScheduledTaskGraphPipelineOwner])
    || receipt.continuationKey !== proof.receipt.continuationKey || receipt.snapshotDigest !== marker.snapshotDigest
    || receipt.evidenceDigest !== marker.evidenceDigest || receipt.checkpointDigest !== checkpointDigest
    || receipt.analyzeGraphRevision !== marker.graphRevision || receipt.prepareScheduleRevision !== proof.receipt.prepareScheduleRevision
    || receipt.prepareWaitId !== record(proof.completion.wait)?.waitId || receipt.gateTaskId !== gate.taskId
    || receipt.gateAppendRevision !== proof.graphRevision + 1 || !validId(receipt.prepareWaitId)) return false
  const waits = await reader.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT wait."id", wait."userId", wait."sessionId", wait."turnId", wait."parentTaskId", wait."stepId", wait."idempotencyKey",
      wait."targetTaskIds", wait."mode", wait."status", wait."matchedTaskIds", wait."result",
      step."taskId" AS "stepTaskId", step."attempt" AS "stepAttempt"
    FROM "agent_wait_conditions" AS wait JOIN "agent_sessions" AS session ON session."id" = wait."sessionId"
      JOIN "agent_turns" AS turn ON turn."id" = wait."turnId" AND turn."sessionId" = wait."sessionId"
      JOIN "agent_steps" AS step ON step."id" = wait."stepId" AND step."sessionId" = wait."sessionId" AND step."turnId" = wait."turnId"
    WHERE wait."id" = ${receipt.prepareWaitId} AND wait."userId" = ${owner.userId} AND wait."sessionId" = ${owner.sessionId}
      AND wait."turnId" = ${owner.turnId} AND wait."parentTaskId" = ${owner.rootTaskId}
      AND session."userId" = ${owner.userId} AND turn."userId" = ${owner.userId}
    FOR UPDATE OF wait, step
  `)
  const wait = waits[0], request = record(record(wait?.result)?.request), stepId = wait?.stepId
  const waitKey = typeof stepId === "string" && typeof marker.key === "string"
    ? `scheduled-prepare-dependency:${createHash("sha256").update(`${marker.key}\0${stepId}`, "utf8").digest("hex")}` : ""
  return waits.length === 1 && wait?.id === receipt.prepareWaitId && validId(stepId) && wait.idempotencyKey === waitKey
    && (wait.stepTaskId === null || wait.stepTaskId === owner.rootTaskId) && wait.stepAttempt === 1 && wait.mode === "all"
    && wait.status === "ready" && sameStrings(wait.targetTaskIds, [proof.result.taskId]) && sameStrings(wait.matchedTaskIds, [proof.result.taskId])
    && request !== null && exactKeys(request, ["targetTaskIds", "mode", "timeoutMs"]) && request.mode === "all"
    && request.timeoutMs === 86_400_000 && sameStrings(request.targetTaskIds, [proof.result.taskId])
}

export function parseScheduledTaskGraphPrepareProof(value: unknown): ParsedScheduledTaskGraphPrepareProof | null {
  try {
    const proof = exactRecord(value, ["receipt", "completion", "result"])
    const receipt = exactRecord(proof?.receipt, ["schemaVersion", "owner", "continuationKey", "snapshotDigest", "evidenceDigest", "checkpointDigest", "analyzeGraphRevision", "prepareScheduleRevision"])
    const completion = exactRecord(proof?.completion, ["schemaVersion", "graphRevision", "nodes", "wait"])
    const result = parsePrepareResult(proof?.result), rawNodes = denseArray(completion?.nodes)
    if (!receipt || !completion || !result || !rawNodes || rawNodes.length < 3 || rawNodes.length > 6 || receipt.schemaVersion !== RECEIPT_SCHEMA
      || !validKey(receipt.continuationKey) || !positive(receipt.prepareScheduleRevision) || completion.schemaVersion !== COMPLETION_SCHEMA
      || !positive(completion.graphRevision) || Number(completion.graphRevision) <= Number(receipt.prepareScheduleRevision)) return null
    const parsed = rawNodes.map(parseCompletionNode)
    if (parsed.some(node => !node)) return null
    const nodes = parsed as ScheduledTaskGraphPrepareProofNode[], scoutCount = nodes.length - 2
    const scouts = nodes.slice(0, scoutCount), analyst = nodes[scoutCount]!, prepare = nodes[scoutCount + 1]!
    const scoutIds = scouts.map(node => node.taskId), wait = exactRecord(completion.wait, ["waitId", "status", "mode", "targetTaskIds", "matchedTaskIds"])
    if (![1, 2, 3, 4].includes(scoutCount) || scouts.some(node => node.role !== "scout" || node.taskType !== "job_discovery" || node.dependsOnTaskIds.length !== 0)
      || analyst.role !== "analyst" || analyst.taskType !== "job_analysis" || !sameSorted(analyst.dependsOnTaskIds, scoutIds)
      || prepare.role !== "prepare" || prepare.taskType !== "scheduled_application_prepare" || prepare.tool !== "scheduled.application.prepare@1"
      || !sameStrings(prepare.dependsOnTaskIds, [analyst.taskId]) || new Set(nodes.map(node => node.taskId)).size !== nodes.length
      || result.taskId !== prepare.taskId || result.attemptCount !== prepare.attemptCount || prepare.resultDigest !== scheduledTaskGraphPrepareResultDigest(result.raw)
      || !wait || !validId(wait.waitId) || wait.status !== "ready" || wait.mode !== "all"
      || !sameStrings(wait.targetTaskIds, [prepare.taskId]) || !sameStrings(wait.matchedTaskIds, [prepare.taskId])) return null
    return { receipt, completion, graphRevision: Number(completion.graphRevision), nodes, result }
  } catch { return null }
}

export function scheduledTaskGraphPrepareResultDigest(result: Record<string, unknown>): string {
  const projection = { schemaVersion: result.schemaVersion, role: result.role, status: result.status, taskId: result.taskId,
    attemptCount: result.attemptCount, snapshotDigest: result.snapshotDigest, checkpointDigest: result.checkpointDigest, jobs: result.jobs, materials: result.materials }
  return createHash("sha256").update(canonicalJson(projection), "utf8").digest("hex")
}

export function scheduledTaskGraphPrepareProofMatchesAttestation(
  proof: ParsedScheduledTaskGraphPrepareProof,
  value: unknown,
): boolean {
  const attestation = parseScheduledPipelineAttestation(value)
  if (!attestation) return false
  const expectedVersion = attestation.schemaVersion === "agent-harness.v2.scheduled-pipeline-attestation.v1" ? "v1" : "v2"
  if (scheduledPipelineContinuationKeyVersion(proof.receipt.continuationKey) !== expectedVersion) return false
  const scouts = attestation.schemaVersion === "agent-harness.v2.scheduled-pipeline-attestation.v1"
    ? [attestation.scout] : attestation.scouts
  if (proof.nodes.length !== scouts.length + 2) return false
  const proofScouts = proof.nodes.slice(0, scouts.length), analyst = proof.nodes[scouts.length]!, prepare = proof.nodes[scouts.length + 1]!
  return scouts.every(source => proofScouts.some(node => node.taskId === source.taskId && node.attemptCount === source.attemptCount))
    && analyst.taskId === attestation.analyst.taskId && analyst.attemptCount === attestation.analyst.attemptCount
    && prepare.taskType === "scheduled_application_prepare"
}

function parseCompletionNode(value: unknown): ScheduledTaskGraphPrepareProofNode | null {
  const role = record(value)?.role, fields = ["taskId", "attemptCount", "role", "taskType", "status", "verification", "dependsOnTaskIds"]
  const row = exactRecord(value, [...fields, ...(role === "prepare" ? ["tool", "resultDigest"] : [])])
  return !row || !validId(row.taskId) || !positive(row.attemptCount) || !["scout", "analyst", "prepare"].includes(String(row.role))
    || typeof row.taskType !== "string" || row.status !== "completed" || row.verification !== "passed" || !stringArray(row.dependsOnTaskIds)
    || row.role === "prepare" && (row.tool !== "scheduled.application.prepare@1" || !hex(row.resultDigest)) || row.role !== "prepare" && (row.tool !== undefined || row.resultDigest !== undefined)
    ? null : row as unknown as ScheduledTaskGraphPrepareProofNode
}

function parsePrepareResult(value: unknown): ScheduledTaskGraphPrepareProofResult | null {
  const row = exactRecord(value, ["schemaVersion", "role", "status", "taskId", "attemptCount", "snapshotDigest", "checkpointDigest", "jobs", "materials"])
  const rawJobs = denseArray(row?.jobs), rawMaterials = denseArray(row?.materials)
  if (!row || row.schemaVersion !== PREPARE_RESULT_SCHEMA || row.role !== "prepare" || row.status !== "completed" || !validId(row.taskId)
    || !positive(row.attemptCount) || !snapshotDigest(row.snapshotDigest) || !hex(row.checkpointDigest) || !rawJobs || !rawMaterials) return null
  const jobs = rawJobs.map(value => { const job = exactRecord(value, ["jobId", "status"]); return job && validId(job.jobId) && ["prepared", "skipped"].includes(String(job.status)) ? { jobId: job.jobId, status: job.status as "prepared" | "skipped" } : null })
  const materials = rawMaterials.map(value => { const item = exactRecord(value, ["jobId", "kind", "artifactRef"]), ref = parseArtifactRef(item?.artifactRef); return item && validId(item.jobId) && (item.kind === "resume" || item.kind === "cover_letter") && ref ? { jobId: item.jobId as string, kind: item.kind, artifactRef: ref } : null })
  if (jobs.some(value => !value) || materials.some(value => !value) || new Set(jobs.map(value => value?.jobId)).size !== jobs.length
    || new Set(materials.map(value => `${value?.jobId}\0${value?.kind}`)).size !== materials.length) return null
  return { raw: row, taskId: row.taskId as string, attemptCount: row.attemptCount as number, snapshotDigest: row.snapshotDigest as string,
    checkpointDigest: row.checkpointDigest as string, jobs: jobs as Array<{ jobId: string; status: "prepared" | "skipped" }>,
    materials: materials as Array<{ jobId: string; kind: "resume" | "cover_letter"; artifactRef: ScheduledTaskGraphArtifactReference }> }
}

function parseArtifactRef(value: unknown): ScheduledTaskGraphArtifactReference | null {
  const row = exactRecord(value, ["artifactId", "version", "contentHash", "sourceDigest"])
  return row && validId(row.artifactId) && positive(row.version) && snapshotDigest(row.contentHash) && snapshotDigest(row.sourceDigest)
    ? { artifactId: row.artifactId, version: row.version as number, contentHash: row.contentHash as string, sourceDigest: row.sourceDigest as string } : null
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const row = record(value)
  if (row) return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(",")}}`
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error("scheduled_prepare_result_digest_invalid")
  return encoded
}
function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const row = record(value), actual = row && Reflect.ownKeys(row)
  return row && actual && actual.length === keys.length && actual.every(key => typeof key === "string" && keys.includes(key)) ? row : null
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value)
  return actual.length === keys.length && actual.every(key => typeof key === "string" && keys.includes(key))
}
function record(value: unknown): Record<string, unknown> | null {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)) ? value as Record<string, unknown> : null
}
function denseArray(value: unknown): unknown[] | null { return Array.isArray(value) && Reflect.ownKeys(value).length === value.length + 1 ? value : null }
function stringArray(value: unknown): value is string[] { return denseArray(value) !== null && (value as unknown[]).every(item => typeof item === "string") }
function sameStrings(value: unknown, expected: readonly string[]): boolean { return stringArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index]) }
function sameSorted(value: readonly string[], expected: readonly string[]): boolean { return value.length === expected.length && [...value].sort().every((item, index) => item === [...expected].sort()[index]) }
function validId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function nonNegative(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
function hex(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) }
function snapshotDigest(value: unknown): value is string { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value) }
function validKey(value: unknown): boolean { return typeof value === "string" && /^scheduled-taskgraph:(?:v2:)?sha256:[a-f0-9]{64}$/.test(value) }
