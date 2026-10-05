import { describe, expect, it, vi } from "vitest"
import type pg from "pg"

import { createPgContextOwnerFence } from "./step-context-owner-fence.js"

describe("PostgreSQL StepContext owner fence", () => {
  it("resolves known reference and attachment owners using the existing tenant columns", async () => {
    const query = vi.fn(async (sql: unknown, values: readonly unknown[] = []) => String(sql).includes('"Resume"')
      ? { rows: [{ id: "resume-a", name: "canonical.pdf" }] }
      : values[1] === "user-a" ? { rows: [{ id: values[0] }] } : { rows: [] })
    const client = { query, release: vi.fn() }
    const fence = createPgContextOwnerFence({ connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">,
      (code, message) => Object.assign(new Error(message), { code }))

    await fence.assertReferenceOwned({ id: "job-a", kind: "job", ownerId: "user-a" }, { userId: "user-a" })
    await expect(fence.assertAttachmentOwned({ type: "attachment_ref", attachmentId: "resume-a", mediaType: "text/plain" }, { userId: "user-a" }))
      .resolves.toEqual({ attachmentId: "resume-a", filename: "canonical.pdf" })
    expect(query).toHaveBeenCalledWith(expect.stringContaining('"userId" = $2'), ["job-a", "user-a"])
    expect(query).toHaveBeenCalledWith(expect.stringContaining('"userId" = $2'), ["resume-a", "user-a"])
  })

  it("rejects a reference that is not owned by the requesting tenant", async () => {
    const client = { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() }
    const fence = createPgContextOwnerFence({ connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">,
      (code, message) => Object.assign(new Error(message), { code }))
    await expect(fence.assertReferenceOwned({ id: "job-b", kind: "job", ownerId: "user-a" }, { userId: "user-a" }))
      .rejects.toMatchObject({ code: "reference_owner_mismatch" })
  })
})
