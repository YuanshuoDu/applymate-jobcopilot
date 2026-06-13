/**
 * Unit tests for the Workday CXS discovery source.
 *
 * Uses vitest. No live API calls — all fetch calls are mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { fetchWorkday } from "./workday"
import type { WorkdayEmployer } from "../registries"

// ── Mock the pace module ───────────────────────────────────────────────
vi.mock("../pace/policies", () => ({
  acquire: vi.fn().mockResolvedValue(undefined),
}))

// ── Test helpers ───────────────────────────────────────────────────────

function workdayEmployer(overrides: Partial<WorkdayEmployer> = {}): WorkdayEmployer {
  return {
    name: "TestCo",
    tenant: "testco",
    siteId: "TestCoCareers",
    baseUrl: "https://testco.wd3.myworkdayjobs.com",
    country: "de",
    tier: 1,
    status: "pending",
    ...overrides,
  }
}

function cxsSearchResult(total: number, postings: Array<{ title: string; externalPath: string; locationsText?: string }>) {
  return {
    total,
    jobPostings: postings,
  }
}

function cxsDetail(description: string, externalUrl?: string) {
  return {
    jobPostingInfo: {
      jobDescription: description,
      externalUrl: externalUrl ?? "https://testco.wd3.myworkdayjobs.com/job/123",
    },
  }
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("fetchWorkday", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("(a) happy path: fetches search, paginates, fetches detail for each posting", async () => {
    // Page 1: 2 postings, total=2
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify(cxsSearchResult(2, [
          { title: "Software Engineer", externalPath: "/job/SE/123", locationsText: "Berlin, Germany" },
          { title: "Product Manager", externalPath: "/job/PM/456", locationsText: "Munich, Germany" },
        ])), { status: 200 })
      )
      // Detail for Software Engineer
      .mockResolvedValueOnce(
        new Response(JSON.stringify(cxsDetail(
          "<p>We are looking for a skilled Software Engineer to build scalable backend services. You will work with Python, AWS, and Kubernetes in a fast-paced agile environment across multiple product teams.</p>",
          "https://testco.wd3.myworkdayjobs.com/apply/SE/123",
        )), { status: 200 })
      )
      // Detail for Product Manager
      .mockResolvedValueOnce(
        new Response(JSON.stringify(cxsDetail(
          "<p>Seeking an experienced Product Manager to lead our SaaS platform strategy. You will define product roadmaps, work with engineering and design, and drive product launches in B2B SaaS.</p>",
          "https://testco.wd3.myworkdayjobs.com/apply/PM/456",
        )), { status: 200 })
      )

    const jobs = await fetchWorkday([workdayEmployer()])

    expect(jobs).toHaveLength(2)
    expect(jobs[0]).toMatchObject({
      title:    "Software Engineer",
      company:  "TestCo",
      location: "Berlin, Germany",
      source:   "workday",
    })
    expect(jobs[0].description).toContain("backend services")
    expect(jobs[0].description).not.toContain("<p>")
    expect(jobs[0].url).toBe("https://testco.wd3.myworkdayjobs.com/apply/SE/123")

    expect(jobs[1].title).toBe("Product Manager")
    expect(jobs[1].description).toContain("SaaS platform")
  })

  it("(b) pagination: fetches multiple pages until offset >= total", async () => {
    // Page 1: total=45, 20 postings
    const page1Postings = Array.from({ length: 20 }, (_, i) => ({
      title: `Job ${i + 1}`,
      externalPath: `/job/J${i + 1}`,
      locationsText: "Remote",
    }))

    // Page 2: 20 postings
    const page2Postings = Array.from({ length: 20 }, (_, i) => ({
      title: `Job ${i + 21}`,
      externalPath: `/job/J${i + 21}`,
      locationsText: "Remote",
    }))

    // Page 3: 5 postings (last page)
    const page3Postings = Array.from({ length: 5 }, (_, i) => ({
      title: `Job ${i + 41}`,
      externalPath: `/job/J${i + 41}`,
      locationsText: "Remote",
    }))

    const mockFetch = vi.spyOn(globalThis, "fetch")

    // Page 1 search
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(cxsSearchResult(45, page1Postings)), { status: 200 })
    )
    // 20 detail calls for page 1
    for (let i = 0; i < 20; i++) {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(cxsDetail(`Description for job ${i + 1}. With enough detail to be a real job posting that describes the role and requirements.`)), { status: 200 })
      )
    }

    // Page 2 search
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(cxsSearchResult(45, page2Postings)), { status: 200 })
    )
    // 20 detail calls for page 2
    for (let i = 0; i < 20; i++) {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(cxsDetail(`Description for job ${i + 21}. With enough detail to be a real job posting that describes the role and requirements.`)), { status: 200 })
      )
    }

    // Page 3 search
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(cxsSearchResult(45, page3Postings)), { status: 200 })
    )
    // 5 detail calls for page 3
    for (let i = 0; i < 5; i++) {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(cxsDetail(`Description for job ${i + 41}. With enough detail to be a real job posting that describes the role and requirements.`)), { status: 200 })
      )
    }

    const jobs = await fetchWorkday([workdayEmployer()])

    expect(jobs).toHaveLength(45)
    expect(jobs[0].title).toBe("Job 1")
    expect(jobs[44].title).toBe("Job 45")
    // 3 search calls + 45 detail calls = 48 fetch calls
    expect(mockFetch).toHaveBeenCalledTimes(48)
  })

  it("(c) employer error isolated: one employer failing does not abort others", async () => {
    const mockFetch = vi.spyOn(globalThis, "fetch")

    // Employer A: search returns 404
    mockFetch.mockResolvedValueOnce(
      new Response(null, { status: 404 })
    )

    // Employer B: search returns 1 posting
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(cxsSearchResult(1, [
        { title: "Backend Dev", externalPath: "/job/BD/789", locationsText: "Amsterdam, NL" },
      ])), { status: 200 })
    )
    // Detail for Employer B's posting
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(cxsDetail("Building distributed systems at scale in a dynamic engineering environment.")), { status: 200 })
    )

    const jobs = await fetchWorkday([
      workdayEmployer({ name: "FailingCo", tenant: "fail" }),
      workdayEmployer({ name: "WorkingCo", tenant: "work" }),
    ])

    expect(jobs).toHaveLength(1)
    expect(jobs[0].title).toBe("Backend Dev")
    expect(jobs[0].company).toBe("WorkingCo")
  })

  it("(d) empty result: employer with 0 jobs returns empty array, no error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(cxsSearchResult(0, [])), { status: 200 })
    )

    const jobs = await fetchWorkday([workdayEmployer()])

    expect(jobs).toHaveLength(0)
  })
})
