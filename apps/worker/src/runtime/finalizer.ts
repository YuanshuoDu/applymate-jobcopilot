import { parseAnswerEvidence, type AnswerEvidence } from "@jobcopilot/agent-protocol"
import type { FinalVerification } from "./verifier.js"
import type { TurnUsage } from "./budget.js"
import { formatTaskGraphFinalSummary } from "./subagents/task-graph-final-summary-format.js"
import { sameTaskGraphFinalSummaryBinding, type TaskGraphFinalSummaryBinding } from "./subagents/task-graph-final-summary-binding.js"
import { buildTaskGraphFinalSourceManifest } from "./subagents/task-graph-final-source-manifest.js"

export type FinalTerminalReason = "goal_satisfied" | "partial_result" | "budget_exhausted" | "no_progress" | "unrecoverable_error" | "final_unverified"

export type FinalResponse = {
  readonly schemaVersion: "agent-harness.v2.final"
  readonly goal: string
  readonly completed: boolean
  readonly completedTasks: readonly string[]
  readonly notCompleted: readonly string[]
  readonly blocker: string | null
  readonly next: readonly string[]
  readonly evidenceRefs: readonly string[]
  readonly response: string
  readonly answerEvidence?: AnswerEvidence
  readonly usage: TurnUsage
  readonly stepCount: number
  readonly toolCallCount: number
  readonly terminalReason: FinalTerminalReason
  readonly summary: string
}

export type FinalizeInput = {
  readonly goal: string
  readonly verification?: FinalVerification
  readonly terminalReason: FinalTerminalReason
  readonly usage: TurnUsage
  readonly stepCount: number
  readonly toolCallCount: number
  readonly blocker?: string | null
  readonly next?: readonly string[]
  readonly response?: string
  readonly answerEvidence?: unknown
  readonly summaryOverride?: string
}

function sorted(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))].sort()
}

export function finalizeTurn(input: FinalizeInput): FinalResponse {
  const verified = input.verification?.ok === true
  const blocker = input.blocker ?? (input.verification?.ok === false ? input.verification.blocker : null)
  const completed = verified && input.terminalReason === "goal_satisfied"
  const evidenceRefs = input.verification?.evidenceRefs ?? []
  const next = sorted(input.next ?? (completed ? [] : ["Resolve the blocker and resume the Turn"]))
  const completedTasks = completed ? ["Turn goal"] : []
  const notCompleted = completed ? [] : [input.goal]
  const summary = input.summaryOverride ?? (completed ? "The Turn goal was completed with verified evidence." : "The Turn did not complete the goal.")
  const answerEvidence = parseAnswerEvidence(input.answerEvidence)
  return {
    schemaVersion: "agent-harness.v2.final", goal: input.goal, completed, completedTasks, notCompleted,
    blocker: blocker ?? null, next, evidenceRefs: sorted(evidenceRefs), response: input.response ?? summary, usage: { ...input.usage },
    ...(answerEvidence ? { answerEvidence } : {}),
    stepCount: input.stepCount, toolCallCount: input.toolCallCount, terminalReason: input.terminalReason, summary,
  }
}

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
export function taskGraphFinalSummaryCopiesMatch(expected: TaskGraphFinalSummaryBinding | undefined, current: TaskGraphFinalSummaryBinding | undefined,
  finalContent: unknown, response: string, finalItemId: string): boolean {
  const content = record(finalContent)
  if (!expected || !current) return expected === undefined && current === undefined
    && !Object.hasOwn(content, "taskGraphSources") && !hasResponseSourceField(content.final) && !hasSerializedSources(response)
  if (!sameTaskGraphFinalSummaryBinding(expected, current)) return false
  let saved: unknown
  try { saved = JSON.parse(response) as unknown } catch { return false }
  let manifest: ReturnType<typeof buildTaskGraphFinalSourceManifest>
  try { manifest = buildTaskGraphFinalSourceManifest(expected, finalItemId) } catch { return false }
  if (hasSerializedSources(response) || hasResponseSourceField(content.final)) return false
  if (manifest ? !sameJson(content.taskGraphSources, manifest) : Object.hasOwn(content, "taskGraphSources")) return false
  const summary = formatTaskGraphFinalSummary(expected.summary)
  return record(saved).summary === summary && record(content.final).summary === summary
}

function hasSerializedSources(response: string): boolean {
  try { return hasResponseSourceField(JSON.parse(response) as unknown) } catch { return false }
}
function hasResponseSourceField(value: unknown): boolean {
  const response = record(value)
  return Object.hasOwn(response, "taskGraphSources") || Object.hasOwn(record(response.answerEvidence), "taskGraphSources")
    || (Array.isArray(response.evidenceRefs) && response.evidenceRefs.some(item => Object.hasOwn(record(item), "taskGraphSources")))
}
function sameJson(left: unknown, right: unknown): boolean {
  try {
    const leftJson = stableJson(left), rightJson = stableJson(right)
    return leftJson !== null && rightJson !== null && leftJson === rightJson
  } catch { return false }
}
function stableJson(value: unknown): string | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : null
  if (Array.isArray(value)) {
    const items = value.map(item => stableJson(item))
    return items.every((item): item is string => item !== null) ? `[${items.join(",")}]` : null
  }
  if (!value || typeof value !== "object" || Object.getOwnPropertySymbols(value).length) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  const keys = Object.keys(value).sort()
  if (keys.some(key => (value as Record<string, unknown>)[key] === undefined)) return null
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key]) ?? "null"}`).join(",")}}`
}

export function serializeFinalResponse(response: FinalResponse): string {
  return JSON.stringify(response)
}
