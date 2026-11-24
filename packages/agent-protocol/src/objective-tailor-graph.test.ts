import { describe, expect, it } from "vitest"
import {
  OBJECTIVE_TAILOR_GRAPH_MAX_NODES,
  OBJECTIVE_TAILOR_GRAPH_SCHEMA_VERSION,
  parseObjectiveTailorGraph,
} from "./objective-tailor-graph.js"

type Fixture = { marker: Record<string, unknown>; nodes: Record<string, unknown>[] }
type FixtureSlot = {
  slotId: string
  sourceAnalystNodeKey: string
  writerNodeKey: string
  reviewerNodeKey: string
  correction?: { writerNodeKey: string; reviewerNodeKey: string }
}

function fixture(sourceNodeCount = 7, slotCount = 8, corrections: readonly number[] = [2, 7]): Fixture {
  const sources = Array.from({ length: sourceNodeCount }, (_, index) => ({
    key: `source-${index + 1}`,
    templateId: index % 2 === 0 ? "scout" : "analyst",
    verificationDisposition: "typed",
    dependsOn: index === 0 ? [] : [`source-${index}`],
  }))
  const analystKeys = sources.filter(node => node.templateId === "analyst").map(node => node.key)
  const slots: FixtureSlot[] = Array.from({ length: slotCount }, (_, index) => ({
    slotId: `tailor-${index + 1}`,
    sourceAnalystNodeKey: analystKeys[index % analystKeys.length],
    writerNodeKey: `writer-${index + 1}`,
    reviewerNodeKey: `reviewer-${index + 1}`,
    ...(corrections.includes(index + 1) ? { correction: {
      writerNodeKey: `correction-writer-${index + 1}`,
      reviewerNodeKey: `correction-reviewer-${index + 1}`,
    } } : {}),
  }))
  const bySlot = slots
  const writers = bySlot.map(slot => ({ key: slot.writerNodeKey, templateId: "cover_letter_writer", dependsOn: [slot.sourceAnalystNodeKey] }))
  const reviewers = bySlot.map(slot => ({ key: slot.reviewerNodeKey, templateId: "cover_letter_reviewer", dependsOn: [slot.writerNodeKey] }))
  const correctionWriters = bySlot.filter(slot => slot.correction).map(slot => ({
    key: slot.correction!.writerNodeKey, templateId: "cover_letter_writer", dependsOn: [slot.reviewerNodeKey],
  }))
  const correctionReviewers = bySlot.filter(slot => slot.correction).map(slot => ({
    key: slot.correction!.reviewerNodeKey, templateId: "cover_letter_reviewer", dependsOn: [slot.correction!.writerNodeKey],
  }))
  return {
    marker: { schemaVersion: OBJECTIVE_TAILOR_GRAPH_SCHEMA_VERSION, sourceNodeCount, slots },
    nodes: [...sources, ...writers, ...reviewers, ...correctionWriters, ...correctionReviewers],
  }
}

describe("Objective Tailor graph codec", () => {
  it("accepts the 27-node reference shape and clones only the closed structural marker", () => {
    const value = fixture()
    expect(value.nodes).toHaveLength(27)
    const parsed = parseObjectiveTailorGraph(value.marker, value.nodes)
    expect(parsed).toEqual(value.marker)
    expect(parsed).not.toBe(value.marker)
    expect(parsed?.slots).not.toBe(value.marker.slots)
    expect(JSON.stringify(parsed)).not.toMatch(/jobId|candidateRef|digest|artifact|sourceMaterial/i)
  })

  it("accepts all eight slots with one correction each at the exact 40-node bound", () => {
    const value = fixture(8, 8, [1, 2, 3, 4, 5, 6, 7, 8])
    expect(value.nodes).toHaveLength(OBJECTIVE_TAILOR_GRAPH_MAX_NODES)
    expect(parseObjectiveTailorGraph(value.marker, value.nodes)?.slots).toHaveLength(8)
  })

  it("accepts cross-wave node ordering when every exact successor follows its predecessor", () => {
    const value = fixture(4, 2, [1, 2])
    const suffix = value.nodes.slice(4)
    value.nodes.splice(4, suffix.length, suffix[0]!, suffix[2]!, suffix[1]!, suffix[4]!, suffix[3]!, suffix[5]!, suffix[6]!, suffix[7]!)
    expect(parseObjectiveTailorGraph(value.marker, value.nodes)).not.toBeNull()
  })

  it("rejects ordinary unmarked and historical graph shapes without changing their parsing", () => {
    const value = fixture()
    expect(parseObjectiveTailorGraph(undefined, value.nodes)).toBeNull()
    expect(parseObjectiveTailorGraph({ schemaVersion: "agent-harness.v2.task-graph", nodes: value.nodes }, value.nodes)).toBeNull()
    expect(parseObjectiveTailorGraph({ ...value.marker, jobId: "private-job" }, value.nodes)).toBeNull()
    expect(parseObjectiveTailorGraph({ ...value.marker, schemaVersion: "agent-harness.v2.objective-tailor-graph.v0" }, value.nodes)).toBeNull()
  })

  it("rejects malformed source prefixes, non-typed source Analysts, and foreign suffix templates", () => {
    const foreignSource = fixture()
    foreignSource.nodes[0] = { ...foreignSource.nodes[0], templateId: "reviewer" }
    expect(parseObjectiveTailorGraph(foreignSource.marker, foreignSource.nodes)).toBeNull()

    const untypedAnalyst = fixture()
    untypedAnalyst.nodes[1] = { ...untypedAnalyst.nodes[1], verificationDisposition: "legacy_unverified" }
    expect(parseObjectiveTailorGraph(untypedAnalyst.marker, untypedAnalyst.nodes)).toBeNull()

    const untypedScout = fixture()
    untypedScout.nodes[0] = { ...untypedScout.nodes[0], verificationDisposition: "specialized" }
    expect(parseObjectiveTailorGraph(untypedScout.marker, untypedScout.nodes)).toBeNull()

    const suffixDependency = fixture()
    suffixDependency.nodes[0] = { ...suffixDependency.nodes[0], dependsOn: ["writer-1"] }
    expect(parseObjectiveTailorGraph(suffixDependency.marker, suffixDependency.nodes)).toBeNull()

    const foreignSuffix = fixture()
    foreignSuffix.nodes[7] = { ...foreignSuffix.nodes[7], templateId: "agent.plan" }
    expect(parseObjectiveTailorGraph(foreignSuffix.marker, foreignSuffix.nodes)).toBeNull()
  })

  it("rejects skipped slots, duplicate claims, missing nodes, and incorrect dependencies", () => {
    const skipped = fixture()
    const slots = skipped.marker.slots as Array<Record<string, unknown>>
    slots[1] = { ...slots[1], slotId: "tailor-3" }
    expect(parseObjectiveTailorGraph(skipped.marker, skipped.nodes)).toBeNull()

    const duplicate = fixture()
    const duplicateSlots = duplicate.marker.slots as Array<Record<string, unknown>>
    duplicateSlots[1] = { ...duplicateSlots[1], writerNodeKey: "writer-1" }
    expect(parseObjectiveTailorGraph(duplicate.marker, duplicate.nodes)).toBeNull()

    const missing = fixture()
    missing.nodes.pop()
    expect(parseObjectiveTailorGraph(missing.marker, missing.nodes)).toBeNull()

    const wrongDependency = fixture()
    wrongDependency.nodes[15] = { ...wrongDependency.nodes[15], dependsOn: ["writer-2"] }
    expect(parseObjectiveTailorGraph(wrongDependency.marker, wrongDependency.nodes)).toBeNull()
  })

  it("rejects successors placed before predecessors and correction pairs bound to the wrong review", () => {
    const reordered = fixture(4, 2, [1])
    const writer = reordered.nodes.findIndex(node => node.key === "writer-1")
    const reviewer = reordered.nodes.findIndex(node => node.key === "reviewer-1")
    ;[reordered.nodes[writer], reordered.nodes[reviewer]] = [reordered.nodes[reviewer]!, reordered.nodes[writer]!]
    expect(parseObjectiveTailorGraph(reordered.marker, reordered.nodes)).toBeNull()

    const wrongCorrection = fixture(4, 2, [1])
    const correctionWriter = wrongCorrection.nodes.findIndex(node => node.key === "correction-writer-1")
    wrongCorrection.nodes[correctionWriter] = { ...wrongCorrection.nodes[correctionWriter], dependsOn: ["reviewer-2"] }
    expect(parseObjectiveTailorGraph(wrongCorrection.marker, wrongCorrection.nodes)).toBeNull()
  })

  it("rejects overflow, sparse arrays, and custom array properties", () => {
    const overflow = fixture(8, 8, [1, 2, 3, 4, 5, 6, 7, 8])
    expect(overflow.nodes).toHaveLength(40)
    overflow.nodes.push({ key: "extra", templateId: "scout", dependsOn: [] })
    expect(overflow.nodes).toHaveLength(41)
    expect(parseObjectiveTailorGraph(overflow.marker, overflow.nodes)).toBeNull()

    const sparse = fixture()
    const sparseSlots = [...sparse.marker.slots as unknown[]]
    delete sparseSlots[0]
    expect(parseObjectiveTailorGraph({ ...sparse.marker, slots: sparseSlots }, sparse.nodes)).toBeNull()

    const custom = fixture()
    Object.assign(custom.marker.slots as object, { extra: true })
    expect(parseObjectiveTailorGraph(custom.marker, custom.nodes)).toBeNull()
  })
})
