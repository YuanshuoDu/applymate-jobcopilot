import { describe, expect, it } from "vitest"

import { canonicalJson, sha256Hex } from "./context-compaction-canonical.js"

describe("compaction canonical encoding", () => {
  it("normalizes object key order and bigint sequences", () => {
    expect(canonicalJson({ z: 1, a: 2n })).toBe('{"a":"2","z":1}')
    expect(sha256Hex({ a: 1 })).toBe(sha256Hex({ a: 1 }))
  })

  it("rejects non-canonical values", () => {
    expect(() => canonicalJson({ missing: undefined })).toThrow("canonical JSON")
    expect(() => canonicalJson({ invalid: Number.NaN })).toThrow("finite")
  })
})
