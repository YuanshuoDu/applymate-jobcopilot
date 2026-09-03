import { describe, expect, it } from "vitest"

import { canonicalJson } from "./context-snapshot-json.js"

describe("context snapshot canonical JSON", () => {
  it("sorts object keys and normalizes bigint values", () => {
    expect(canonicalJson({ b: 2, a: 1, cursor: 4n })).toBe('{"a":1,"b":2,"cursor":"4"}')
  })

  it("rejects values that cannot be represented deterministically", () => {
    expect(() => canonicalJson({ value: undefined })).toThrow("undefined")
    expect(() => canonicalJson({ value: Number.NaN })).toThrow("finite")
  })

  it("fails closed when a snapshot would persist credential material", () => {
    expect(() => canonicalJson({ apiKey: "sk-live-secret-value" })).toThrow("secret material")
    expect(() => canonicalJson({ note: "Authorization: Bearer abcdefghijk" })).toThrow("secret material")
  })
})
