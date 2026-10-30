import { types as nodeTypes } from "node:util"
import type { ModelMessage } from "@jobcopilot/agent-model"

import { ROOT_TASK_VERIFICATION_REQUIREMENTS_OBSERVATION_ID } from "../context/root-task-goal-criteria-context.js"
import { TASK_GRAPH_OBJECTIVE_PROGRESS_OBSERVATION_ID } from "../context/task-graph-objective-progress.js"
import type { StepContext } from "../context/step-context-builder.js"
import { TASK_GRAPH_LIMITS } from "../planning/task-graph.js"
import { TASK_GRAPH_VERIFICATION_LIMITS } from "../planning/task-graph-verification.js"

const CURRENT_GRAPH_BLOCK_ID = "observation:task-graph-current"
const OBJECTIVE_REQUIREMENTS_BLOCK_ID = `observation:${ROOT_TASK_VERIFICATION_REQUIREMENTS_OBSERVATION_ID}`
const OBJECTIVE_PROGRESS_BLOCK_ID = `observation:${TASK_GRAPH_OBJECTIVE_PROGRESS_OBSERVATION_ID}`
const OBJECTIVE_PROGRESS_SCHEMA = "agent-harness.v2.objective-progress.v1"
const OBJECTIVE_REQUIREMENT_KINDS = new Set(["candidate_count_gte", "finding_count_gte"])
const OBJECTIVE_PROGRESS_STATUSES = new Set(["missing", "active", "failed", "unverified", "reported_passed", "unknown"])
const SAFE_REQUIREMENT_ID = /^[a-z][a-z0-9._-]{0,63}$/
const MAX_REQUIREMENTS = TASK_GRAPH_VERIFICATION_LIMITS.maxCriteria
const MAX_CONTEXT_BLOCKS = 1_024
const MAX_TOOLS = 128

type Row = Record<string, unknown>
type Requirement = Readonly<{ id: string; kind: string; minimum: number }>

function record(value: unknown): Row | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || nodeTypes.isProxy(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const keys = Reflect.ownKeys(value)
    if (keys.some(key => typeof key !== "string")) return null
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<string, PropertyDescriptor>
    if (keys.some(key => !descriptors[key as string]?.enumerable || !("value" in descriptors[key as string]!))) return null
    return value as Row
  } catch { return null }
}

function field(row: Row | null, key: string): unknown {
  if (!row) return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(row, key)
    return descriptor?.enumerable && "value" in descriptor ? descriptor.value : undefined
  } catch { return undefined }
}

function exactRecord(value: unknown, expectedKeys: readonly string[]): Row | null {
  const row = record(value)
  if (!row) return null
  try {
    const keys = Reflect.ownKeys(row)
    if (keys.length !== expectedKeys.length || keys.some(key => typeof key !== "string" || !expectedKeys.includes(key))) return null
    const output = Object.create(null) as Row
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(row, key)
      if (!descriptor?.enumerable || !("value" in descriptor)) return null
      output[key] = descriptor.value
    }
    return output
  } catch { return null }
}

function denseArray(value: unknown, maximum: number): unknown[] | null {
  try {
    if (!Array.isArray(value) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return null
    const keys = Reflect.ownKeys(value)
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value
    if (!Number.isSafeInteger(length) || Number(length) < 0 || Number(length) > maximum || keys.length !== Number(length) + 1
      || keys.some(key => key !== "length" && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= Number(length)))) return null
    const output: unknown[] = []
    for (let index = 0; index < Number(length); index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor?.enumerable || !("value" in descriptor)) return null
      output.push(descriptor.value)
    }
    return output
  } catch { return null }
}

function uniqueBlock(blocksValue: unknown, id: string): Row | null {
  const blocks = denseArray(blocksValue, MAX_CONTEXT_BLOCKS)
  if (!blocks) return null
  let match: Row | null = null
  for (const value of blocks) {
    const block = record(value)
    if (!block) return null
    if (field(block, "id") !== id) continue
    if (match) return null
    match = block
  }
  return match
}

function observationContent(block: Row | null, id: string): Row | null {
  if (!block || field(block, "id") !== id || field(block, "layer") !== "tool_observation"
    || field(block, "role") !== "data" || field(block, "trust") !== "external_untrusted"
    || field(block, "source") !== "tool_or_subagent") return null
  return record(field(block, "content"))
}

function parseRequirements(value: unknown): Requirement[] | null {
  const rows = denseArray(value, MAX_REQUIREMENTS)
  if (!rows || rows.length === 0) return null
  const seen = new Set<string>()
  const requirements: Requirement[] = []
  for (const value of rows) {
    const row = exactRecord(value, ["id", "kind", "minimum"])
    const id = field(row, "id"), kind = field(row, "kind"), minimum = field(row, "minimum")
    if (typeof id !== "string" || !SAFE_REQUIREMENT_ID.test(id) || SAFE_REQUIREMENT_ID.exec(id)?.[0] !== id || seen.has(id)
      || typeof kind !== "string" || !OBJECTIVE_REQUIREMENT_KINDS.has(kind)
      || !Number.isSafeInteger(minimum) || Number(minimum) < 1 || Number(minimum) > TASK_GRAPH_VERIFICATION_LIMITS.maxItems) return null
    seen.add(id)
    requirements.push({ id, kind, minimum: Number(minimum) })
  }
  return requirements
}

function canonicalRequirements(blocks: unknown): Requirement[] | null {
  const content = observationContent(uniqueBlock(blocks, OBJECTIVE_REQUIREMENTS_BLOCK_ID), OBJECTIVE_REQUIREMENTS_BLOCK_ID)
  if (!content || field(content, "kind") !== "canonical_objective_verification_requirements"
    || field(content, "trust") !== "external_untrusted" || field(content, "source") !== "canonical_turn_objective"
    || field(content, "status") !== "valid") return null
  const keys = Reflect.ownKeys(content)
  if (keys.length !== 5 || keys.some(key => typeof key !== "string"
    || !["kind", "trust", "source", "status", "requirements"].includes(key))) return null
  return parseRequirements(field(content, "requirements"))
}

function hasCurrentGraphRevision(blocks: unknown, revision: number): boolean {
  const content = observationContent(uniqueBlock(blocks, CURRENT_GRAPH_BLOCK_ID), CURRENT_GRAPH_BLOCK_ID)
  if (!content || field(content, "kind") !== "task_graph_current" || field(content, "revision") !== revision) return false
  return denseArray(field(content, "nodes"), TASK_GRAPH_LIMITS.maxNodes) !== null
}

function hasMissingRequirement(blocks: unknown, revision: number, canonical: readonly Requirement[]): boolean {
  const content = observationContent(uniqueBlock(blocks, OBJECTIVE_PROGRESS_BLOCK_ID), OBJECTIVE_PROGRESS_BLOCK_ID)
  if (!content) return false
  const row = exactRecord(content, ["schemaVersion", "advisory", "revision", "requirements"])
  if (!row || field(row, "schemaVersion") !== OBJECTIVE_PROGRESS_SCHEMA || field(row, "advisory") !== true
    || field(row, "revision") !== revision) return false
  const values = denseArray(field(row, "requirements"), MAX_REQUIREMENTS)
  if (!values || values.length !== canonical.length) return false
  const seen = new Set<string>()
  let missing = false
  for (let index = 0; index < values.length; index++) {
    const value = exactRecord(values[index], ["id", "kind", "minimum", "status"])
    const id = field(value, "id"), kind = field(value, "kind"), minimum = field(value, "minimum"), status = field(value, "status")
    const expected = canonical[index]
    if (!expected || id !== expected.id || kind !== expected.kind || minimum !== expected.minimum
      || seen.has(String(id)) || typeof status !== "string" || !OBJECTIVE_PROGRESS_STATUSES.has(status)) return false
    seen.add(String(id))
    if (status === "missing") missing = true
  }
  return missing
}

function visiblePlanningTool(tools: readonly unknown[]): boolean | null {
  const values = denseArray(tools, MAX_TOOLS)
  if (!values) return null
  let visible = false
  for (const value of values) {
    const row = record(value)
    const name = field(row, "name")
    if (typeof name !== "string" || !/^[a-z][a-z0-9_.-]{0,63}$/i.test(name)) return null
    if (name === "agent.plan") visible = true
  }
  return visible
}

/** Guides only the current Root from validated, same-revision missing objective coverage. */
export function buildTaskGraphObjectiveProgressInstruction(
  context: StepContext,
  tools: readonly unknown[],
  isCurrentRootStep: boolean,
): ModelMessage | null {
  const contextRow = record(context)
  const revision = field(contextRow, "taskGraphRevision"), blocks = field(contextRow, "blocks")
  if (field(contextRow, "schemaVersion") !== "agent-harness.v2") return null
  if (!isCurrentRootStep || !Number.isSafeInteger(revision) || Number(revision) < 0
    || !hasCurrentGraphRevision(blocks, Number(revision))) return null
  const canonical = canonicalRequirements(blocks)
  if (!canonical || !hasMissingRequirement(blocks, Number(revision), canonical)) return null
  const planningToolVisible = visiblePlanningTool(tools)
  if (planningToolVisible === null) return null
  const action = planningToolVisible
    ? `Use the request-visible agent.plan tool with expectedRevision ${revision} to propose typed work covering each missing requirement's canonical id, kind, and minimum. If no valid plan can cover it, state the blocker.`
    : "No request-visible agent.plan tool is available; state that missing coverage is blocked and do not claim the requirement is covered or the objective is complete."
  return { role: "system", content: [{ type: "text", text: `Current structured objective progress reports at least one missing requirement. Use the canonical objective-requirements observation and current TaskGraph to identify the missing coverage. ${action} This advisory is not evidence, PASS, permission, or authority; existing server coverage and independent verification gates remain authoritative. Do not alter the original goal or requirements.` }] }
}
