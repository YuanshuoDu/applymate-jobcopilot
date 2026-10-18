import { Buffer } from "node:buffer"
import { Value } from "@sinclair/typebox/value"
import { InputContentPartSchema } from "@jobcopilot/agent-protocol"
import { TASK_GRAPH_VERIFICATION_LIMITS } from "../planning/task-graph-verification.js"
import { digestNativeVerificationValue } from "../subagents/native-verification-contract.js"

export type RootTaskObjectiveResolution = Readonly<{
  goal: string | null
  criteria: readonly string[]
  criteriaValid: boolean
  turnGoalConflict: boolean
}>

export type RootTaskVerifierObjective = Readonly<{
  goal: string
  criteria: readonly Readonly<{ criterionId: string; requirement: string }>[]
}>
/** The opt-in is only for native-verifier derivation before its Root row exists; history stays strict. */
export type RootTaskObjectiveOptions = Readonly<{ allowNativeFreshRootFallback?: true }>

export type RootTaskVerificationRequirement = Readonly<{
  id: string
  kind: "candidate_count_gte" | "finding_count_gte"
  minimum: number
}>
export type RootTaskVerificationRequirementsResolution =
  | Readonly<{ status: "absent" }>
  | Readonly<{ status: "valid"; requirements: readonly RootTaskVerificationRequirement[] }>
  | Readonly<{ status: "invalid" }>

type Row = Record<string, unknown>
const MAX_GOAL_BYTES = 4 * 1024
const MAX_CRITERIA = 32
const MAX_CRITERION_BYTES = 2_000
const OBJECTIVE_REQUIREMENTS_SCHEMA_VERSION = "agent-harness.v2.objective-requirements.v1"
const OBJECTIVE_REQUIREMENT_ID = /^[a-z][a-z0-9._-]{0,63}$/

function record(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try { const prototype = Object.getPrototypeOf(parsed); return prototype === Object.prototype || prototype === null ? parsed as Row : null } catch { return null }
}

function cleanText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes
}

function validInputContentParts(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0 && Reflect.ownKeys(value).length === value.length + 1
    && value.every((part, index) => Object.hasOwn(value, index) && Value.Check(InputContentPartSchema, part))
}

function criterionList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_CRITERIA || Reflect.ownKeys(value).length !== value.length + 1) return null
  const output: string[] = []
  for (const item of value) if (!cleanText(item, MAX_CRITERION_BYTES)) return null; else output.push(item)
  return output
}

function canonicalTurnGoal(value: unknown): Readonly<{ value: string | null; valid: boolean }> {
  const envelope = record(value)
  if (!envelope) return { value: null, valid: false }
  const nested = record(envelope.input)
  const source = nested && Object.keys(nested).length > 0 ? nested : envelope
  const hasGoal = Object.hasOwn(source, "goal"), hasContent = Object.hasOwn(source, "content")
  const goal = source.goal, content = source.content
  if (hasGoal && (typeof goal !== "string" || !goal.trim() || !cleanText(goal.trim(), MAX_GOAL_BYTES))) return { value: null, valid: false }
  if (hasContent && (typeof content === "string"
    ? !content.trim() || !cleanText(content.trim(), MAX_GOAL_BYTES)
    : !validInputContentParts(content))) return { value: null, valid: false }
  if (hasGoal && typeof content === "string" && (goal as string).trim() !== content.trim()) return { value: null, valid: false }
  const selected = hasGoal ? goal : typeof content === "string" ? content : undefined
  return typeof selected === "string" ? { value: selected.trim(), valid: true } : { value: null, valid: false }
}

function criteriaField(row: Row | null, key: string): Readonly<{ value: readonly string[]; valid: boolean }> {
  if (!row || !Object.hasOwn(row, key)) return { value: [], valid: true }
  const parsed = criterionList(row[key])
  return parsed ? { value: parsed, valid: true } : { value: [], valid: false }
}

function mergeCriteria(turnCriteria: readonly string[], rootCriteria: readonly string[], goal: string | null): readonly string[] {
  const merged = [...new Set([...turnCriteria, ...rootCriteria])]
  if (merged.length > MAX_CRITERIA) return []
  return merged.length ? merged : goal ? [goal] : []
}

type OwnField = Readonly<{ status: "absent" }> | Readonly<{ status: "present"; value: unknown }> | Readonly<{ status: "invalid" }>

function ownDataField(value: unknown, key: string): OwnField {
  if (!value || typeof value !== "object") return { status: "absent" }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor) return { status: "absent" }
    return "value" in descriptor && descriptor.enumerable
      ? { status: "present", value: descriptor.value }
      : { status: "invalid" }
  } catch { return { status: "invalid" } }
}

function exactRequirementRecord(value: unknown, keys: readonly string[]): Row | null {
  if (!value || typeof value !== "object") return null
  try {
    if (Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    const ownKeys = Reflect.ownKeys(value)
    if ((prototype !== Object.prototype && prototype !== null) || ownKeys.length !== keys.length
      || ownKeys.some(key => typeof key !== "string" || !keys.includes(key))) return null
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<string, PropertyDescriptor>
    const result: Row = Object.create(null) as Row
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null
      result[key] = descriptor.value
    }
    return result
  } catch { return null }
}

function denseRequirementList(value: unknown): unknown[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null
    const keys = Reflect.ownKeys(value)
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<string, PropertyDescriptor>
    const length = descriptors.length?.value
    if (!Number.isSafeInteger(length) || Number(length) < 1 || Number(length) > TASK_GRAPH_VERIFICATION_LIMITS.maxCriteria
      || keys.length !== Number(length) + 1 || keys.some(key => typeof key !== "string"
        || (key !== "length" && (!/^\d+$/.test(key) || Number(key) >= Number(length))))) return null
    const result: unknown[] = []
    for (let index = 0; index < Number(length); index++) {
      const descriptor = descriptors[String(index)]
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null
      result.push(descriptor.value)
    }
    return result
  } catch { return null }
}

function parseObjectiveRequirements(value: unknown): readonly RootTaskVerificationRequirement[] | null {
  const block = exactRequirementRecord(value, ["schemaVersion", "requirements"])
  if (!block || block.schemaVersion !== OBJECTIVE_REQUIREMENTS_SCHEMA_VERSION) return null
  const rows = denseRequirementList(block.requirements)
  if (!rows) return null
  const ids = new Set<string>()
  const result: RootTaskVerificationRequirement[] = []
  for (const row of rows) {
    const entry = exactRequirementRecord(row, ["id", "check"])
    if (!entry || typeof entry.id !== "string" || entry.id.length > TASK_GRAPH_VERIFICATION_LIMITS.maxCriterionIdLength
      || !OBJECTIVE_REQUIREMENT_ID.test(entry.id) || ids.has(entry.id)) return null
    const check = exactRequirementRecord(entry.check, ["kind", "minimum"])
    if (!check || (check.kind !== "candidate_count_gte" && check.kind !== "finding_count_gte")
      || !Number.isSafeInteger(check.minimum) || Number(check.minimum) < 1
      || Number(check.minimum) > TASK_GRAPH_VERIFICATION_LIMITS.maxItems) return null
    ids.add(entry.id)
    result.push({ id: entry.id, kind: check.kind, minimum: Number(check.minimum) })
  }
  return Object.freeze(result)
}

function requirementsEqual(left: readonly RootTaskVerificationRequirement[], right: readonly RootTaskVerificationRequirement[]): boolean {
  const byId = (a: RootTaskVerificationRequirement, b: RootTaskVerificationRequirement) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  const canonicalLeft = [...left].sort(byId), canonicalRight = [...right].sort(byId)
  return canonicalLeft.length === canonicalRight.length && canonicalLeft.every((requirement, index) => {
    const other = canonicalRight[index]
    return requirement.id === other?.id && requirement.kind === other.kind && requirement.minimum === other.minimum
  })
}

/** Resolves only the optional persisted Turn objective block; invalid intent stays distinct from absence. */
export function resolveRootTaskVerificationRequirements(turnInput: unknown): RootTaskVerificationRequirementsResolution {
  const envelope = record(turnInput)
  if (!envelope) {
    if (turnInput !== null && typeof turnInput === "object") return { status: "invalid" }
    const direct = ownDataField(turnInput, "verificationRequirements")
    return direct.status === "absent" ? { status: "absent" } : { status: "invalid" }
  }
  const envelopeField = ownDataField(envelope, "verificationRequirements")
  const nestedInputField = ownDataField(envelope, "input")
  if (envelopeField.status === "invalid" || nestedInputField.status === "invalid") return { status: "invalid" }
  const nested = nestedInputField.status === "present" ? record(nestedInputField.value) : null
  if (nestedInputField.status === "present" && nested === null && nestedInputField.value
    && typeof nestedInputField.value === "object") return { status: "invalid" }
  const nestedField = ownDataField(nested, "verificationRequirements")
  if (nestedField.status === "invalid") return { status: "invalid" }
  const fields = [envelopeField, nestedField].filter((field): field is Extract<OwnField, { status: "present" }> => field.status === "present")
  if (!fields.length) return { status: "absent" }
  const parsed = fields.map(field => parseObjectiveRequirements(field.value))
  if (parsed.some(requirements => requirements === null)) return { status: "invalid" }
  const requirements = parsed[0]
  if (!requirements || parsed.slice(1).some(copy => !copy || !requirementsEqual(requirements, copy))) return { status: "invalid" }
  return { status: "valid", requirements }
}

/** Resolves the frozen Turn objective against its persisted root task without changing verifier policy. */
export function resolveRootTaskObjective(
  turnInput: unknown,
  root?: Readonly<{ goal?: unknown; successCriteria?: unknown }>,
  options: RootTaskObjectiveOptions = {},
): RootTaskObjectiveResolution {
  const input = record(turnInput)
  const nestedInput = record(input?.input)
  const canonicalInput = nestedInput && Object.keys(nestedInput).length > 0 ? nestedInput : input
  const turnGoal = canonicalTurnGoal(turnInput)
  const freshRootFallback = root === undefined && options.allowNativeFreshRootFallback === true
  const rootGoal = root
    ? typeof root.goal === "string" && root.goal.trim() ? root.goal.trim() : null
    : freshRootFallback ? turnGoal.value : null
  const goal = turnGoal.value
  const turnGoalConflict = !turnGoal.valid || !goal || !rootGoal || goal !== rootGoal
  const turnCriteria = criteriaField(canonicalInput, "successCriteria")
  const rootCriteria = root ? criteriaField(record(root), "successCriteria") : { value: [], valid: freshRootFallback }
  const fieldsValid = turnCriteria.valid && rootCriteria.valid
  const criteria = fieldsValid ? mergeCriteria(turnCriteria.value, rootCriteria.value, goal) : []
  return {
    goal,
    criteria,
    criteriaValid: fieldsValid && criteria.length > 0
      && criteria.every(item => Buffer.byteLength(item, "utf8") <= MAX_CRITERION_BYTES),
    turnGoalConflict,
  }
}

/** Digests only the verifier-normalized objective and its ordered criterion-N requirement rows. */
export function rootTaskObjectiveDigest(objective: RootTaskVerifierObjective): string {
  return digestNativeVerificationValue({
    goal: objective.goal,
    criteria: objective.criteria.map(({ criterionId, requirement }) => ({ criterionId, requirement })),
  })
}
