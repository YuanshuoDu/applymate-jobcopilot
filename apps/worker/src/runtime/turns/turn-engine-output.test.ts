import { describe, expect, it } from "vitest"

import { TurnEngineError, toRepositoryJson } from "./turn-engine-output.js"
import { TASK_GRAPH_FINAL_SUMMARY_BINDING } from "../subagents/task-graph-final-summary-binding.js"
import { reduceTaskGraphFinalSummary } from "../subagents/task-graph-final-summary.js"

describe("TurnEngine output boundary", () => {
  it("recognizes the discovery memory overflow terminal code", () => {
    expect(new TurnEngineError("discovery_memory_overflow", "safe recovery").code).toBe("discovery_memory_overflow")
  })

  it("sorts object keys recursively and omits undefined object fields", () => {
    expect(toRepositoryJson({ z: 1, a: undefined, nested: { b: true, a: "first" } })).toEqual({ nested: { a: "first", b: true }, z: 1 })
  })

  it("normalizes undefined array values to null", () => {
    expect(toRepositoryJson([undefined, "value"])).toEqual([null, "value"])
  })

  it("rejects non-finite numbers with the typed output error", () => {
    expect(() => toRepositoryJson({ cost: Number.NaN })).toThrowError(TurnEngineError)
    expect(() => toRepositoryJson({ cost: Number.NaN })).toThrow("non-finite")
  })

  it("excludes private TaskGraph summary bindings from repository JSON", () => {
    const binding = { graphRevision: 1, summary: reduceTaskGraphFinalSummary({ graphRevision: 1, nodes: [] }) }
    const saved = toRepositoryJson({ finalContent: { text: "candidate" }, [TASK_GRAPH_FINAL_SUMMARY_BINDING]: binding })
    expect(saved).toEqual({ finalContent: { text: "candidate" } })
    expect(JSON.stringify(saved)).not.toContain("task_graph_final_summary_binding")
  })
})
