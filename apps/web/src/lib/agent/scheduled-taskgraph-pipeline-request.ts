import { Prisma } from "@prisma/client"
import type { ScheduledTaskGraphRequestOwner } from "./scheduled-taskgraph-audit-action"
import type { ScheduledTaskGraphWaitResult } from "./run-service"
import { parseScheduledTaskGraphActionRequest, type ScheduledTaskGraphActionRequest } from "./scheduled-taskgraph-gate-rpc"
import { parseScheduledAutomationSnapshot } from "./scheduled-automation-snapshot"
import { scheduledTaskGraphOwnerMatches } from "./scheduled-taskgraph-pipeline-fence"
import type { ScheduledTaskGraphPipelineOwner } from "./scheduled-taskgraph-pipeline-checkpoint"
import { AgentExecutionCancelledError } from "./execution-control"

const CLAIM_SCHEMA = "agent-harness.v2.scheduled-pipeline-claim.v1"

export type ScheduledTaskGraphPipelineBody = ScheduledTaskGraphActionRequest & { gateCompletionProof?: unknown }
export type ScheduledTaskGraphStoredExecution = { id: string; status: string; attemptCount: number; state: unknown }
type GateFailurePhase = "owner_assertion" | "gate_execution"
type GateFailureErrorClass = "prisma_known_request_error" | "agent_execution_cancelled" | "type_error" | "range_error" | "syntax_error" | "error" | "non_error"
type GateFailureDiagnostic = Readonly<{ phase: GateFailurePhase; errorClass: GateFailureErrorClass; prismaCode?: string; safeErrorCode?: string }>
const GATE_SAFE_ERROR_CODES = ["scheduled_taskgraph_gate_result_invalid", "application_review_session_scope_required"] as const

export async function parseScheduledTaskGraphPipelineRequest(request: Request): Promise<ScheduledTaskGraphActionRequest | null> {
  return parseScheduledTaskGraphActionRequest(await request.json().catch(() => null))
}

export function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}
export function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value
}
export function safeCount(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 0 }

export function json(status: number, value: unknown, scheduledWaitId?: string): Response {
  const row = record(value)
  return Response.json(scheduledWaitId && row ? { ...row, scheduledWaitId } : value, { status })
}
export function blocked(status: number, errorCode: string, testDiagnostic?: GateFailureDiagnostic): Response {
  return json(status, { status: "blocked", errorCode,
    ...(process.env.NODE_ENV === "test" && testDiagnostic ? { testDiagnostic } : {}) })
}
export function gateFailureDiagnostic(phase: GateFailurePhase, error: unknown): GateFailureDiagnostic {
  const safeErrorCode = error instanceof Error && GATE_SAFE_ERROR_CODES.includes(error.message as typeof GATE_SAFE_ERROR_CODES[number])
    ? error.message as typeof GATE_SAFE_ERROR_CODES[number] : undefined
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const prismaCode = /^P\d{4}$/.test(error.code) ? error.code : undefined
    return { phase, errorClass: "prisma_known_request_error", ...(prismaCode ? { prismaCode } : {}),
      ...(safeErrorCode ? { safeErrorCode } : {}) }
  }
  const errorClass: GateFailureErrorClass = error instanceof AgentExecutionCancelledError ? "agent_execution_cancelled"
    : error instanceof TypeError ? "type_error" : error instanceof RangeError ? "range_error"
      : error instanceof SyntaxError ? "syntax_error" : error instanceof Error ? "error" : "non_error"
  return { phase, errorClass, ...(safeErrorCode ? { safeErrorCode } : {}) }
}
export function completedResponse(report: unknown, waitId: string | undefined, action: string): Response {
  return json(200, { status: "completed", report }, ["execute", "scheduled_audit_execute"].includes(action) ? undefined : waitId)
}

export function matchingTurnSnapshot(value: unknown) {
  const input = record(value)
  if (input?.automationRunMode !== "scheduled") return null
  try { return parseScheduledAutomationSnapshot(input.scheduledAutomationSnapshot) } catch { return null }
}
export function reportLeaseIsCurrent(turn: Record<string, unknown>, owner: ScheduledTaskGraphRequestOwner): boolean {
  if (turn.leaseVersion !== owner.turnLeaseVersion) return false
  if (["in_progress", "waiting_for_user"].includes(String(turn.status)) && turn.leaseOwnerId === owner.turnLeaseOwnerId) {
    const expires = turn.leaseExpiresAt instanceof Date ? turn.leaseExpiresAt.getTime()
      : typeof turn.leaseExpiresAt === "string" ? Date.parse(turn.leaseExpiresAt) : Number.NaN
    return Number.isFinite(expires) && expires > Date.now()
  }
  return ["waiting_for_user", "completed"].includes(String(turn.status))
    && turn.leaseOwnerId === null && turn.leaseExpiresAt === null
}
export function claimLeaseIsActive(state: Record<string, unknown>): boolean {
  const claim = record(state.scheduledTaskGraphClaim), expires = claim?.leaseExpiresAt
  const timestamp = typeof expires === "string" ? Date.parse(expires) : Number.NaN
  return Number.isFinite(timestamp) && timestamp > Date.now()
}
export function claimLeaseIsValidAndExpired(claim: Record<string, unknown>, key: string,
  owner: ScheduledTaskGraphPipelineOwner, now = Date.now()): boolean {
  const fields = ["schemaVersion", "key", "claimToken", "owner", "claimedAt", "leaseExpiresAt"]
  if (Object.keys(claim).length !== fields.length || !fields.every(field => Object.hasOwn(claim, field))
    || claim.schemaVersion !== CLAIM_SCHEMA || claim.key !== key || !validId(claim.claimToken)
    || !scheduledTaskGraphOwnerMatches(claim.owner, owner)) return false
  const claimedAt = typeof claim.claimedAt === "string" ? Date.parse(claim.claimedAt) : Number.NaN
  const expiresAt = typeof claim.leaseExpiresAt === "string" ? Date.parse(claim.leaseExpiresAt) : Number.NaN
  return Number.isFinite(claimedAt) && Number.isFinite(expiresAt) && expiresAt <= now
}
export function scheduledTaskGraphLineageOwnerIsSame(value: unknown, owner: ScheduledTaskGraphPipelineOwner): boolean {
  const row = strictRecord(value)
  return Boolean(row && ["userId", "sessionId", "turnId", "rootTaskId", "rootAttemptCount", "executionId", "executionAttemptCount"]
    .every(key => row[key] === owner[key as keyof ScheduledTaskGraphPipelineOwner]))
}
export function scheduledTaskGraphClaimIsValid(claim: Record<string, unknown> | null, owner: ScheduledTaskGraphPipelineOwner,
  key: string, token: unknown): boolean {
  return Boolean(claim && Object.keys(claim).length === 6 && claim.schemaVersion === CLAIM_SCHEMA && claim.key === key
    && validId(token) && claim.claimToken === token && scheduledTaskGraphLineageOwnerIsSame(claim.owner, owner)
    && typeof claim.claimedAt === "string" && Number.isFinite(Date.parse(claim.claimedAt))
    && typeof claim.leaseExpiresAt === "string" && Number.isFinite(Date.parse(claim.leaseExpiresAt)))
}
export function scheduledTaskGraphRootLeaseIsLive(turn: Readonly<{ status: string; leaseOwnerId: string | null; leaseVersion: number; leaseExpiresAt: Date | null }>,
  owner: Pick<ScheduledTaskGraphPipelineOwner, "turnLeaseOwnerId" | "turnLeaseVersion">): boolean {
  return turn.status === "in_progress" && turn.leaseOwnerId === owner.turnLeaseOwnerId && turn.leaseVersion === owner.turnLeaseVersion
    && turn.leaseExpiresAt instanceof Date && turn.leaseExpiresAt.getTime() > Date.now()
}
function strictRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null
}
export function hasPrepareCheckpoint(state: Record<string, unknown>, key: string, owner: ScheduledTaskGraphPipelineOwner): boolean {
  const marker = record(state.scheduledTaskGraphContinuation)
  return marker?.key === key && scheduledTaskGraphOwnerMatches(marker.owner, owner)
    && typeof state.nextStage === "string" && state.nextStage !== "scout"
}
export function hasMarkerlessScoutState(state: Record<string, unknown>): boolean {
  return state.nextStage === "scout" && state.scheduledTaskGraphContinuation === undefined
    && state.scheduledTaskGraphWait === undefined
}
export function mapCheckpointError(error: unknown): string {
  const reason = record(error)?.reason
  if (reason === "snapshot_mismatch" || reason === "invalid_snapshot") return "scheduled_pipeline_snapshot_mismatch"
  if (reason === "discovery_incomplete") return "scheduled_pipeline_discovery_incomplete"
  if (reason === "owner_mismatch" || reason === "invalid_owner") return "scheduled_pipeline_owner_mismatch"
  return "scheduled_pipeline_attestation_invalid"
}
export function isWaitResult(value: unknown): value is ScheduledTaskGraphWaitResult {
  const row = record(value)
  return row?.status === "waiting_for_user" && typeof row.waitId === "string" && typeof row.stage === "string"
}
