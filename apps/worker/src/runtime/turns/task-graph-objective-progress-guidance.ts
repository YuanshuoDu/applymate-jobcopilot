import { types as nodeTypes } from "node:util"
import type { ModelMessage } from "@jobcopilot/agent-model"
import { normalizeAgentLocationAllowlist } from "@jobcopilot/shared"

import type { RootTaskVerificationRequirement } from "../context/root-task-objective.js"
import { ROOT_TASK_VERIFICATION_REQUIREMENTS_OBSERVATION_ID } from "../context/root-task-goal-criteria-context.js"
import { TASK_GRAPH_OBJECTIVE_PROGRESS_OBSERVATION_ID } from "../context/task-graph-objective-progress.js"
import type { StepContext } from "../context/step-context-builder.js"
import { TASK_GRAPH_LIMITS } from "../planning/task-graph.js"
import { TASK_GRAPH_VERIFICATION_LIMITS } from "../planning/task-graph-verification.js"

const CURRENT_GRAPH_BLOCK_ID = "observation:task-graph-current"
const OBJECTIVE_REQUIREMENTS_BLOCK_ID = `observation:${ROOT_TASK_VERIFICATION_REQUIREMENTS_OBSERVATION_ID}`
const OBJECTIVE_PROGRESS_BLOCK_ID = `observation:${TASK_GRAPH_OBJECTIVE_PROGRESS_OBSERVATION_ID}`
const OBJECTIVE_PROGRESS_SCHEMA = "agent-harness.v2.objective-progress.v1"
const OBJECTIVE_PROGRESS_STATUSES = new Set(["missing", "active", "failed", "unverified", "reported_passed", "unknown"])
const SAFE_REQUIREMENT_ID = /^[a-z][a-z0-9._-]{0,63}$/
const MAX_REQUIREMENTS = TASK_GRAPH_VERIFICATION_LIMITS.maxCriteria
const MAX_LOCATIONS = 8
const MAX_CONTEXT_BLOCKS = 1_024
const MAX_TOOLS = 128

type Row = Record<string, unknown>

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
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value
    if (!Number.isSafeInteger(length) || Number(length) < 0 || Number(length) > maximum) return null
    const keys = Reflect.ownKeys(value)
    if (keys.length !== Number(length) + 1
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

function sameLocations(expected: readonly string[], actual: readonly unknown[]): boolean {
  return expected.length === actual.length && expected.every((location, index) => location === actual[index])
}

function canonicalLocations(value: unknown): readonly string[] | null {
  const items = denseArray(value, MAX_LOCATIONS)
  if (!items || items.some(item => typeof item !== "string" || item.length > 128)) return null
  const normalized = normalizeAgentLocationAllowlist(items)
  // Producers already canonicalize these lists. A change during normalization invalidates the packet.
  return normalized && sameLocations(normalized, items) ? normalized : null
}

function parseRequirements(value: unknown): RootTaskVerificationRequirement[] | null {
  const rows = denseArray(value, MAX_REQUIREMENTS)
  if (!rows || rows.length === 0) return null
  const seen = new Set<string>()
  const requirements: RootTaskVerificationRequirement[] = []
  for (const value of rows) {
    const kind = field(record(value), "kind")
    const row = exactRecord(value, ["id", "kind", kind === "candidate_location_in" ? "locations" : "minimum"])
    const id = field(row, "id")
    if (!row || typeof id !== "string" || SAFE_REQUIREMENT_ID.exec(id)?.[0] !== id || seen.has(id)) return null
    if (kind === "candidate_location_in") {
      const locations = canonicalLocations(row.locations)
      if (!locations) return null
      requirements.push({ id, kind, locations })
    } else {
      const minimum = row.minimum
      if ((kind !== "candidate_count_gte" && kind !== "finding_count_gte") || typeof minimum !== "number"
        || !Number.isSafeInteger(minimum) || minimum < 1 || minimum > TASK_GRAPH_VERIFICATION_LIMITS.maxItems) return null
      requirements.push({ id, kind, minimum })
    }
    seen.add(id)
  }
  return requirements
}

function canonicalRequirements(blocks: unknown): RootTaskVerificationRequirement[] | null {
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
  return denseArray(field(content, "nodes"), TASK_GRAPH_LIMITS.maxPersistedNodes) !== null
}

type ObjectiveProgressCoverage = Readonly<{ missing: boolean; unknown: boolean }>

function readObjectiveProgressCoverage(
  blocks: unknown,
  revision: number,
  canonical: readonly RootTaskVerificationRequirement[],
): ObjectiveProgressCoverage | null {
  const content = observationContent(uniqueBlock(blocks, OBJECTIVE_PROGRESS_BLOCK_ID), OBJECTIVE_PROGRESS_BLOCK_ID)
  if (!content) return null
  const row = exactRecord(content, ["schemaVersion", "advisory", "revision", "requirements"])
  if (!row || field(row, "schemaVersion") !== OBJECTIVE_PROGRESS_SCHEMA || field(row, "advisory") !== true
    || field(row, "revision") !== revision) return null
  const values = denseArray(field(row, "requirements"), MAX_REQUIREMENTS)
  if (!values || values.length !== canonical.length) return null
  let missing = false
  let unknown = false
  for (const [index, expected] of canonical.entries()) {
    const constraint = expected.kind === "candidate_location_in" ? "locations" : "minimum"
    const value = exactRecord(values[index], ["id", "kind", constraint, "status"])
    if (!value || value.id !== expected.id || value.kind !== expected.kind
      || typeof value.status !== "string" || !OBJECTIVE_PROGRESS_STATUSES.has(value.status)) return null
    if (expected.kind === "candidate_location_in") {
      const locations = denseArray(value.locations, MAX_LOCATIONS)
      if (!locations || !sameLocations(expected.locations, locations)) return null
    } else if (value.minimum !== expected.minimum) return null
    if (value.status === "missing") missing = true
    if (value.status === "unknown") unknown = true
  }
  return { missing, unknown }
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

/** Guides only the current Root from validated, same-revision missing or unknown objective coverage. */
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
  const coverageState = canonical ? readObjectiveProgressCoverage(blocks, Number(revision), canonical) : null
  if (!canonical || !coverageState || (!coverageState.missing && !coverageState.unknown)) return null
  const planningToolVisible = visiblePlanningTool(tools)
  if (planningToolVisible === null) return null
  const missingCoverage = canonical.some(requirement => requirement.kind === "candidate_location_in")
    ? "each missing requirement by its canonical id, kind, and typed constraint. Preserve numeric minimums and include each exact canonical location constraint on every Scout"
    : "each missing requirement's canonical id, kind, and minimum"
  let state = ""
  if (coverageState.missing && coverageState.unknown) {
    state = "Current structured objective progress reports both missing coverage and unresolved evidence. Missing means absent coverage; unknown means unresolved evidence, not absent work or success. Use the canonical objective-requirements observation and current TaskGraph to identify missing coverage, then recheck exact evidence and preserve any work that remains valid."
  } else if (coverageState.unknown) {
    state = "Current structured objective progress reports unresolved evidence. Recheck exact coverage against the current owner-read TaskGraph and established verification evidence, and preserve any work that remains valid. Unknown coverage is not absent work or success."
  } else {
    state = "Current structured objective progress reports at least one missing requirement. Use the canonical objective-requirements observation and current TaskGraph to identify the missing coverage."
  }
  let action = ""
  if (coverageState.missing) {
    action = planningToolVisible
      ? `Use the request-visible agent.plan tool with expectedRevision ${revision} to propose typed work covering ${missingCoverage}. If no valid plan can cover it, state the blocker.`
      : "No request-visible agent.plan tool is available; state that missing coverage is blocked and do not claim the requirement is covered or the objective is complete."
  }
  if (coverageState.unknown) {
    const unknownAction = planningToolVisible
      ? `Only after inspection, use the request-visible agent.plan tool with expectedRevision ${revision} for necessary typed changes to resolve the unknown coverage; preserve valid existing work and do not add work solely because evidence is unknown. If no evidence-backed change is justified, preserve the current graph.`
      : "No request-visible agent.plan tool is available; state the uncertainty or seek bounded clarification through the existing request-visible agent.ask_user tool when available. Do not invent coverage or claim the objective is complete."
    action = action ? `${action} ${unknownAction}` : unknownAction
  }
  return { role: "system", content: [{ type: "text", text: `${state} ${action} This advisory is not evidence, PASS, permission, or authority; existing server coverage and independent verification gates remain authoritative. Do not alter the original goal or requirements.` }] }
}
