import { projectRootTaskHistory, type ValidatedRootTaskHistoryOutcome } from "./context/root-task-history.js"
import type { DirectRootTaskHistoryLoadInput } from "./context/root-task-history-direct-store.js"
import type { ContextSeedBlock, StepContextSnapshot } from "./context/step-context-builder.js"

export type DirectRootTaskHistoryReader = Readonly<{
  load(input: DirectRootTaskHistoryLoadInput): Promise<readonly ValidatedRootTaskHistoryOutcome[]>
}>

/** Replaces any caller-provided reserved block with history read from the canonical owner-scoped source. */
export async function appendCanonicalRootTaskHistory(input: Readonly<{
  snapshot: StepContextSnapshot
  reader: DirectRootTaskHistoryReader
  request: DirectRootTaskHistoryLoadInput
}>): Promise<StepContextSnapshot> {
  const observations = input.snapshot.toolObservations.filter(item => item.id !== "root-task-history")
  const outcomes = await input.reader.load(input.request)
  const block: ContextSeedBlock | undefined = projectRootTaskHistory(outcomes)
  return block
    ? { ...input.snapshot, toolObservations: [...observations, block] }
    : { ...input.snapshot, toolObservations: observations }
}
