import { describe, expect, it } from "vitest"

import { canonicalJson, CanonicalJsonError, hashContent } from "./canonical-json.js"
import { canonicalJsonFixtures } from "./fixtures/canonical-json-fixtures.js"

describe("shared canonical JSON", () => {
  it.each(canonicalJsonFixtures)("matches the locked baseline for $name", fixture => {
    expect(canonicalJson(fixture.value)).toBe(fixture.canonical)
    expect(hashContent(fixture.value)).toBe(fixture.hash)
  })

  it("is insensitive to object insertion order while preserving array order", () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}')
    expect(canonicalJson(["b", "a"])).toBe('["b","a"]')
  })

  it("sorts keys by deterministic code-unit comparison, not locale collation", () => {
    expect(canonicalJson({ z: 1, "ä": 2, a: 3 })).toBe('{"a":3,"z":1,"ä":2}')
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("rejects non-finite number %s", value => {
    expect(() => canonicalJson(value)).toThrow(CanonicalJsonError)
  })

  it("rejects unsupported values", () => {
    expect(() => canonicalJson(undefined)).toThrow(CanonicalJsonError)
    expect(() => canonicalJson(BigInt(1))).toThrow(CanonicalJsonError)
  })
})
