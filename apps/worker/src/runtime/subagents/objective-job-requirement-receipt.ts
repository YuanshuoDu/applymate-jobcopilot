import { createHash } from "node:crypto"
import type pg from "pg"
import { objectiveJobRequirementProposals, verifyObjectiveJobRequirementEvidence,
  type ObjectiveJobRequirementDeliveryCandidate, type ObjectiveJobRequirementDeliveryVerification,
  type ObjectiveJobRequirementProposal } from "@jobcopilot/shared/objective-job-requirement-evidence"
import { isCanonicalJobId } from "../tools/job-read-output-redaction.js"
import { createPostgresReadToolDataSource } from "../tools/read-data-source.js"
import { scheduledDraftJobMaterialDigest } from "./scheduled-draft-job-material.js"
import { loadTaskGraphVerificationReceipts, type TaskGraphVerificationReceipts } from "./task-graph-pg-verification-receipts.js"
import { taskGraphEvidenceDigest, type TaskGraphVerificationScope } from "./task-graph-pg-verification-receipt-validation.js"
import { taskGraphResultDigest } from "./task-graph-pg-verification.js"
import { canonicalTaskGraphJson, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import type { AnalystResult } from "./role-result-job-evidence.js"
import { readScheduledDraftAnalystProof } from "./scheduled-draft-candidate-analyst-proof.js"
import type { GraphIdentityScope } from "./task-graph-pg-state.js"
import type { ObjectiveTailorWaveSlotOutcome } from "../canonical-objective-tailor-wave-completion.js"

type Queryable = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
const RECEIPT_SCHEMA = "agent-harness.v2.objective-job-requirement-receipt.v1"
const MAX_JOB_IDS = 8
const SHA = /^[a-f0-9]{64}$/
type Delivery = Readonly<{ toolCallId: string; callItemId: string; callItemRevision: number; resultItemId: string;
  resultItemRevision: number; replaySourceCallItemId?: string; replaySourceResultItemId?: string }>
export type ObjectiveJobRequirementReceipt = Readonly<{
  schemaVersion: typeof RECEIPT_SCHEMA; userId: string; sessionId: string; sourceTurnId: string; rootTaskId: string
  graphItemId: string; graphRevision: number; analystNodeKey: string; analystTaskId: string; attemptCount: number
  jobId: string; evidenceId: string; inputJobId: string; outputJobId: string; toolVersion: string
  analystResultDigest: string; analystEvidenceDigest: string; inputDigest: string; outputDigest: string
  jobMaterialDigest: string; quoteDigest: string; startUtf16: number; endUtf16: number; quote: string
  deliveries: readonly Delivery[]
}>
export type ObjectiveJobRequirementEvidence = Readonly<{
  status: "absent" | "partial" | "verified" | "unavailable"
  proposedCount: number
  receipts: readonly ObjectiveJobRequirementReceipt[]
}>
export type ObjectiveJobRequirementInput = Readonly<{
  scope: TaskGraphVerificationScope; graphItemId: string; graphRevision: number; analystNodeKey: string
  result: AnalystResult; resultDigest: string; evidenceDigest: string; evidenceIds: readonly string[]; jobIds: readonly string[]
}>

type ObjectiveTailorRequirementsInput = Readonly<{ scope: GraphIdentityScope; graphItemId: string; graphRevision: number;
  snapshot: TaskGraphSnapshot; outcomes: readonly ObjectiveTailorWaveSlotOutcome[] }>

/** Revalidates only optional requirement quotes; unavailable citations never affect role eligibility. */
export async function readObjectiveJobRequirementEvidence(client: Queryable,
  input: ObjectiveJobRequirementInput): Promise<ObjectiveJobRequirementEvidence> {
  const proposals = objectiveJobRequirementProposals(input.result, input.jobIds)
  if (!proposals) return unavailable(0)
  if (!proposals.length) return { status: "absent", proposedCount: 0, receipts: [] }
  if (!validInput(input)) return unavailable(proposals.length)
  try {
    if (taskGraphResultDigest(input.result) !== input.resultDigest) return unavailable(proposals.length)
    const receipts = await loadTaskGraphVerificationReceipts(client, input.scope)
    if (taskGraphEvidenceDigest(receipts.items, receipts.outcomes, input.evidenceIds, input.resultDigest, receipts.replayReceipts)
      !== input.evidenceDigest) return unavailable(proposals.length)
    const byJob = new Map<string, typeof proposals>()
    for (const proposal of proposals) byJob.set(proposal.jobId, [...(byJob.get(proposal.jobId) ?? []), proposal])
    const verified: ObjectiveJobRequirementReceipt[] = []
    for (const [jobId, values] of byJob) {
      const deliveries = deliveryCandidates(receipts, input.scope, jobId)
      if (!deliveries) continue
      const currentJob = await createPostgresReadToolDataSource(client).getJob(input.scope.userId, jobId)
      const materialDigest = currentJob && scheduledDraftJobMaterialDigest(currentJob)
      if (!currentJob || currentJob.id !== jobId || typeof currentJob.description !== "string" || !materialDigest) continue
      for (const value of values) {
        const proof = verifyObjectiveJobRequirementEvidence({ proposal: value, attemptCount: input.scope.attemptCount,
          currentJob, deliveries })
        if (!proof || proof.jobMaterialDigest !== materialDigest) continue
        verified.push(makeReceipt(input, value, proof))
      }
    }
    const status = verified.length === proposals.length ? "verified" : verified.length > 0 ? "partial" : "unavailable"
    return { status, proposedCount: proposals.length, receipts: verified }
  } catch {
    return unavailable(proposals.length)
  }
}

/** Optional private citation reread for callers that explicitly request completed-source details. */
export async function readObjectiveTailorJobRequirementEvidence(client: Queryable,
  input: ObjectiveTailorRequirementsInput): Promise<ObjectiveJobRequirementEvidence> {
  if (!Array.isArray(input.outcomes) || input.outcomes.length === 0 || input.outcomes.length > MAX_JOB_IDS) return unavailable(0)
  const groups = new Map<string, { nodeKey: string; jobIds: string[]; outcomes: ObjectiveTailorWaveSlotOutcome[] }>()
  for (const outcome of input.outcomes) {
    const witness = outcome.candidateWitness, nodeKey = witness.sourceAnalystKeys[0], jobId = witness.candidate.jobId
    if (outcome.status !== "ready" || outcome.jobId !== jobId || !text(nodeKey) || !isCanonicalJobId(jobId)
      || groups.size > MAX_JOB_IDS) return unavailable(0)
    const group = groups.get(nodeKey) ?? { nodeKey, jobIds: [], outcomes: [] }
    if (group.jobIds.includes(jobId)) return unavailable(0)
    group.jobIds.push(jobId); group.outcomes.push(outcome); groups.set(nodeKey, group)
  }
  let proposedCount = 0, unavailableProof = false
  const verified: ObjectiveJobRequirementReceipt[] = []
  for (const group of groups.values()) {
    const node = input.snapshot.nodes.find(value => value.key === group.nodeKey)
    const proof = node && await readScheduledDraftAnalystProof(client, input.scope, input.snapshot, node)
    const proofDigest = proof ? sha256(canonicalTaskGraphJson(proof.binding)) : undefined
    if (!proof || proof.binding.nodeKey !== group.nodeKey
      || group.outcomes.some(outcome => outcome.candidateWitness.analystProofDigest !== proofDigest)
      || group.outcomes.some(outcome => proof.materialDigests.get(outcome.jobId) !== outcome.candidateWitness.candidate.materialDigest)) {
      unavailableProof = true; continue
    }
    const evidence = await readObjectiveJobRequirementEvidence(client, { scope: { ...input.scope, taskId: proof.binding.taskId,
      attemptCount: proof.binding.attemptCount }, graphItemId: input.graphItemId, graphRevision: input.graphRevision,
      analystNodeKey: group.nodeKey, result: proof.result, resultDigest: proof.binding.resultDigest,
      evidenceDigest: proof.binding.evidenceDigest, evidenceIds: proof.evidenceIds, jobIds: group.jobIds })
    proposedCount += evidence.proposedCount; verified.push(...evidence.receipts)
    if (evidence.status === "unavailable" || evidence.status === "partial") unavailableProof = true
  }
  const status = proposedCount === 0 ? unavailableProof ? "unavailable" : "absent"
    : verified.length === proposedCount && !unavailableProof ? "verified" : verified.length ? "partial" : "unavailable"
  return { status, proposedCount, receipts: verified }
}

function makeReceipt(input: ObjectiveJobRequirementInput, proposal: ObjectiveJobRequirementProposal,
  verified: ObjectiveJobRequirementDeliveryVerification): ObjectiveJobRequirementReceipt {
  return { schemaVersion: RECEIPT_SCHEMA, userId: input.scope.userId, sessionId: input.scope.sessionId,
    sourceTurnId: input.scope.turnId, rootTaskId: input.scope.rootTaskId, graphItemId: input.graphItemId,
    graphRevision: input.graphRevision, analystNodeKey: input.analystNodeKey, analystTaskId: input.scope.taskId,
    attemptCount: input.scope.attemptCount, jobId: proposal.jobId, evidenceId: proposal.evidenceId,
    inputJobId: verified.inputJobId, outputJobId: verified.outputJobId, toolVersion: verified.toolVersion,
    analystResultDigest: input.resultDigest, analystEvidenceDigest: input.evidenceDigest,
    inputDigest: verified.inputDigest, outputDigest: verified.outputDigest, jobMaterialDigest: verified.jobMaterialDigest,
    quoteDigest: verified.quoteDigest, startUtf16: verified.startUtf16, endUtf16: verified.endUtf16, quote: proposal.quote,
    deliveries: verified.deliveries }
}

function deliveryCandidates(receipts: TaskGraphVerificationReceipts, scope: TaskGraphVerificationScope,
  selectedJobId: string): ObjectiveJobRequirementDeliveryCandidate[] | undefined {
  const results = new Map<string, Row>()
  for (const item of receipts.items) if (item.type === "tool_result") {
    const content = record(item.content), id = content && text(content.toolCallId) ? content.toolCallId : undefined
    if (id) results.set(id, item)
  }
  const replayByCall = new Map(receipts.replayReceipts.map(receipt => [receipt.currentCallId, receipt] as const))
  const deliveries: ObjectiveJobRequirementDeliveryCandidate[] = []
  for (const item of receipts.items) {
    if (item.type !== "tool_call") continue
    const content = record(item.content)
    if (content?.toolName !== "jobs.get") continue
    const toolCallId = text(content.toolCallId) ? content.toolCallId : undefined
    const input = record(content.input), inputJobId = input && text(input.jobId) ? input.jobId : undefined
    const result = toolCallId ? results.get(toolCallId) : undefined
    const resultContent = record(result?.content), outputJobId = resultContent && resultJobId(resultContent.output)
    if (inputJobId !== selectedJobId && outputJobId !== selectedJobId) continue
    if (!text(toolCallId) || !text(item.id) || item.status !== "completed" || item.taskId !== scope.taskId || item.sessionId !== scope.sessionId
      || item.turnId !== scope.turnId || !text(item.stepId) || Number(item.attempt) !== scope.attemptCount
      || !Number.isSafeInteger(Number(item.ordinal)) || Number(item.ordinal) < 0 || !Number.isSafeInteger(Number(item.revision))
      || Number(item.revision) < 0 || content.status !== "completed" || content.errorCode !== null
      || receipts.outcomes.get(toolCallId) !== "completed") return undefined
    if (!result || !resultContent || !text(result.id) || result.status !== "completed" || result.taskId !== scope.taskId
      || result.sessionId !== scope.sessionId || result.turnId !== scope.turnId || result.stepId !== item.stepId
      || Number(result.attempt) !== scope.attemptCount || Number(result.ordinal) !== Number(item.ordinal)
      || !Number.isSafeInteger(Number(result.revision)) || Number(result.revision) < 0 || resultContent.toolCallId !== toolCallId
      || resultContent.errorCode !== null || !exactResultContent(resultContent)) return undefined
    const replay = replayByCall.get(toolCallId)
    const delivery = { call: { id: String(item.id), stepId: String(item.stepId), attempt: Number(item.attempt),
      ordinal: Number(item.ordinal), revision: Number(item.revision) },
    callContent: { toolCallId, toolName: String(content.toolName), toolVersion: String(content.toolVersion), input: content.input,
      status: String(content.status), errorCode: content.errorCode },
    outcome: receipts.outcomes.get(toolCallId) ?? null,
    result: { id: String(result.id), stepId: String(result.stepId), attempt: Number(result.attempt),
      ordinal: Number(result.ordinal), revision: Number(result.revision) },
    resultContent: { toolCallId: String(resultContent.toolCallId), output: resultContent.output,
      status: "completed", errorCode: resultContent.errorCode },
    replay: replay ? { currentCallId: replay.currentCallId, sourceCallItemId: replay.sourceCallItem[0],
      sourceResultItemId: replay.sourceResultItem[0] } : null }
    deliveries.push(delivery)
  }
  return deliveries
}
function exactResultContent(value: Row): boolean {
  const keys = Reflect.ownKeys(value)
  return keys.length === 3 && keys.every(key => typeof key === "string" && ["errorCode", "output", "toolCallId"].includes(key)
    && Boolean(Object.getOwnPropertyDescriptor(value, key)?.enumerable && "value" in Object.getOwnPropertyDescriptor(value, key)!))
}
function resultJobId(value: unknown): string | undefined {
  const output = record(value), job = record(output?.job)
  return job && text(job.id) ? job.id : undefined
}
function validInput(input: ObjectiveJobRequirementInput): boolean {
  const scope = input.scope
  return [scope.userId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.taskId, input.graphItemId, input.analystNodeKey]
    .every(text) && scope.rootTaskId === scope.parentTaskId && Number.isSafeInteger(scope.attemptCount) && scope.attemptCount >= 1
    && Number.isSafeInteger(input.graphRevision) && input.graphRevision > 0 && SHA.test(input.resultDigest) && SHA.test(input.evidenceDigest)
    && Array.isArray(input.evidenceIds) && input.evidenceIds.length <= 50 && Reflect.ownKeys(input.evidenceIds).length === input.evidenceIds.length + 1
    && input.evidenceIds.every(text) && new Set(input.evidenceIds).size === input.evidenceIds.length
}
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex") }
function unavailable(proposedCount: number): ObjectiveJobRequirementEvidence { return { status: "unavailable", proposedCount, receipts: [] } }
function record(value: unknown): Row | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null ? value as Row : undefined } catch { return undefined }
}
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.trim() === value }
