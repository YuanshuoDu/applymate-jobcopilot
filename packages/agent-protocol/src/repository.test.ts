import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { isRepositoryJsonValue } from "./repository-contract.js"

describe("repository protocol boundary", () => {
  it("accepts JSON values and rejects provider/runtime objects", () => {
    expect(isRepositoryJsonValue({ nested: ["ok", 1, false, null] })).toBe(true)
    expect(isRepositoryJsonValue(new Date())).toBe(false)
    expect(isRepositoryJsonValue(undefined)).toBe(false)
  })

  it("stays type-only and provider-neutral", () => {
    const source = readFileSync(new URL("./repository.ts", import.meta.url), "utf8")
    expect(source).not.toMatch(/from\s+["'](?:pg|@prisma\/)/)
    expect(source).not.toMatch(/require\s*\(/)
  })
})
