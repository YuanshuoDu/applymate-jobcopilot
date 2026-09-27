import { describe, expect, it } from "vitest"

import { TASK_GRAPH_LIMITS, type TaskGraphState } from "../planning/task-graph.js"
import { canonicalTaskGraphJson, parseTaskGraphEvent, parseTaskGraphSnapshot, taskGraphSnapshot, TASK_GRAPH_SNAPSHOT_VERSION } from "./task-graph-snapshot.js"

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
      nodes: [{ key: "node-1", successCriteria: ["Evidence found"], dependsOn: [] }],
    })
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
        templateId: "t".repeat(128),
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
