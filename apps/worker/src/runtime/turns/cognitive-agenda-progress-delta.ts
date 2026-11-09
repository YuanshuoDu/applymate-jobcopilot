import { parseCognitiveAgendaReceipt, COGNITIVE_AGENDA_RECEIPT_V2_SCHEMA_VERSION,
  buildCognitiveAgendaReceipt, type CognitiveAgendaReceipt, type CognitiveAgendaReceiptScope } from "./cognitive-agenda-receipt.js"
import { type CognitiveActionAgenda } from "./cognitive-action-agenda.js"
import { objectiveProgressSnapshotFromContext, taskGraphObjectiveProgressDelta,
  type ObjectiveProgressDelta, type ObjectiveProgressSnapshot } from "../context/task-graph-objective-progress-delta.js"
import type { StepContext } from "../context/step-context-builder.js"

type Input = Readonly<{
  previousReceipt?: unknown
  scope: Omit<CognitiveAgendaReceiptScope, "stepId">
  currentStepId: string
  goalRevision: string | null
  currentPlanRevision?: number | null
  currentSnapshot: ObjectiveProgressSnapshot | null
}>

/** Compares only one previously validated receipt from the exact same Root Turn lineage. */
export function cognitiveAgendaProgressDelta(input: Input): ObjectiveProgressDelta {
  const value = input.previousReceipt
  const previousStepId = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>).stepId : undefined
  const currentScope = { ...input.scope, stepId: typeof previousStepId === "string" ? previousStepId : "" }
  const previous = parseCognitiveAgendaReceipt(value, currentScope)
  const canCompare = previous?.schemaVersion === COGNITIVE_AGENDA_RECEIPT_V2_SCHEMA_VERSION
    && previous.stepId !== input.currentStepId && previous.goalRevision !== null
    && input.goalRevision !== null && previous.goalRevision === input.goalRevision
    && previous.objectiveProgressSnapshot !== null && previous.objectiveProgressSnapshot.revision !== null
    && input.currentSnapshot !== null && input.currentSnapshot.revision !== null
  const delta = taskGraphObjectiveProgressDelta(canCompare ? previous.objectiveProgressSnapshot : null,
    input.currentSnapshot, canCompare)
  return input.currentSnapshot?.revision === null || input.currentSnapshot === null
    ? { ...delta, currentPlanRevision: input.currentPlanRevision ?? null }
    : delta
}

type ReceiptInput = Readonly<{
  scope: CognitiveAgendaReceiptScope
  rootTaskId: string
  agenda: CognitiveActionAgenda
  context: StepContext
  previousReceipt?: unknown
  objectiveProgressGoalRevision?: () => string | undefined
  inputThroughSequence: bigint
  consumedInputIds: readonly string[]
}>
function digest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) }

/** Builds v2 only for the current Root; other task agendas retain the legacy shape. */
export function buildCognitiveAgendaStepReceipt(input: ReceiptInput): CognitiveAgendaReceipt | null {
  const fence = { inputThroughSequence: input.inputThroughSequence, consumedInputIds: input.consumedInputIds }
  if (input.scope.taskId !== input.rootTaskId) return buildCognitiveAgendaReceipt({ ...input.scope, ...fence, agenda: input.agenda })
  let goalRevision: string | null = null
  try { const value = input.objectiveProgressGoalRevision?.(); goalRevision = digest(value) ? value : null } catch { goalRevision = null }
  const currentSnapshot = objectiveProgressSnapshotFromContext(input.context)
  const progressDelta = cognitiveAgendaProgressDelta({ previousReceipt: input.previousReceipt,
    scope: { sessionId: input.scope.sessionId, turnId: input.scope.turnId, taskId: input.scope.taskId },
    currentStepId: input.scope.stepId, goalRevision, currentPlanRevision: input.agenda.planRevision, currentSnapshot })
  return buildCognitiveAgendaReceipt({ ...input.scope, ...fence, agenda: input.agenda,
    objectiveProgress: { goalRevision, objectiveProgressSnapshot: currentSnapshot, progressDelta } })
}
