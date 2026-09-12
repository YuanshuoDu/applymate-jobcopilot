import { Buffer } from "node:buffer"

import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"

import { PLAN_MAX_REVISIONS, isPlainJsonObject } from "./goal-plan-contract.js"
import { fingerprintPlanProposal, isPlanFingerprint } from "./plan-fingerprint.js"
import { normalizePlanProposal } from "./goal-plan-validator.js"

const MAX_ID_LENGTH = 240
const MAX_RECEIPT_BYTES = 64 * 1024
const OUTPUT_KEYS = ["status", "goalRevision", "planRevision", "basedOnPlanRevision", "proposal", "intents", "proposalHash"] as const
const RECEIPT_KEYS = ["planCallId", "goalRevision", "planRevision", "basedOnPlanRevision", "proposalHash"] as const

export type PlanRevisionReceipt = {
  readonly planCallId: string
  readonly goalRevision: number
  readonly planRevision: number
  readonly basedOnPlanRevision: number | null
  readonly proposalHash?: string
}
export type PlanRevisionReceiptParseOptions = { readonly requireProposalHash?: boolean }

/** Server-owned state supplied only after a persisted receipt has been parsed. */
export type PlanRevisionRecovery = Pick<PlanRevisionReceipt, "goalRevision" | "planRevision" | "basedOnPlanRevision" | "proposalHash">
export type PlanRevisionRecoveryTransition = {
  readonly commit: () => void
  readonly rollback: () => void
}
export type PlanRevisionRecoveryHandler = (receipt: PlanRevisionRecovery) => void | PlanRevisionRecoveryTransition
export type PlanRevisionRecoveryDispatcher = {
  register(handler: PlanRevisionRecoveryHandler): void
  recover(receipt: PlanRevisionRecovery): void
}

export class PlanRevisionRecoveryError extends Error {
  readonly code = "invalid_output" as const

  constructor() {
    super("Plan revision replay recovery is not a contiguous server revision")
    this.name = "PlanRevisionRecoveryError"
  }
}

/**
 * Applies one server-owned replay receipt to a local revision cursor.
 * A receipt already represented by the cursor is idempotent only when its
 * predecessor metadata and known hash agree; every other non-next revision is
 * rejected so a replay gap cannot silently advance local state.
 */
export function recoverPlanRevision(current: number | null, receipt: PlanRevisionRecovery, maxPlanRevisions = PLAN_MAX_REVISIONS): number {
  const basedOn = receipt.basedOnPlanRevision
  if (!validRevision(maxPlanRevisions, 1) || maxPlanRevisions > PLAN_MAX_REVISIONS || (current !== null && (!validRevision(current, 1) || current > maxPlanRevisions)) ||
    !validRevision(receipt.goalRevision, 1) || !validRevision(receipt.planRevision, 1) || receipt.planRevision > maxPlanRevisions ||
    (basedOn !== null && (!validRevision(basedOn, 0) || basedOn >= maxPlanRevisions))) throw new PlanRevisionRecoveryError()
  if (current !== null && receipt.planRevision === current) {
    if (basedOn !== (current === 1 ? null : current - 1)) throw new PlanRevisionRecoveryError()
    return current
  }
  const expected = current === null ? 1 : current + 1
  if (basedOn !== current || receipt.planRevision !== expected) throw new PlanRevisionRecoveryError()
  return receipt.planRevision
}

/**
 * Dispatches replay repairs to the planning state holders created for one runtime.
 * It deliberately carries no model identity, lease, or budget authority.
 */
export function createPlanRevisionRecoveryDispatcher(): PlanRevisionRecoveryDispatcher {
  const handlers = new Set<PlanRevisionRecoveryHandler>()
  return {
    register(handler) {
      if (typeof handler !== "function") throw new TypeError("Plan revision recovery handler must be callable")
      handlers.add(handler)
    },
    recover(receipt) {
      const transitions: PlanRevisionRecoveryTransition[] = []
      let committing: PlanRevisionRecoveryTransition | undefined
      try {
        for (const handler of handlers) {
          const transition = handler(receipt)
          if (transition === undefined) continue
          if (!transition || typeof transition.commit !== "function" || typeof transition.rollback !== "function") throw new PlanRevisionRecoveryError()
          transitions.push(transition)
        }
        for (const transition of transitions) {
          committing = transition
          transition.commit()
        }
      } catch (error: unknown) {
        if (committing) {
          for (const transition of [...transitions].reverse()) {
            try { transition.rollback() } catch { /* keep the original recovery failure */ }
          }
        }
        if (error instanceof PlanRevisionRecoveryError) throw error
        throw new PlanRevisionRecoveryError()
      }
    },
  }
}

export function isBoundedPlanJson(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value !== "object" || seen.has(value)) return false
  if (!Array.isArray(value) && !isPlainJsonObject(value)) return false
  seen.add(value)
  const valid = Object.values(value).every(child => isBoundedPlanJson(child, seen))
  seen.delete(value)
  return valid
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= MAX_ID_LENGTH
}

function validRevision(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
}

function metadata(value: Record<string, unknown>, planCallId: string | undefined): PlanRevisionReceipt | null {
  if (Object.keys(value).some(key => !(RECEIPT_KEYS as readonly string[]).includes(key))) return null
  const id = planCallId ?? value.planCallId
  const basedOn = value.basedOnPlanRevision
  if (!validId(id) || !validRevision(value.goalRevision, 1) || !validRevision(value.planRevision, 1) || value.planRevision > PLAN_MAX_REVISIONS ||
    (basedOn !== null && !validRevision(basedOn, 0)) || value.planRevision !== (basedOn === null ? 1 : basedOn + 1)) return null
  if (basedOn !== null && basedOn >= PLAN_MAX_REVISIONS) return null
  const proposalHash = value.proposalHash
  if (proposalHash !== undefined && !isPlanFingerprint(proposalHash)) return null
  return { planCallId: id, goalRevision: value.goalRevision, planRevision: value.planRevision, basedOnPlanRevision: basedOn as number | null, ...(proposalHash === undefined ? {} : { proposalHash }) }
}

/** Parses the server-shaped output of agent.plan.propose and supplies the call id. */
export function parsePlanRevisionReceipt(value: unknown, planCallId: string, options: PlanRevisionReceiptParseOptions = {}): PlanRevisionReceipt | null {
  if (!isPlainJsonObject(value) || !isBoundedPlanJson(value) || Object.keys(value).some(key => !(OUTPUT_KEYS as readonly string[]).includes(key))) return null
  if (value.status !== "accepted" || !isPlainJsonObject(value.proposal) || !Array.isArray(value.intents) || value.intents.length > 8) return null
  if (options.requireProposalHash && !isPlanFingerprint(value.proposalHash)) return null
  const encoded = JSON.stringify(value)
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_RECEIPT_BYTES) return null
  if (value.proposalHash !== undefined) {
    try {
      const normalized = normalizePlanProposal(value.proposal)
      if (normalized.basedOnGoalRevision !== value.goalRevision || normalized.basedOnPlanRevision !== value.basedOnPlanRevision || fingerprintPlanProposal(normalized) !== value.proposalHash) return null
    } catch { return null }
  }
  return metadata({ goalRevision: value.goalRevision, planRevision: value.planRevision, basedOnPlanRevision: value.basedOnPlanRevision, ...(value.proposalHash === undefined ? {} : { proposalHash: value.proposalHash }) }, planCallId)
}

export function parsePlanRevisionEvent(value: unknown): PlanRevisionReceipt | null {
  if (!isPlainJsonObject(value) || !isBoundedPlanJson(value)) return null
  return metadata(value, undefined)
}

export function planRevisionObservation(receipt: PlanRevisionReceipt): { id: string; content: RepositoryJsonValue } {
  return {
    id: `plan-revision:${receipt.planCallId}`,
    content: { kind: "plan_revision", planCallId: receipt.planCallId, goalRevision: receipt.goalRevision, planRevision: receipt.planRevision, basedOnPlanRevision: receipt.basedOnPlanRevision, ...(receipt.proposalHash === undefined ? {} : { proposalHash: receipt.proposalHash }) },
  }
}

type RevisionEvent = { readonly type: unknown; readonly payload: unknown }

export function restorePlanRevisions(events: readonly RevisionEvent[]): { readonly latest: PlanRevisionReceipt | null; readonly hashes: readonly string[] } {
  let latest: PlanRevisionReceipt | null = null
  const hashes: string[] = []
  for (const event of events) {
    const payload = isPlainJsonObject(event.payload) ? event.payload : {}
    const candidate = event.type === "plan.revision" ? parsePlanRevisionEvent(payload)
      : event.type === "tool_call.completed" && payload.toolName === "agent.plan.propose" && typeof payload.toolCallId === "string"
        ? parsePlanRevisionReceipt(payload.output, payload.toolCallId) : null
    if (!candidate || candidate.planRevision !== (latest ? latest.planRevision + 1 : 1) || candidate.basedOnPlanRevision !== (latest?.planRevision ?? null)) continue
    latest = candidate
    if (candidate.proposalHash && hashes.length < PLAN_MAX_REVISIONS && !hashes.includes(candidate.proposalHash)) hashes.push(candidate.proposalHash)
  }
  return { latest, hashes }
}
