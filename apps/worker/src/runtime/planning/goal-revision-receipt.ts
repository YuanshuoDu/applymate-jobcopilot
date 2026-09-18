import { Buffer } from "node:buffer"

import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"

import { isPlainJsonObject, MAX_GOAL_REVISIONS, normalizeGoalContract, type GoalContract } from "./goal-plan-contract.js"

const MAX_RECEIPT_BYTES = 64 * 1024
const OUTPUT_KEYS = ["status", "goalRevision", "basedOnGoalRevision", "goalContract"] as const
const EVENT_KEYS = ["goalRevision", "basedOnGoalRevision", "goalContract"] as const

export type GoalRevisionReceipt = {
  readonly goalRevision: number
  readonly basedOnGoalRevision: number
  readonly goalContract: GoalContract
}

function boundedJson(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value !== "object" || seen.has(value)) return false
  if (!Array.isArray(value) && !isPlainJsonObject(value)) return false
  seen.add(value)
  const valid = Object.values(value).every(child => boundedJson(child, seen))
  seen.delete(value)
  return valid
}

function validRevision(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 }

function parseMetadata(value: unknown): GoalRevisionReceipt | null {
  if (!isPlainJsonObject(value) || !boundedJson(value) || !EVENT_KEYS.every(key => Object.prototype.hasOwnProperty.call(value, key)) || Object.keys(value).some(key => !(EVENT_KEYS as readonly string[]).includes(key))) return null
  const goalRevision = value.goalRevision
  const basedOnGoalRevision = value.basedOnGoalRevision
  if (!validRevision(goalRevision) || !validRevision(basedOnGoalRevision) || goalRevision > MAX_GOAL_REVISIONS || basedOnGoalRevision >= MAX_GOAL_REVISIONS || goalRevision !== basedOnGoalRevision + 1) return null
  try {
    const goalContract = normalizeGoalContract(value.goalContract)
    if (goalContract.revision !== goalRevision || goalContract.budgetRef !== "runtime:turn") return null
    const encoded = JSON.stringify(value)
    if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_RECEIPT_BYTES) return null
    return { goalRevision, basedOnGoalRevision, goalContract }
  } catch { return null }
}

export function parseGoalRevisionOutput(value: unknown): GoalRevisionReceipt | null {
  if (!isPlainJsonObject(value) || !Object.prototype.hasOwnProperty.call(value, "status") || Object.keys(value).some(key => !(OUTPUT_KEYS as readonly string[]).includes(key)) || value.status !== "accepted") return null
  return parseMetadata({ goalRevision: value.goalRevision, basedOnGoalRevision: value.basedOnGoalRevision, goalContract: value.goalContract })
}

export function parseGoalRevisionEvent(value: unknown): GoalRevisionReceipt | null { return parseMetadata(value) }

export function goalRevisionObservation(receipt: GoalRevisionReceipt): { id: string; content: RepositoryJsonValue } {
  const contract = { ...receipt.goalContract, constraints: [...receipt.goalContract.constraints], successCriteria: [...receipt.goalContract.successCriteria], knownFacts: [...receipt.goalContract.knownFacts], unresolvedQuestions: [...receipt.goalContract.unresolvedQuestions], approvalBoundaries: [...receipt.goalContract.approvalBoundaries] }
  return { id: `goal-revision:${receipt.goalRevision}`, content: { kind: "goal_revision", goalRevision: receipt.goalRevision, basedOnGoalRevision: receipt.basedOnGoalRevision, goalContract: contract } }
}

type EventRow = { readonly type: unknown; readonly payload: unknown }
function payload(value: unknown): Record<string, unknown> { return isPlainJsonObject(value) ? value : {} }

export function restoreGoalRevisions(initial: GoalContract, events: readonly EventRow[]): { readonly goalContract: GoalContract; readonly receipt: GoalRevisionReceipt | null } {
  let current = initial
  let receipt: GoalRevisionReceipt | null = null
  for (const event of events) {
    if (event.type !== "goal.revision") continue
    const candidate = parseGoalRevisionEvent(payload(event.payload))
    if (!candidate || candidate.basedOnGoalRevision !== current.revision) continue
    current = candidate.goalContract
    receipt = candidate
  }
  return { goalContract: current, receipt }
}

export function filterPlanRevisionEvents(events: readonly EventRow[], goalRevision: number): readonly EventRow[] {
  return events.filter(event => {
    if (event.type !== "plan.revision" && event.type !== "tool_call.completed") return false
    const value = payload(event.payload)
    const candidate = event.type === "plan.revision" ? value : payload(value.output)
    return candidate.goalRevision === goalRevision
  })
}
