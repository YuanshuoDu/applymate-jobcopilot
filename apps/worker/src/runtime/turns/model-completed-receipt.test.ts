import { describe, expect, it } from "vitest"
import { parseModelCompletedReceipt } from "./model-completed-receipt.js"

const legacy = { taskId: "root", provider: "fixture", model: "test" }

describe("model.completed receipt", () => {
  it("accepts the exact legacy shape and a safe emitted tool count", () => {
    expect(parseModelCompletedReceipt(legacy)).toEqual(legacy)
    expect(parseModelCompletedReceipt({ ...legacy, toolCallCount: 2 })).toEqual({ ...legacy, toolCallCount: 2 })
  })

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "2", null])("rejects malformed tool count %s", (toolCallCount) => {
    expect(parseModelCompletedReceipt({ ...legacy, toolCallCount })).toBeNull()
  })

  it("rejects extra keys, hidden/accessor count fields, and foreign prototypes", () => {
    expect(parseModelCompletedReceipt({ ...legacy, toolCallCount: 1, extra: true })).toBeNull()
    const hidden = { ...legacy } as Record<string, unknown>
    Object.defineProperty(hidden, "toolCallCount", { value: 1 })
    expect(parseModelCompletedReceipt(hidden)).toBeNull()
    const accessor = { ...legacy } as Record<string, unknown>
    Object.defineProperty(accessor, "toolCallCount", { enumerable: true, get: () => 1 })
    expect(parseModelCompletedReceipt(accessor)).toBeNull()
    expect(parseModelCompletedReceipt(Object.assign(Object.create({ inherited: true }), legacy))).toBeNull()
  })
})
