/**
 * Unit tests for the Lever discovery source.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { fetchLever } from "./lever"

function leverPostings(overrides: Record<string, unknown> = {}) {
  return [{
    id: "abc123",
    text: "Senior Backend Engineer",
    hostedUrl: "https://jobs.lever.co/spotify/abc123",
    descriptionPlain: "Join our platform team to build distributed systems at scale.",
    description: "<p>Join our <strong>platform team</strong>.</p>",
    categories: {
      location: "Stockholm, Sweden",
      commitment: "Full-time",
      department: "Engineering",
    },
    createdAt: 1716300000000,
    ...overrides,
  }]
}

describe("fetchLever", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("maps Lever response to DiscoveredJob shape (happy path)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(leverPostings()), { status: 200 })
    )

    const jobs = await fetchLever(["spotify"])

    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({
      title:    "Senior Backend Engineer",
      company:  "spotify",
      location: "Stockholm, Sweden",
      url:      "https://jobs.lever.co/spotify/abc123",
      source:   "lever",
    })
    expect(jobs[0].description).toContain("Join our platform team")
    expect(jobs[0].description).not.toContain("<strong>")
  })

  it("prefers descriptionPlain over HTML description", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(leverPostings({
        descriptionPlain: "Plain text desc",
        description: "<p><b>HTML</b> desc</p>",
      })), { status: 200 })
    )

    const jobs = await fetchLever(["spotify"])
    expect(jobs[0].description).toBe("Plain text desc")
  })

  it("falls back to stripHtml(description) when descriptionPlain absent", async () => {
    const posting = leverPostings()
    delete (posting[0] as Record<string, unknown>).descriptionPlain
    posting[0].description = "<div><h2>Role</h2><p>We need a <em>senior</em> engineer.</p></div>"

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(posting), { status: 200 })
    )

    const jobs = await fetchLever(["testco"])
    expect(jobs[0].description).toBe("Role We need a senior engineer.")
  })

  it("isolates 404 slugs — continues to next slug", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(leverPostings({ text: "Frontend Dev" })), { status: 200 })
      )

    const jobs = await fetchLever(["nonexistent", "valid-co"])
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].title).toBe("Frontend Dev")
  })

  it("returns empty array on network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("ETIMEDOUT"))
    const jobs = await fetchLever(["timeout-co"])
    expect(jobs).toHaveLength(0)
  })
})