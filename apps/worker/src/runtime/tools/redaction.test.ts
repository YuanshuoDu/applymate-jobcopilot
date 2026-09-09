import { describe, expect, it } from "vitest"

import { InMemoryToolResultReferenceStore, sanitizeForLifecycle } from "./redaction.js"

describe("tool lifecycle redaction", () => {
  it("redacts secrets and personal contact keys", async () => {
    const references = new InMemoryToolResultReferenceStore()
    const safe = await sanitizeForLifecycle({ email: "candidate@example.com", password: "secret", bearer: "Bearer abcdefghijk", value: "private fact", content: "resume body", role: "Engineer", message: "token=should-not-leak" }, references)
    expect(safe).toEqual({ email: "[REDACTED]", password: "[REDACTED]", bearer: "Bearer [REDACTED]", value: "[REDACTED]", content: "[REDACTED]", role: "Engineer", message: "token=[REDACTED]" })
  })

  it("returns bounded metadata without creating an in-memory reference", async () => {
    const references = new InMemoryToolResultReferenceStore()
    const safe = await sanitizeForLifecycle({ description: "x".repeat(9_000), apiKey: "never-store-raw" }, references, 256)
    expect(safe).toMatchObject({ $truncated: true, sizeBytes: expect.any(Number), sha256: expect.any(String) })
    expect(JSON.stringify(safe)).not.toContain("never-store-raw")
    expect(references.get("tool-result:unused")).toBeUndefined()
  })
})
