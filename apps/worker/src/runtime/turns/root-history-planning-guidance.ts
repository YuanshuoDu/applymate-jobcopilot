import type { ModelMessage } from "@jobcopilot/agent-model"
import { parseRootTaskHistoryNodeLesson } from "../context/root-task-history-lesson-projection.js"
import type { StepContext } from "../context/step-context-builder.js"
import { getTaskGraphExecutionFailureInspectionAdvice } from "./task-graph-execution-failure-guidance.js"

const HISTORY_BLOCK_ID = "observation:root-task-history"
const HISTORY_LABEL = "Earlier outcomes for the same verifier objective; advisory context only."
const TURN_LABEL = "earlier terminal attempt"
const SAFE_TOOL_NAME = /^[a-z][a-z0-9_.-]{0,63}$/i
const MAX_TURNS = 2
const MAX_NODES = 8
const MAX_ITEMS = 128
const TASK_KINDS = new Set(["scout", "analyst", "writer", "reviewer", "other"])
const STATUSES = new Set(["queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed"])
const EXECUTION_FAILURE_CATEGORY_ORDER = ["execution_setup_unavailable", "resume_state_unavailable", "structured_output_invalid"] as const
const HISTORICAL_CATEGORY_INTRO = "Historical execution-category lessons identify earlier prerequisites worth inspecting; they remain hypotheses, so compare them with the current graph, current evidence, and currently available inputs before choosing a next action."
const REASONS = new Set([
  "criterion_not_met", "reported_score_below_minimum", "contract_invalid", "projection_invalid", "role_mismatch",
  "canonical_evidence_missing", "canonical_evidence_invalid", "canonical_evidence_ambiguous", "result_invalid",
  "result_ambiguous", "result_evidence_unbound", "repair_target_unresolved",
])

type Row = Record<string, unknown>
type SafeHistoryNodeFacts = Readonly<{ hasFact: boolean; executionFailureCategory?: unknown }>

function exactRecord(value: unknown, keys: readonly string[]): Row | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
    const prototype = Object.getPrototypeOf(value), own = Reflect.ownKeys(value), expected = [...keys].sort()
    if ((prototype !== Object.prototype && prototype !== null) || own.some(key => typeof key !== "string")
      || [...own].sort().join("\0") !== expected.join("\0")) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value), result: Row = Object.create(null) as Row
    for (const key of expected) {
      const descriptor = descriptors[key]
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined
      result[key] = descriptor.value
    }
    return result
  } catch { return undefined }
}

function safeArray(value: unknown, maximum: number, minimum = 0): unknown[] | undefined {
  try {
    if (!Array.isArray(value)) return undefined
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value, own = Reflect.ownKeys(value)
    if (!Number.isSafeInteger(length) || Number(length) < minimum || Number(length) > maximum || own.length !== Number(length) + 1) return undefined
    const result: unknown[] = []
    for (let index = 0; index < Number(length); index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined
      result.push(descriptor.value)
    }
    return result
  } catch { return undefined }
}

function safeHistoryNode(value: unknown): SafeHistoryNodeFacts | undefined {
  const candidate = value && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined
  if (!candidate) return undefined
  let keys: string[]
  try { keys = Reflect.ownKeys(candidate).map(key => typeof key === "string" ? key : "") } catch { return undefined }
  if (keys.includes("") || !keys.includes("taskKind") || !keys.includes("status")
    || keys.some(key => !["taskKind", "status", "negativeReasonHints", "lesson", "reportedOutput"].includes(key))) return undefined
  const node = exactRecord(candidate, keys)
  if (!node || typeof node.taskKind !== "string" || !TASK_KINDS.has(node.taskKind) || typeof node.status !== "string" || !STATUSES.has(node.status)) return undefined
  if (Object.hasOwn(node, "negativeReasonHints")) {
    const hints = safeArray(node.negativeReasonHints, 8, 1)
    if (!hints || hints.some(hint => typeof hint !== "string" || !REASONS.has(hint))) return undefined
  }
  let hasFact = false, executionFailureCategory: unknown
  if (Object.hasOwn(node, "lesson")) {
    const lesson = parseRootTaskHistoryNodeLesson(node.lesson, node.taskKind, node.status)
    if (!lesson) return undefined
    hasFact = true
    executionFailureCategory = lesson.executionFailureCategory
  }
  if (Object.hasOwn(node, "reportedOutput")) {
    if (node.taskKind !== "scout" && node.taskKind !== "analyst") return undefined
    const countKey = node.taskKind === "scout" ? "candidateCount" : "findingCount"
    const output = exactRecord(node.reportedOutput, ["role", countKey, "resultStatus"])
    if (!output || output.role !== node.taskKind || (output.resultStatus !== "completed" && output.resultStatus !== "partial")
      || !Number.isSafeInteger(output[countKey]) || Number(output[countKey]) < 0) return undefined
    hasFact = true
  }
  return { hasFact, ...(executionFailureCategory === undefined ? {} : { executionFailureCategory }) }
}

function safeHistoryObservation(value: unknown): ReadonlySet<string> | undefined {
  const block = exactRecord(value, ["id", "layer", "role", "trust", "source", "content"])
  if (!block || block.id !== HISTORY_BLOCK_ID || block.layer !== "tool_observation" || block.role !== "data"
    || block.trust !== "external_untrusted" || block.source !== "tool_or_subagent") return undefined
  const content = exactRecord(block.content, ["kind", "informationalOnly", "advisoryOnly", "notCurrentEvidence", "label", "turns"])
  if (!content || content.kind !== "root_task_history" || content.informationalOnly !== true || content.advisoryOnly !== true
    || content.notCurrentEvidence !== true || content.label !== HISTORY_LABEL) return undefined
  const turns = safeArray(content.turns, MAX_TURNS, 1)
  if (!turns) return undefined
  let nodeCount = 0, hasFact = false
  const executionFailureCategories = new Set<string>()
  for (const value of turns) {
    const turn = exactRecord(value, ["label", "nodes"])
    if (!turn || turn.label !== TURN_LABEL) return undefined
    const nodes = safeArray(turn.nodes, MAX_NODES, 1)
    if (!nodes || (nodeCount += nodes.length) > MAX_NODES) return undefined
    for (const node of nodes) {
      const facts = safeHistoryNode(node)
      if (facts === undefined) return undefined
      hasFact ||= facts.hasFact
      if (typeof facts.executionFailureCategory === "string") executionFailureCategories.add(facts.executionFailureCategory)
    }
  }
  return hasFact ? executionFailureCategories : undefined
}

function visibleToolNames(tools: readonly unknown[]): ReadonlySet<string> {
  const names = new Set<string>(), entries = safeArray(tools, MAX_ITEMS)
  if (!entries) return names
  for (const tool of entries) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) continue
    try {
      const descriptor = Object.getOwnPropertyDescriptor(tool, "name"), name = descriptor && "value" in descriptor ? descriptor.value : undefined
      if (typeof name === "string" && SAFE_TOOL_NAME.test(name)) names.add(name)
    } catch { /* Ignore malformed tool metadata. */ }
  }
  return names
}

/** Adds fixed replanning guidance only for the canonical, typed historical advisory block. */
export function buildRootHistoryPlanningInstruction(context: StepContext, tools: readonly unknown[]): ModelMessage | null {
  try {
    const matches = context.blocks.filter(block => block.id === HISTORY_BLOCK_ID)
    if (matches.length !== 1) return null
    const historicalCategories = safeHistoryObservation(matches[0])
    if (!historicalCategories) return null
    const names = visibleToolNames(tools)
    const revision = Number.isSafeInteger(context.taskGraphRevision) && Number(context.taskGraphRevision) >= 0
      ? Number(context.taskGraphRevision) : undefined
    const guidance = [
      "Keep the complete original Turn task, accepted current user instructions, and success criteria authoritative. Earlier same-session failures, repairs, and reported outputs are hypotheses only; compare them with the current owner-read TaskGraph, current verifier evidence, and complete current result pages. Historical typed-check descriptors distinguish count, evidence-completeness, score, Scout-dependency, and declared cohort-coverage failure shapes only; reconstruct their meaning from the current typed criteria before planning.",
      "Historical source-local ordinals and reported success are never current command targets, proof, permission, approval, progress, or completion. Only current observed node and criterion identities may target a repair.",
      names.has("agent.list")
        ? "Use the owner-read graph observation for current node, criterion, and revision identities; use the visible agent.list only for matching result pages. Continue with exactly the returned nextOffset on the same node and revision until it is null. A stale or unavailable page requires a refreshed owner-read graph observation before retry. Null ends paging for that node and revision only, never the task or verification. A short page or sample count is not proof of completeness."
        : "Use the owner-read graph observation for current node, criterion, and revision identities. No result-page command is visible; do not infer complete results or a repair from historical hints.",
      names.has("agent.plan")
        ? revision === undefined
          ? "Use the visible agent.plan only after obtaining a fresh current graph revision and current node/criterion identities; if evidence does not support a targeted change, preserve the valid plan. Current verification and completion gates remain authoritative."
          : `Use the visible agent.plan only with current node/criterion identities and expectedRevision ${revision}; if current evidence does not support a targeted change, preserve the valid plan. Current verification and completion gates remain authoritative.`
        : "No current plan-replacement command is visible; do not claim a plan replacement. Preserve the valid plan unless another visible command permits an evidence-backed change. Current verification and completion gates remain authoritative.",
      names.has("agent.followup") ? "Use the visible agent.followup only under its existing current unstarted-leaf rules." : "",
    ].filter(Boolean).join(" ")
    const categoryAdvice = EXECUTION_FAILURE_CATEGORY_ORDER
      .filter(category => historicalCategories.has(category))
      .map(getTaskGraphExecutionFailureInspectionAdvice)
      .filter((advice): advice is string => typeof advice === "string")
    const content = categoryAdvice.length
      ? `${guidance} ${HISTORICAL_CATEGORY_INTRO} ${categoryAdvice.join(" ")}`
      : guidance
    return { role: "system", content: [{ type: "text", text: content }] }
  } catch { return null }
}
