import { createHash } from "node:crypto"
import { Buffer } from "node:buffer"
import { createTaskGraphObservedReadEvidenceIndex, hydrateTaskGraphObservedReadEvidence } from "@jobcopilot/shared/task-graph-read-observations"
import { objectiveJobRequirementMaterialDigest, objectiveJobRequirementProposals,
  verifyObjectiveJobRequirementEvidence } from "@jobcopilot/shared/objective-job-requirement-evidence"
import { canonicalTaskGraphReceiptJson } from "@jobcopilot/shared/task-graph-tool-receipt-verification"
import { taskGraphEvidenceDigest, taskGraphResultDigest } from "@jobcopilot/shared/task-graph-verification-digest"
import type { ObjectiveJourneySource } from "./objective-journey-report-source"
import type { ObjectiveJourneyRequirementRead } from "./objective-journey-report-requirement-receipts"

type Row = Record<string, unknown>
type Slot = ObjectiveJourneySource["slots"][number]
type ProofResult = Readonly<{ checked: boolean; hasVerifiedRequirements: boolean }>
const VERIFIER = "agent-harness.v2.task-graph-verifier.v1"
const SHA = /^[a-f0-9]{64}$/
const JOB_KEYS = ["company", "description", "id", "keywords", "location", "role", "salary", "score", "source", "status", "url"]

export function objectiveJourneyAnalystGraphRequirements(value: unknown): Readonly<{
  criteriaIds: readonly string[]; dependencyNodeKeys: readonly string[]; hasScoutMembership: boolean
}> | undefined {
  const verification = record(value), criteria = verification && dense(verification.criteria, 8)
  if (verification?.role !== "analyst" || !criteria?.length) return undefined
  const rows = criteria.map(record)
  if (rows.some(item => !item || typeof item.id !== "string" || !record(item.check))) return undefined
  const checks = rows.map(item => record(item!.check)!)
  return { criteriaIds: rows.map(item => item!.id as string),
    dependencyNodeKeys: [...new Set(checks.flatMap(checkDependencyKeys))].sort(),
    hasScoutMembership: checks.some(check => check.kind === "findings_from_scout_dependency" || check.kind === "findings_from_scout_union") }
}

/** Verifies the private Analyst result, event receipts, candidate binding and current Job before counting coverage. */
export function verifyObjectiveJourneyRequirementProof(source: ObjectiveJourneySource, slot: Slot,
  read: ObjectiveJourneyRequirementRead): ProofResult {
  try {
    const analyst = slot.requirementAnalyst, jobId = slot.jobId, scope = read.scope
    if (!slot.sourceReady || slot.tailoringStatus !== "ready" || !analyst || !jobId || scope.userId !== source.userId
      || scope.sessionId !== source.sessionId || scope.turnId !== source.sourceTurnId || scope.rootTaskId !== source.rootTaskId
      || scope.parentTaskId !== source.rootTaskId || scope.taskId !== analyst.taskId || scope.attemptCount !== analyst.attemptCount
      || read.currentJob.userId !== source.userId) return unchecked()
    const envelope = record(parseJson(read.taskResult)), taskResult = envelope && completedTaskResult(envelope)
    if (!taskResult) return unchecked()
    const result = record(taskResult.structuredResult), report = parsePassedReport(taskResult.taskGraphVerificationReport, analyst)
    if (!result || !report || !resultBoundToObservations(result, read) || taskGraphResultDigest(result) !== report.resultDigest) return unchecked()
    const resultDigest = taskGraphResultDigest(result)
    const evidenceIds = verifiedEvidenceIds(read)
    if (!evidenceIds || taskGraphEvidenceDigest(read.items, read.outcomes, evidenceIds, resultDigest, read.replayReceipts) !== report.evidenceDigest) return unchecked()
    const reportDigest = digest(report), analystProofDigest = digest({ nodeKey: analyst.nodeKey, taskId: analyst.taskId,
      attemptCount: analyst.attemptCount, resultDigest, evidenceDigest: report.evidenceDigest, reportDigest,
      scouts: [...report.dependencyBindings].sort((left, right) => Buffer.compare(Buffer.from(String(left.nodeKey), "utf8"), Buffer.from(String(right.nodeKey), "utf8"))) })
    if (!reportDigest || analystProofDigest !== analyst.proofDigest) return unchecked()
    const job = exactJob(read.currentJob), currentMaterial = job && objectiveJobRequirementMaterialDigest(job)
    if (!job || job.id !== jobId || currentMaterial !== analyst.jobMaterialDigest) return unchecked()
    const proposals = objectiveJobRequirementProposals(result, [jobId])
    if (!proposals) return unchecked()
    const findings = result.findings
    if (!Array.isArray(findings) || !findings.some(value => record(value)?.jobId === jobId)) return unchecked()
    if (proposals.length === 0) return { checked: true, hasVerifiedRequirements: false }
    const deliveries = deliveryCandidates(read)
    if (!deliveries) return unchecked()
    let verified = 0
    for (const proposal of proposals) {
      const proof = verifyObjectiveJobRequirementEvidence({ proposal, attemptCount: analyst.attemptCount, currentJob: job, deliveries })
      if (!proof || proof.jobMaterialDigest !== currentMaterial || proof.inputJobId !== jobId || proof.outputJobId !== jobId) return unchecked()
      verified += 1
    }
    return { checked: true, hasVerifiedRequirements: verified > 0 }
  } catch { return unchecked() }
}

function completedTaskResult(row: Row): Row | undefined {
  return exact(row, "finalItemId,finalText,status,stepCount,taskGraphVerificationReport,toolCallCount,structuredResult")
    && row.status === "completed" && (row.finalItemId === null || text(row.finalItemId)) && typeof row.finalText === "string"
    && integer(row.stepCount, 0) && integer(row.toolCallCount, 0) && Object.hasOwn(row, "structuredResult") ? row : undefined
}

function parsePassedReport(value: unknown, analyst: NonNullable<Slot["requirementAnalyst"]>): Row & { resultDigest: string; evidenceDigest: string;
  dependencyBindings: readonly Row[] } | undefined {
  const row = record(value), criteria = row && dense(row.criteria, 8), bindings = row && dense(row.dependencyBindings, 8)
  if (!row || !exact(row, "criteria,dependencyBindings,evidenceDigest,reasonCode,resultDigest,status,verifierVersion")
    || row.verifierVersion !== VERIFIER || row.status !== "passed" || row.reasonCode !== "criteria_met"
    || typeof row.resultDigest !== "string" || !SHA.test(row.resultDigest) || typeof row.evidenceDigest !== "string" || !SHA.test(row.evidenceDigest)
    || !criteria || criteria.length !== analyst.criteriaIds.length || !bindings || bindings.length !== analyst.dependencyNodeKeys.length
    || !analyst.dependencyNodeKeys.length) return undefined
  if (!criteria.every((value, index) => {
    const item = record(value)
    return !!item && exact(item, "criterionId,reasonCode,status") && item.criterionId === analyst.criteriaIds[index]
      && item.status === "passed" && item.reasonCode === "criteria_met"
  })) return undefined
  const parsedBindings: Row[] = []
  for (let index = 0; index < bindings.length; index += 1) {
    const item = record(bindings[index])
    const expected = analyst.dependencies[index]
    if (!item || !exact(item, "attemptCount,evidenceDigest,nodeDigest,nodeKey,reportDigest,resultDigest,taskId")
      || !expected || item.nodeKey !== expected.nodeKey || item.taskId !== expected.taskId || !text(item.taskId) || !integer(item.attemptCount, 1)
      || ![item.nodeDigest, item.evidenceDigest, item.reportDigest, item.resultDigest].every(value => typeof value === "string" && SHA.test(value))) return undefined
    parsedBindings.push({ nodeKey: item.nodeKey, taskId: item.taskId, attemptCount: item.attemptCount, nodeDigest: item.nodeDigest,
      resultDigest: item.resultDigest, evidenceDigest: item.evidenceDigest, reportDigest: item.reportDigest })
  }
  return { verifierVersion: VERIFIER, status: "passed", reasonCode: "criteria_met", criteria: criteria.map(value => {
    const item = value as Row
    return { criterionId: item.criterionId, status: "passed", reasonCode: "criteria_met" }
  }), evidenceDigest: row.evidenceDigest, resultDigest: row.resultDigest, dependencyBindings: parsedBindings }
}

function verifiedEvidenceIds(read: ObjectiveJourneyRequirementRead): readonly string[] | undefined {
  const index = createTaskGraphObservedReadEvidenceIndex()
  hydrateTaskGraphObservedReadEvidence(index, read.evidenceObservations)
  if (index.conflicts.size || !index.entries.size) return undefined
  const result = record(record(parseJson(read.taskResult))?.structuredResult), evidence = result && dense(result.evidence, 1024)
  if (!evidence) return undefined
  const ids = new Set<string>()
  for (const value of evidence) {
    const item = record(value)
    if (!item || !exact(item, "id,kind,ref,source") || !text(item.id) || !text(item.ref) || !text(item.source)
      || !["job", "persona", "resume", "source"].includes(String(item.kind)) || ids.has(item.id)) return undefined
    const observed = index.entries.get(`${item.kind}\u0000${item.ref}`)
    if (!observed || observed.id !== item.id || observed.source !== item.source) return undefined
    ids.add(item.id)
  }
  return [...index.entries.values()].map(value => value.id)
}

function resultBoundToObservations(result: Row, read: ObjectiveJourneyRequirementRead): boolean {
  const index = createTaskGraphObservedReadEvidenceIndex()
  hydrateTaskGraphObservedReadEvidence(index, read.evidenceObservations)
  if (index.conflicts.size || index.entries.size === 0) return false
  const evidence = dense(result.evidence, 1024)
  return !!evidence && evidence.every(value => {
    const item = record(value)
    if (!item || !text(item.id) || !text(item.ref) || !text(item.source)) return false
    const observed = index.entries.get(`${item.kind}\u0000${item.ref}`)
    return !!observed && observed.id === item.id && observed.source === item.source
  })
}

function deliveryCandidates(read: ObjectiveJourneyRequirementRead): Row[] | undefined {
  const results = new Map<string, Row>()
  for (const value of read.items) if (value.type === "tool_result") {
    const content = record(value.content), callId = content && text(content.toolCallId) ? content.toolCallId : undefined
    if (callId) results.set(callId, value)
  }
  const replayByCall = new Map(read.replayReceipts.map(receipt => [receipt.currentCallId, receipt] as const)), output: Row[] = []
  for (const call of read.items) {
    if (call.type !== "tool_call") continue
    const content = record(call.content)
    if (content?.toolName !== "jobs.get") continue
    const input = record(content.input), result = text(content.toolCallId) ? results.get(content.toolCallId) : undefined
    const resultContent = record(result?.content), outputJob = record(resultContent?.output)?.job
    const inputId = input?.jobId, outputId = record(outputJob)?.id
    if (inputId !== read.currentJob.id && outputId !== read.currentJob.id) continue
    if (!input || !exact(input, "jobId") || !text(input.jobId) || !result || !resultContent || !callContentValid(content)
      || !resultFieldsValid(result, call) || !exact(resultContent, "errorCode,output,status,toolCallId")
      || resultContent.status !== "completed" || resultContent.errorCode !== null
      || resultContent.toolCallId !== content.toolCallId || read.outcomes.get(String(content.toolCallId)) !== "completed") return undefined
    const replay = replayByCall.get(String(content.toolCallId)), rawResult = result as Row, rawResultContent = record(rawResult.content)!
    output.push({ call: { id: call.id, stepId: call.stepId, attempt: call.attempt, ordinal: call.ordinal, revision: call.revision },
      callContent: { toolCallId: content.toolCallId, toolName: content.toolName, toolVersion: content.toolVersion, input,
        status: content.status, errorCode: content.errorCode }, outcome: "completed",
      result: { id: rawResult.id, stepId: rawResult.stepId, attempt: rawResult.attempt, ordinal: rawResult.ordinal, revision: rawResult.revision },
      resultContent: { toolCallId: rawResultContent.toolCallId, output: rawResultContent.output, status: rawResultContent.status,
        errorCode: rawResultContent.errorCode }, replay: replay ? { currentCallId: replay.currentCallId,
          sourceCallItemId: replay.sourceCallItem[0], sourceResultItemId: replay.sourceResultItem[0] } : null })
  }
  return output
}

function exactJob(value: Row): Row | undefined {
  const { userId: _userId, ...job } = value
  return exact(job, JOB_KEYS.join(",")) ? job : undefined
}
function callContentValid(row: Row): boolean { return exact(row, "errorCode,input,status,toolCallId,toolName,toolVersion") }
function resultFieldsValid(row: Row, call: Row): boolean {
  return row.type === "tool_result" && text(row.id) && row.stepId === call.stepId && Number(row.attempt) === Number(call.attempt)
    && Number(row.ordinal) === Number(call.ordinal) && Number.isSafeInteger(row.revision) && !!record(row.content)
}
function exact(row: Row, keys: string): boolean {
  const expected = keys.split(","), actual = Reflect.ownKeys(row)
  return actual.length === expected.length && actual.every(key => typeof key === "string" && expected.includes(key)
    && !!Object.getOwnPropertyDescriptor(row, key)?.enumerable && Object.hasOwn(Object.getOwnPropertyDescriptor(row, key)!, "value"))
}
function record(value: unknown): Row | undefined {
  const parsed = parseJson(value)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  try { const proto = Object.getPrototypeOf(parsed); return proto === Object.prototype || proto === null ? parsed as Row : undefined } catch { return undefined }
}
function parseJson(value: unknown): unknown { if (typeof value !== "string") return value; try { return JSON.parse(value) as unknown } catch { return undefined } }
function dense(value: unknown, max: number): unknown[] | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max
    || Reflect.ownKeys(value).length !== value.length + 1) return undefined
  return Array.from({ length: value.length }, (_, index) => Object.getOwnPropertyDescriptor(value, String(index))?.value)
}
function integer(value: unknown, min: number): boolean { return Number.isSafeInteger(value) && Number(value) >= min }
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.trim() === value }
function digest(value: unknown): string | undefined { try { return createHash("sha256").update(canonicalTaskGraphReceiptJson(value)).digest("hex") } catch { return undefined } }
function unchecked(): ProofResult { return { checked: false, hasVerifiedRequirements: false } }
function checkDependencyKeys(check: Row): readonly string[] {
  if (check.kind === "findings_from_scout_dependency" || check.kind === "findings_cover_scout_candidates_gte")
    return typeof check.dependencyNodeKey === "string" ? [check.dependencyNodeKey] : []
  const multi = ["findings_from_scout_union", "findings_cover_scout_candidate_union_gte", "findings_cover_each_scout_candidates_gte"]
  return multi.includes(String(check.kind)) && dense(check.dependencyNodeKeys, 8)?.every((key): key is string => typeof key === "string")
    ? check.dependencyNodeKeys as string[] : []
}
