import type pg from "pg"
import { projectRootTaskHistory, type ValidatedRootTaskHistoryOutcome } from "./context/root-task-history.js"
import type { DirectRootTaskHistoryLoadInput } from "./context/root-task-history-direct-store.js"
import type { ContextSeedBlock, StepContextSnapshot } from "./context/step-context-builder.js"
import { parseRootTaskHistoryChronologyXid8 } from "./context/root-task-history-chronology-witness.js"

export type DirectRootTaskHistoryReader = Readonly<{
  load(input: DirectRootTaskHistoryLoadInput): Promise<readonly ValidatedRootTaskHistoryOutcome[]>
  loadWithClient?(client: pg.PoolClient, input: DirectRootTaskHistoryLoadInput): Promise<readonly ValidatedRootTaskHistoryOutcome[]>
}>

/** Replaces any caller-provided reserved block with history read from the canonical owner-scoped source. */
export async function appendCanonicalRootTaskHistory(input: Readonly<{
  snapshot: StepContextSnapshot
  reader: DirectRootTaskHistoryReader
  request: DirectRootTaskHistoryLoadInput
}>): Promise<StepContextSnapshot> {
  const outcomes = await input.reader.load(input.request)
  const crossSessionEnabled = input.request.crossSessionRootTaskHistoryEnabled === true
  return appendCanonicalRootTaskHistoryOutcomes({ snapshot: input.snapshot,
    sameSessionOutcomes: crossSessionEnabled ? outcomes.filter(outcome => outcome.sourceSessionDiffers === false) : outcomes,
    crossSessionOutcomes: crossSessionEnabled ? outcomes.filter(outcome => outcome.sourceSessionDiffers === true) : [],
    crossSessionRootTaskHistoryEnabled: crossSessionEnabled })
}

/** Reprojects same-session and immutable cross-session outcomes together under the shared history bounds. */
export function appendCanonicalRootTaskHistoryOutcomes(input: Readonly<{
  snapshot: StepContextSnapshot
  sameSessionOutcomes: readonly ValidatedRootTaskHistoryOutcome[]
  crossSessionOutcomes?: readonly ValidatedRootTaskHistoryOutcome[]
  crossSessionRootTaskHistoryEnabled?: boolean
}>): StepContextSnapshot {
  const observations = input.snapshot.toolObservations.filter(item => item.id !== "root-task-history")
  const crossSessionEnabled = input.crossSessionRootTaskHistoryEnabled === true
  const cross = input.crossSessionOutcomes ?? []
  const hasVerifiedOrder = [...input.sameSessionOutcomes, ...cross].every(outcome =>
    parseRootTaskHistoryChronologyXid8(outcome.terminalXid8) !== undefined && typeof outcome.terminalWitnessEventId === "string"
      && outcome.terminalWitnessEventId.length > 0)
  const canComposeCrossSession = crossSessionEnabled && cross.length > 0 && hasVerifiedOrder
    && input.sameSessionOutcomes.every(outcome => outcome.sourceSessionDiffers === false)
    && cross.every(outcome => outcome.sourceSessionDiffers === true)
  const outcomes = canComposeCrossSession ? [...input.sameSessionOutcomes, ...cross] : input.sameSessionOutcomes
  const block: ContextSeedBlock | undefined = outcomes.length
    ? projectRootTaskHistory(outcomes, canComposeCrossSession)
    : undefined
  return block
    ? { ...input.snapshot, toolObservations: [...observations, block] }
    : { ...input.snapshot, toolObservations: observations }
}
