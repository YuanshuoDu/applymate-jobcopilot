import { describe, expect, it } from "vitest"

import { objectiveStartRequestHash, samePersistedJson } from "./objective-start-attempt-request-identity"
import type { ObjectiveStartCommand } from "./types"

const command: ObjectiveStartCommand = {
  userId: "user_1", sessionId: "session_1", clientMessageId: "attempt_1", source: "user",
  objective: " Find Dublin roles ", content: [{ type: "text", text: "Context" }],
}

describe("objective start request identity", () => {
  it("compares values using JSON persistence semantics and canonical object keys", () => {
    expect(samePersistedJson({ nested: { b: 2, a: 1 }, optional: undefined }, { optional: undefined, nested: { a: 1, b: 2 } })).toBe(true)
    expect(samePersistedJson({ value: undefined }, {})).toBe(true)
    expect(samePersistedJson(undefined, null)).toBe(true)
    expect(samePersistedJson(["first", "second"], ["second", "first"])).toBe(false)
    expect(samePersistedJson(BigInt(1), BigInt(1))).toBe(false)
  })

  it("hashes object keys canonically while preserving array order and content", () => {
    const ordered = {
      ...command,
      content: [
        { type: "attachment_ref" as const, attachmentId: "resume_1", mediaType: "application/pdf", filename: "cv.pdf" },
        { type: "text" as const, text: "Context" },
      ],
    }
    const reordered = {
      ...command,
      content: [
        { filename: "cv.pdf", mediaType: "application/pdf", attachmentId: "resume_1", type: "attachment_ref" as const },
        { text: "Context", type: "text" as const },
      ],
    }

    expect(objectiveStartRequestHash(reordered)).toBe(objectiveStartRequestHash(ordered))
    expect(objectiveStartRequestHash({ ...ordered, content: [...ordered.content].reverse() })).not.toBe(objectiveStartRequestHash(ordered))
    expect(objectiveStartRequestHash({ ...ordered, content: [ordered.content[0], { type: "text", text: "Changed" }] })).not.toBe(objectiveStartRequestHash(ordered))
  })

  it("keeps optional JSON fields persistence-compatible while retaining the requirements sentinel", () => {
    const withUndefinedFilename = {
      ...command,
      content: [{ type: "attachment_ref" as const, attachmentId: "resume_1", mediaType: "application/pdf", filename: undefined }],
    }
    const withoutFilename = {
      ...command,
      content: [{ type: "attachment_ref" as const, attachmentId: "resume_1", mediaType: "application/pdf" }],
    }

    expect(objectiveStartRequestHash(withUndefinedFilename)).toBe(objectiveStartRequestHash(withoutFilename))
    expect(objectiveStartRequestHash({ ...command, verificationRequirements: null })).not.toBe(objectiveStartRequestHash(command))
  })
})
