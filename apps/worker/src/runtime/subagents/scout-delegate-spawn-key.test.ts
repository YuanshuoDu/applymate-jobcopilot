import { describe, expect, it } from "vitest"

import { scoutDelegateSpawnKey } from "./scout-delegate-spawn-key.js"

describe("scoutDelegateSpawnKey", () => {
  it("preserves the existing hash bytes for parent, attempt, and original call", () => {
    expect(scoutDelegateSpawnKey("parent-task", 2, "call-9"))
      .toBe("scout-delegate:306236f1d0285b44c4495dcf747be31b91e25aab11b4a5bc41da0ece2fa03414")
  })

  it("changes the operation key when any idempotency field changes", () => {
    const key = scoutDelegateSpawnKey("parent-task", 2, "call-9")
    expect(scoutDelegateSpawnKey("other-parent", 2, "call-9")).not.toBe(key)
    expect(scoutDelegateSpawnKey("parent-task", 1, "call-9")).not.toBe(key)
    expect(scoutDelegateSpawnKey("parent-task", 2, "call-10")).not.toBe(key)
  })
})
