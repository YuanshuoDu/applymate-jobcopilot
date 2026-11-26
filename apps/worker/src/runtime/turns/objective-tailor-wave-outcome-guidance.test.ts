import { describe, expect, it } from "vitest"
import type { StepContext } from "../context/step-context-builder.js"
import { OBJECTIVE_TAILOR_WAVE_OUTCOME_SCHEMA } from "../objective-tailor-wave-outcome-projection.js"
import { objectiveTailorWaveOutcomeGuidance } from "./objective-tailor-wave-outcome-guidance.js"

const child = (taskId: string) => ({ taskId, status: "completed", readiness: "terminal" })
function slot(index: number, effectivePair: "initial" | "correction") {
  return { slotId: `tailor-${index}`, sourceAnalystNodeKey: `PRIVATE_SOURCE_${index}`, effectivePair,
    initial: { writer: child(`PRIVATE_INITIAL_WRITER_${index}`), reviewer: child(`PRIVATE_INITIAL_REVIEWER_${index}`) },
    ...(effectivePair === "correction" ? { correction: { writer: child(`PRIVATE_CORRECTION_WRITER_${index}`), reviewer: child(`PRIVATE_CORRECTION_REVIEWER_${index}`) } } : {}) }
}
function context(rows: readonly Readonly<{ slotId: string; effectivePair: "initial" | "correction"; status: string }>[], revision = 7): StepContext {
  const slots = rows.map((row, index) => slot(index + 1, row.effectivePair))
  return { schemaVersion: "agent-harness.v2", sessionId: "session", turnId: "turn", stepId: "step",
    inputThroughSequence: 0n, consumedInputIds: [], canonicalJson: "{}", blocks: [
      { id: "observation:task-graph-current", layer: "tool_observation", role: "data", trust: "external_untrusted", source: "tool_or_subagent",
        content: { kind: "task_graph_current", revision, objectiveTailorWave: { schemaVersion: "agent-harness.v2.objective-tailor-wave-view.v1",
          graphRevision: revision, sourceNodeCount: 2, ordinaryPlanAppend: "closed", slots } } },
      { id: "observation:objective-tailor-wave-outcomes", layer: "tool_observation", role: "data", trust: "external_untrusted", source: "tool_or_subagent",
        content: { kind: "objective_tailor_wave_outcomes", schemaVersion: OBJECTIVE_TAILOR_WAVE_OUTCOME_SCHEMA, graphRevision: revision,
          slots: [...rows] } },
    ] }
}
const v2Tool = [{ name: "agent.tailor", version: "2" }]
function guidanceText(rows: readonly Readonly<{ slotId: string; effectivePair: "initial" | "correction"; status: string }>[], tools: readonly unknown[] = v2Tool, root = true, revision = 7) {
  const message = objectiveTailorWaveOutcomeGuidance(context(rows, revision), tools, root)
  const part = message?.content.find(item => item.type === "text")
  return part?.type === "text" ? part.text : undefined
}

describe("Objective Tailor wave outcome guidance", () => {
  it("routes only initial needs_revision through one evidence-backed same-slot correction and preserves ready or pending", () => {
    const text = guidanceText([
      { slotId: "tailor-1", effectivePair: "initial", status: "needs_revision" },
      { slotId: "tailor-2", effectivePair: "initial", status: "ready" },
      { slotId: "tailor-3", effectivePair: "initial", status: "pending" },
    ])
    if (!text) throw new Error("expected Root guidance")
    expect(text).toContain("at most one correction for that same slot")
    expect(text).toContain("command must independently revalidate the current slot and Reviewer receipt")
    expect(text).toContain("do not assume concurrent acceptance")
    expect(text).toContain("tailor-1")
    expect(text).toContain("Preserve every ready slot")
    expect(text).toContain("wait for the current graph")
    expect(text).toContain("grants no permission, approval, completion, or submission authority")
    for (const privateValue of ["PRIVATE_SOURCE", "PRIVATE_INITIAL", "PRIVATE_CORRECTION", "PRIVATE_TASK"]) expect(text).not.toContain(privateValue)
  })

  it("keeps a correction still needing revision unresolved and does not offer another correction", () => {
    const text = guidanceText([{ slotId: "tailor-1", effectivePair: "correction", status: "needs_revision" }])
    if (!text) throw new Error("expected Root guidance")
    expect(text).toContain("still marked needs_revision is unresolved")
    expect(text).toContain("do not request a second correction")
    expect(text).not.toContain("at most one correction")
  })

  it("reports terminal non-ready outcomes and fails closed when the v2 tool is unavailable", () => {
    const text = guidanceText([
      { slotId: "tailor-1", effectivePair: "initial", status: "needs_revision" },
      { slotId: "tailor-2", effectivePair: "initial", status: "rejected" },
      { slotId: "tailor-3", effectivePair: "initial", status: "stale" },
      { slotId: "tailor-4", effectivePair: "initial", status: "failed" },
    ], [{ name: "agent.tailor", version: "1" }])
    if (!text) throw new Error("expected Root guidance")
    expect(text).toContain("no unambiguous request-visible agent.tailor v2 tool")
    expect(text).toContain("Report rejected, stale, and failed slots as unresolved")
  })

  it("omits child, untrusted, stale, duplicate, and malformed projections", () => {
    const valid = context([{ slotId: "tailor-1", effectivePair: "initial", status: "ready" }])
    const duplicate = { ...valid, blocks: [...valid.blocks, valid.blocks[1]!] }
    const wrongTrust = { ...valid, blocks: valid.blocks.map(block => block.id.includes("outcomes") ? { ...block, trust: "internal_record" as const } : block) }
    const childStep = { ...valid, stepId: "child-step" }
    const stale = { ...valid, blocks: valid.blocks.map(block => block.id.includes("outcomes")
      ? { ...block, content: { ...(block.content as object), graphRevision: 8 } } : block) }
    const badOrder = context([{ slotId: "tailor-2", effectivePair: "initial", status: "ready" }])
    for (const candidate of [duplicate, wrongTrust, stale, badOrder]) expect(objectiveTailorWaveOutcomeGuidance(candidate, v2Tool, true)).toBeNull()
    expect(objectiveTailorWaveOutcomeGuidance(childStep, v2Tool, false)).toBeNull()
    expect(objectiveTailorWaveOutcomeGuidance(valid, v2Tool, false)).toBeNull()
    const mixed = guidanceText([{ slotId: "tailor-1", effectivePair: "initial", status: "needs_revision" }],
      [{ name: "agent.tailor", version: "2" }, { name: "agent.tailor", version: "1" }])
    expect(mixed).toContain("no unambiguous request-visible agent.tailor v2 tool")
  })
})
