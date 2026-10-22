import { describe, expect, it } from "vitest"
import { redactSensitiveText } from "@jobcopilot/shared"

import { TASK_GRAPH_LIMITS } from "../planning/task-graph.js"
import { NATIVE_VERIFICATION_REPORT_SCHEMA } from "../subagents/native-verification-contract.js"
import { InMemoryToolResultReferenceStore, prepareDurableWaitOutput, prepareLifecycleValue, prepareScheduledPrepareLifecycleOutput, prepareSubagentSpawnReceipt, prepareTaskGraphPlanReceipt, sanitizeForLifecycle } from "./redaction.js"
import { nativeCoordinationOutput } from "./task-graph-coordination-bridge.js"
import type { TaskGraphNativeCommandReceipt } from "../subagents/task-graph-command-port.js"
import { ROLE_RESULT_SCHEMA } from "../subagents/role-results.js"

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

const prepareTaskId = "subagent-0e34de21-c5e7-4db7-8e75-904732813337"
const prepareJobId = "c123456789012345678901234"
const prepareOutput = {
  schemaVersion: ROLE_RESULT_SCHEMA,
  role: "prepare",
  status: "completed",
  taskId: prepareTaskId,
  attemptCount: 1,
  snapshotDigest: `sha256:${"a".repeat(64)}`,
  checkpointDigest: "b".repeat(64),
  jobs: [{ jobId: prepareJobId, status: "prepared" }],
  materials: [{ jobId: prepareJobId, kind: "resume", artifactRef: {
    artifactId: `scheduled-draft:${"e".repeat(64)}`,
    version: 1,
    contentHash: `sha256:${"c".repeat(64)}`,
    sourceDigest: `sha256:${"d".repeat(64)}`,
  } }],
} as const

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
  it("preserves only a valid scheduled Prepare receipt and its artifact digests", () => {
    expect(redactSensitiveText(prepareTaskId)).not.toBe(prepareTaskId)
    const prepared = prepareScheduledPrepareLifecycleOutput(prepareOutput, prepareTaskId)
    expect(prepared.safe).toEqual(prepareOutput)
    expect(prepared.safe).toHaveProperty("materials.0.artifactRef.contentHash", prepareOutput.materials[0]!.artifactRef.contentHash)
    expect(Object.keys(prepared.safe as Record<string, unknown>).sort()).toEqual([
      "attemptCount", "checkpointDigest", "jobs", "materials", "role", "schemaVersion", "snapshotDigest", "status", "taskId",
    ])
  })

  it("rejects a mismatched task, extra private body, and malformed Prepare shape or digest", () => {
    expect(() => prepareScheduledPrepareLifecycleOutput(prepareOutput, "another-task"))
      .toThrow("scheduled_prepare_lifecycle_output_invalid")
    expect(() => prepareScheduledPrepareLifecycleOutput({ ...prepareOutput, coverLetterBody: "private letter" }, prepareTaskId))
      .toThrow("scheduled_prepare_lifecycle_output_invalid")
    expect(() => prepareScheduledPrepareLifecycleOutput({
      ...prepareOutput, materials: [{ ...prepareOutput.materials[0]!, artifactRef: {
        ...prepareOutput.materials[0]!.artifactRef, contentHash: "redacted",
      } }],
    }, prepareTaskId)).toThrow("scheduled_prepare_lifecycle_output_invalid")
    expect(() => prepareScheduledPrepareLifecycleOutput({ ...prepareOutput, jobs: "malformed" }, prepareTaskId))
      .toThrow("scheduled_prepare_lifecycle_output_invalid")
  })

  it("rejects task, job, and artifact identifiers that the text redactor would alter", () => {
    const emailTaskId = "candidate@example.com"
    expect(() => prepareScheduledPrepareLifecycleOutput({ ...prepareOutput, taskId: emailTaskId }, emailTaskId))
      .toThrow("scheduled_prepare_lifecycle_output_invalid")
    expect(() => prepareScheduledPrepareLifecycleOutput({
      ...prepareOutput, jobs: [{ jobId: "candidate 555 010 1234", status: "prepared" }],
      materials: [{ ...prepareOutput.materials[0]!, jobId: "candidate 555 010 1234" }],
    }, prepareTaskId)).toThrow("scheduled_prepare_lifecycle_output_invalid")
    expect(() => prepareScheduledPrepareLifecycleOutput({
      ...prepareOutput, materials: [{ ...prepareOutput.materials[0]!, artifactRef: {
        ...prepareOutput.materials[0]!.artifactRef, artifactId: "sk-supersecret123",
      } }],
    }, prepareTaskId)).toThrow("scheduled_prepare_lifecycle_output_invalid")
  })

  it("requires opaque subagent task IDs and Prisma CUID job IDs", () => {
    expect(redactSensitiveText(prepareJobId)).toBe(prepareJobId)
    expect(() => prepareScheduledPrepareLifecycleOutput(prepareOutput, prepareTaskId)).not.toThrow()
    expect(() => prepareScheduledPrepareLifecycleOutput({ ...prepareOutput, taskId: "candidate" }, "candidate"))
      .toThrow("scheduled_prepare_lifecycle_output_invalid")
    expect(() => prepareScheduledPrepareLifecycleOutput({ ...prepareOutput, taskId: "sk-supersecret123" }, "sk-supersecret123"))
      .toThrow("scheduled_prepare_lifecycle_output_invalid")
    expect(() => prepareScheduledPrepareLifecycleOutput({
      ...prepareOutput, jobs: [{ jobId: "candidate", status: "prepared" }],
      materials: [{ ...prepareOutput.materials[0]!, jobId: "candidate" }],
    }, prepareTaskId)).toThrow("scheduled_prepare_lifecycle_output_invalid")
    expect(() => prepareScheduledPrepareLifecycleOutput({
      ...prepareOutput, jobs: [{ jobId: "sk-supersecret123", status: "prepared" }],
      materials: [{ ...prepareOutput.materials[0]!, jobId: "sk-supersecret123" }],
    }, prepareTaskId)).toThrow("scheduled_prepare_lifecycle_output_invalid")
    const malformedJobId = `c${"1".repeat(23)}`
    expect(() => prepareScheduledPrepareLifecycleOutput({
      ...prepareOutput, jobs: [{ jobId: malformedJobId, status: "prepared" }],
      materials: [{ ...prepareOutput.materials[0]!, jobId: malformedJobId }],
    }, prepareTaskId)).toThrow("scheduled_prepare_lifecycle_output_invalid")
  })

  it("requires the generated scheduled-draft digest format for artifact identifiers", () => {
    const numericDigestArtifactId = `scheduled-draft:${"1".repeat(64)}`
    expect(redactSensitiveText(numericDigestArtifactId)).not.toBe(numericDigestArtifactId)
    const numericDigestOutput = {
      ...prepareOutput,
      materials: [{ ...prepareOutput.materials[0]!, artifactRef: {
        ...prepareOutput.materials[0]!.artifactRef, artifactId: numericDigestArtifactId,
      } }],
    }
    expect(() => prepareScheduledPrepareLifecycleOutput(numericDigestOutput, prepareTaskId)).not.toThrow()
    expect(() => prepareScheduledPrepareLifecycleOutput({
      ...prepareOutput, materials: [{ ...prepareOutput.materials[0]!, artifactRef: {
        ...prepareOutput.materials[0]!.artifactRef, artifactId: "Jane-Doe",
      } }],
    }, prepareTaskId)).toThrow("scheduled_prepare_lifecycle_output_invalid")
  })

  it("rejects accessors at the Prepare receipt and nested material levels without invoking them", () => {
    let getterInvoked = false
    const topLevel = { ...prepareOutput }
    Object.defineProperty(topLevel, "taskId", { enumerable: true, get: () => { getterInvoked = true; return prepareTaskId } })
    expect(() => prepareScheduledPrepareLifecycleOutput(topLevel, prepareTaskId))
      .toThrow("scheduled_prepare_lifecycle_output_invalid")
    expect(getterInvoked).toBe(false)

    const nested = { ...prepareOutput, materials: [{
      ...prepareOutput.materials[0]!, artifactRef: { ...prepareOutput.materials[0]!.artifactRef },
    }] }
    Object.defineProperty(nested.materials[0]!.artifactRef, "contentHash", {
      enumerable: true, get: () => { getterInvoked = true; return prepareOutput.materials[0]!.artifactRef.contentHash },
    })
    expect(() => prepareScheduledPrepareLifecycleOutput(nested, prepareTaskId))
      .toThrow("scheduled_prepare_lifecycle_output_invalid")
    expect(getterInvoked).toBe(false)
  })

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

  it("applies the native feedback projection in prepareDurableWaitOutput", () => {
    const output = durableWaitOutput()
    Object.assign(output.tasks[0]!.result, { nativeVerificationReport: {
      schemaVersion: NATIVE_VERIFICATION_REPORT_SCHEMA,
      controlOperationId: "verify-op",
      controlTaskId: durableWaitTaskId,
      controlAttempt: 1,
      owner: { userId: "user-1", sessionId: "session-1", turnId, rootTaskId, parentTaskId: null },
      target: { kind: "root_goal", candidateDigest: "a".repeat(64), childBindingSetDigest: "b".repeat(64) },
      goalDigest: "c".repeat(64), criteriaDigest: "d".repeat(64), evidencePacketDigest: "e".repeat(64), disposition: "passed",
      criteria: [{ criterionId: "criterion-1", disposition: "passed", reasonCode: "meets_criterion", evidenceReferenceIds: ["target-ref"] }],
    } })

    const safe = prepareDurableWaitOutput(output).safe as Record<string, unknown>
    const tasks = safe.tasks as Array<Record<string, unknown>>
    expect(tasks[0]?.result).toMatchObject({
      nativeVerificationFeedback: {
        disposition: "passed",
        criteria: [{ criterionId: "criterion-1", disposition: "passed", reasonCode: "meets_criterion", evidenceReferenceIds: ["target-ref"] }],
      },
    })
    expect(JSON.stringify(safe)).not.toContain("nativeVerificationReport")
    expect(JSON.stringify(safe)).not.toContain("evidencePacketDigest")
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
