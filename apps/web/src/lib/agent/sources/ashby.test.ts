import { describe, expect, it, vi, beforeEach } from "vitest"

const pinnedFetch = vi.hoisted(() => vi.fn((input: string | URL, init?: unknown) =>
  globalThis.fetch(String(input), init as RequestInit)
))
const acquire = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock("@jobcopilot/shared", async () => {
  const actual = await vi.importActual<typeof import("@jobcopilot/shared")>("@jobcopilot/shared")
  return { ...actual, pinnedFetch }
})
vi.mock("../pace/policies", () => ({ acquire }))

import { fetchAshby } from "./ashby"

function ashbyResponse() {
  return {
    apiVersion: "1",
    jobs: [{
      title: "Senior Software Engineer",
      location: "Berlin",
      secondaryLocations: [{ location: "Remote - European Union" }],
      jobUrl: "https://jobs.ashbyhq.com/acme/job-1",
      applyUrl: "https://jobs.ashbyhq.com/acme/job-1/application",
      isListed: true,
      descriptionHtml: "<h2>About</h2><p>Build reliable systems.</p>",
      compensation: { scrapeableCompensationSalarySummary: "€90K – €120K" },
    }],
  }
}

describe("fetchAshby", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("maps public postings, descriptions, locations, apply URLs, and compensation", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(ashbyResponse()), { status: 200 })
    )

    const jobs = await fetchAshby(["acme"])

    expect(jobs).toEqual([expect.objectContaining({
      title: "Senior Software Engineer",
      company: "acme",
      location: "Berlin · Remote - European Union",
      url: "https://jobs.ashbyhq.com/acme/job-1/application",
      description: "About Build reliable systems.",
      salary: "€90K – €120K",
      source: "ashby",
    })])
  })

  it("does not expose unlisted postings and falls back to the job URL", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ jobs: [
        { ...ashbyResponse().jobs[0], isListed: false },
        { ...ashbyResponse().jobs[0], title: "Backend Engineer", applyUrl: undefined },
      ] }), { status: 200 })
    )

    const jobs = await fetchAshby(["acme"])

    expect(jobs).toHaveLength(1)
    expect(jobs[0].title).toBe("Backend Engineer")
    expect(jobs[0].url).toBe("https://jobs.ashbyhq.com/acme/job-1")
  })

  it("continues past stale boards and network failures", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockRejectedValueOnce(new Error("ETIMEDOUT"))
      .mockResolvedValueOnce(new Response(JSON.stringify(ashbyResponse()), { status: 200 }))

    const jobs = await fetchAshby(["missing", "timeout", "acme"])

    expect(fetch).toHaveBeenCalledTimes(3)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].company).toBe("acme")
  })

  it("returns no jobs for an empty or malformed response", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobs: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))

    expect(await fetchAshby(["empty", "malformed"])).toEqual([])
  })
})
