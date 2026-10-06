import { describe, expect, it } from "vitest"

import { TASK_GRAPH_LIMITS } from "../planning/task-graph.js"
import { InMemoryToolResultReferenceStore, prepareDurableWaitOutput, prepareLifecycleValue, prepareSubagentSpawnReceipt, prepareTaskGraphPlanReceipt, sanitizeForLifecycle } from "./redaction.js"
import { nativeCoordinationOutput } from "./task-graph-coordination-bridge.js"
import type { TaskGraphNativeCommandReceipt } from "../subagents/task-graph-command-port.js"

const turnId = "c123456789012345678901234"
const rootTaskId = `root-${turnId}`
const taskId = "subagent-0e34de21-c5e7-4db7-8e75-904732813337"
const spawnReceipt = {
  taskId,
  rootTaskId,
  parentTaskId: rootTaskId,
  path: `/${rootTaskId}/${taskId}`,
  depth: 1,
  status: "queued",
  replay: false,
} as const
const nativeCommandReceipt: TaskGraphNativeCommandReceipt = {
  status: "accepted", replay: false, operationId: "native-operation-1", requestFingerprint: "a".repeat(64),
  graphRevision: 2, nodeKey: "native-node-1", dispatchDisposition: "pending",
  child: { taskId, rootTaskId, parentTaskId: rootTaskId, path: spawnReceipt.path, depth: 1, role: "scout", taskType: "research", status: "queued" },
}
const nativeSpawnReceipt = nativeCoordinationOutput("spawn", rootTaskId, nativeCommandReceipt)
const nativeSourceTaskId = "subagent-12345678-1234-4abc-8def-123456789012"
const nativeFollowupChildId = "subagent-87654321-4321-4abc-8def-210987654321"
const nativeFollowupReceipt = {
  ...nativeCoordinationOutput("followup", rootTaskId, {
    ...nativeCommandReceipt,
    operationId: "native-followup-1",
    child: { ...nativeCommandReceipt.child, taskId: nativeFollowupChildId, path: `/${rootTaskId}/${nativeFollowupChildId}` },
    source: { taskId: nativeSourceTaskId, rootTaskId, parentTaskId: rootTaskId, turnId, role: "scout", taskType: "research", status: "cancelled", attemptCount: 0, resultDigest: "b".repeat(64), graphNodeKey: null, origin: "native_legacy" },
  }),
  sourceTaskId: nativeSourceTaskId,
}

const durableWaitId = "wait-12345678-1234-4234-9234-123456789012"
const durableWaitTaskId = "subagent-12345678-1234-4234-9234-123456789012"

function durableWaitOutput() {
  return {
    waitId: durableWaitId,
    status: "ready",
    taskIds: [durableWaitTaskId],
    deadlineAt: "2026-10-04T12:00:00.000Z",
    matchedTaskIds: [durableWaitTaskId],
    tasks: [{
      taskId: durableWaitTaskId,
      status: "completed",
      role: "scout",
      result: {
        description: "Contact candidate@example.com at 202-555-0199",
        privateNotes: { content: "private candidate details" },
      },
      failureReason: null,
    }],
  }
}

describe("tool lifecycle redaction", () => {
  it("uses the shared TaskGraph limits for plan receipts", () => {
    const node = (index: number, key: string) => ({
      key,
      taskId: `subagent-00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      status: "queued" as const,
    })
    const receipt = (nodes: ReturnType<typeof node>[]) => ({
      status: "accepted" as const,
      revision: 1,
      nodes,
      readyTaskIds: nodes.map(item => item.taskId),
    })
    const atNodeLimit = Array.from({ length: TASK_GRAPH_LIMITS.maxNodes }, (_, index) => node(index, `task-${index}`))
    expect(() => prepareTaskGraphPlanReceipt(receipt(atNodeLimit))).not.toThrow()
    expect(() => prepareTaskGraphPlanReceipt(receipt([...atNodeLimit, node(atNodeLimit.length, "overflow")]))).toThrow("task_graph_receipt_invalid")

    const atKeyLimit = receipt([node(0, "k".repeat(TASK_GRAPH_LIMITS.maxKeyLength))])
    expect(() => prepareTaskGraphPlanReceipt(atKeyLimit)).not.toThrow()
    expect(() => prepareTaskGraphPlanReceipt({
      ...atKeyLimit,
      nodes: [node(0, `${"k".repeat(TASK_GRAPH_LIMITS.maxKeyLength)}k`)],
    })).toThrow("task_graph_receipt_invalid")
  })

  it("preserves canonical wait IDs while redacting private text in the same receipt", () => {
    const output = durableWaitOutput()

    expect(prepareLifecycleValue(output).safe).not.toEqual(output)
    expect(prepareDurableWaitOutput(output).safe).toEqual({
      waitId: durableWaitId,
      status: "ready",
      taskIds: [durableWaitTaskId],
      deadlineAt: "2026-10-04T12:00:00.000Z",
      matchedTaskIds: [durableWaitTaskId],
      tasks: [{
        taskId: durableWaitTaskId,
        status: "completed",
        role: "scout",
        result: {
          description: "Contact [REDACTED_EMAIL] at [REDACTED_PHONE]",
          privateNotes: { content: "[REDACTED]" },
        },
        failureReason: null,
      }],
    })
  })

  it("rejects malformed, incomplete, and accessor-shaped durable wait receipts", () => {
    expect(() => prepareDurableWaitOutput({
      ...durableWaitOutput(),
      waitId: "wait-123",
    })).toThrow("durable_wait_receipt_invalid")
    expect(() => prepareDurableWaitOutput({ waitId: durableWaitId, status: "ready" })).toThrow("durable_wait_receipt_invalid")
    expect(() => prepareDurableWaitOutput({
      ...durableWaitOutput(),
      injected: "candidate@example.com",
    })).toThrow("durable_wait_receipt_invalid")

    const accessorReceipt = durableWaitOutput()
    Object.defineProperty(accessorReceipt, "waitId", {
      enumerable: true,
      get: () => durableWaitId,
    })
    expect(() => prepareDurableWaitOutput(accessorReceipt)).toThrow("durable_wait_receipt_invalid")
  })

  it("preserves generated spawn lineage after generic redaction would alter a phone-like UUID", () => {
    expect(prepareLifecycleValue(spawnReceipt).safe).not.toEqual(spawnReceipt)
    expect(prepareSubagentSpawnReceipt(spawnReceipt, { turnId, taskId: rootTaskId, rootTaskId }).safe).toEqual(spawnReceipt)
  })

  it("preserves only strict native spawn and follow-up envelopes bound to their child and root", () => {
    expect(prepareSubagentSpawnReceipt(nativeSpawnReceipt, { turnId, taskId: rootTaskId, rootTaskId, toolName: "agent.spawn" }).safe).toEqual(nativeSpawnReceipt)
    expect(prepareSubagentSpawnReceipt(nativeSpawnReceipt, { turnId, taskId: rootTaskId, rootTaskId, toolName: "spawn_subagent" }).safe).toEqual(nativeSpawnReceipt)
    expect(prepareSubagentSpawnReceipt(nativeFollowupReceipt, { turnId, taskId: rootTaskId, rootTaskId, toolName: "agent.followup" }).safe).toEqual(nativeFollowupReceipt)

    const malformed = [
      { ...nativeSpawnReceipt, taskId: "subagent-99999999-9999-4999-8999-999999999999" },
      { ...nativeSpawnReceipt, rootTaskId: "root-foreign" },
      { ...nativeSpawnReceipt, nativeCoordination: { ...nativeSpawnReceipt.nativeCoordination, rootTaskId: "root-foreign", child: { ...nativeSpawnReceipt.nativeCoordination.child, rootTaskId: "root-foreign", parentTaskId: "root-foreign" } } },
      { ...nativeSpawnReceipt, nativeCoordination: { ...nativeSpawnReceipt.nativeCoordination, extra: "untrusted" } },
      { ...nativeFollowupReceipt, nativeCoordination: { ...nativeFollowupReceipt.nativeCoordination, operationKind: "spawn" } },
    ]
    for (const receipt of malformed) {
      const toolName = Object.hasOwn(receipt, "sourceTaskId") ? "agent.followup" : "agent.spawn"
      expect(() => prepareSubagentSpawnReceipt(receipt, { turnId, taskId: rootTaskId, rootTaskId, toolName })).toThrow("subagent_spawn_receipt_invalid")
    }
  })

  it("accepts a depth-zero self-root spawn and rejects malformed lineage or extra fields", () => {
    const ownRoot = { ...spawnReceipt, rootTaskId: taskId, parentTaskId: null, path: `/${taskId}`, depth: 0 }
    expect(prepareSubagentSpawnReceipt(ownRoot, { turnId }).safe).toEqual(ownRoot)

    const rootAsNewTask = { ...ownRoot, taskId: rootTaskId, rootTaskId, path: `/${rootTaskId}` }
    expect(() => prepareSubagentSpawnReceipt(rootAsNewTask, { turnId })).toThrow("subagent_spawn_receipt_invalid")

    const malformed = [
      { ...spawnReceipt, extra: "candidate@example.com" },
      { ...spawnReceipt, parentTaskId: "root-other" },
      { ...spawnReceipt, rootTaskId: "root-other" },
      { ...spawnReceipt, path: `/${rootTaskId}/${taskId}/extra` },
      { ...spawnReceipt, depth: 2 },
      { ...spawnReceipt, taskId: "subagent-12345678-1234-3123-8def-123456789012", path: `/${rootTaskId}/subagent-12345678-1234-3123-8def-123456789012` },
    ]
    for (const receipt of malformed) {
      expect(() => prepareSubagentSpawnReceipt(receipt, { turnId, taskId: rootTaskId, rootTaskId })).toThrow("subagent_spawn_receipt_invalid")
    }
  })
  it("redacts secrets and personal contact keys", async () => {
    const references = new InMemoryToolResultReferenceStore()
    const safe = await sanitizeForLifecycle({ email: "candidate@example.com", password: "secret", bearer: "Bearer abcdefghijk", value: "private fact", content: "resume body", role: "Engineer", message: "token=should-not-leak" }, references)
    expect(safe).toEqual({ email: "[REDACTED]", password: "[REDACTED]", bearer: "Bearer [REDACTED]", value: "[REDACTED]", content: "[REDACTED]", role: "Engineer", message: "token=[REDACTED]" })
  })

  it("returns bounded metadata without creating an in-memory reference", async () => {
    const references = new InMemoryToolResultReferenceStore()
    const safe = await sanitizeForLifecycle({ description: "x".repeat(9_000), apiKey: "never-store-raw" }, references, 256)
    expect(safe).toMatchObject({ $truncated: true, sizeBytes: expect.any(Number), sha256: expect.any(String) })
    expect(JSON.stringify(safe)).not.toContain("never-store-raw")
    expect(references.get("tool-result:unused")).toBeUndefined()
  })
})
