import { describe, expect, it, vi } from "vitest"
import type pg from "pg"

import { attachTurnQuestionStore } from "./turn-question-store-factory.js"

describe("attachTurnQuestionStore", () => {
  it("preserves existing store methods and adds the durable question methods", () => {
    const base = { existing: vi.fn(() => "kept") }
    const store = attachTurnQuestionStore(base, { connect: vi.fn() } as unknown as Pick<pg.Pool, "connect">)
    expect(store.existing()).toBe("kept")
    expect(store.stageQuestionUsage).toEqual(expect.any(Function))
    expect(store.cancelPausedQuestion).toEqual(expect.any(Function))
    expect(store.waitForQuestion).toEqual(expect.any(Function))
    expect(store.readPendingQuestion).toEqual(expect.any(Function))
  })
})
