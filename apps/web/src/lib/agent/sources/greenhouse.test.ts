/**
 * Unit tests for the Greenhouse discovery source.
 *
 * Uses vitest. No live API calls — all fetch calls are mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { fetchGreenhouse } from "./greenhouse"

function greenhouseJob(overrides: Record<string, unknown> = {}) {
  return {
    jobs: [{
      id: 12345,
      title: "Software Engineer",
      absolute_url: "https://boards.greenhouse.io/booking/jobs/12345",
      location: { name: "Amsterdam, Netherlands" },
      content: "<p>Build great things with us.</p><ul><li>React</li><li>Node.js</li></ul>",
      ...overrides,
    }],
  }
}

describe("fetchGreenhouse", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("maps Greenhouse response to DiscoveredJob shape (happy path)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(greenhouseJob()), { status: 200 })
    )

    const jobs = await fetchGreenhouse(["booking"])

    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({
      title:    "Software Engineer",
      company:  "booking",
      location: "Amsterdam, Netherlands",
      url:      "https://boards.greenhouse.io/booking/jobs/12345",
      source:   "greenhouse",
    })
    expect(jobs[0].description).toContain("Build great things with us")
    expect(jobs[0].description).not.toContain("<p>")
    expect(jobs[0].description).not.toContain("<li>")
  })

  it("isolates 404 slugs — continues to next slug", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(greenhouseJob({ title: "Backend Dev", id: 99999 })),
          { status: 200 }
        )
      )

    const jobs = await fetchGreenhouse(["nonexistent", "valid-co"])

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].title).toBe("Backend Dev")
    expect(jobs[0].company).toBe("valid-co")
  })

  it("strips HTML from job description content", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify(greenhouseJob({
          content: "<div><h2>About the role</h2><p>We are hiring a <strong>senior</strong> engineer.</p><p>&amp; bonuses!</p></div>",
        })),
        { status: 200 }
      )
    )

    const jobs = await fetchGreenhouse(["testco"])

    expect(jobs[0].description).toBe(
      "About the role We are hiring a senior engineer. & bonuses!"
    )
  })

  it("returns empty array when API returns no jobs", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ jobs: [] }), { status: 200 })
    )

    const jobs = await fetchGreenhouse(["empty-co"])
    expect(jobs).toHaveLength(0)
  })

  it("returns empty array on network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("ETIMEDOUT"))

    const jobs = await fetchGreenhouse(["timeout-co"])
    expect(jobs).toHaveLength(0)
  })
})