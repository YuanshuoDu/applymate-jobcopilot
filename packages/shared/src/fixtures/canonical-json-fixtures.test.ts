import { describe, expect, it } from "vitest"

import { canonicalJson, hashContent } from "../canonical-json.js"
import { canonicalJsonFixtures } from "./canonical-json-fixtures.js"

describe("canonical JSON fixtures", () => {
  it("contains self-consistent canonical and hash baselines", () => {
    for (const fixture of canonicalJsonFixtures) {
      expect(canonicalJson(fixture.value), fixture.name).toBe(fixture.canonical)
      expect(hashContent(fixture.value), fixture.name).toBe(fixture.hash)
    }
  })
})
