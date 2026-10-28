import {
  parseDiscoveryAttemptHealth, parseDiscoveryAttemptSidecar, type DiscoveryAttemptHealth,
} from "./child-discovery-attempt.js"
import { parseDiscoveryQueryFootprint, type DiscoveryQueryFootprint } from "./child-discovery-query-footprint.js"
import type { TaskGraphVerificationContract } from "../planning/task-graph-verification.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import type { StoredTaskGraphNode } from "./task-graph-snapshot.js"

type DiscoveryAttemptTask = Readonly<{
  status: string
  role: string
  taskType?: string
  expectedOutputSchema?: unknown
  attemptCount?: number
}>
type DiscoveryAttemptNode = Pick<StoredTaskGraphNode,
  "templateId" | "verificationDisposition" | "verification" | "repairOf" | "nativeDelegation" | "registeredScoutEnvelope">
type CurrentNodeGate = Readonly<{
  templateId: string
  status: string
  verification?: TaskGraphVerificationContract
  repairOf?: unknown
  repairReceipt?: unknown
  native: boolean
  nativeResult: boolean
}>
export type TaskGraphDiscoveryTurnEligibility = "ordinary" | "scheduled" | "unknown"

function dataRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null || Reflect.ownKeys(value).length !== keys.length) return null
    const record = value as Record<string, unknown>
    if (!keys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return descriptor?.enumerable && "value" in descriptor
    })) return null
    return Reflect.ownKeys(value).every(key => typeof key === "string" && keys.includes(key)) ? record : null
  } catch { return null }
}

function scoutSchema(value: unknown): boolean {
  let parsed = value
  if (typeof value === "string") {
    try { parsed = JSON.parse(value) as unknown } catch { return false }
  }
  const schema = dataRecord(parsed, ["role", "schemaVersion"])
  return schema?.role === "scout" && schema.schemaVersion === ROLE_RESULT_SCHEMA
}

function dataProperty(value: unknown, key: string): unknown {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor?.enumerable && "value" in descriptor ? descriptor.value : undefined
  } catch { return undefined }
}

/** Projects only a server-authored sidecar for a current ordinary discovery Scout attempt. */
export function projectTaskGraphDiscoveryAttemptHealth(
  node: DiscoveryAttemptNode, task: DiscoveryAttemptTask, result: unknown,
): DiscoveryAttemptHealth | undefined {
  if (!eligibleCurrentScout(node, task)) return undefined
  const sidecar = dataProperty(result, "discoveryAttempt")
  return parseDiscoveryAttemptSidecar(sidecar, task.attemptCount ?? NaN) ?? undefined
}

/** Projects only the separately versioned, current-attempt query observation for an ordinary turn. */
export function projectTaskGraphDiscoveryAttemptQueryFootprint(
  node: DiscoveryAttemptNode, task: DiscoveryAttemptTask, result: unknown, turn: TaskGraphDiscoveryTurnEligibility,
): DiscoveryQueryFootprint | undefined {
  if (turn !== "ordinary" || !eligibleCurrentScout(node, task)) return undefined
  const sidecar = dataRecord(dataProperty(result, "discoveryAttempt"), ["attemptCount", "health", "queryFootprint"])
  if (!sidecar || sidecar.attemptCount !== task.attemptCount
    || !parseDiscoveryAttemptSidecar(sidecar, task.attemptCount ?? NaN)) return undefined
  return parseDiscoveryQueryFootprint(sidecar.queryFootprint) ?? undefined
}

/** Revalidates bounded health before the current graph is placed in Root context. */
export function parseTaskGraphCurrentDiscoveryAttemptHealth(
  row: Record<string, unknown>, gate: CurrentNodeGate,
): DiscoveryAttemptHealth | undefined {
  if (gate.templateId !== "scout" || gate.status !== "completed" && gate.status !== "failed"
    || gate.verification?.role !== "scout" || gate.repairOf || gate.repairReceipt || gate.native || gate.nativeResult) return undefined
  return parseDiscoveryAttemptHealth(dataProperty(row, "discoveryAttemptHealth")) ?? undefined
}

/** Second strict parse before an ordinary current-turn footprint enters the model context. */
export function parseTaskGraphCurrentDiscoveryQueryFootprint(
  row: Record<string, unknown>, gate: CurrentNodeGate, turn: TaskGraphDiscoveryTurnEligibility,
): DiscoveryQueryFootprint | undefined {
  if (turn !== "ordinary" || gate.templateId !== "scout"
    || gate.status !== "completed" && gate.status !== "failed"
    || gate.verification?.role !== "scout" || gate.repairOf || gate.repairReceipt || gate.native || gate.nativeResult) return undefined
  return parseDiscoveryQueryFootprint(dataProperty(row, "discoveryQueryFootprint")) ?? undefined
}

function eligibleCurrentScout(node: DiscoveryAttemptNode, task: DiscoveryAttemptTask): boolean {
  const envelope = node.registeredScoutEnvelope
  if ((task.status !== "completed" && task.status !== "failed") || node.templateId !== "scout"
    || node.verificationDisposition !== "typed" || node.verification?.role !== "scout"
    || node.repairOf || node.nativeDelegation || !envelope || task.role !== "scout"
    || task.taskType !== "job_discovery" || envelope.role !== "scout" || envelope.taskType !== task.taskType
    || !envelope.allowedActions.includes("jobs.discover") || !scoutSchema(envelope.expectedOutputSchema)
    || !scoutSchema(task.expectedOutputSchema)) return false
  return true
}
