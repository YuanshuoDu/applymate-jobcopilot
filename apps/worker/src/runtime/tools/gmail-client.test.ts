import { describe, expect, it, vi } from "vitest"
import type pg from "pg"

import { createGmailClient, createPgGmailCredentialPort } from "./gmail-client.js"

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } })
}

describe("Gmail API client", () => {
  it("creates a draft through drafts and never sends it", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/drafts")
      expect(init?.method).toBe("POST")
      expect(String(init?.body)).not.toContain("drafts/send")
      return response({ id: "draft-a", message: { id: "message-a", threadId: "thread-a" } })
    })
    const result = await createGmailClient(fetcher as unknown as typeof fetch).createDraft("access-token", { idempotencyKey: "draft-key", jobId: "job-a", to: "a@example.com", subject: "Hi", body: "Body" }, new AbortController().signal)
    expect(result).toEqual({ draftId: "draft-a", messageId: "message-a", threadId: "thread-a" })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("sends only an approved draft id through drafts/send and requires provider evidence", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/drafts/send")
      expect(JSON.parse(String(init?.body))).toEqual({ id: "draft-a" })
      return response({ id: "sent-a", threadId: "thread-a" })
    })
    await expect(createGmailClient(fetcher as unknown as typeof fetch).sendDraft("access-token", "draft-a", new AbortController().signal)).resolves.toEqual({ messageId: "sent-a", threadId: "thread-a" })
  })

  it("does not invent a draft id when Gmail omits evidence", async () => {
    const fetcher = vi.fn(async () => response({ message: {} }))
    await expect(createGmailClient(fetcher as unknown as typeof fetch).createDraft("access-token", { idempotencyKey: "draft-key", jobId: "job-a", to: "a@example.com", subject: "Hi", body: "Body" }, new AbortController().signal)).rejects.toMatchObject({ code: "gmail_http_error" })
  })

  it("looks up credentials only through the requested tenant", async () => {
    const query = vi.fn(async (_sql: string, values?: readonly unknown[]) => {
      expect(values).toEqual(["user-a"])
      return { rows: [] }
    })
    await expect(createPgGmailCredentialPort({ query } as unknown as Pick<pg.Pool, "query">).getAccessToken("user-a")).resolves.toBeNull()
  })
})
