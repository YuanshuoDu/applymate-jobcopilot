import { describe, expect, it } from "vitest"
import { graphMatchesActiveLocationScope, registeredScoutsFromPlan } from "./active-turn-location-plan-proof"

function scout(key: string, taskId: string, locations: string[]) {
  return { key, taskId, templateId: "scout", goal: `Search ${key}`, successCriteria: ["Return current matching roles"], dependsOn: [], depth: 1,
    verificationDisposition: "typed", verification: { schemaVersion: "agent-harness.v2.task-graph-verification.v2", role: "scout",
      criteria: [{ id: "candidate-location", check: { kind: "candidate_location_in", locations } }] } }
}
const graph = { schemaVersion: "agent-harness.v2.task-graph", nodes: [scout("old-scout", "old-task", ["berlin"]), scout("new-scout", "new-task", ["dublin"])] }

describe("active Turn location plan evidence", () => {
  it("uses the newly registered Scout set while ignoring an older visible Scout", () => {
    const registered = [{ key: "new-scout", taskId: "new-task", status: "queued" }]
    const newlyRegistered = registeredScoutsFromPlan(graph, registered)
    expect(newlyRegistered).toEqual(registered)
    expect(graphMatchesActiveLocationScope(graph, newlyRegistered ?? [], ["dublin"])).toBe(true)
    expect(graphMatchesActiveLocationScope(graph, [{ key: "old-scout", taskId: "old-task" }], ["dublin"])).toBe(false)
  })

  it("does not accept a newly registered Scout absent from the current effective graph", () => {
    const newlyRegistered = registeredScoutsFromPlan(graph, [{ key: "new-scout", taskId: "new-task", status: "queued" }])
    expect(graphMatchesActiveLocationScope({ ...graph, nodes: [graph.nodes[0]] }, newlyRegistered ?? [], ["dublin"])).toBe(false)
  })

  it("rejects duplicate or malformed registration identities", () => {
    expect(registeredScoutsFromPlan(graph, [
      { key: "new-scout", taskId: "new-task", status: "queued" }, { key: "new-scout", taskId: "new-task", status: "waiting" },
    ])).toBeNull()
    expect(registeredScoutsFromPlan(graph, [{ key: "foreign", taskId: "foreign-task", status: "queued" }])).toEqual([])
  })
})
