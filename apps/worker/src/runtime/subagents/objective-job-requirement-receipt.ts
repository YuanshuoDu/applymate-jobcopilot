import { createHash } from "node:crypto"
import type pg from "pg"
import { isCanonicalJobId } from "../tools/job-read-output-redaction.js"
import { createPostgresReadToolDataSource } from "../tools/read-data-source.js"
import { scheduledDraftJobMaterialDigest } from "./scheduled-draft-job-material.js"
import { loadTaskGraphVerificationReceipts, type TaskGraphVerificationReceipts } from "./task-graph-pg-verification-receipts.js"
import { taskGraphEvidenceDigest, type TaskGraphVerificationScope } from "./task-graph-pg-verification-receipt-validation.js"
import type { TaskGraphReplayReceipt } from "./task-graph-pg-event-validation.js"
import { taskGraphResultDigest } from "./task-graph-pg-verification.js"
import { canonicalTaskGraphJson, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { uniqueRequirementQuoteOffsets, type AnalystResult } from "./role-result-job-evidence.js"
import { readScheduledDraftAnalystProof } from "./scheduled-draft-candidate-analyst-proof.js"
import type { GraphIdentityScope } from "./task-graph-pg-state.js"
import type { ObjectiveTailorWaveSlotOutcome } from "../canonical-objective-tailor-wave-completion.js"

type Queryable = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
const RECEIPT_SCHEMA = "agent-harness.v2.objective-job-requirement-receipt.v1"
const MAX_JOB_IDS = 8
const MAX_DELIVERIES = 8
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
  const proposals = citationsForJobs(input.result, input.jobIds)
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
      const currentJob = await createPostgresReadToolDataSource(client).getJob(input.scope.userId, jobId)
      const materialDigest = currentJob && scheduledDraftJobMaterialDigest(currentJob)
      const matching = matchingJobGet(receipts, jobId, input.scope)
      const selected = matching && selectUniqueDeliverySet(matching, receipts.replayReceipts, receipts.outcomes, input.scope.attemptCount)
      const outputJob = selected && jobFrom(selected.output)
      const outputDigest = selected && safeDigest(selected.output)
      const inputDigest = selected && safeDigest(selected.input)
      const receiptMaterialDigest = outputJob && scheduledDraftJobMaterialDigest(outputJob)
      if (!currentJob || currentJob.id !== jobId || typeof currentJob.description !== "string" || !materialDigest
        || !selected || !outputJob || outputJob.id !== jobId || typeof outputJob.description !== "string"
        || outputJob.description !== currentJob.description
        || !outputDigest || !inputDigest || !receiptMaterialDigest || materialDigest !== receiptMaterialDigest) {
        continue
      }
      for (const value of values) {
        const offsets = uniqueRequirementQuoteOffsets(outputJob.description, value.quote)
        if (!offsets) continue
        verified.push(makeReceipt(input, selected, value.evidenceId, jobId, offsets, value.quote,
          inputDigest, outputDigest, materialDigest))
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

type Proposal = Readonly<{ jobId: string; evidenceId: string; quote: string }>
function citationsForJobs(result: AnalystResult, jobIds: readonly string[]): Proposal[] | undefined {
  if (!Array.isArray(jobIds) || jobIds.length > MAX_JOB_IDS || new Set(jobIds).size !== jobIds.length
    || jobIds.some(id => !isCanonicalJobId(id))) return undefined
  const selected = new Set(jobIds), evidence = new Map(result.evidence.map(item => [item.id, item] as const))
  return result.findings.flatMap(finding => selected.has(finding.jobId) ? (finding.requirementCitations ?? []).flatMap(citation => {
    const linked = evidence.get(citation.evidenceId)
    return linked?.kind === "job" && linked.ref === finding.jobId ? [{ jobId: finding.jobId, ...citation }] : []
  }) : [])
}
type MatchingCall = Readonly<{ call: Row; result: Row; input: Row; output: Row; content: Row; callContent: Row }>
function matchingJobGet(receipts: TaskGraphVerificationReceipts, jobId: string, scope: TaskGraphVerificationScope): MatchingCall[] {
  const results = new Map<string, Row>()
  for (const item of receipts.items) if (item.type === "tool_result") {
    const content = record(item.content), id = content && text(content.toolCallId) ? content.toolCallId : undefined
    if (id) results.set(id, item)
  }
  const matches: MatchingCall[] = []
  for (const call of receipts.items) {
    if (call.type !== "tool_call") continue
    const content = record(call.content), id = content && text(content.toolCallId) ? content.toolCallId : undefined
    if (!content || content.toolName !== "jobs.get" || !id) continue
    const result = results.get(id), resultContent = record(result?.content), input = record(content.input), output = record(resultContent?.output)
    if (call.taskId !== scope.taskId || call.sessionId !== scope.sessionId || call.turnId !== scope.turnId
      || Number(call.attempt) !== scope.attemptCount || result && (result.taskId !== scope.taskId || result.sessionId !== scope.sessionId
        || result.turnId !== scope.turnId || Number(result.attempt) !== scope.attemptCount)) return []
    const inputMatches = input?.jobId === jobId, outputMatches = jobFrom(output)?.id === jobId
    if (!inputMatches && !outputMatches) continue
    if (!result || !resultContent || !input || !output) return []
    matches.push({ call, result, input, output, content: resultContent, callContent: content })
  }
  return matches
}
type SelectedDelivery = Readonly<{ input: Row; output: Row; toolVersion: string; deliveries: readonly Delivery[] }>
function selectUniqueDeliverySet(calls: readonly MatchingCall[], replayReceipts: readonly TaskGraphReplayReceipt[],
  outcomes: ReadonlyMap<string, "completed" | "failed">, attemptCount: number): SelectedDelivery | undefined {
  if (!calls.length || calls.length > MAX_DELIVERIES) return undefined
  const ordered = [...calls].sort((a, b) => compareText(String(a.call.id), String(b.call.id)))
  const replayByCall = new Map(replayReceipts.map(receipt => [receipt.currentCallId, receipt] as const))
  const canonical = ordered.map(entry => {
    const callId = entry.callContent.toolCallId, replay = replayByCall.get(String(callId)), job = jobFrom(entry.output)
    if (!job || !isCanonicalJobId(job.id) || !exactKeys(entry.input, "jobId") || entry.input.jobId !== job.id
      || entry.callContent.toolName !== "jobs.get" || entry.callContent.toolVersion !== "1"
      || entry.callContent.status !== "completed" || entry.callContent.errorCode !== null
      || entry.content.status !== "completed" || entry.content.errorCode !== null || outcomes.get(String(callId)) !== "completed"
      || entry.content.toolCallId !== callId || entry.call.stepId !== entry.result.stepId
      || Number(entry.call.attempt) !== attemptCount || Number(entry.result.attempt) !== attemptCount
      || !Number.isSafeInteger(entry.call.revision) || !Number.isSafeInteger(entry.result.revision)
      || !Number.isSafeInteger(entry.call.attempt) || Number(entry.call.attempt) < 1
      || !text(entry.call.id) || !text(entry.result.id)) return undefined
    return { entry, replay }
  })
  if (canonical.some(item => !item)) return undefined
  const rows = canonical as Array<NonNullable<typeof canonical[number]>>
  const first = rows[0]!, inputDigest = safeDigest(first.entry.input), outputDigest = safeDigest(first.entry.output)
  if (!inputDigest || !outputDigest || rows.some(row => row.entry.callContent.toolVersion !== first.entry.callContent.toolVersion
    || safeDigest(row.entry.input) !== inputDigest || safeDigest(row.entry.output) !== outputDigest)) return undefined
  if (rows.length > 1) {
    const direct = rows.filter(row => !row.replay)
    if (direct.length > 1) return undefined
    const source = direct.length === 1 ? `${direct[0]!.entry.call.id}\u0000${direct[0]!.entry.result.id}`
      : rows[0]!.replay && `${rows[0]!.replay.sourceCallItem[0]}\u0000${rows[0]!.replay.sourceResultItem[0]}`
    if (!source || rows.some(row => row.replay
      && `${row.replay.sourceCallItem[0]}\u0000${row.replay.sourceResultItem[0]}` !== source)) return undefined
  }
  const deliveries = rows.map(({ entry, replay }) => ({ toolCallId: String(entry.callContent.toolCallId), callItemId: String(entry.call.id),
    callItemRevision: Number(entry.call.revision), resultItemId: String(entry.result.id), resultItemRevision: Number(entry.result.revision),
    ...(replay ? { replaySourceCallItemId: replay.sourceCallItem[0], replaySourceResultItemId: replay.sourceResultItem[0] } : {}) }))
  return { input: first.entry.input, output: first.entry.output, toolVersion: String(first.entry.callContent.toolVersion), deliveries }
}

function makeReceipt(input: ObjectiveJobRequirementInput, selected: SelectedDelivery, evidenceId: string, jobId: string,
  offsets: Readonly<{ startUtf16: number; endUtf16: number }>, quote: string, inputDigest: string, outputDigest: string,
  jobMaterialDigest: string): ObjectiveJobRequirementReceipt {
  return { schemaVersion: RECEIPT_SCHEMA, userId: input.scope.userId, sessionId: input.scope.sessionId,
    sourceTurnId: input.scope.turnId, rootTaskId: input.scope.rootTaskId, graphItemId: input.graphItemId,
    graphRevision: input.graphRevision, analystNodeKey: input.analystNodeKey, analystTaskId: input.scope.taskId,
    attemptCount: input.scope.attemptCount, jobId, evidenceId, inputJobId: jobId, outputJobId: jobId,
    toolVersion: selected.toolVersion, analystResultDigest: input.resultDigest, analystEvidenceDigest: input.evidenceDigest,
    inputDigest, outputDigest, jobMaterialDigest, quoteDigest: sha256(quote), ...offsets, quote,
    deliveries: selected.deliveries }
}
function validInput(input: ObjectiveJobRequirementInput): boolean {
  const scope = input.scope
  return [scope.userId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.taskId, input.graphItemId, input.analystNodeKey]
    .every(text) && scope.rootTaskId === scope.parentTaskId && Number.isSafeInteger(scope.attemptCount) && scope.attemptCount >= 1
    && Number.isSafeInteger(input.graphRevision) && input.graphRevision > 0 && SHA.test(input.resultDigest) && SHA.test(input.evidenceDigest)
    && Array.isArray(input.evidenceIds) && input.evidenceIds.length <= 50 && Reflect.ownKeys(input.evidenceIds).length === input.evidenceIds.length + 1
    && input.evidenceIds.every(text) && new Set(input.evidenceIds).size === input.evidenceIds.length
}
function jobFrom(value: unknown): Row | undefined {
  const envelope = record(value), job = record(envelope?.job)
  if (!envelope || !exactKeys(envelope, "job") || !job || !text(job.id) || !isCanonicalJobId(job.id)) return undefined
  return job
}
function safeDigest(value: unknown): string | undefined {
  try { return sha256(canonicalTaskGraphJson(value)) } catch { return undefined }
}
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex") }
function unavailable(proposedCount: number): ObjectiveJobRequirementEvidence { return { status: "unavailable", proposedCount, receipts: [] } }
function exactKeys(value: Row, csv: string): boolean {
  const keys = csv.split(","), actual = Reflect.ownKeys(value)
  return actual.length === keys.length && actual.every(key => typeof key === "string" && keys.includes(key)
    && Boolean(Object.getOwnPropertyDescriptor(value, key)?.enumerable && "value" in Object.getOwnPropertyDescriptor(value, key)!))
}
function record(value: unknown): Row | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null ? value as Row : undefined } catch { return undefined }
}
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.trim() === value }
function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
