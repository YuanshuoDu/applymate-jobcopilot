import { describe, expect, it } from "vitest"

import { normalizeAgentLocation, normalizeAgentLocationAllowlist } from "./agent-location-normalization.js"

describe("agent location normalization", () => {
  it("uses NFKC, trim, whitespace folding, and lowercase without aliases", () => {
    expect(normalizeAgentLocation("  Ｄｕｂｌｉｎ\u00a0\tIreland  ")).toBe("dublin ireland")
    expect(normalizeAgentLocation("Dublin")).not.toBe(normalizeAgentLocation("Dublin, Ireland"))
    expect(normalizeAgentLocation("Remote")).toBe("remote")
  })

  it("rejects non-string and empty locations", () => {
    for (const value of [undefined, null, 1, "", " \t\n "]) expect(normalizeAgentLocation(value)).toBeNull()
  })

  it("sorts and deduplicates normalized values", () => {
    expect(normalizeAgentLocationAllowlist(["Cork", " Dublin ", "dublin", "Belfast"])).toEqual(["belfast", "cork", "dublin"])
  })

  it("rejects empty, oversized, sparse, and overlong allowlists", () => {
    expect(normalizeAgentLocationAllowlist([])).toBeNull()
    expect(normalizeAgentLocationAllowlist(Array(9).fill("Dublin"))).toBeNull()
    expect(normalizeAgentLocationAllowlist(["x".repeat(129)])).toBeNull()
    expect(normalizeAgentLocationAllowlist(new Array(1))).toBeNull()
    expect(normalizeAgentLocationAllowlist(["🟦".repeat(33)])).toBeNull()
  })
})
