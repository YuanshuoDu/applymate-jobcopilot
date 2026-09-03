import type { FinalVerification } from "./verifier.js"
import type { TurnUsage } from "./budget.js"

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
  const summary = completed ? "The Turn goal was completed with verified evidence." : "The Turn did not complete the goal."
  return {
    schemaVersion: "agent-harness.v2.final", goal: input.goal, completed, completedTasks, notCompleted,
    blocker: blocker ?? null, next, evidenceRefs: sorted(evidenceRefs), response: input.response ?? summary, usage: { ...input.usage },
    stepCount: input.stepCount, toolCallCount: input.toolCallCount, terminalReason: input.terminalReason, summary,
  }
}

export function serializeFinalResponse(response: FinalResponse): string {
  return JSON.stringify(response)
}
