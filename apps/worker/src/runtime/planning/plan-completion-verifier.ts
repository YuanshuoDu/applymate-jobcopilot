import type { StepContextSnapshot } from "../context/step-context-builder.js"
import { isPlainJsonObject } from "./goal-plan-contract.js"

const MAX_LOCAL_ID_LENGTH = 128
const MAX_DEPENDENCIES = 8
const MAX_COMPLETION_CRITERIA = 16
const MAX_CRITERION_LENGTH = 1_000
const MAX_OBSERVATION_BYTES = 8 * 1024
const MAX_CALL_ID_LENGTH = 240

const COMPLETION_KEYS = ["kind", "localId", "status", "dependsOn", "completionCriteria"]
const RESULT_KEYS = ["kind", "localId", "commandKind", "dependsOn", "status", "errorCode", "output"]
const COMMAND_KINDS = new Set(["tool_call", "delegate", "join"])

export const PLAN_COMPLETION_BLOCKER = "Plan completion could not be verified"
export const PLAN_COMPLETION_FEEDBACK = "A server-owned completion proposal with completed dependencies is required."

export type PlanCompletionVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly blocker: string; readonly feedback: string }

export type PlanCompletionVerifierInput =
  | { readonly snapshot: Pick<StepContextSnapshot, "toolObservations">; readonly required?: boolean }
  | { readonly toolObservations: StepContextSnapshot["toolObservations"]; readonly required?: boolean }

type CompletionCandidate = {
  readonly index: number
  readonly id: string
  readonly callId: string
  readonly localId: string
  readonly dependsOn: readonly string[]
  readonly completionCriteria: readonly string[]
}

function failed(): PlanCompletionVerification {
  return { ok: false, blocker: PLAN_COMPLETION_BLOCKER, feedback: PLAN_COMPLETION_FEEDBACK }
}

function row(value: unknown): Record<string, unknown> | null {
  return isPlainJsonObject(value) ? value : null
}

function plainJson(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value !== "object" || seen.has(value)) return false
  if (!Array.isArray(value) && !isPlainJsonObject(value)) return false
  seen.add(value)
  const valid = Object.values(value).every(item => plainJson(item, seen))
  seen.delete(value)
  return valid
}

function boundedJson(value: unknown): boolean {
  if (!plainJson(value)) return false
  try {
    const encoded = JSON.stringify(value)
    return encoded !== undefined && new TextEncoder().encode(encoded).byteLength <= MAX_OBSERVATION_BYTES
  } catch {
    return false
  }
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.every(key => allowed.includes(key)) && required.every(key => Object.prototype.hasOwnProperty.call(value, key))
}

function boundedStrings(value: unknown, maxItems: number, maxLength: number, unique = true): value is readonly string[] {
  if (!Array.isArray(value) || value.length > maxItems) return false
  const result = value.every(item => typeof item === "string" && item.trim() === item && item.length > 0 && item.length <= maxLength)
  return result && (!unique || new Set(value).size === value.length)
}

function callIdFromControlId(value: string, localId: string): string | null {
  const prefix = "plan-control:"
  const suffix = `:${localId}`
  if (!value.startsWith(prefix) || !value.endsWith(suffix) || value.trim() !== value) return null
  const callId = value.slice(prefix.length, value.length - suffix.length)
  return callId.length > 0 && callId.length <= MAX_CALL_ID_LENGTH && callId.trim() === callId ? callId : null
}

function parseCompletionCandidate(index: number, observation: { readonly id: string; readonly content: unknown }): CompletionCandidate | null {
  if (observation.id.length === 0 || observation.id.length > 256 || observation.id.trim() !== observation.id) return null
  const content = row(observation.content)
  if (!content || !exactKeys(content, COMPLETION_KEYS, COMPLETION_KEYS) || content.kind !== "plan_control" || content.status !== "completion_proposed") return null
  if (typeof content.localId !== "string" || content.localId.trim() !== content.localId || content.localId.length === 0 || content.localId.length > MAX_LOCAL_ID_LENGTH) return null
  if (!boundedStrings(content.dependsOn, MAX_DEPENDENCIES, MAX_LOCAL_ID_LENGTH) || !boundedStrings(content.completionCriteria, MAX_COMPLETION_CRITERIA, MAX_CRITERION_LENGTH)) return null
  const callId = callIdFromControlId(observation.id, content.localId)
  if (!callId) return null
  return { index, id: observation.id, callId, localId: content.localId, dependsOn: content.dependsOn, completionCriteria: content.completionCriteria }
}

function validResult(observation: { readonly id: string; readonly content: unknown }, expectedLocalId: string): boolean {
  const content = row(observation.content)
  if (!content || !exactKeys(content, RESULT_KEYS, ["kind", "localId", "commandKind", "dependsOn", "status", "errorCode"])) return false
  if (content.kind !== "plan_command" || content.localId !== expectedLocalId || typeof content.commandKind !== "string" || !COMMAND_KINDS.has(content.commandKind)) return false
  if (!boundedStrings(content.dependsOn, MAX_DEPENDENCIES, MAX_LOCAL_ID_LENGTH) || content.status !== "completed" || content.errorCode !== null) return false
  return !Object.prototype.hasOwnProperty.call(content, "output") || boundedJson(content.output)
}

function observationsFor(input: PlanCompletionVerifierInput): StepContextSnapshot["toolObservations"] {
  return "snapshot" in input ? input.snapshot.toolObservations : input.toolObservations
}

/** Verify only server-owned structural completion evidence; criteria text is never semantically evaluated. */
export function verifyPlanCompletion(input: PlanCompletionVerifierInput): PlanCompletionVerification {
  if (input.required !== true) return { ok: true }
  const observations = observationsFor(input)
  if (!Array.isArray(observations)) return failed()
  const controls: CompletionCandidate[] = []
  for (const [index, observation] of observations.entries()) {
    if (!observation || typeof observation.id !== "string") continue
    const content = row(observation.content)
    if (content?.kind !== "plan_control" || content.status !== "completion_proposed") continue
    const candidate = parseCompletionCandidate(index, observation)
    if (!candidate) return failed()
    controls.push(candidate)
  }
  if (controls.length === 0) return failed()
  const latest = controls[controls.length - 1]!
  if (controls.filter(candidate => candidate.callId === latest.callId).length !== 1) return failed()
  for (const dependency of latest.dependsOn) {
    const expectedId = `plan-result:${latest.callId}:${dependency}`
    const matches = observations.flatMap((observation, index) => observation.id === expectedId ? [{ observation, index }] : [])
    if (matches.length !== 1 || matches[0]!.index >= latest.index || !validResult(matches[0]!.observation, dependency)) return failed()
  }
  return { ok: true }
}

export const verifyPlanCompletionBarrier = verifyPlanCompletion
