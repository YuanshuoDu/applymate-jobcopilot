import { describe, expect, it } from "vitest"

import type { ContextSnapshotCompactionPort } from "./context-snapshot-compaction-seam.js"

describe("AH2-034 snapshot compaction seam", () => {
  it("requires atomic publish and has no history deletion method", () => {
    const methods: readonly (keyof ContextSnapshotCompactionPort)[] = ["loadLatest", "recordStarted", "publishAtomically", "recordFailed"]
    expect(methods).not.toContain("delete")
    expect(methods).toContain("publishAtomically")
  })
})
