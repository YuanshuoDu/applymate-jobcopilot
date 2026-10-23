import { createHash } from "node:crypto"
import type { ScheduledAutomationPipelineAttestation, ScheduledAutomationPipelineBridgeScope } from "./scheduled-automation-pipeline-bridge.js"
import { parseScheduledGateResult, scheduledGatePreparedJobIds, type ScheduledGateChoiceId, type ScheduledGateCompletionProof,
  type ScheduledGateQuestionKind, type ScheduledGateResult } from "./scheduled-gate-contract.js"
import type { ScheduledPrepareTaskGraphProof } from "./scheduled-prepare-task-graph-verification.js"

const path = "/api/internal/agent-runtime/scheduled-pipeline"
const blockedErrors = new Set(["scheduled_pipeline_owner_mismatch", "scheduled_pipeline_turn_stale", "scheduled_pipeline_mode_mismatch", "scheduled_pipeline_root_mismatch", "scheduled_pipeline_execution_mismatch", "scheduled_pipeline_attestation_invalid", "scheduled_pipeline_snapshot_mismatch", "scheduled_pipeline_discovery_incomplete", "scheduled_pipeline_jobs_mismatch", "scheduled_pipeline_claim_conflict", "scheduled_pipeline_analysis_interrupted", "scheduled_pipeline_request_invalid", "scheduled_pipeline_unauthorized", "scheduled_pipeline_account_unavailable", "scheduled_pipeline_entitlement_required", "scheduled_pipeline_ai_unavailable", "scheduled_pipeline_ai_budget_exhausted"])

export type ScheduledPipelineAnalyzeCheckpointProof = Readonly<{
  status: "analyze_checkpointed"
  continuationKey: string
  checkpointDigest: string
  claimTokenDigest: string
  executionId: string
  executionAttemptCount: number
}>
export type ScheduledPipelineHandoff =
  | { status: "completed" }
  | { status: "waiting_for_user"; waitId: string; waitKind: "external" }
  | { status: "waiting_for_user"; waitId: string; waitKind: "scheduled_prepare"; scheduledWaitId: string }
  | { status: "analyze_checkpointed"; proof: ScheduledPipelineAnalyzeCheckpointProof }
  | { status: "gate_checkpointed" }
  | { status: "blocked"; errorCode: string }
type AnalyzeHandoffInput = { owner: ScheduledAutomationPipelineBridgeScope; attestation: ScheduledAutomationPipelineAttestation }
type PrepareHandoffInput = AnalyzeHandoffInput & { prepareProof: unknown; scheduledWaitId?: string }
type HandoffInput = AnalyzeHandoffInput | PrepareHandoffInput
export type ScheduledPipelineExecuteResult = Readonly<{ status: "completed" | "waiting_for_user" }>
export type ScheduledPipelineGateChoice = Readonly<{ kind: ScheduledGateQuestionKind; jobIds: readonly string[]; choiceId: ScheduledGateChoiceId }>
export type ScheduledPipelineGateInput = Readonly<{
  owner: ScheduledAutomationPipelineBridgeScope
  attestation: ScheduledAutomationPipelineAttestation
  prepareProof: ScheduledPrepareTaskGraphProof
  scheduledWaitId?: string
  gateTaskId: string
  gateLeaseOwnerId: string
  gateAttemptCount: number
  validatedChoice?: ScheduledPipelineGateChoice
  priorChoices?: readonly ScheduledPipelineGateChoice[]
}>
export type ScheduledPipelineGateResponse = ScheduledGateResult | Readonly<{ status: "blocked"; errorCode: string }>
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }

/** Authenticated server-to-server continuation; secrets remain in the header and are never serialized. */
export async function postScheduledPipelineContinuation(input: HandoffInput, signal: AbortSignal, fetcher: typeof fetch = globalThis.fetch): Promise<ScheduledPipelineHandoff> {
  if ("prepareProof" in input && Object.hasOwn(input, "scheduledWaitId") && (typeof input.scheduledWaitId !== "string"
    || input.scheduledWaitId.trim() !== input.scheduledWaitId || input.scheduledWaitId.length < 1 || input.scheduledWaitId.length > 256)) {
    throw new Error("scheduled_pipeline_handoff_input_invalid")
  }
  const base = process.env.AGENT_WEB_URL?.trim() || process.env.WEB_APP_URL?.trim() || process.env.APPLYMATE_WEB_URL?.trim(), secret = process.env.AGENT_WORKER_SECRET?.trim()
  if (!base || !secret || typeof fetcher !== "function") throw new Error("scheduled_pipeline_handoff_unavailable")
  const url = new URL(`${base.replace(/\/$/, "")}${path}`)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("scheduled_pipeline_handoff_unavailable")
  const response = await fetcher(url.toString(), { method: "POST", headers: { "content-type": "application/json", "x-agent-worker-secret": secret }, body: JSON.stringify(input), cache: "no-store", redirect: "error", signal })
  let payload: Record<string, unknown>
  try { payload = record(await response.json()) } catch { throw new Error("scheduled_pipeline_handoff_response_invalid") }
  if (response.status === 200 && payload.status === "completed" && validReport(payload.report)) {
    // The Prepare handoff must stop at the durable Gate checkpoint. Treating a
    // legacy completed report as success here would skip the fixed Gate task.
    if ("prepareProof" in input) return { status: "blocked", errorCode: "scheduled_pipeline_gate_checkpoint_missing" }
    if (!scheduledWaitEchoMatches(input, payload)) return { status: "blocked", errorCode: "scheduled_pipeline_wait_identity_mismatch" }
    return { status: "completed" }
  }
  if (response.status === 200 && payload.status === "gate_checkpointed" && Object.keys(payload).length === 1) {
    return "prepareProof" in input ? { status: "gate_checkpointed" }
      : { status: "blocked", errorCode: "scheduled_pipeline_gate_checkpoint_unexpected" }
  }
  if (response.status === 200 && payload.status === "analyze_checkpointed" && !("prepareProof" in input)) {
    const proof = parseAnalyzeCheckpointProof(payload, input)
    return proof ? { status: "analyze_checkpointed", proof }
      : { status: "blocked", errorCode: "scheduled_pipeline_analyze_checkpoint_invalid" }
  }
  if (response.status === 202 && payload.status === "waiting_for_user" && validWaitId(payload.waitId)) {
    if (!scheduledWaitEchoMatches(input, payload)) {
      return { status: "blocked", errorCode: "scheduled_pipeline_wait_identity_mismatch" }
    }
    return "prepareProof" in input && input.scheduledWaitId !== undefined
      ? { status: "waiting_for_user", waitId: payload.waitId, waitKind: "scheduled_prepare", scheduledWaitId: input.scheduledWaitId }
      : { status: "waiting_for_user", waitId: payload.waitId, waitKind: "external" }
  }
  const errorCode = payload.errorCode
  if (response.status >= 400 && response.status < 500 && payload.status === "blocked" && typeof errorCode === "string" && blockedErrors.has(errorCode)) return { status: "blocked", errorCode }
  throw new Error(response.status === 202 ? "scheduled_pipeline_handoff_in_progress" : "scheduled_pipeline_handoff_retryable")
}

/** Continues only after the canonical Worker Gate completion proof is present. */
export async function postScheduledPipelineExecute(input: Readonly<{
  owner: ScheduledAutomationPipelineBridgeScope
  attestation: ScheduledAutomationPipelineAttestation
  prepareProof: ScheduledPrepareTaskGraphProof
  scheduledWaitId?: string
  gateCompletionProof: ScheduledGateCompletionProof
}>, signal: AbortSignal, fetcher: typeof fetch = globalThis.fetch): Promise<ScheduledPipelineExecuteResult | { status: "blocked"; errorCode: string }> {
  if (input.scheduledWaitId !== undefined && !validWaitId(input.scheduledWaitId)) throw new Error("scheduled_pipeline_handoff_input_invalid")
  const base = process.env.AGENT_WEB_URL?.trim() || process.env.WEB_APP_URL?.trim() || process.env.APPLYMATE_WEB_URL?.trim(), secret = process.env.AGENT_WORKER_SECRET?.trim()
  if (!base || !secret || typeof fetcher !== "function") throw new Error("scheduled_pipeline_handoff_unavailable")
  const url = new URL(`${base.replace(/\/$/, "")}${path}`)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("scheduled_pipeline_handoff_unavailable")
  const body = { action: "execute", ...input }
  const response = await fetcher(url.toString(), { method: "POST", headers: { "content-type": "application/json", "x-agent-worker-secret": secret },
    body: JSON.stringify(body), cache: "no-store", redirect: "error", signal })
  let payload: Record<string, unknown>
  try { payload = record(await response.json()) } catch { throw new Error("scheduled_pipeline_handoff_response_invalid") }
  if (response.status === 200 && payload.status === "completed" && Object.keys(payload).sort().join(",") === "report,status" && validReport(payload.report)) {
    return { status: "completed" }
  }
  if (response.status === 202 && payload.status === "waiting_for_user" && Object.keys(payload).length === 1) return { status: "waiting_for_user" }
  const errorCode = payload.errorCode
  if (response.status >= 400 && response.status < 500 && payload.status === "blocked" && typeof errorCode === "string" && blockedErrors.has(errorCode)) {
    return { status: "blocked", errorCode }
  }
  throw new Error(response.status === 202 ? "scheduled_pipeline_handoff_in_progress" : "scheduled_pipeline_handoff_retryable")
}

/** Invokes the fixed Web Gate action using only the exact child fence and validated choice DTOs. */
export async function postScheduledPipelineGate(input: ScheduledPipelineGateInput, signal: AbortSignal,
  fetcher: typeof fetch = globalThis.fetch): Promise<ScheduledPipelineGateResponse> {
  const expectedJobIds = scheduledGatePreparedJobIds(input.prepareProof)
  const currentChoice = input.validatedChoice && projectGateChoice(input.validatedChoice, expectedJobIds ?? [])
  const priorChoices = input.priorChoices?.map(choice => projectGateChoice(choice, expectedJobIds ?? []))
  if (!validAttestationBinding(input) || !expectedJobIds || !validId(input.gateTaskId) || !validId(input.gateLeaseOwnerId)
    || !Number.isSafeInteger(input.gateAttemptCount) || input.gateAttemptCount < 1
    || input.scheduledWaitId !== undefined && !validWaitId(input.scheduledWaitId)
    || input.validatedChoice !== undefined && !currentChoice || priorChoices?.some(choice => choice === null)) {
    throw new Error("scheduled_pipeline_gate_input_invalid")
  }
  const base = process.env.AGENT_WEB_URL?.trim() || process.env.WEB_APP_URL?.trim() || process.env.APPLYMATE_WEB_URL?.trim()
  const secret = process.env.AGENT_WORKER_SECRET?.trim()
  if (!base || !secret || typeof fetcher !== "function") throw new Error("scheduled_pipeline_handoff_unavailable")
  const url = new URL(`${base.replace(/\/$/, "")}${path}`)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("scheduled_pipeline_handoff_unavailable")
  const body = { action: "gate" as const, owner: input.owner, attestation: input.attestation, prepareProof: input.prepareProof,
    ...(input.scheduledWaitId ? { scheduledWaitId: input.scheduledWaitId } : {}), gateTaskId: input.gateTaskId,
    gateLeaseOwnerId: input.gateLeaseOwnerId, gateAttemptCount: input.gateAttemptCount,
    ...(currentChoice ? { validatedChoice: currentChoice } : {}), ...(priorChoices ? { priorChoices } : {}) }
  const response = await fetcher(url.toString(), { method: "POST", headers: { "content-type": "application/json", "x-agent-worker-secret": secret },
    body: JSON.stringify(body), cache: "no-store", redirect: "error", signal })
  let payload: Record<string, unknown>
  try { payload = record(await response.json()) } catch { throw new Error("scheduled_pipeline_handoff_response_invalid") }
  if (response.status === 200) {
    const result = parseScheduledGateResult(payload, expectedJobIds)
    if (result) return result
    throw new Error("scheduled_pipeline_gate_response_invalid")
  }
  const errorCode = payload.errorCode
  if (response.status >= 400 && response.status < 500 && payload.status === "blocked" && typeof errorCode === "string"
    && (blockedErrors.has(errorCode) || errorCode.startsWith("scheduled_pipeline_gate_"))) return { status: "blocked", errorCode }
  throw new Error(response.status === 202 ? "scheduled_pipeline_handoff_in_progress" : "scheduled_pipeline_handoff_retryable")
}

function projectGateChoice(value: ScheduledPipelineGateChoice, expectedJobIds: readonly string[]): ScheduledPipelineGateChoice | null {
  const row = record(value), keys = ["choiceId", "jobIds", "kind"]
  if (Object.keys(row).sort().join(",") !== keys.join(",") || !Array.isArray(row.jobIds) || row.jobIds.length < 1 || row.jobIds.length > 50
    || row.jobIds.some(id => !validId(id) || !expectedJobIds.includes(id)) || new Set(row.jobIds).size !== row.jobIds.length
    || (row.kind !== "borderline_match" && row.kind !== "weak_cover_letter")) return null
  const choices: Readonly<Record<ScheduledGateQuestionKind, readonly ScheduledGateChoiceId[]>> = {
    borderline_match: ["add_to_pending", "skip", "lower_threshold"], weak_cover_letter: ["continue", "review", "skip"],
  }
  if (!choices[row.kind].includes(row.choiceId as ScheduledGateChoiceId)
    || row.kind === "weak_cover_letter" && row.jobIds.length !== 1) return null
  return { kind: row.kind, jobIds: [...row.jobIds] as string[], choiceId: row.choiceId as ScheduledGateChoiceId }
}

function scheduledWaitEchoMatches(input: HandoffInput, payload: Record<string, unknown>): boolean {
  if (!("prepareProof" in input)) return true
  return input.scheduledWaitId === undefined ? !Object.hasOwn(payload, "scheduledWaitId") : payload.scheduledWaitId === input.scheduledWaitId
}

function validReport(value: unknown): boolean {
  const report = record(value)
  return ["processed", "applied", "queued", "pending", "skipped", "failed", "durationMs"].every(key => Number.isSafeInteger(report[key]) && Number(report[key]) >= 0)
}

function validWaitId(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256
}

function parseAnalyzeCheckpointProof(value: unknown, input: HandoffInput): ScheduledPipelineAnalyzeCheckpointProof | null {
  const proof = record(value)
  if (Object.keys(proof).length !== 6 || !["status", "continuationKey", "checkpointDigest", "claimTokenDigest", "executionId", "executionAttemptCount"].every(key => Object.hasOwn(proof, key))
    || proof.status !== "analyze_checkpointed" || !validId(proof.executionId)
    || !Number.isSafeInteger(proof.executionAttemptCount) || Number(proof.executionAttemptCount) < 0
    || typeof proof.checkpointDigest !== "string" || !/^[a-f0-9]{64}$/.test(proof.checkpointDigest)
    || typeof proof.claimTokenDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(proof.claimTokenDigest)
    || typeof proof.continuationKey !== "string" || !/^scheduled-taskgraph:sha256:[a-f0-9]{64}$/.test(proof.continuationKey)
    || !validAttestationBinding(input)) return null

  const expectedKey = scheduledTaskGraphContinuationKey(input.owner, input.attestation, proof.executionId, Number(proof.executionAttemptCount))
  if (proof.continuationKey !== expectedKey) return null
  return {
    status: "analyze_checkpointed",
    continuationKey: proof.continuationKey,
    checkpointDigest: proof.checkpointDigest,
    claimTokenDigest: proof.claimTokenDigest,
    executionId: proof.executionId,
    executionAttemptCount: Number(proof.executionAttemptCount),
  }
}

function validAttestationBinding(input: HandoffInput): boolean {
  const { owner, attestation } = input
  return attestation.schemaVersion === "agent-harness.v2.scheduled-pipeline-attestation.v1"
    && sameOwner(owner, attestation.owner)
    && validId(attestation.scout.taskId) && validId(attestation.analyst.taskId)
    && Number.isSafeInteger(attestation.scout.attemptCount) && attestation.scout.attemptCount > 0
    && Number.isSafeInteger(attestation.analyst.attemptCount) && attestation.analyst.attemptCount > 0
    && Number.isSafeInteger(attestation.graphRevision) && attestation.graphRevision > 0
    && validId(attestation.scout.discoveryReceipt.taskId)
    && Number.isSafeInteger(attestation.scout.discoveryReceipt.attemptCount) && attestation.scout.discoveryReceipt.attemptCount > 0
    && [attestation.snapshotDigest, attestation.scout.resultDigest, attestation.analyst.resultDigest,
      attestation.evidenceDigest, attestation.scout.discoveryReceipt.receiptDigest].every(value => typeof value === "string" && value.length > 0)
}

function sameOwner(left: ScheduledAutomationPipelineBridgeScope, right: ScheduledAutomationPipelineAttestation["owner"]): boolean {
  return left.userId === right.userId && left.sessionId === right.sessionId && left.turnId === right.turnId
    && left.rootTaskId === right.rootTaskId && left.rootAttemptCount === right.rootAttemptCount
}

export function scheduledTaskGraphContinuationKey(
  owner: ScheduledAutomationPipelineBridgeScope,
  attestation: ScheduledAutomationPipelineAttestation,
  executionId: string,
  executionAttemptCount: number,
): string {
  const receipt = attestation.scout.discoveryReceipt
  const evidence = [owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.rootAttemptCount,
    executionId, executionAttemptCount, attestation.snapshotDigest, attestation.graphRevision,
    attestation.scout.taskId, attestation.scout.attemptCount, attestation.scout.resultDigest,
    attestation.analyst.taskId, attestation.analyst.attemptCount, attestation.analyst.resultDigest,
    attestation.evidenceDigest, receipt.receiptDigest]
  return `scheduled-taskgraph:sha256:${createHash("sha256").update(JSON.stringify(evidence), "utf8").digest("hex")}`
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)
}
