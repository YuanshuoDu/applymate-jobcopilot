import { parsePlanRevisionEvent } from "./plan-revision-receipt.js"
import { isPlainJsonObject } from "./goal-plan-contract.js"

const MAX_OBSERVATIONS = 256
const MAX_ID = 256
const MAX_LOCAL_ID = 128
const SIGNAL_KEYS = ["kind", "localId", "status", "dependsOn", "reason", "failedTaskIds"] as const

export type PlanRevisionScopeObservation = { readonly id: string; readonly content: unknown }
export type PlanRevisionScope =
  | { readonly kind: "known"; readonly planCallId: string; readonly planRevision: number }
  | { readonly kind: "unknown" }

function row(value: unknown): Record<string, unknown> | null { return isPlainJsonObject(value) ? value : null }
function id(value: unknown, limit = MAX_ID): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= limit }
function integer(value: unknown, minimum: number): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum }
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key)) }
function strings(value: unknown, limit: number, allowEmpty = false): value is readonly string[] {
  return Array.isArray(value) && (allowEmpty || value.length > 0) && value.length <= 16 && value.every(item => id(item, limit)) && new Set(value).size === value.length
}
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
function sorted(value: readonly string[]): boolean { return value.every((item, index) => index === 0 || compare(value[index - 1]!, item) < 0) }
function canonicalId(value: string): string { return value.startsWith("observation:") ? value.slice("observation:".length) : value }

function projection(observation: PlanRevisionScopeObservation): ReturnType<typeof parsePlanRevisionEvent> | "invalid" | null {
  const content = row(observation.content)
  if (content?.kind !== "plan_revision") return null
  const observationId = canonicalId(observation.id)
  if (!id(observationId) || !observationId.startsWith("plan-revision:")) return "invalid"
  const { kind: _kind, ...metadata } = content
  const parsed = parsePlanRevisionEvent(metadata)
  return parsed && observationId === `plan-revision:${parsed.planCallId}` ? parsed : "invalid"
}

export function resolveLatestAcceptedPlanCallId(observations: readonly PlanRevisionScopeObservation[], expectedGoalRevision: number): PlanRevisionScope {
  if (!Array.isArray(observations) || observations.length > MAX_OBSERVATIONS || !integer(expectedGoalRevision, 1)) return { kind: "unknown" }
  const plans = new Map<string, NonNullable<ReturnType<typeof parsePlanRevisionEvent>>>()
  const revisions = new Map<number, string>()
  for (const observation of observations) {
    if (!observation || typeof observation.id !== "string") return { kind: "unknown" }
    const parsed = projection(observation)
    if (parsed === "invalid") return { kind: "unknown" }
    if (!parsed) continue
    if (parsed.goalRevision > expectedGoalRevision) return { kind: "unknown" }
    if (parsed.goalRevision !== expectedGoalRevision) continue
    if (plans.has(parsed.planCallId) || revisions.has(parsed.planRevision)) return { kind: "unknown" }
    plans.set(parsed.planCallId, parsed)
    revisions.set(parsed.planRevision, parsed.planCallId)
  }
  const ordered = [...plans.values()].sort((left, right) => left.planRevision - right.planRevision)
  let previous: number | null = null
  for (const plan of ordered) {
    if (plan.planRevision !== (previous === null ? 1 : previous + 1) || plan.basedOnPlanRevision !== previous) return { kind: "unknown" }
    previous = plan.planRevision
  }
  const latest = ordered.at(-1)
  return latest ? { kind: "known", planCallId: latest.planCallId, planRevision: latest.planRevision } : { kind: "unknown" }
}

export function replanSignalPlanCallId(observation: PlanRevisionScopeObservation): string | null {
  const content = row(observation.content)
  if (!content || content.kind !== "plan_control" || content.status !== "replan_required" || !exact(content, SIGNAL_KEYS) || content.reason !== "child_failure" || !strings(content.dependsOn, MAX_LOCAL_ID) || !strings(content.failedTaskIds, MAX_ID) || !sorted(content.failedTaskIds)) return null
  const localId = content.localId
  if (!id(localId, MAX_LOCAL_ID) || !localId.endsWith(":replan")) return null
  const observationId = canonicalId(observation.id), prefix = "plan-control:", suffix = `:${localId}`
  if (!observationId.startsWith(prefix) || !observationId.endsWith(suffix)) return null
  const planCallId = observationId.slice(prefix.length, observationId.length - suffix.length)
  return id(planCallId) && observationId === `${prefix}${planCallId}${suffix}` ? planCallId : null
}
