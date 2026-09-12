import type { TurnEngineOptions } from "./turn-engine-types.js"

type PersistedToolObservation = {
  readonly toolName: string
  readonly input: unknown
  readonly status: unknown
  readonly output: unknown
}

function persistedToolObservation(snapshot: TurnEngineOptions["snapshot"], callId: string): PersistedToolObservation | null {
  const observation = snapshot.toolObservations.find((entry) => {
    if (!entry.content || typeof entry.content !== "object" || Array.isArray(entry.content)) return false
    return (entry.content as Record<string, unknown>).toolCallId === callId
  })
  if (!observation || !observation.content || typeof observation.content !== "object" || Array.isArray(observation.content)) return null
  const content = observation.content as Record<string, unknown>
  return typeof content.toolName === "string"
    ? { toolName: content.toolName, input: content.input ?? {}, status: content.status, output: content.output }
    : null
}

export function findToolObservation(snapshot: TurnEngineOptions["snapshot"], callId: string): { toolName: string; input: unknown } | null {
  const observation = persistedToolObservation(snapshot, callId)
  return observation ? { toolName: observation.toolName, input: observation.input } : null
}

export function findToolResultObservation(snapshot: TurnEngineOptions["snapshot"], callId: string): PersistedToolObservation | null {
  return persistedToolObservation(snapshot, callId)
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}
