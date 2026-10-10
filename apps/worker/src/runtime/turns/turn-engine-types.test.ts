import { describe, expect, it } from "vitest"

import { TurnEngineError, toRepositoryJson } from "./turn-engine-types.js"
import { TASK_GRAPH_FINAL_SUMMARY_BINDING } from "../subagents/task-graph-final-summary-binding.js"
import { reduceTaskGraphFinalSummary } from "../subagents/task-graph-final-summary.js"

describe("TurnEngine repository JSON boundary", () => {
  it("normalizes object order and omits undefined object fields", () => {
    expect(toRepositoryJson({ z: 1, a: undefined, nested: { b: true, a: "first" } })).toEqual({ z: 1, nested: { a: "first", b: true } })
  })

  it("converts undefined array values to null", () => {
    expect(toRepositoryJson([undefined, "value"])).toEqual([null, "value"])
  })

  it("rejects non-finite output before it reaches persistence", () => {
    expect(() => toRepositoryJson({ cost: Number.NaN })).toThrowError(TurnEngineError)
    expect(() => toRepositoryJson({ cost: Number.NaN })).toThrow("non-finite")
  })

  it("keeps the private TaskGraph binding out of repository JSON", () => {
    const binding = { graphRevision: 1, summary: reduceTaskGraphFinalSummary({ graphRevision: 1, nodes: [] }) }
    const terminal = { finalContent: { text: "candidate" }, [TASK_GRAPH_FINAL_SUMMARY_BINDING]: binding }
    const saved = toRepositoryJson(terminal)
    expect(saved).toEqual({ finalContent: { text: "candidate" } })
    expect(JSON.stringify(saved)).not.toContain("task_graph_final_summary_binding")
  })
})
