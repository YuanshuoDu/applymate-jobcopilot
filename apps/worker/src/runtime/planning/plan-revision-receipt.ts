import { Buffer } from "node:buffer"

import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"

import { isPlainJsonObject } from "./goal-plan-contract.js"

const MAX_ID_LENGTH = 240
const MAX_RECEIPT_BYTES = 64 * 1024
const OUTPUT_KEYS = ["status", "goalRevision", "planRevision", "basedOnPlanRevision", "proposal", "intents"] as const
const RECEIPT_KEYS = ["planCallId", "goalRevision", "planRevision", "basedOnPlanRevision"] as const

export type PlanRevisionReceipt = {
  readonly planCallId: string
  readonly goalRevision: number
  readonly planRevision: number
  readonly basedOnPlanRevision: number | null
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
  if (!validId(id) || !validRevision(value.goalRevision, 1) || !validRevision(value.planRevision, 1) ||
    (basedOn !== null && !validRevision(basedOn, 0)) || value.planRevision !== (basedOn === null ? 1 : basedOn + 1)) return null
  return { planCallId: id, goalRevision: value.goalRevision, planRevision: value.planRevision, basedOnPlanRevision: basedOn as number | null }
}

/** Parses the server-shaped output of agent.plan.propose and supplies the call id. */
export function parsePlanRevisionReceipt(value: unknown, planCallId: string): PlanRevisionReceipt | null {
  if (!isPlainJsonObject(value) || !isBoundedPlanJson(value) || Object.keys(value).some(key => !(OUTPUT_KEYS as readonly string[]).includes(key))) return null
  if (value.status !== "accepted" || !isPlainJsonObject(value.proposal) || !Array.isArray(value.intents) || value.intents.length > 8) return null
  const encoded = JSON.stringify(value)
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_RECEIPT_BYTES) return null
  return metadata({ goalRevision: value.goalRevision, planRevision: value.planRevision, basedOnPlanRevision: value.basedOnPlanRevision }, planCallId)
}

export function parsePlanRevisionEvent(value: unknown): PlanRevisionReceipt | null {
  if (!isPlainJsonObject(value) || !isBoundedPlanJson(value)) return null
  return metadata(value, undefined)
}

export function planRevisionObservation(receipt: PlanRevisionReceipt): { id: string; content: RepositoryJsonValue } {
  return {
    id: `plan-revision:${receipt.planCallId}`,
    content: { kind: "plan_revision", planCallId: receipt.planCallId, goalRevision: receipt.goalRevision, planRevision: receipt.planRevision, basedOnPlanRevision: receipt.basedOnPlanRevision },
  }
}
