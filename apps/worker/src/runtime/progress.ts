import type { StepContextSnapshot } from "./context/step-context-builder.js"
import { stableJson } from "./turns/turn-engine-replay.js"
import type { TurnEngineToolCall } from "./turns/turn-engine-types.js"

export type ProgressObservation = {
  readonly signature: string
  readonly stateFingerprint: string
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
  observe(input: { snapshot: StepContextSnapshot; toolCalls: readonly TurnEngineToolCall[] }): ProgressObservation
}

export function createProgressDetector(repeatLimit = 2): ProgressDetector {
  if (!Number.isInteger(repeatLimit) || repeatLimit < 2) throw new TypeError("repeatLimit must be an integer of at least 2")
  const observations = new Map<string, number>()
  return {
    observe(input): ProgressObservation {
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
