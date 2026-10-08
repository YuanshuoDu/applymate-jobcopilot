import type { StepContext, StepContextSnapshot } from "./context/step-context-builder.js"
import { stableJson } from "./turns/turn-engine-replay.js"
import type { TurnEngineToolCall } from "./turns/turn-engine-types.js"

export type ProgressObservation = {
  readonly signature: string
  readonly stateFingerprint: string
}

export type ProgressCheckpoint = Readonly<{
  inputThroughSequence: bigint
  consumedInputIds: readonly string[]
  taskGraphRevision?: number
}>

export function progressCheckpointFromStepContext(context: Pick<StepContext, "inputThroughSequence" | "consumedInputIds" | "taskGraphRevision">): ProgressCheckpoint {
  return { inputThroughSequence: context.inputThroughSequence, consumedInputIds: context.consumedInputIds,
    ...(context.taskGraphRevision === undefined ? {} : { taskGraphRevision: context.taskGraphRevision }) }
}

export class NoProgressError extends Error {
  readonly code = "no_progress" as const
  readonly reasonCode = "repeated_signature" as const

  constructor(readonly observation: ProgressObservation) {
    super(`Turn made no progress: repeated ${observation.signature}`)
    this.name = "NoProgressError"
  }
}

export type ProgressDetector = {
  observe(input: { snapshot: StepContextSnapshot; toolCalls: readonly TurnEngineToolCall[] }, checkpoint?: ProgressCheckpoint): ProgressObservation
}

type EffectiveCheckpoint = {
  inputThroughSequence: bigint
  consumedInputIds: Set<string>
  taskGraphRevision?: number
}

function parseCheckpoint(value: unknown): EffectiveCheckpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const keys = Reflect.ownKeys(record)
  if (keys.some(key => typeof key !== "string" || !["inputThroughSequence", "consumedInputIds", "taskGraphRevision"].includes(key))
    || typeof record.inputThroughSequence !== "bigint" || record.inputThroughSequence < 0n
    || !Array.isArray(record.consumedInputIds)) return null
  const ids = record.consumedInputIds as unknown[]
  const uniqueIds = new Set<string>()
  for (const id of ids) {
    if (typeof id !== "string" || id.length === 0 || uniqueIds.has(id)) return null
    uniqueIds.add(id)
  }
  const hasRevision = Object.hasOwn(record, "taskGraphRevision")
  if (hasRevision && (typeof record.taskGraphRevision !== "number" || !Number.isSafeInteger(record.taskGraphRevision) || record.taskGraphRevision < 0)) return null
  return {
    inputThroughSequence: record.inputThroughSequence,
    consumedInputIds: uniqueIds,
    ...(hasRevision ? { taskGraphRevision: record.taskGraphRevision as number } : {}),
  }
}

function advanceCheckpoint(current: EffectiveCheckpoint | undefined, next: EffectiveCheckpoint): { checkpoint: EffectiveCheckpoint; advanced: boolean } {
  if (!current) return { checkpoint: next, advanced: false }
  const sequenceAdvanced = next.inputThroughSequence > current.inputThroughSequence
  const inputIdsCanAdvance = next.inputThroughSequence >= current.inputThroughSequence
  const addedInputId = inputIdsCanAdvance && [...next.consumedInputIds].some(id => !current.consumedInputIds.has(id))
  const graphRevisionAdvanced = next.taskGraphRevision !== undefined && current.taskGraphRevision !== undefined
    && next.taskGraphRevision > current.taskGraphRevision
  const checkpoint: EffectiveCheckpoint = {
    inputThroughSequence: sequenceAdvanced ? next.inputThroughSequence : current.inputThroughSequence,
    consumedInputIds: new Set(current.consumedInputIds),
    ...(current.taskGraphRevision !== undefined
      ? { taskGraphRevision: Math.max(current.taskGraphRevision, next.taskGraphRevision ?? current.taskGraphRevision) }
      : next.taskGraphRevision === undefined ? {} : { taskGraphRevision: next.taskGraphRevision }),
  }
  if (inputIdsCanAdvance) for (const id of next.consumedInputIds) checkpoint.consumedInputIds.add(id)
  return { checkpoint, advanced: sequenceAdvanced || addedInputId || graphRevisionAdvanced }
}

export function createProgressDetector(repeatLimit = 2): ProgressDetector {
  if (!Number.isInteger(repeatLimit) || repeatLimit < 2) throw new TypeError("repeatLimit must be an integer of at least 2")
  let observations = new Map<string, number>()
  let effectiveCheckpoint: EffectiveCheckpoint | undefined
  return {
    observe(input, checkpoint): ProgressObservation {
      const parsedCheckpoint = parseCheckpoint(checkpoint)
      if (parsedCheckpoint) {
        const advanced = advanceCheckpoint(effectiveCheckpoint, parsedCheckpoint)
        effectiveCheckpoint = advanced.checkpoint
        if (advanced.advanced) observations = new Map<string, number>()
      }
      const signature = stableJson(input.toolCalls.map((call) => ({ name: call.name, arguments: call.arguments })))
      const stateFingerprint = stableJson({
        businessRefs: input.snapshot.businessRefs.map((reference) => reference.id).sort(),
        toolObservations: [...new Set(input.snapshot.toolObservations.flatMap((observation) => {
          if (!observation.content || typeof observation.content !== "object" || Array.isArray(observation.content)) return []
          const content = observation.content as Record<string, unknown>
          return [stableJson({ toolName: content.toolName, input: content.input, status: content.status, output: content.output, errorCode: content.errorCode })]
        }))].sort(),
      })
      const pair = `${signature}|${stateFingerprint}`
      const nextObservationCount = (observations.get(pair) ?? 0) + 1
      observations.set(pair, nextObservationCount)
      if (nextObservationCount >= repeatLimit) throw new NoProgressError({ signature, stateFingerprint })
      return { signature, stateFingerprint }
    },
  }
}
