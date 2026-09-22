import { isPlainJsonObject } from "./goal-plan-contract.js"
import { ROLE_RESULT_SCHEMA } from "../subagents/role-results.js"
import type { DelegateOutputSchemaMarker, ToolRouterContext } from "../tools/types.js"

const IDENTITY_KEYS = new Set(["userId", "sessionId", "turnId", "stepId", "taskId", "parentTaskId", "rootTaskId", "ownerId", "lease", "leaseOwnerId", "leaseVersion", "idempotencyKey", "capabilities", "permissions", "allowedCapabilities", "budgetLimit", "maxBudget"])

export function plainJson(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value !== "object" || seen.has(value)) return false
  if (!Array.isArray(value) && !isPlainJsonObject(value)) return false
  seen.add(value)
  const valid = Object.values(value).every(child => plainJson(child, seen))
  seen.delete(value)
  return valid
}

export function containsIdentityKey(value: unknown, allowed = new Set<string>(), seen = new Set<object>()): boolean {
  if (!value || typeof value !== "object" || seen.has(value)) return false
  if (Array.isArray(value)) { seen.add(value); const found = value.some(item => containsIdentityKey(item, allowed, seen)); seen.delete(value); return found }
  if (!isPlainJsonObject(value)) return false
  if (Object.keys(value).some(key => IDENTITY_KEYS.has(key) && !allowed.has(key))) return true
  seen.add(value); const found = Object.values(value).some(item => containsIdentityKey(item, allowed, seen)); seen.delete(value); return found
}

export function validDelegateOutputSchemaMarker(value: unknown, role: unknown, outputSchemaRef: unknown): value is DelegateOutputSchemaMarker {
  const marker = isPlainJsonObject(value)
  return marker
    && Object.keys(value).length === 2
    && value.schemaVersion === ROLE_RESULT_SCHEMA
    && outputSchemaRef === ROLE_RESULT_SCHEMA
    && (role === "scout" || role === "analyst")
    && value.role === role
}

export function validPlanCommandContext(value: unknown, expectedMarker: DelegateOutputSchemaMarker | undefined, role: unknown, outputSchemaRef: unknown): value is ToolRouterContext {
  const context = isPlainJsonObject(value) ? value : null
  const scope = context && isPlainJsonObject(context.scope) ? context.scope : null
  if (!context || !scope || typeof scope.userId !== "string" || !scope.userId.trim()
    || typeof context.sessionId !== "string" || !context.sessionId.trim()
    || typeof context.turnId !== "string" || !context.turnId.trim()
    || typeof context.stepId !== "string" || !context.stepId.trim()) return false
  return expectedMarker === undefined
    ? context.delegateOutputSchemaMarker === undefined
    : validDelegateOutputSchemaMarker(context.delegateOutputSchemaMarker, role, outputSchemaRef)
}
