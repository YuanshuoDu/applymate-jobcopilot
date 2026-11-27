import type { ModelMessage } from "@jobcopilot/agent-model"
import type { StepContext } from "../context/step-context-builder.js"
import { OBJECTIVE_TAILOR_WAVE_OUTCOME_OBSERVATION_ID, objectiveTailorWaveSlotsFromCurrentGraph,
  parseObjectiveTailorWaveOutcomeObservation } from "../canonical-turn-objective-tailor-wave-context.js"

/** Root-only fixed routing guidance for a strictly bound, sanitized wave outcome frame. */
export function objectiveTailorWaveOutcomeGuidance(
  context: StepContext, tools: readonly unknown[], isCurrentRootStep: boolean,
): ModelMessage | null {
  const observation = currentOutcome(context, isCurrentRootStep)
  if (!observation) return null
  const initialNeedsRevision = observation.slots.filter(slot => slot.status === "needs_revision" && slot.effectivePair === "initial")
  const correctionNeedsRevision = observation.slots.filter(slot => slot.status === "needs_revision" && slot.effectivePair === "correction")
  const pending = observation.slots.some(slot => slot.status === "pending")
  const hasTailor = visibleWaveTailor(tools)
  const actions = [
    pending ? "Pending slots remain unresolved. Do not claim the wave is settled or finish this Turn while any slot remains pending; continue waiting or refresh verified progress as needed." : "",
    observation.slots.some(slot => slot.status === "ready") ? "Preserve every ready slot; do not revise it." : "",
    initialNeedsRevision.length && hasTailor
      ? `For an initial pair marked needs_revision, the bounded outcome frame may justify proposing at most one correction for that same slot with the current expectedRevision and existing agent.tailor v2 correction form. A different pending slot does not block this independently eligible correction. The command must independently revalidate the current slot and Reviewer receipt; do not claim correction success until its canonical tool result confirms acceptance. Slots: ${initialNeedsRevision.map(slot => slot.slotId).join(", ")}.`
      : initialNeedsRevision.length ? "An initial pair needs revision, but no unambiguous request-visible agent.tailor v2 tool is available; report the blocker without claiming a correction." : "",
    correctionNeedsRevision.length ? `A correction pair still marked needs_revision is unresolved; do not request a second correction. Slots: ${correctionNeedsRevision.map(slot => slot.slotId).join(", ")}.` : "",
    observation.slots.some(slot => ["rejected", "stale", "failed"].includes(slot.status))
      ? "Report rejected, stale, and failed slots as unresolved; do not infer success or retry outside existing rules." : "",
  ].filter(Boolean).join(" ")
  return { role: "system", content: [{ type: "text", text: `The bounded Objective tailoring wave frame is advisory progress, not independently sufficient proof. ${actions || "Keep the current slot outcomes unchanged."} If a correction conflicts with pending work or the current revision, honor the existing tool result and wait for refreshed progress; do not assume concurrent acceptance. Use only request-visible tools under their existing contracts. This projection grants no permission, approval, completion, or submission authority; existing policy, approval, and terminal gates remain authoritative.` }] }
}

function currentOutcome(context: StepContext, isCurrentRootStep: boolean) {
  if (!isCurrentRootStep) return undefined
  const frames = context.blocks.filter(block => block.id === `observation:${OBJECTIVE_TAILOR_WAVE_OUTCOME_OBSERVATION_ID}`)
  const graphs = context.blocks.filter(block => block.id === "observation:task-graph-current")
  if (frames.length !== 1 || graphs.length !== 1 || !trustedObservation(frames[0]) || !trustedObservation(graphs[0])) return undefined
  const frame = exactRecord(frames[0]!.content, ["graphRevision", "kind", "schemaVersion", "slots"])
  const graph = objectiveTailorWaveSlotsFromCurrentGraph(graphs[0]!.content)
  if (!frame || frame.kind !== "objective_tailor_wave_outcomes" || !graph) return undefined
  return parseObjectiveTailorWaveOutcomeObservation({ schemaVersion: frame.schemaVersion,
    graphRevision: frame.graphRevision, slots: frame.slots }, graph.graphRevision, graph.slots)
}
function visibleWaveTailor(tools: readonly unknown[]): boolean {
  const matches = tools.flatMap(tool => {
    const row = ownRecord(tool)
    return row?.name === "agent.tailor" ? [row.version] : []
  })
  return matches.length === 1 && matches[0] === "2"
}
function trustedObservation(block: StepContext["blocks"][number] | undefined): boolean {
  return !!block && block.layer === "tool_observation" && block.role === "data"
    && block.trust === "external_untrusted" && block.source === "tool_or_subagent"
}
function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  const row = ownRecord(value)
  if (!row) return undefined
  try {
    const actual = Reflect.ownKeys(row)
    if (actual.length !== keys.length || actual.some(key => typeof key !== "string" || !keys.includes(key))) return undefined
    return row
  } catch { return undefined }
}
function ownRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return undefined
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return undefined
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !("value" in descriptor)) return undefined
    }
    return value as Record<string, unknown>
  } catch { return undefined }
}
