import { createHash } from "node:crypto"
import { Type, type Static } from "@sinclair/typebox"
import { schemaVersion } from "@jobcopilot/agent-protocol"
import type { AgentArtifactTaskFence } from "../../db/agent-artifact-repo.js"
import { hashArtifactContent } from "../subagents/artifact-adapters.js"
import { ROLE_RESULT_SCHEMA } from "../subagents/role-results.js"
import { parseScheduledTaskGraphContinuationReceipt, type ScheduledTaskGraphContinuationReceipt } from "../subagents/scheduled-taskgraph-continuation-receipt.js"
import { parseScheduledAutomationSnapshot, type ScheduledAutomationSnapshot } from "../subagents/scheduled-automation-snapshot.js"
import type { TurnQuestionWaitReceipt } from "../turns/turn-question-contract.js"
import { ToolExecutionError, type RuntimeToolDefinition, type ToolExecutionContext } from "./types.js"

const ID = Type.String({ minLength: 1, maxLength: 256 })
const DIGEST = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" })
const HEX_DIGEST = Type.String({ pattern: "^[a-f0-9]{64}$" })
const ARTIFACT_REF = Type.Object({ artifactId: Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" }), version: Type.Integer({ minimum: 1 }), contentHash: DIGEST, sourceDigest: DIGEST }, { additionalProperties: false })
const PREPARE_JOB = Type.Object({ jobId: ID, status: Type.Union([Type.Literal("prepared"), Type.Literal("skipped"), Type.Literal("failed")]) }, { additionalProperties: false })
const PREPARE_MATERIAL = Type.Object({ jobId: ID, kind: Type.Union([Type.Literal("resume"), Type.Literal("cover_letter")]), artifactRef: ARTIFACT_REF }, { additionalProperties: false })
export const SCHEDULED_APPLICATION_PREPARE_INPUT_SCHEMA = Type.Object({}, { additionalProperties: false })
export const SCHEDULED_APPLICATION_PREPARE_OUTPUT_SCHEMA = Type.Object({
  schemaVersion: Type.Literal(ROLE_RESULT_SCHEMA), role: Type.Literal("prepare"), status: Type.Union([Type.Literal("completed"), Type.Literal("partial")]),
  taskId: ID, attemptCount: Type.Integer({ minimum: 1 }),
  snapshotDigest: DIGEST, checkpointDigest: HEX_DIGEST, jobs: Type.Array(PREPARE_JOB, { maxItems: 50 }), materials: Type.Array(PREPARE_MATERIAL, { maxItems: 100 }),
}, { additionalProperties: false })
export type ScheduledPrepareOutput = Static<typeof SCHEDULED_APPLICATION_PREPARE_OUTPUT_SCHEMA>
export const SCHEDULED_PREPARE_CHOICE_SCHEMA = "agent-harness.v2.scheduled-taskgraph-resume-tailoring-choice.v2" as const
export type ScheduledPrepareOwner = Readonly<{ userId: string; sessionId: string; turnId: string; rootTaskId: string; rootAttemptCount: number; turnLeaseOwnerId: string; turnLeaseVersion: number; executionId: string; executionAttemptCount: number }>
export type ScheduledPrepareReceipt = ScheduledTaskGraphContinuationReceipt
export type ScheduledPrepareTailoringChoice = Readonly<{ schemaVersion: typeof SCHEDULED_PREPARE_CHOICE_SCHEMA; key: string; questionId: string; answerItemId: string; value: "apply_ai_changes" | "keep_resume"; snapshotDigest: string; evidenceDigest: string; checkpointDigest: string; analyzeGraphRevision: number; prepareScheduleRevision: number; owner: ScheduledPrepareOwner }>
export type ScheduledPrepareJob = Readonly<{ jobId: string; score: number; sourceDigest: string; evidenceRefs: readonly string[] }>
export type ScheduledPrepareChoiceResolution = Readonly<{ status: "answered"; choice: ScheduledPrepareTailoringChoice }> | Readonly<{ status: "waiting_for_user"; receipt: TurnQuestionWaitReceipt; owner: ScheduledPrepareOwner; snapshotDigest: string }>
export type VerifiedScheduledPrepareInvocation = Readonly<{ source: "automation"; runMode: "scheduled"; templateId: "prepare"; role: "prepare"; taskType: "scheduled_application_prepare"; owner: ScheduledPrepareOwner; taskFence: AgentArtifactTaskFence; snapshot: ScheduledAutomationSnapshot; receipt: ScheduledPrepareReceipt; checkpointJobs: readonly ScheduledPrepareJob[]; resumeTailoringChoice?: ScheduledPrepareTailoringChoice }>
export type ScheduledPrepareArtifactWriteBinding = Readonly<{ userId: string; sessionId: string; turnId: string; rootTaskId: string; taskId: string; executionId: string; executionAttemptCount: number; taskFence: AgentArtifactTaskFence; continuationKey: string; snapshotDigest: string; evidenceDigest: string; checkpointDigest: string; analyzeGraphRevision: number; prepareScheduleRevision: number; resumeTailoringChoiceDigest: string | null; jobId: string; score: number; sourceDigest: string; evidenceRefs: readonly string[]; kind: "resume" | "cover_letter"; toolCallId: string; requestHash: string }>
export type ScheduledPrepareMaterialOutput = Readonly<{ kind: "resume" | "cover_letter"; artifactRef: Readonly<{ artifactId: string; version: number; contentHash: string; sourceDigest: string }> }>
export type ScheduledPrepareJobOutput = Readonly<{ status: "prepared" | "skipped" | "failed"; materials: readonly ScheduledPrepareMaterialOutput[] }>
export type ScheduledPrepareJobInput = Readonly<{ invocation: VerifiedScheduledPrepareInvocation; job: ScheduledPrepareJob; resumeTailoringChoice?: ScheduledPrepareTailoringChoice["value"]; artifactBinding(kind: "resume" | "cover_letter"): ScheduledPrepareArtifactWriteBinding }>
export type ScheduledApplicationPrepareDependencies = Readonly<{
  /** Reload persisted schedule/checkpoint/fences and any owner-fenced answer for this Turn. */
  loadVerifiedInvocation(context: ToolExecutionContext): Promise<unknown>
  /** Persist or resume the durable user question; answer stays private and wait receipts are server-owned. */
  resolveResumeTailoringChoice(input: Readonly<{ invocation: VerifiedScheduledPrepareInvocation; context: ToolExecutionContext }>): Promise<ScheduledPrepareChoiceResolution>
  /** Persist materials through immutable receipts; never log/return bodies or the answer. */
  prepareJob(input: ScheduledPrepareJobInput, signal: AbortSignal): Promise<unknown>
}>

const INVOCATION_KEYS = ["checkpointJobs", "owner", "receipt", "role", "runMode", "snapshot", "source", "taskFence", "taskType", "templateId"]
const OWNER_KEYS = ["executionAttemptCount", "executionId", "rootAttemptCount", "rootTaskId", "sessionId", "turnId", "turnLeaseOwnerId", "turnLeaseVersion", "userId"]
const TASK_FENCE_KEYS = ["attemptCount", "leaseOwner", "parentTaskId", "rootTaskId", "sessionId", "taskId", "turnId", "userId"]
const JOB_KEYS = ["evidenceRefs", "jobId", "score", "sourceDigest"], OUTPUT_KEYS = ["materials", "status"]
const MATERIAL_KEYS = ["artifactRef", "kind"], ARTIFACT_KEYS = ["artifactId", "contentHash", "sourceDigest", "version"]
const SAFE_ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export function createScheduledApplicationPrepareTool(dependencies: ScheduledApplicationPrepareDependencies): RuntimeToolDefinition<unknown, ScheduledPrepareOutput> {
  return {
    schemaVersion, name: "scheduled.application.prepare", version: "1", template: "prepare",
    description: "Prepare scheduled application materials from the persisted Analyze checkpoint and save only safe artifact references.",
    capabilities: ["read", "write"], inputSchema: SCHEDULED_APPLICATION_PREPARE_INPUT_SCHEMA, outputSchema: SCHEDULED_APPLICATION_PREPARE_OUTPUT_SCHEMA,
    risk: "draft_write", domain: "resume", idempotency: "requires_key", timeoutMs: 300_000, requiredCapabilities: [],
    execute: async (context, input) => {
      assertEmptyInput(input); assertToolContext(context)
      let invocation: VerifiedScheduledPrepareInvocation
      try { invocation = parseInvocation(await dependencies.loadVerifiedInvocation(context), context) }
      catch { throw unavailable() }
      if (invocation.snapshot.requireApproval && !invocation.resumeTailoringChoice) {
        let resolution: ScheduledPrepareChoiceResolution
        try { resolution = parseChoiceResolution(await dependencies.resolveResumeTailoringChoice({ invocation, context }), invocation) }
        catch { throw unavailable("The scheduled resume choice could not be verified.") }
        if (resolution.status === "waiting_for_user") throw new ToolExecutionError("policy_requires_user_input", "Scheduled Prepare is waiting for the persisted user choice.", {
          status: resolution.status, waitId: resolution.receipt.waitId, nextTurnRevision: resolution.receipt.nextTurnRevision,
        })
        invocation = { ...invocation, resumeTailoringChoice: resolution.choice }
      }
      const eligible = invocation.checkpointJobs.filter(job => job.score >= invocation.snapshot.minScore).slice(0, invocation.snapshot.dailyCap)
      const jobs: Array<{ jobId: string; status: "prepared" | "skipped" | "failed" }> = []
      const materials: Array<{ jobId: string; kind: "resume" | "cover_letter"; artifactRef: { artifactId: string; version: number; contentHash: string; sourceDigest: string } }> = []
      for (const job of eligible) {
        if (context.signal.aborted) throw new ToolExecutionError("cancelled", "Scheduled Prepare was interrupted.")
        try {
          const result = parseJobOutput(await dependencies.prepareJob({ invocation, job, resumeTailoringChoice: invocation.resumeTailoringChoice?.value,
            artifactBinding: kind => artifactBinding(invocation, job, kind) }, context.signal), job)
          jobs.push({ jobId: job.jobId, status: result.status }); for (const material of result.materials) materials.push({ jobId: job.jobId, ...material })
        } catch {
          if (context.signal.aborted) throw new ToolExecutionError("cancelled", "Scheduled Prepare was interrupted.")
          jobs.push({ jobId: job.jobId, status: "failed" })
        }
      }
      return { schemaVersion: ROLE_RESULT_SCHEMA, role: "prepare", status: jobs.some(job => job.status === "failed") ? "partial" : "completed",
        taskId: invocation.taskFence.taskId, attemptCount: invocation.taskFence.attemptCount,
        snapshotDigest: invocation.receipt.snapshotDigest, checkpointDigest: invocation.receipt.checkpointDigest, jobs, materials }
    },
  }
}

function unavailable(message = "Scheduled Prepare could not verify its persisted inputs."): ToolExecutionError {
  return new ToolExecutionError("scheduled_prepare_unavailable", message)
}
function assertEmptyInput(value: unknown): void {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error()
    const prototype = Object.getPrototypeOf(value)
    if ((prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(value).length !== 0) throw new Error()
  } catch { throw new ToolExecutionError("invalid_input", "Scheduled Prepare accepts no model-supplied arguments.") }
}
function assertToolContext(context: ToolExecutionContext): void {
  const marker = context.delegateOutputSchemaMarker
  if (context.signal.aborted || context.actorRole !== "subagent" || !context.scope.userId?.trim() || !context.sessionId.trim() || !context.turnId.trim()
    || !context.stepId.trim() || !context.taskId?.trim() || !context.rootTaskId?.trim() || !context.toolCallId?.trim()
    || !marker || marker.schemaVersion !== ROLE_RESULT_SCHEMA || marker.role !== "prepare") throw unavailable("Scheduled Prepare is unavailable outside its registered TaskGraph task.")
}
function parseInvocation(value: unknown, context: ToolExecutionContext): VerifiedScheduledPrepareInvocation {
  const row = exactRecord(value, INVOCATION_KEYS) ?? exactRecord(value, [...INVOCATION_KEYS, "resumeTailoringChoice"])
  if (!row || row.source !== "automation" || row.runMode !== "scheduled" || row.templateId !== "prepare" || row.role !== "prepare" || row.taskType !== "scheduled_application_prepare") throw new Error()
  const owner = parseOwner(row.owner), taskFence = parseTaskFence(row.taskFence), receipt = parseReceipt(row.receipt)
  const snapshot = parseScheduledAutomationSnapshot(row.snapshot), checkpointJobs = parseJobs(row.checkpointJobs)
  const choice = row.resumeTailoringChoice === undefined ? undefined : parseTailoringChoice(row.resumeTailoringChoice)
  if (!owner || !taskFence || !receipt || !snapshot || !checkpointJobs || (row.resumeTailoringChoice !== undefined && !choice)
    || owner.userId !== context.scope.userId || owner.sessionId !== context.sessionId || owner.turnId !== context.turnId || owner.rootTaskId !== context.rootTaskId
    || !sameTurnAttempt(owner, receipt.owner) || taskFence.userId !== owner.userId || taskFence.sessionId !== owner.sessionId || taskFence.turnId !== owner.turnId
    || taskFence.rootTaskId !== owner.rootTaskId || taskFence.parentTaskId !== owner.rootTaskId || taskFence.taskId !== context.taskId || !validId(taskFence.leaseOwner)
    || receipt.snapshotDigest !== scheduledSnapshotDigest(snapshot) || (choice && !choiceMatchesReceipt(choice, receipt))) throw new Error()
  return { source: "automation", runMode: "scheduled", templateId: "prepare", role: "prepare", taskType: "scheduled_application_prepare",
    owner, taskFence, snapshot, receipt, checkpointJobs, ...(choice ? { resumeTailoringChoice: choice } : {}) }
}
function parseTailoringChoice(value: unknown): ScheduledPrepareTailoringChoice | undefined {
  const row = exactRecord(value, ["analyzeGraphRevision", "answerItemId", "checkpointDigest", "evidenceDigest", "key", "owner", "prepareScheduleRevision", "questionId", "schemaVersion", "snapshotDigest", "value"]), owner = row && parseOwner(row.owner)
  if (!row || row.schemaVersion !== SCHEDULED_PREPARE_CHOICE_SCHEMA || !owner || !validId(row.key) || !validId(row.questionId)
    || row.answerItemId !== `agent-wait:question:${row.questionId}` || (row.value !== "apply_ai_changes" && row.value !== "keep_resume")
    || !isSnapshotDigest(row.snapshotDigest) || !isHexDigest(row.evidenceDigest) || !isHexDigest(row.checkpointDigest)
    || !positive(row.analyzeGraphRevision) || !positive(row.prepareScheduleRevision)
    || row.prepareScheduleRevision !== row.analyzeGraphRevision + 1) return undefined
  return { schemaVersion: SCHEDULED_PREPARE_CHOICE_SCHEMA, key: row.key, questionId: row.questionId, answerItemId: row.answerItemId,
    value: row.value, snapshotDigest: row.snapshotDigest, evidenceDigest: row.evidenceDigest, checkpointDigest: row.checkpointDigest,
    analyzeGraphRevision: row.analyzeGraphRevision, prepareScheduleRevision: row.prepareScheduleRevision, owner }
}
function parseChoiceResolution(value: unknown, invocation: VerifiedScheduledPrepareInvocation): ScheduledPrepareChoiceResolution {
  const row = exactRecord(value, ["choice", "status"])
  if (row?.status === "answered") {
    const choice = parseTailoringChoice(row.choice)
    if (!choice || !choiceMatchesReceipt(choice, invocation.receipt)) throw new Error()
    return { status: "answered", choice }
  }
  const wait = exactRecord(value, ["owner", "receipt", "snapshotDigest", "status"]), owner = wait && parseOwner(wait.owner)
  const receipt = wait && parseQuestionWaitReceipt(wait.receipt)
  if (!wait || wait.status !== "waiting_for_user" || !owner || !receipt || !sameTurnAttempt(invocation.owner, owner)
    || wait.snapshotDigest !== invocation.receipt.snapshotDigest || receipt.turnId !== invocation.owner.turnId) throw new Error()
  return { status: "waiting_for_user", receipt, owner, snapshotDigest: invocation.receipt.snapshotDigest }
}
function parseQuestionWaitReceipt(value: unknown): TurnQuestionWaitReceipt | undefined {
  const row = exactRecord(value, ["disposition", "itemId", "nextTurnRevision", "status", "toolCallId", "turnId", "waitId"])
  if (!row || row.status !== "waiting_for_user" || (row.disposition !== "created" && row.disposition !== "replayed")
    || ![row.waitId, row.itemId, row.turnId].every(validId) || row.toolCallId !== null
    || row.itemId !== `agent-wait:question:${row.waitId}` || !positive(row.nextTurnRevision)) return undefined
  return row as unknown as TurnQuestionWaitReceipt
}
function parseOwner(value: unknown): ScheduledPrepareOwner | undefined {
  const row = exactRecord(value, OWNER_KEYS)
  if (!row || ![row.userId, row.sessionId, row.turnId, row.rootTaskId, row.turnLeaseOwnerId, row.executionId].every(validOwnerId)
    || !positive(row.rootAttemptCount) || !positive(row.turnLeaseVersion) || !nonNegative(row.executionAttemptCount)) return undefined
  return row as unknown as ScheduledPrepareOwner
}
function parseTaskFence(value: unknown): AgentArtifactTaskFence | undefined {
  const row = exactRecord(value, TASK_FENCE_KEYS)
  if (!row || ![row.taskId, row.userId, row.sessionId, row.turnId, row.rootTaskId, row.leaseOwner].every(validId)
    || !(row.parentTaskId === null || validId(row.parentTaskId)) || !positive(row.attemptCount)) return undefined
  return row as unknown as AgentArtifactTaskFence
}
function parseReceipt(value: unknown): ScheduledPrepareReceipt | undefined {
  return parseScheduledTaskGraphContinuationReceipt(value) ?? undefined
}
function parseJobs(value: unknown): ScheduledPrepareJob[] | undefined {
  if (!Array.isArray(value) || value.length > 500 || !denseArray(value)) return undefined
  const ids = new Set<string>(), parsed: ScheduledPrepareJob[] = []
  for (const item of value) {
    const row = exactRecord(item, JOB_KEYS), evidenceRefs = row && parseEvidenceRefs(row.evidenceRefs)
    if (!row || !validId(row.jobId) || ids.has(row.jobId) || typeof row.score !== "number" || !Number.isSafeInteger(row.score)
      || row.score < 0 || row.score > 100 || !isSnapshotDigest(row.sourceDigest) || !evidenceRefs) return undefined
    ids.add(row.jobId); parsed.push({ jobId: row.jobId, score: row.score, sourceDigest: row.sourceDigest, evidenceRefs })
  }
  return parsed
}
function parseEvidenceRefs(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64 || !denseArray(value) || !value.every(validId) || new Set(value).size !== value.length) return undefined
  return [...value].sort()
}
function parseJobOutput(value: unknown, job: ScheduledPrepareJob): ScheduledPrepareJobOutput {
  const row = exactRecord(value, OUTPUT_KEYS)
  if (!row || (row.status !== "prepared" && row.status !== "skipped" && row.status !== "failed") || !Array.isArray(row.materials)
    || row.materials.length > 2 || !denseArray(row.materials)) throw new Error()
  const parsed: ScheduledPrepareMaterialOutput[] = [], kinds = new Set<string>()
  for (const item of row.materials) {
    const material = exactRecord(item, MATERIAL_KEYS), ref = material && parseArtifactRef(material.artifactRef)
    if (!material || (material.kind !== "resume" && material.kind !== "cover_letter") || kinds.has(material.kind) || !ref || ref.sourceDigest !== job.sourceDigest) throw new Error()
    kinds.add(material.kind); parsed.push({ kind: material.kind, artifactRef: ref })
  }
  if (row.status === "prepared" && !kinds.has("resume") || row.status !== "prepared" && parsed.length) throw new Error()
  return { status: row.status, materials: parsed }
}
function parseArtifactRef(value: unknown) {
  const row = exactRecord(value, ARTIFACT_KEYS)
  if (!row || !validId(row.artifactId) || !SAFE_ARTIFACT_ID.test(row.artifactId) || !positive(row.version)
    || !isSnapshotDigest(row.contentHash) || !isSnapshotDigest(row.sourceDigest)) return undefined
  return { artifactId: row.artifactId, version: row.version, contentHash: row.contentHash, sourceDigest: row.sourceDigest }
}
function artifactBinding(invocation: VerifiedScheduledPrepareInvocation, job: ScheduledPrepareJob, kind: "resume" | "cover_letter"): ScheduledPrepareArtifactWriteBinding {
  const { owner, taskFence, receipt } = invocation
  const toolCallId = `scheduled-prepare-${hashArtifactContent({ taskId: taskFence.taskId, jobId: job.jobId, kind }).slice(7)}`
  const choice = invocation.resumeTailoringChoice
  const resumeTailoringChoiceDigest = choice ? hashArtifactContent({ schemaVersion: choice.schemaVersion, key: choice.key,
    questionId: choice.questionId, answerItemId: choice.answerItemId, value: choice.value, snapshotDigest: choice.snapshotDigest,
    evidenceDigest: choice.evidenceDigest, checkpointDigest: choice.checkpointDigest, analyzeGraphRevision: choice.analyzeGraphRevision,
    prepareScheduleRevision: choice.prepareScheduleRevision, owner: stableOwner(choice.owner) }) : null
  const requestHash = hashArtifactContent({ schemaVersion: "agent-harness.v2.scheduled-prepare-artifact-write.v1", userId: owner.userId,
    sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId, rootAttemptCount: owner.rootAttemptCount,
    executionId: owner.executionId, executionAttemptCount: owner.executionAttemptCount,
    taskId: taskFence.taskId, parentTaskId: taskFence.parentTaskId, continuationKey: receipt.continuationKey,
    snapshotDigest: receipt.snapshotDigest, evidenceDigest: receipt.evidenceDigest, checkpointDigest: receipt.checkpointDigest,
    analyzeGraphRevision: receipt.analyzeGraphRevision, prepareScheduleRevision: receipt.prepareScheduleRevision, resumeTailoringChoiceDigest,
    jobId: job.jobId, score: job.score, sourceDigest: job.sourceDigest, evidenceRefs: job.evidenceRefs, kind })
  return { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
    taskId: taskFence.taskId, executionId: owner.executionId, executionAttemptCount: owner.executionAttemptCount, taskFence,
    continuationKey: receipt.continuationKey, snapshotDigest: receipt.snapshotDigest, evidenceDigest: receipt.evidenceDigest,
    checkpointDigest: receipt.checkpointDigest, analyzeGraphRevision: receipt.analyzeGraphRevision,
    prepareScheduleRevision: receipt.prepareScheduleRevision, resumeTailoringChoiceDigest, jobId: job.jobId, score: job.score,
    sourceDigest: job.sourceDigest, evidenceRefs: job.evidenceRefs, kind, toolCallId, requestHash }
}
function scheduledSnapshotDigest(snapshot: ScheduledAutomationSnapshot): string {
  const projection = [snapshot.schemaVersion, snapshot.targetRoles, snapshot.targetLocations, snapshot.minScore, snapshot.dailyCap, snapshot.requireApproval, snapshot.autoApply]
  return `sha256:${createHash("sha256").update(JSON.stringify(projection), "utf8").digest("hex")}`
}
function sameTurnAttempt(left: ScheduledPrepareOwner, right: ScheduledPrepareOwner): boolean {
  return ["userId", "sessionId", "turnId", "rootTaskId", "rootAttemptCount", "executionId", "executionAttemptCount"]
    .every(key => left[key as keyof ScheduledPrepareOwner] === right[key as keyof ScheduledPrepareOwner])
}
function choiceMatchesReceipt(choice: ScheduledPrepareTailoringChoice, receipt: ScheduledPrepareReceipt): boolean {
  return sameTurnAttempt(receipt.owner, choice.owner) && choice.key === receipt.continuationKey
    && choice.snapshotDigest === receipt.snapshotDigest && choice.evidenceDigest === receipt.evidenceDigest
    && choice.checkpointDigest === receipt.checkpointDigest && choice.analyzeGraphRevision === receipt.analyzeGraphRevision
    && choice.prepareScheduleRevision === receipt.prepareScheduleRevision
}
function stableOwner(owner: ScheduledPrepareOwner): Readonly<Pick<ScheduledPrepareOwner,
  "userId" | "sessionId" | "turnId" | "rootTaskId" | "rootAttemptCount" | "executionId" | "executionAttemptCount">> {
  const { userId, sessionId, turnId, rootTaskId, rootAttemptCount, executionId, executionAttemptCount } = owner
  return { userId, sessionId, turnId, rootTaskId, rootAttemptCount, executionId, executionAttemptCount }
}
function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
    const ownKeys = Reflect.ownKeys(value), prototype = Object.getPrototypeOf(value)
    if ((prototype !== Object.prototype && prototype !== null) || ownKeys.some(key => typeof key !== "string") || ownKeys.length !== keys.length
      || (ownKeys as string[]).some(key => !keys.includes(key))) return undefined
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of keys) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor?.enumerable || !("value" in descriptor)) return undefined; result[key] = descriptor.value }
    return result
  } catch { return undefined }
}
function denseArray(value: readonly unknown[]): boolean {
  try { const keys = Reflect.ownKeys(value); return keys.length === value.length + 1 && keys.every(key => key === "length" || typeof key === "string" && /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length) }
  catch { return false }
}
function validId(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= 256 }
function validOwnerId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)
}
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function nonNegative(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
function isSnapshotDigest(value: unknown): value is string { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value) }
function isHexDigest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) }
