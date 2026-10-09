import { describe, expect, it } from "vitest"

import { TASK_GRAPH_LIMITS, type TaskGraphState, type TaskGraphVerificationDisposition } from "../planning/task-graph.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { canonicalTaskGraphJson, parseTaskGraphEvent, parseTaskGraphSnapshot, taskGraphSnapshot, taskGraphState, TASK_GRAPH_SNAPSHOT_VERSION } from "./task-graph-snapshot.js"

const queuedEvent = {
  type: "task.queued",
  idempotencyKey: "task-graph:node-1:queued",
  expectedRevision: 4,
  nodeKey: "node-1",
} as const

describe("parseTaskGraphEvent", () => {
  it("parses task.queued lifecycle events from objects and JSON", () => {
    expect(parseTaskGraphEvent(queuedEvent)).toEqual(queuedEvent)
    expect(parseTaskGraphEvent(JSON.stringify(queuedEvent))).toEqual(queuedEvent)
  })

  it("rejects unknown and malformed lifecycle events", () => {
    expect(parseTaskGraphEvent({ ...queuedEvent, type: "task.unknown" })).toBeNull()
    expect(parseTaskGraphEvent({ ...queuedEvent, nodeKey: " " })).toBeNull()
    expect(parseTaskGraphEvent({ ...queuedEvent, expectedRevision: -1 })).toBeNull()
    expect(parseTaskGraphEvent({ ...queuedEvent, extra: "unexpected" })).toBeNull()
    expect(parseTaskGraphEvent({ ...queuedEvent, type: "task.failed" })).toBeNull()
  })
})

function snapshotWithLists(successCriteria: unknown, dependsOn: unknown) {
  return {
    schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION,
    nodes: [{
      key: "node-1",
      templateId: "scout",
      goal: "Find evidence",
      successCriteria,
      dependsOn,
      depth: 1,
      taskId: "task-1",
    }],
  }
}

function snapshotWithNodes(nodes: readonly unknown[]) {
  return { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes }
}

function storedNode(key: string, dependsOn: string[] = []) {
  return {
    key,
    templateId: "scout",
    goal: `Find evidence for ${key}`,
    successCriteria: ["Evidence found"],
    dependsOn,
    depth: 1,
    taskId: `task-${key}`,
  }
}

const analystVerification = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION,
  role: "analyst",
  criteria: [{ id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } }],
} as const
const scoutVerification = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION,
  role: "scout",
  criteria: [
    { id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } },
    { id: "candidate-evidence", check: { kind: "all_candidates_have_evidence", minimumItems: 1 } },
  ],
} as const

function boundedEightNodeSnapshot(useUnicode: boolean) {
  const keys = Array.from({ length: 8 }, (_, index) => `${"k".repeat(127)}${index}`)
  return snapshotWithNodes(keys.map((key, index) => ({
    key,
    templateId: "t".repeat(128),
    goal: useUnicode ? "😀".repeat(600) : "g".repeat(1200),
    successCriteria: Array.from({ length: 8 }, () => useUnicode ? "😀".repeat(160) : "c".repeat(320)),
    dependsOn: keys.slice(0, index),
    depth: index + 1,
    taskId: `${"x".repeat(127)}${index}`,
  })))
}

describe("parseTaskGraphSnapshot", () => {
  it("parses well-formed dependency and success-criteria arrays", () => {
    expect(parseTaskGraphSnapshot(snapshotWithLists(["Evidence found"], []))).toMatchObject({
      schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION,
      nodes: [{ key: "node-1", successCriteria: ["Evidence found"], dependsOn: [], verificationDisposition: "legacy_unverified" }],
    })
  })

  it("preserves normalized typed contracts in canonical snapshots and identifies old nodes as legacy", () => {
    const typed = parseTaskGraphSnapshot(snapshotWithNodes([{
      ...storedNode("typed"), templateId: "analyst", verification: analystVerification, verificationDisposition: "typed",
    }]))
    expect(typed.nodes[0]).toMatchObject({ verificationDisposition: "typed", verification: analystVerification })
    expect(parseTaskGraphSnapshot(canonicalTaskGraphJson(typed))).toEqual(typed)
    const typedState = taskGraphState(typed, 1, new Map([["task-typed", { status: "retrying", failureReason: null }]]), [])
    const persistedDisposition: TaskGraphVerificationDisposition = typedState.nodes[0].verificationDisposition!
    expect(persistedDisposition).toBe("typed")
    expect(taskGraphSnapshot(typedState, new Map([["typed", "task-typed"]]))).toEqual(typed)

    const legacy = parseTaskGraphSnapshot(snapshotWithNodes([storedNode("old")]))
    expect(legacy.nodes[0]).toMatchObject({ verificationDisposition: "legacy_unverified" })
    expect(legacy.nodes[0]).not.toHaveProperty("verification")
    expect(canonicalTaskGraphJson(legacy)).toContain('"verificationDisposition":"legacy_unverified"')
    expect(parseTaskGraphSnapshot(snapshotWithNodes([{
      ...storedNode("old-writer"), templateId: "cover_letter_writer",
    }])).nodes[0]).toMatchObject({ verificationDisposition: "legacy_unverified" })

    const resumed = taskGraphState(legacy, 1, new Map([["task-old", { status: "queued", failureReason: null }]]), [])
    const rewritten = taskGraphSnapshot(resumed, new Map([["old", "task-old"]]))
    expect(rewritten.nodes[0]).toMatchObject({ verificationDisposition: "legacy_unverified" })
    expect(rewritten.nodes[0]).not.toHaveProperty("verification")
  })

  it("requires a named findings source to be a direct typed registered Scout in the same snapshot", () => {
    const check = { kind: "findings_from_scout_dependency", dependencyNodeKey: "scout-source" }
    const scout = { ...storedNode("scout-source"), verification: scoutVerification, verificationDisposition: "typed" }
    const analyst = {
      ...storedNode("analyst", ["scout-source"]), templateId: "analyst",
      verification: { ...analystVerification, criteria: [{ id: "in-scout", check }] }, verificationDisposition: "typed",
    }
    expect(parseTaskGraphSnapshot(snapshotWithNodes([scout, analyst])).nodes[1]).toMatchObject({ key: "analyst" })

    const middle = { ...storedNode("middle", ["scout-source"]), templateId: "analyst", verification: analystVerification, verificationDisposition: "typed" }
    const legacyScout = { ...storedNode("scout-source"), verificationDisposition: "legacy_unverified" }
    for (const nodes of [
      [scout, { ...analyst, dependsOn: ["middle"] }, middle],
      [legacyScout, analyst],
      [{ ...scout, templateId: "analyst", verification: analystVerification }, analyst],
    ]) {
      expect(() => parseTaskGraphSnapshot(snapshotWithNodes(nodes))).toThrow("task_graph_snapshot_verification_dependency_invalid")
    }
  })

  it("rejects conflicting or invalid verification dispositions instead of upgrading legacy nodes", () => {
    const base = storedNode("node-1")
    for (const node of [
      { ...base, verificationDisposition: "typed" },
      { ...base, verificationDisposition: "legacy_unverified", verification: analystVerification },
      { ...base, verificationDisposition: "specialized" },
      { ...base, verification: analystVerification, verificationDisposition: "typed" },
      { ...base, verificationDisposition: "unknown" },
    ]) {
      expect(() => parseTaskGraphSnapshot(snapshotWithNodes([node]))).toThrow()
    }
  })

  it("round-trips unsupported legacy templates but limits new specialized nodes to Writer and Reviewer", () => {
    const unknownLegacy = storedNode("old-custom")
    unknownLegacy.templateId = "custom_agent"
    const legacySnapshot = parseTaskGraphSnapshot(snapshotWithNodes([unknownLegacy]))
    expect(legacySnapshot.nodes[0]).toMatchObject({ templateId: "custom_agent", verificationDisposition: "legacy_unverified" })
    const restoredState = taskGraphState(legacySnapshot, 1, new Map([["task-old-custom", { status: "queued", failureReason: null }]]), [])
    const rewritten = taskGraphSnapshot(restoredState, new Map([["old-custom", "task-old-custom"]]))
    expect(rewritten.nodes[0]).toMatchObject({ templateId: "custom_agent", verificationDisposition: "legacy_unverified" })
    expect(parseTaskGraphSnapshot(canonicalTaskGraphJson(rewritten))).toEqual(rewritten)
    expect(() => parseTaskGraphSnapshot(snapshotWithNodes([{
      ...unknownLegacy, verificationDisposition: "specialized",
    }]))).toThrow("task_graph_snapshot_verification_disposition_invalid")

    const state: TaskGraphState = {
      revision: 1,
      nodes: [{
        key: "custom", templateId: "custom_agent", goal: "Do custom work",
        successCriteria: ["Complete custom work"], dependsOn: [], depth: 1, status: "queued",
      }],
      appliedEvents: [],
    }
    expect(() => taskGraphSnapshot(state, new Map([["custom", "task-custom"]])))
      .toThrow("task_graph_snapshot_template_unsupported")
  })

  it("keeps new Writer and Reviewer snapshots on their specialized verification paths", () => {
    const state: TaskGraphState = {
      revision: 1,
      nodes: [{
        key: "writer", templateId: "cover_letter_writer", goal: "Create a draft",
        successCriteria: ["Persist draft"], dependsOn: [], depth: 1, status: "queued",
      }, {
        key: "reviewer", templateId: "cover_letter_reviewer", goal: "Review the draft",
        successCriteria: ["Persist review"], dependsOn: ["writer"], depth: 2, status: "queued",
      }],
      appliedEvents: [],
    }
    const snapshot = taskGraphSnapshot(state, new Map([["writer", "task-writer"], ["reviewer", "task-reviewer"]]))

    expect(snapshot.nodes).toMatchObject([
      { key: "writer", verificationDisposition: "specialized" },
      { key: "reviewer", verificationDisposition: "specialized" },
    ])
    expect(snapshot.nodes[0]).not.toHaveProperty("verification")
    expect(snapshot.nodes[1]).not.toHaveProperty("verification")
    expect(parseTaskGraphSnapshot(snapshot)).toEqual(snapshot)
  })

  it("round-trips repair lineage without rewriting its target or marking it passed", () => {
    const target = {
      ...storedNode("target"), verification: scoutVerification, verificationDisposition: "typed",
    }
    const repairOf = { graphRootTaskId: "root-task", nodeKey: "target", taskId: "task-target", criterionIds: ["candidate-count"] }
    const repair = {
      ...storedNode("repair"), verification: { ...scoutVerification, criteria: [scoutVerification.criteria[0]] },
      verificationDisposition: "typed", repairOf,
    }
    const snapshot = parseTaskGraphSnapshot(snapshotWithNodes([target, repair]))
    expect(snapshot.nodes[0]).toMatchObject({ verification: scoutVerification, verificationDisposition: "typed" })
    expect(snapshot.nodes[0]).not.toHaveProperty("repairOf")
    expect(snapshot.nodes[1]?.repairOf).toEqual(repairOf)
    expect(snapshot.nodes[1]).not.toHaveProperty("verdict")
    expect(parseTaskGraphSnapshot(canonicalTaskGraphJson(snapshot))).toEqual(snapshot)

    const state = taskGraphState(snapshot, 1, new Map([
      ["task-target", { status: "completed", failureReason: null }],
      ["task-repair", { status: "queued", failureReason: null }],
    ]), [])
    expect(state.nodes[0]?.taskId).toBe("task-target")
    expect(taskGraphSnapshot(state, new Map([ ["target", "task-target"], ["repair", "task-repair"] ]))).toEqual(snapshot)
  })

  it("rejects stale, future, mismatched, dependent, or untyped repair targets", () => {
    const target = { ...storedNode("target"), verification: scoutVerification, verificationDisposition: "typed" }
    const relation = { graphRootTaskId: "root-task", nodeKey: "target", taskId: "task-target", criterionIds: ["candidate-count"] }
    const repair = {
      ...storedNode("repair"), verification: { ...scoutVerification, criteria: [scoutVerification.criteria[0]] },
      verificationDisposition: "typed", repairOf: relation,
    }
    const legacyTarget = { ...storedNode("target"), verificationDisposition: "legacy_unverified" }
    const invalid = [
      [target, { ...repair, repairOf: { ...relation, taskId: "stale-task" } }],
      [{ ...repair, key: "repair" }, target],
      [target, { ...repair, repairOf: { ...relation, nodeKey: "missing" } }],
      [target, { ...repair, repairOf: { ...relation, criterionIds: ["missing"] } }],
      [target, { ...repair, verification: { ...repair.verification, criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 2 } }] } }],
      [target, { ...repair, verification: scoutVerification }],
      [target, { ...repair, templateId: "analyst", verification: analystVerification }],
      [target, { ...repair, dependsOn: ["target"] }],
      [legacyTarget, repair],
      [target, { ...repair, repairOf: { ...relation, criterionIds: ["candidate-count", "candidate-count"] } }],
      [target, { ...repair, repairOf: { ...relation, graphRootTaskId: " " } }],
    ]
    for (const nodes of invalid) expect(() => parseTaskGraphSnapshot(snapshotWithNodes(nodes))).toThrow()
  })

  it("rejects sparse arrays and arrays with extra own properties", () => {
    const sparseSuccessCriteria = new Array<string>(1)
    const sparseDependencies = new Array<string>(1)
    const extraStringProperty = Object.assign(["Evidence found"], { extra: "unexpected" })
    const extraSymbolProperty = ["node-1"]
    Object.defineProperty(extraSymbolProperty, Symbol("extra"), { value: "unexpected" })

    for (const [successCriteria, dependsOn] of [
      [sparseSuccessCriteria, []],
      [["Evidence found"], sparseDependencies],
      [extraStringProperty, []],
      [["Evidence found"], extraSymbolProperty],
    ]) {
      expect(() => parseTaskGraphSnapshot(snapshotWithLists(successCriteria, dependsOn))).toThrow("task_graph_snapshot_invalid")
    }
  })

  it("rejects duplicate dependency keys", () => {
    const nodes = [storedNode("node-1", ["node-2", "node-2"]), storedNode("node-2")]

    expect(() => parseTaskGraphSnapshot(snapshotWithNodes(nodes))).toThrow("task_graph_snapshot_dependency_invalid")
  })

  it("rejects dependency cycles", () => {
    const nodes = [storedNode("node-1", ["node-2"]), storedNode("node-2", ["node-1"])]

    expect(() => parseTaskGraphSnapshot(snapshotWithNodes(nodes))).toThrow("task_graph_snapshot_cycle_invalid")
  })

  it("rejects unexpected snapshot and node keys and malformed JSON", () => {
    const valid = snapshotWithNodes([storedNode("node-1")])

    expect(() => parseTaskGraphSnapshot({ ...valid, unexpected: true })).toThrow("task_graph_snapshot_invalid")
    expect(() => parseTaskGraphSnapshot(snapshotWithNodes([{ ...storedNode("node-1"), unexpected: true }]))).toThrow("task_graph_snapshot_invalid")
    expect(() => parseTaskGraphSnapshot("{broken json")).toThrow("task_graph_snapshot_invalid")
  })

  it("enforces persisted node, text, list, and depth limits", () => {
    const base = storedNode("node-1")
    const oversizedNodes = Array.from({ length: 9 }, (_, index) => storedNode(`node-${index}`))
    const oversizedCriteria = Array.from({ length: 9 }, () => "criterion")
    const oversizedDependencies = Array.from({ length: 9 }, (_, index) => `node-${index}`)

    for (const snapshot of [
      snapshotWithNodes(oversizedNodes),
      snapshotWithNodes([{ ...base, key: "k".repeat(129) }]),
      snapshotWithNodes([{ ...base, templateId: "t".repeat(129) }]),
      snapshotWithNodes([{ ...base, taskId: "t".repeat(129) }]),
      snapshotWithNodes([{ ...base, goal: "g".repeat(1201) }]),
      snapshotWithNodes([{ ...base, successCriteria: oversizedCriteria }]),
      snapshotWithNodes([{ ...base, successCriteria: ["c".repeat(321)] }]),
      snapshotWithNodes([{ ...base, dependsOn: oversizedDependencies }]),
      snapshotWithNodes([{ ...base, dependsOn: ["d".repeat(129)] }]),
      snapshotWithNodes([{ ...base, depth: 9 }]),
    ]) {
      expect(() => parseTaskGraphSnapshot(snapshot)).toThrow("task_graph_snapshot_invalid")
    }
  })

  it("measures the persisted snapshot cap in UTF-8 bytes of canonical JSON", () => {
    const ascii = boundedEightNodeSnapshot(false)
    const unicode = boundedEightNodeSnapshot(true)
    const asciiBytes = Buffer.byteLength(canonicalTaskGraphJson(ascii), "utf8")
    const unicodeBytes = Buffer.byteLength(canonicalTaskGraphJson(unicode), "utf8")

    expect(asciiBytes).toBeLessThanOrEqual(TASK_GRAPH_LIMITS.maxSnapshotBytes)
    expect(unicodeBytes).toBeGreaterThan(TASK_GRAPH_LIMITS.maxSnapshotBytes)
    expect(() => parseTaskGraphSnapshot(ascii)).not.toThrow()
    expect(() => parseTaskGraphSnapshot(unicode)).toThrow("task_graph_snapshot_too_large")
  })

  it("applies the snapshot byte cap when building the persistence representation", () => {
    const keys = Array.from({ length: 8 }, (_, index) => `${"k".repeat(127)}${index}`)
    const state: TaskGraphState = {
      revision: 1,
      nodes: keys.map((key, index) => ({
        key,
        templateId: "scout",
        goal: "😀".repeat(600),
        successCriteria: Array.from({ length: 8 }, () => "😀".repeat(160)),
        dependsOn: keys.slice(0, index),
        depth: index + 1,
        status: "queued",
      })),
      appliedEvents: [],
    }
    const taskIds = new Map(state.nodes.map((node, index) => [node.key, `task-${index}`] as const))

    expect(() => taskGraphSnapshot(state, taskIds)).toThrow("task_graph_snapshot_too_large")
  })
})
