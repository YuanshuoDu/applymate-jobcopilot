import { describe, expect, it } from "vitest"
import { isRootTaskHistoryFootprintOrigin, rootTaskHistoryFootprintOrigin } from "./root-task-history-footprint-origin.js"

const intent = { kind: "objective_task_graph_execution", version: 1 }
const origin = '["user","objective_task_graph_execution",1]'

describe("root task history footprint origin", () => {
  it("accepts only the server-owned user objective intent v1", () => {
    expect(rootTaskHistoryFootprintOrigin("user", { intent })).toBe(origin)
    expect(rootTaskHistoryFootprintOrigin("user", { input: { intent } })).toBe(origin)
    expect(rootTaskHistoryFootprintOrigin("user", { intent, input: { intent } })).toBe(origin)
    expect(isRootTaskHistoryFootprintOrigin(origin)).toBe(true)
  })

  it.each([
    ["automation source", "automation", { intent }],
    ["missing intent", "user", { goal: "Search" }],
    ["legacy intent version", "user", { intent: { ...intent, version: 2 } }],
    ["extra intent field", "user", { intent: { ...intent, extra: true } }],
    ["conflicting nested intent", "user", { intent, input: { intent: { kind: "interactive_discovery_shortlist", version: 1 } } }],
    ["malformed nested input", "user", { intent, input: null }],
  ])("rejects %s", (_label, source, input) => {
    expect(rootTaskHistoryFootprintOrigin(source, input)).toBeUndefined()
  })

  it("recognizes only the canonical serialized origin", () => {
    for (const value of [
      '["automation","objective_task_graph_execution",1]',
      '["user","objective_task_graph_execution",2]',
      '["user","objective_task_graph_execution",1,"extra"]',
      '[ "user", "objective_task_graph_execution", 1 ]',
    ]) expect(isRootTaskHistoryFootprintOrigin(value)).toBe(false)
  })
})
