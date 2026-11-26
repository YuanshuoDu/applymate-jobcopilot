import { describe, expect, it } from "vitest"

import { canonicalTaskGraphReceiptJson } from "./task-graph-receipt-json.js"

describe("canonicalTaskGraphReceiptJson", () => {
  it("sorts plain object keys and parses JSON-object strings like the Worker snapshot codec", () => {
    expect(canonicalTaskGraphReceiptJson({ z: 1, a: { y: 2, b: 3 } }))
      .toBe('{"a":{"b":3,"y":2},"z":1}')
    expect(canonicalTaskGraphReceiptJson('{"z":1,"a":{"y":2,"b":3}}'))
      .toBe('{"a":{"b":3,"y":2},"z":1}')
  })

  it("preserves array order and treats JSON-array strings as strings", () => {
    expect(canonicalTaskGraphReceiptJson([2, 1])).toBe("[2,1]")
    expect(canonicalTaskGraphReceiptJson('[2,1]')).toBe('"[2,1]"')
  })

  it("uses JSON fallback for non-plain or symbol-bearing objects", () => {
    const withSymbol = { value: 1, [Symbol("private")]: 2 }
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, { z: 1, a: 2 })
    expect(canonicalTaskGraphReceiptJson(withSymbol)).toBe('{"value":1}')
    expect(canonicalTaskGraphReceiptJson(new Date("2020-01-01T00:00:00.000Z")))
      .toBe('"2020-01-01T00:00:00.000Z"')
    expect(canonicalTaskGraphReceiptJson(nullPrototype)).toBe('{"a":2,"z":1}')
  })

  it("keeps null and undefined serialization behavior", () => {
    expect(canonicalTaskGraphReceiptJson(null)).toBe("null")
    expect(() => canonicalTaskGraphReceiptJson(undefined)).toThrow("task_graph_json_invalid")
  })
})
