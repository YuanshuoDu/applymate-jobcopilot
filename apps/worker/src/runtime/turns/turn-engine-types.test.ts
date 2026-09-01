import { describe, expect, it } from "vitest"

import { TurnEngineError, toRepositoryJson } from "./turn-engine-types.js"

describe("TurnEngine repository JSON boundary", () => {
  it("normalizes object order and omits undefined object fields", () => {
    expect(toRepositoryJson({ z: 1, a: undefined, nested: { b: true, a: "first" } })).toEqual({ z: 1, nested: { a: "first", b: true } })
  })

  it("converts undefined array values to null", () => {
    expect(toRepositoryJson([undefined, "value"])).toEqual([null, "value"])
  })

  it("rejects non-finite output before it reaches persistence", () => {
    expect(() => toRepositoryJson({ cost: Number.NaN })).toThrowError(TurnEngineError)
    expect(() => toRepositoryJson({ cost: Number.NaN })).toThrow("non-finite")
  })
})
