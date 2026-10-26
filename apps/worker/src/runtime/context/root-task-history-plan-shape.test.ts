import { describe, expect, it } from "vitest"
import { buildRootTaskHistoryPlanShape, parseRootTaskHistoryPlanShape } from "./root-task-history-plan-shape.js"

const node = (key: string, templateId: string, dependsOn: readonly string[] = []) => ({ key, templateId, dependsOn })
const packet = (nodes: readonly unknown[]) => ({ schemaVersion: "agent-harness.v2.root-task-history-plan-shape.v1",
  ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true, nodes })

describe("root-task-history plan shape", () => {
  it("maps source graph edges to stable local ordinals before any outcome ordering", () => {
    const graph = { revision: 7, nodes: [node("analyst-secret", "analyst", ["scout-secret"]),
      node("scout-secret", "scout"), node("writer-secret", "cover_letter_writer", ["analyst-secret"])] }
    const shape = buildRootTaskHistoryPlanShape(graph, [2, 1, 3])
    expect(shape).toEqual(packet([
      { ordinal: 1, role: "scout", dependsOnOrdinals: [] },
      { ordinal: 2, role: "analyst", dependsOnOrdinals: [1] },
      { ordinal: 3, role: "writer", dependsOnOrdinals: [2] },
    ]))
    expect(JSON.stringify(shape)).not.toMatch(/secret|revision|key|templateId|goal|criteria|taskId/)
    expect(parseRootTaskHistoryPlanShape(shape)).toEqual(shape)
  })

  it("collapses unsupported templates to the closed other role", () => {
    expect(buildRootTaskHistoryPlanShape({ nodes: [node("private-template-key", "private_template_name")] }, [1]))
      .toEqual(packet([{ ordinal: 1, role: "other", dependsOnOrdinals: [] }]))
  })

  it.each([
    ["missing graph", null, [1]], ["missing ordinal mapping", { nodes: [node("a", "scout")] }, undefined],
    ["duplicate ordinal", { nodes: [node("a", "scout"), node("b", "analyst")] }, [1, 1]],
    ["noncontiguous ordinal", { nodes: [node("a", "scout"), node("b", "analyst")] }, [1, 3]],
    ["duplicate key", { nodes: [node("same", "scout"), node("same", "analyst")] }, [1, 2]],
    ["dangling edge", { nodes: [node("a", "scout", ["missing"])] }, [1]],
    ["self edge", { nodes: [node("a", "scout", ["a"])] }, [1]],
    ["duplicate edge", { nodes: [node("a", "scout"), node("b", "analyst", ["a", "a"])] }, [1, 2]],
    ["cycle", { nodes: [node("a", "scout", ["b"]), node("b", "analyst", ["a"])] }, [1, 2]],
    ["nondense dependencies", { nodes: [node("a", "scout", new Array<string>(2))] }, [1]],
  ] as const)("omits a malformed or incomplete %s graph", (_name, graph, ordinals) => {
    expect(buildRootTaskHistoryPlanShape(graph, ordinals)).toBeUndefined()
  })

  it("parses only the closed, contiguous, acyclic packet", () => {
    const valid = packet([{ ordinal: 1, role: "scout", dependsOnOrdinals: [] },
      { ordinal: 2, role: "analyst", dependsOnOrdinals: [1] }])
    expect(parseRootTaskHistoryPlanShape(valid)).toEqual(valid)
    for (const invalid of [
      { ...valid, privateText: "not allowed" },
      packet([{ ordinal: 1, role: "scout", dependsOnOrdinals: [], taskId: "private" }]),
      packet([{ ordinal: 2, role: "scout", dependsOnOrdinals: [] }]),
      packet([{ ordinal: 1, role: "unknown", dependsOnOrdinals: [] }]),
      packet([{ ordinal: 1, role: "scout", dependsOnOrdinals: [1] }]),
      packet([{ ordinal: 1, role: "scout", dependsOnOrdinals: [2] }, { ordinal: 2, role: "analyst", dependsOnOrdinals: [1] }]),
      packet([{ ordinal: 1, role: "scout", dependsOnOrdinals: [] }, { ordinal: 2, role: "analyst", dependsOnOrdinals: [1, 1] }]),
    ]) expect(parseRootTaskHistoryPlanShape(invalid)).toBeUndefined()
  })

  it("rejects accessor-backed packet and source fields without invoking them", () => {
    const valid = packet([{ ordinal: 1, role: "scout", dependsOnOrdinals: [] }])
    let reads = 0
    const accessorPacket = { ...valid }
    Object.defineProperty(accessorPacket, "schemaVersion", { enumerable: true, get: () => { reads += 1; return valid.schemaVersion } })
    expect(parseRootTaskHistoryPlanShape(accessorPacket)).toBeUndefined()

    const accessorNode = node("private-key", "scout")
    Object.defineProperty(accessorNode, "key", { enumerable: true, get: () => { reads += 1; return "private-key" } })
    expect(buildRootTaskHistoryPlanShape({ nodes: [accessorNode] }, [1])).toBeUndefined()
    expect(reads).toBe(0)
  })

  it("fails closed when reflection on a packet or graph array throws", () => {
    const valid = packet([{ ordinal: 1, role: "scout", dependsOnOrdinals: [] }])
    const hostilePacket = new Proxy(valid, { ownKeys: () => { throw new Error("reflection failed") } })
    expect(parseRootTaskHistoryPlanShape(hostilePacket)).toBeUndefined()

    const hostileNodes = new Proxy([], { getOwnPropertyDescriptor: () => { throw new Error("reflection failed") } })
    expect(buildRootTaskHistoryPlanShape({ nodes: hostileNodes }, [1])).toBeUndefined()
  })
})
