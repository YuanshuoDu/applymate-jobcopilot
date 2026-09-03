import { describe, expect, it } from "vitest"

import { roleProfile } from "./role-profiles.js"

describe("subagent role profiles", () => {
  it("keeps model and context profiles independent per role", () => {
    const writer = roleProfile("writer")
    const reviewer = roleProfile("reviewer")
    expect(writer.role).toBe("writer")
    expect(reviewer.role).toBe("reviewer")
    expect(writer.model.model).not.toBe(reviewer.model.model)
    expect(writer.context.sources).not.toContain("findings")
    expect(reviewer.context.sources).toEqual(expect.arrayContaining(["findings", "evidence"]))
  })

  it("returns defensive profile copies", () => {
    const first = roleProfile("writer")
    const second = roleProfile("writer")
    expect(first.context.sources).not.toBe(second.context.sources)
    expect(first.model).not.toBe(second.model)
  })
})
