import { describe, expect, it } from "vitest"

import { CONTEXT_SNAPSHOT_SCHEMA_VERSION, ContextSnapshotError } from "./context-snapshot-types.js"

describe("context snapshot types", () => {
  it("exposes the versioned protocol error boundary", () => {
    expect(CONTEXT_SNAPSHOT_SCHEMA_VERSION).toBe("agent-harness.context.v1")
    expect(new ContextSnapshotError("invalid_input", "invalid").name).toBe("ContextSnapshotError")
  })
})
