import { Buffer } from "node:buffer"

import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"

import { isPlainJsonObject } from "./goal-plan-contract.js"
import { isBoundedPlanJson } from "./plan-revision-receipt.js"

const MAX_ID_LENGTH = 240
const MAX_RECEIPT_BYTES = 8 * 1024
const RECEIPT_KEYS = ["planCallId", "planRevision", "observationId", "content"] as const

export type PlanCommandReceipt = {
  readonly planCallId: string
  readonly planRevision: number
  readonly observationId: string
  readonly content: RepositoryJsonValue
}
export type PlanCommandReceiptInput = Omit<PlanCommandReceipt, "content"> & { readonly content: unknown }

function validId(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= MAX_ID_LENGTH
}

function validRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
}

export function parsePlanCommandReceipt(value: unknown, expectedPlanCallId?: string, expectedPlanRevision?: number): PlanCommandReceipt | null {
  if (!isPlainJsonObject(value) || !isBoundedPlanJson(value) || Object.keys(value).some(key => !(RECEIPT_KEYS as readonly string[]).includes(key))) return null
  const planCallId = value.planCallId
  const observationId = value.observationId
  if (!validId(planCallId) || (expectedPlanCallId !== undefined && planCallId !== expectedPlanCallId) || !validRevision(value.planRevision) ||
    (expectedPlanRevision !== undefined && value.planRevision !== expectedPlanRevision) || !validId(observationId) || !isPlainJsonObject(value.content) || !isBoundedPlanJson(value.content)) return null
  const encoded = JSON.stringify(value)
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_RECEIPT_BYTES) return null
  return { planCallId, planRevision: value.planRevision, observationId, content: value.content as RepositoryJsonValue }
}

export function createPlanCommandReceipt(input: PlanCommandReceiptInput): PlanCommandReceipt {
  const receipt = parsePlanCommandReceipt(input, input.planCallId, input.planRevision)
  if (!receipt) throw new Error("invalid_plan_command_receipt")
  return receipt
}

export function planCommandObservation(receipt: PlanCommandReceipt): { id: string; content: RepositoryJsonValue } {
  return { id: receipt.observationId, content: receipt.content }
}
