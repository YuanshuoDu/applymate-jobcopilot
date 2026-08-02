import { describe, expect, it } from "vitest"
import { forEachConcurrent } from "./concurrency"

describe("forEachConcurrent", () => {
  it("caps simultaneous independent work while visiting every item", async () => {
    let active = 0
    let peak = 0
    const completed: number[] = []
    await forEachConcurrent([1, 2, 3, 4, 5], 2, async value => {
      active++; peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 1))
      completed.push(value); active--
    })
    expect(peak).toBe(2)
    expect(completed.sort()).toEqual([1, 2, 3, 4, 5])
  })
})
