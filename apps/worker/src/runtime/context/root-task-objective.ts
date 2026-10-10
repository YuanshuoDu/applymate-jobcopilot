import { Buffer } from "node:buffer"
import { Value } from "@sinclair/typebox/value"
import { InputContentPartSchema } from "@jobcopilot/agent-protocol"
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

type Row = Record<string, unknown>
const MAX_GOAL_BYTES = 4 * 1024
const MAX_CRITERIA = 32
const MAX_CRITERION_BYTES = 2_000

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

/** Resolves the frozen Turn objective against its persisted root task without changing verifier policy. */
export function resolveRootTaskObjective(
  turnInput: unknown,
  root: Readonly<{ goal?: unknown; successCriteria?: unknown }>,
): RootTaskObjectiveResolution {
  const input = record(turnInput)
  const nestedInput = record(input?.input)
  const canonicalInput = nestedInput && Object.keys(nestedInput).length > 0 ? nestedInput : input
  const turnGoal = canonicalTurnGoal(turnInput)
  const rootGoal = typeof root.goal === "string" && root.goal.trim() ? root.goal.trim() : null
  const goal = turnGoal.value
  const turnGoalConflict = !turnGoal.valid || !goal || !rootGoal || goal !== rootGoal
  const turnCriteria = criteriaField(canonicalInput, "successCriteria")
  const rootCriteria = criteriaField(record(root), "successCriteria")
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
