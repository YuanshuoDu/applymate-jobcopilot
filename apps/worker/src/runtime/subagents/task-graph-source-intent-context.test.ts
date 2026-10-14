import { describe, expect, it } from "vitest"
import {
  compareTaskGraphInputCursors, copyTaskGraphSourceCheckpointMetadata, projectTaskGraphInputRelationAfterCheckpoint,
  projectTaskGraphObservationNode, projectTaskGraphSourceIntent, rememberTaskGraphSourceCheckpointMetadata, taskGraphInputRelation,
  TASK_GRAPH_CURRENT_CONTEXT_MAX_TEXT,
} from "./task-graph-source-intent-context.js"

describe("TaskGraph source intent context", () => {
  it("projects bounded plan text and a closed advisory relation while dropping provenance identifiers", () => {
    const projected = projectTaskGraphObservationNode({
      key: "scout", templateId: "scout", goal: "Find roles", successCriteria: ["Return links"], dependsOn: [], taskId: "child-secret",
      status: "completed", readiness: "terminal", inputRelation: "predates_current_inputs",
      causationId: "private-step-id", sourceStepId: "private-step-id", inputThroughSequence: "192", consumedInputIds: ["private-input-id"],
    })

    expect(projected).toMatchObject({ goal: "Find roles", successCriteria: ["Return links"], inputRelation: "predates_current_inputs" })
    const serialized = JSON.stringify(projected)
    expect(serialized).not.toContain("private-step-id")
    expect(serialized).not.toContain("private-input-id")
    expect(serialized).not.toContain("inputThroughSequence")
    expect(serialized).not.toContain('"192"')
  })

  it("treats missing or hostile relation values as unknown without rejecting a valid node", () => {
    expect(taskGraphInputRelation({ sourceStepId: "model-step", inputThroughSequence: 77 })).toBe("unknown")
    expect(projectTaskGraphObservationNode({
      key: "scout", templateId: "scout", goal: "Find roles", successCriteria: ["Return links"], dependsOn: [], taskId: "child-1",
      status: "queued", readiness: "ready", inputRelation: "model-supplied",
    }).inputRelation).toBe("unknown")
  })

  it("keeps Analyst source intent explicitly untrusted and bounded", () => {
    expect(projectTaskGraphSourceIntent({ goal: "Find roles", successCriteria: ["Return links"], inputRelation: "covers_current_inputs" }))
      .toEqual({ trust: "untrusted", goal: "Find roles", successCriteria: ["Return links"], inputRelation: "covers_current_inputs" })
    expect(projectTaskGraphSourceIntent({ goal: "Find roles", successCriteria: ["Return links"], inputRelation: "invalid", sourceStepId: "secret" }))
      .toBeUndefined()
    expect(projectTaskGraphSourceIntent({ goal: "Find roles", successCriteria: Array(9).fill("criterion"), inputRelation: "unknown" }))
      .toBeUndefined()
  })

  it("compares only coherent checkpoints after the current Step has accepted input", () => {
    expect(compareTaskGraphInputCursors(1n, 2n)).toBe("predates_current_inputs")
    expect(compareTaskGraphInputCursors(2n, 2n)).toBe("covers_current_inputs")
    expect(compareTaskGraphInputCursors(3n, 2n)).toBe("unknown")
    expect(compareTaskGraphInputCursors(0n, 0n)).toBe("covers_current_inputs")
    expect(compareTaskGraphInputCursors(0n, 2n)).toBe("predates_current_inputs")
    expect(compareTaskGraphInputCursors(2n, 0n)).toBe("unknown")
    expect(compareTaskGraphInputCursors(-1n, 2n)).toBe("unknown")
  })

  it("finalizes only with metadata bound to the exact Step and keeps cursor identities private", () => {
    const content = { kind: "task_graph_current", revision: 1, nodes: [{ key: "scout", inputRelation: "unknown" }] }
    rememberTaskGraphSourceCheckpointMetadata(content, {
      currentStepId: "private-current-step", sourceStepIds: new Map([["scout", "private-source-step"]]),
      sourceInputCursors: new Map([["scout", 1n]]),
    })

    const finalized = projectTaskGraphInputRelationAfterCheckpoint(content, "private-current-step", 2n, ["private-current-input"])
    expect((finalized as typeof content).nodes[0]?.inputRelation).toBe("predates_current_inputs")
    const serialized = JSON.stringify(finalized)
    for (const secret of ["private-current-step", "private-source-step", "private-current-input", "sourceInputCursors", "inputThroughSequence"]) {
      expect(serialized).not.toContain(secret)
    }

    const cloned = { ...content, nodes: content.nodes.map(node => ({ ...node, inputRelation: "predates_current_inputs" })) }
    const missingMetadata = projectTaskGraphInputRelationAfterCheckpoint(cloned, "private-current-step", 2n, ["private-current-input"])
    expect((missingMetadata as typeof content).nodes[0]?.inputRelation).toBe("unknown")
    const wrongStep = projectTaskGraphInputRelationAfterCheckpoint(content, "different-step", 2n, ["private-current-input"])
    expect((wrongStep as typeof content).nodes[0]?.inputRelation).toBe("unknown")

    const copied = { ...content }
    copyTaskGraphSourceCheckpointMetadata(content, copied)
    const reprojected = projectTaskGraphInputRelationAfterCheckpoint(copied, "private-current-step", 2n, ["private-current-input"])
    expect((reprojected as typeof content).nodes[0]?.inputRelation).toBe("predates_current_inputs")
  })

  it("treats same-Step source intent as covering the accepted current checkpoint", () => {
    const content = { kind: "task_graph_current", revision: 1, nodes: [{ key: "scout", inputRelation: "unknown" }] }
    rememberTaskGraphSourceCheckpointMetadata(content, {
      currentStepId: "current-step", sourceStepIds: new Map([["scout", "current-step"]]),
      sourceInputCursors: new Map([["scout", undefined]]),
    })
    const finalized = projectTaskGraphInputRelationAfterCheckpoint(content, "current-step", 2n, ["accepted-input"])
    expect((finalized as typeof content).nodes[0]?.inputRelation).toBe("covers_current_inputs")
    const carriedCursor = projectTaskGraphInputRelationAfterCheckpoint(content, "current-step", 2n, [])
    expect((carriedCursor as typeof content).nodes[0]?.inputRelation).toBe("covers_current_inputs")
    expect(projectTaskGraphInputRelationAfterCheckpoint(content, "current-step", 0n, [])).toMatchObject({
      nodes: [{ inputRelation: "covers_current_inputs" }],
    })
    expect(projectTaskGraphInputRelationAfterCheckpoint(content, "current-step", 0n, ["invalid-zero-input"]))
      .toMatchObject({ nodes: [{ inputRelation: "unknown" }] })
  })

  it("falls back to unknown when post-claim relations would exceed the current observation cap", () => {
    const base = {
      kind: "task_graph_current", revision: 1, padding: "",
      nodes: [{ key: "scout", inputRelation: "unknown", resultProjection: { status: "completed" } }],
    }
    const relationGrowth = "predates_current_inputs".length - "unknown".length
    const padding = "x".repeat(TASK_GRAPH_CURRENT_CONTEXT_MAX_TEXT - JSON.stringify(base).length - relationGrowth + 1)
    const content = { ...base, padding }
    expect(JSON.stringify(content).length).toBeLessThanOrEqual(TASK_GRAPH_CURRENT_CONTEXT_MAX_TEXT)
    rememberTaskGraphSourceCheckpointMetadata(content, {
      currentStepId: "current-step", sourceStepIds: new Map([["scout", "source-step"]]),
      sourceInputCursors: new Map([["scout", 1n]]),
    })

    const projected = projectTaskGraphInputRelationAfterCheckpoint(content, "current-step", 2n, ["accepted-input"])
    expect((projected as typeof content).nodes[0]).toMatchObject({ inputRelation: "unknown", resultProjection: { status: "completed" } })
    expect(JSON.stringify(projected).length).toBeLessThanOrEqual(TASK_GRAPH_CURRENT_CONTEXT_MAX_TEXT)
  })

  it("omits the relation when even unknown would grow the original capped observation", () => {
    const base = { kind: "task_graph_current", revision: 1, padding: "", nodes: [{ key: "scout", proof: { status: "passed" } }] }
    const padding = "x".repeat(TASK_GRAPH_CURRENT_CONTEXT_MAX_TEXT - JSON.stringify(base).length)
    const content = { ...base, padding }
    const originalLength = JSON.stringify(content).length
    expect(originalLength).toBe(TASK_GRAPH_CURRENT_CONTEXT_MAX_TEXT)
    rememberTaskGraphSourceCheckpointMetadata(content, {
      currentStepId: "current-step", sourceStepIds: new Map([ ["scout", "source-step"] ]),
      sourceInputCursors: new Map([ ["scout", 1n] ]),
    })

    const projected = projectTaskGraphInputRelationAfterCheckpoint(content, "current-step", 2n, ["accepted-input"])
    const serialized = JSON.stringify(projected)
    expect((projected as typeof content).nodes[0]).toEqual({ key: "scout", proof: { status: "passed" } })
    expect(serialized.length).toBe(originalLength)
    expect(serialized.length).toBeLessThanOrEqual(TASK_GRAPH_CURRENT_CONTEXT_MAX_TEXT)
  })

  it("never grows the original observation during an unknown fallback", () => {
    const base = { kind: "task_graph_current", revision: 1, padding: "", nodes: [{ key: "scout", proof: { status: "passed" } }] }
    const unknown = { ...base, nodes: [{ ...base.nodes[0], inputRelation: "unknown" }] }
    const relationGrowth = JSON.stringify(unknown).length - JSON.stringify(base).length
    const padding = "x".repeat(TASK_GRAPH_CURRENT_CONTEXT_MAX_TEXT - JSON.stringify(base).length - relationGrowth)
    const content = { ...base, padding }
    const originalLength = JSON.stringify(content).length
    expect(originalLength).toBeLessThan(TASK_GRAPH_CURRENT_CONTEXT_MAX_TEXT)
    expect(originalLength + relationGrowth).toBe(TASK_GRAPH_CURRENT_CONTEXT_MAX_TEXT)
    rememberTaskGraphSourceCheckpointMetadata(content, {
      currentStepId: "current-step", sourceStepIds: new Map([ ["scout", "source-step"] ]),
      sourceInputCursors: new Map([ ["scout", 1n] ]),
    })

    const projected = projectTaskGraphInputRelationAfterCheckpoint(content, "current-step", 2n, ["accepted-input"])
    expect((projected as typeof content).nodes[0]).toEqual({ key: "scout", proof: { status: "passed" } })
    expect(JSON.stringify(projected).length).toBe(originalLength)
  })
})
