import type { JsonValue, ScriptedAt, ScriptedModelEvent, ScriptedModelStep } from "../types.js"

export type ScriptedModel = {
  readonly steps: readonly ScriptedModelStep[]
  next(sequence: number, elapsedMs: number): ScriptedModelStep | null
  reset(): void
}

export function scriptedModel(options: { readonly steps: readonly ScriptedModelStep[] }): ScriptedModel {
  const steps = options.steps.map(validateStep).sort((left, right) => atValue(left.at) - atValue(right.at))
  let cursor = 0
  return {
    steps,
    next: (sequence, elapsedMs) => {
      const candidate = steps[cursor]
      if (!candidate || !isDue(candidate.at, sequence, elapsedMs)) return null
      cursor += 1
      return candidate
    },
    reset: () => { cursor = 0 },
  }
}

function validateStep(step: ScriptedModelStep): ScriptedModelStep {
  if (!Number.isFinite(atValue(step.at)) || atValue(step.at) < 0) throw new TypeError("model step at must be non-negative")
  if (!step.event || typeof step.event.type !== "string") throw new TypeError("model step event is required")
  return step
}

function atValue(at: ScriptedAt): number {
  return typeof at === "number" ? at : at.timeMs
}

function isDue(at: ScriptedAt, sequence: number, elapsedMs: number): boolean {
  return atValue(at) <= (typeof at === "number" ? sequence : elapsedMs)
}

export function modelText(at: ScriptedAt, text: string): ScriptedModelStep {
  return { at, event: { type: "text", text } }
}

export function modelFinal(at: ScriptedAt, text: string): ScriptedModelStep {
  return { at, event: { type: "final", text } }
}

export function modelTool(at: ScriptedAt, callId: string, name: string, input: JsonValue): ScriptedModelStep {
  return { at, event: { type: "tool_call", callId, name, input } }
}
