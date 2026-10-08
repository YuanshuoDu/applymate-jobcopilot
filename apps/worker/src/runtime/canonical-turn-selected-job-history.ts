import { projectSelectedJobHistory, type ValidatedSelectedJobHistory } from "./context/selected-job-history.js"
import type { SelectedJobMemoryRecord } from "./context/selected-job-memory.js"
import type { SelectedJobHistoryLoadInput } from "./context/selected-job-history-store.js"
import type { StepContextSnapshot, ContextSeedBlock } from "./context/step-context-builder.js"
import type { TurnLease } from "./turns/lease.js"

export type SelectedJobHistoryReader = Readonly<{
  load(input: SelectedJobHistoryLoadInput): Promise<readonly ValidatedSelectedJobHistory[]>
}>

export async function appendCanonicalSelectedJobHistory(input: {
  readonly snapshot: StepContextSnapshot
  readonly reader: SelectedJobHistoryReader
  readonly lease: TurnLease
  readonly rootTaskId: string
  readonly rootAttemptCount: number
  readonly stepId: string
  readonly jobId?: string
  readonly records: readonly SelectedJobMemoryRecord[]
  readonly now: Date
}): Promise<StepContextSnapshot> {
  const observations = input.snapshot.toolObservations.filter(item => item.id !== "selected-job-history")
  if (!input.jobId) return { ...input.snapshot, toolObservations: observations }
  const validated = await input.reader.load({
    lease: input.lease, rootTaskId: input.rootTaskId, rootAttemptCount: input.rootAttemptCount,
    stepId: input.stepId, jobId: input.jobId, records: input.records, now: input.now,
  })
  const block: ContextSeedBlock | undefined = projectSelectedJobHistory(validated)
  return block
    ? { ...input.snapshot, toolObservations: [...observations, block] }
    : { ...input.snapshot, toolObservations: observations }
}
