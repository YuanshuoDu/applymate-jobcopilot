import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"

import { parsePlanCommandReceipt } from "./planning/plan-command-receipt.js"
import { parsePlanRevisionEvent, parsePlanRevisionReceipt } from "./planning/plan-revision-receipt.js"

type Row = Record<string, unknown>
type Projection = { readonly id: string; readonly content: unknown }
type PlanScope = { readonly goalRevision: number; readonly planRevision: number }

function object(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {}
}

function payload(value: unknown): Row {
  const outer = object(value)
  return object(outer.payload ?? outer)
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256
}

function json(value: unknown): RepositoryJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(json)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined).map(([key, child]) => [key, json(child)]))
  return null
}

function sameScope(left: PlanScope, right: PlanScope): boolean {
  return left.goalRevision === right.goalRevision && left.planRevision === right.planRevision
}

function planScopes(events: readonly Row[]): ReadonlyMap<string, PlanScope> {
  const candidates = new Map<string, PlanScope | null>()
  for (const event of events) {
    const current = payload(event.payload)
    const receipt = event.type === "plan.revision"
      ? parsePlanRevisionEvent(current)
      : event.type === "tool_call.completed" && current.toolName === "agent.plan.propose" && validId(current.toolCallId)
        ? parsePlanRevisionReceipt(current.output, current.toolCallId)
        : null
    if (!receipt) continue
    const scope = { goalRevision: receipt.goalRevision, planRevision: receipt.planRevision }
    const prior = candidates.get(receipt.planCallId)
    if (prior === undefined) candidates.set(receipt.planCallId, scope)
    else if (prior !== null && !sameScope(prior, scope)) candidates.set(receipt.planCallId, null)
  }
  return new Map([...candidates].flatMap(([callId, scope]) => scope === null || scope === undefined ? [] : [[callId, scope] as const]))
}

function waitScopes(events: readonly Row[]): ReadonlyMap<string, PlanScope> {
  const plans = planScopes(events)
  const candidates = new Map<string, PlanScope | null>()
  for (const event of events) {
    if (event.type !== "plan.command") continue
    const receipt = parsePlanCommandReceipt(payload(event.payload))
    if (!receipt) continue
    const scope = plans.get(receipt.planCallId)
    const content = object(receipt.content)
    const output = object(content.output)
    const waitId = output.waitId
    if (!scope || receipt.planRevision !== scope.planRevision || content.kind !== "plan_command" || content.commandKind !== "join" ||
      (output.status !== "waiting" && output.status !== "waiting_for_dependency") || !validId(waitId)) continue
    const prior = candidates.get(waitId)
    if (prior === undefined) candidates.set(waitId, scope)
    else if (prior !== null && !sameScope(prior, scope)) candidates.set(waitId, null)
  }
  return new Map([...candidates].flatMap(([waitId, scope]) => scope === null || scope === undefined ? [] : [[waitId, scope] as const]))
}

/** Adds server-proven plan scope to canonical durable wait projections only. */
export function scopeCanonicalWaitProjections(projections: readonly Projection[], events: readonly Row[]): readonly Projection[] {
  const scopes = waitScopes(events)
  return projections.map(projection => {
    if (!projection.id.startsWith("wait-result:")) return projection
    const waitId = projection.id.slice("wait-result:".length)
    const scope = scopes.get(waitId)
    const content = object(projection.content)
    if (!scope || Object.keys(content).length === 0) return projection
    return { ...projection, content: json({ ...content, goalRevision: scope.goalRevision, planRevision: scope.planRevision }) }
  })
}
