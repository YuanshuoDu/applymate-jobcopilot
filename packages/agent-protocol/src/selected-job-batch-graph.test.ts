import { describe, expect, it } from "vitest"
import { parseSelectedJobBatchGraph } from "./selected-job-batch-graph.js"

const slots = ["slot-1", "slot-2"] as const
const nodes = [
  { key: "w1", templateId: "cover_letter_writer_slot_1", dependsOn: [] },
  { key: "r1", templateId: "cover_letter_reviewer_slot_1", dependsOn: ["w1"] },
  { key: "w2", templateId: "cover_letter_writer_slot_2", dependsOn: [] },
  { key: "r2", templateId: "cover_letter_reviewer_slot_2", dependsOn: ["w2"] },
]
const correction = [
  ...nodes,
  { key: "w1b", templateId: "cover_letter_writer_slot_1", dependsOn: ["r1"] },
  { key: "r1b", templateId: "cover_letter_reviewer_slot_1", dependsOn: ["w1b"] },
]

describe("parseSelectedJobBatchGraph", () => {
  it("keeps exact initial pairs and effective references", () => {
    const parsed = parseSelectedJobBatchGraph(nodes, slots)
    expect(parsed?.map(slot => [slot.initial.writer.key, slot.initial.reviewer.key,
      slot.effective.writer.key, slot.effective.reviewer.key])).toEqual([
      ["w1", "r1", "w1", "r1"], ["w2", "r2", "w2", "r2"],
    ])
    expect(parsed?.[0]?.initial.writer).toBe(nodes[0])
  })

  it("accepts one same-slot correction chain and points effective at its fresh review", () => {
    const parsed = parseSelectedJobBatchGraph(correction, slots)
    expect(parsed?.[0]).toMatchObject({
      initial: { writer: { key: "w1" }, reviewer: { key: "r1" } },
      correction: { writer: { key: "w1b" }, reviewer: { key: "r1b" } },
      effective: { writer: { key: "w1b" }, reviewer: { key: "r1b" } },
    })
    expect(parsed?.[1]?.correction).toBeUndefined()
  })

  it.each([
    ["cross-slot correction", correction.map(node => node.key === "w1b" ? { ...node, dependsOn: ["r2"] } : node)],
    ["extra correction dependency", correction.map(node => node.key === "w1b" ? { ...node, dependsOn: ["r1", "r2"] } : node)],
    ["wrong correction reviewer slot", correction.map(node => node.key === "r1b" ? { ...node, templateId: "cover_letter_reviewer_slot_2" } : node)],
    ["second correction chain", [...correction,
      { key: "w1c", templateId: "cover_letter_writer_slot_1", dependsOn: ["r1b"] },
      { key: "r1c", templateId: "cover_letter_reviewer_slot_1", dependsOn: ["w1c"] }]],
  ])("rejects %s", (_name, proposed) => {
    expect(parseSelectedJobBatchGraph(proposed as typeof nodes, slots)).toBeNull()
  })

  it("accepts two complete independent corrections within the eight-node ceiling", () => {
    const twoCorrections = [...correction,
      { key: "w2b", templateId: "cover_letter_writer_slot_2", dependsOn: ["r2"] },
      { key: "r2b", templateId: "cover_letter_reviewer_slot_2", dependsOn: ["w2b"] }]
    expect(parseSelectedJobBatchGraph(twoCorrections, slots)?.map(slot => slot.effective.writer.key)).toEqual(["w1b", "w2b"])
  })

  it.each([
    ["foreign node", [...nodes, { key: "x", templateId: "analyst", dependsOn: [] }]],
    ["duplicate key", [...nodes, { key: "w1", templateId: "cover_letter_writer_slot_2", dependsOn: ["r2"] }]],
    ["wrong initial edge", nodes.map(node => node.key === "r1" ? { ...node, dependsOn: ["w2"] } : node)],
    ["noncanonical slots", nodes],
    ["capacity overflow", [
      ...nodes,
      { key: "w3", templateId: "cover_letter_writer_slot_3", dependsOn: [] },
      { key: "r3", templateId: "cover_letter_reviewer_slot_3", dependsOn: ["w3"] },
      { key: "w1b", templateId: "cover_letter_writer_slot_1", dependsOn: ["r1"] },
      { key: "r1b", templateId: "cover_letter_reviewer_slot_1", dependsOn: ["w1b"] },
      { key: "w2b", templateId: "cover_letter_writer_slot_2", dependsOn: ["r2"] },
      { key: "r2b", templateId: "cover_letter_reviewer_slot_2", dependsOn: ["w2b"] },
    ]],
  ])("rejects malformed %s", (name, proposed) => {
    const selectedSlots = name === "noncanonical slots" ? ["slot-2", "slot-3"] as const
      : name === "capacity overflow" ? ["slot-1", "slot-2", "slot-3"] as const : slots
    expect(parseSelectedJobBatchGraph(proposed as typeof nodes, selectedSlots)).toBeNull()
  })
})
