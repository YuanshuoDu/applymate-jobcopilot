import { describe, expect, it } from "vitest"
import {
  projectTaskGraphDependencySourceIntent,
  projectTaskGraphRootSourceIntents,
  sourceIntentForTaskGraphNode,
  withTaskGraphRootSourceIntent,
} from "./task-graph-source-intent-context.js"

const intent = {
  goal: "Find backend engineering roles in Dublin.",
  successCriteria: ["Return current roles with direct application URLs."],
  inputRelation: "predates_current_inputs",
}

describe("TaskGraph source intent context", () => {
  it("projects only bounded advisory fields for a direct dependency", () => {
    const projected = projectTaskGraphDependencySourceIntent({
      ...intent, sourceStepId: "private-step", inputThroughSequence: 91n,
    })

    expect(projected).toBeUndefined()
    expect(projectTaskGraphDependencySourceIntent(intent)).toEqual(intent)
    expect(Object.keys(projectTaskGraphDependencySourceIntent(intent) ?? {}).sort()).toEqual([
      "goal", "inputRelation", "successCriteria",
    ])
  })

  it("accepts only the three known advisory relations and bounded intent text", () => {
    expect(projectTaskGraphDependencySourceIntent({ ...intent, inputRelation: "stale" })).toBeUndefined()
    expect(projectTaskGraphDependencySourceIntent({ ...intent, goal: " ".repeat(4) })).toBeUndefined()
    expect(projectTaskGraphDependencySourceIntent({ ...intent, goal: "g".repeat(1201) })).toBeUndefined()
    expect(projectTaskGraphDependencySourceIntent({ ...intent, successCriteria: Array(9).fill("criterion") })).toBeUndefined()
    expect(projectTaskGraphDependencySourceIntent({ ...intent, successCriteria: ["c".repeat(321)] })).toBeUndefined()
    expect(projectTaskGraphDependencySourceIntent({ ...intent, inputRelation: "unknown" })).toMatchObject({ inputRelation: "unknown" })
  })

  it("derives provenance from checkpoints and fails open to unknown without the current checkpoint", () => {
    const node = { goal: intent.goal, successCriteria: intent.successCriteria }
    const source = { inputThroughSequence: 3n }

    expect(sourceIntentForTaskGraphNode(node, source, { inputThroughSequence: 4n })).toEqual({
      ...intent, inputRelation: "predates_current_inputs",
    })
    expect(sourceIntentForTaskGraphNode(node, source, source)).toEqual({
      ...intent, inputRelation: "covers_current_inputs",
    })
    expect(sourceIntentForTaskGraphNode(node, source)).toEqual({
      ...intent, inputRelation: "unknown",
    })
    expect(JSON.stringify(sourceIntentForTaskGraphNode(node, source, source))).not.toMatch(/inputThroughSequence|stepId|cursor/)
  })

  it("ties Root metadata to unique current node keys and emits no checkpoint identity", () => {
    const projected = projectTaskGraphRootSourceIntents([
      { nodeKey: "source-1", ...intent },
      { nodeKey: "source-1", ...intent, inputRelation: "covers_current_inputs" },
      { nodeKey: "sibling", ...intent },
      { nodeKey: "source-2", ...intent, sourceInputCheckpoint: { inputThroughSequence: "8" } },
    ], new Set(["source-1", "source-2"]))

    expect(projected).toEqual([{ nodeKey: "source-1", ...intent }])
    expect(JSON.stringify(projected)).not.toMatch(/sourceStepId|inputId|cursor|inputThroughSequence|sourceInputCheckpoint/)
  })

  it("omits optional Root metadata when it would exceed the existing observation cap", () => {
    const base = { kind: "task_graph_current", nodes: [{ key: "source-1", resultProjection: { preserved: true } }] }
    const omitted = withTaskGraphRootSourceIntent(base, [{ nodeKey: "source-1", ...intent }], 20)
    const included = withTaskGraphRootSourceIntent(base, [{ nodeKey: "source-1", ...intent }], 1000)

    expect(omitted).toBe(base)
    expect(omitted.nodes[0]?.resultProjection).toEqual({ preserved: true })
    expect(included).toMatchObject({ sourceIntent: [{ nodeKey: "source-1", ...intent }] })
    expect(included.nodes[0]?.resultProjection).toEqual({ preserved: true })
  })

  it("rejects accessor-backed rows without evaluating model-controlled getters", () => {
    let evaluated = false
    const hostile = { ...intent }
    Object.defineProperty(hostile, "goal", { enumerable: true, get() { evaluated = true; return "goal" } })

    expect(projectTaskGraphDependencySourceIntent(hostile)).toBeUndefined()
    expect(evaluated).toBe(false)
  })
})
