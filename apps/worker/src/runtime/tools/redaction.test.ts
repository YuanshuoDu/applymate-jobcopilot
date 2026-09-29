import { describe, expect, it } from "vitest"

import { InMemoryToolResultReferenceStore, prepareLifecycleValue, prepareSubagentSpawnReceipt, sanitizeForLifecycle } from "./redaction.js"

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

describe("tool lifecycle redaction", () => {
  it("preserves generated spawn lineage after generic redaction would alter a phone-like UUID", () => {
    expect(prepareLifecycleValue(spawnReceipt).safe).not.toEqual(spawnReceipt)
    expect(prepareSubagentSpawnReceipt(spawnReceipt, { turnId, taskId: rootTaskId, rootTaskId }).safe).toEqual(spawnReceipt)
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
