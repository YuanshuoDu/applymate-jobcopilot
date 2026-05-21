import { describe, it, expect, vi, afterEach } from "vitest"

// Mock the DB module so we don't need Prisma client at test time
vi.mock("@/lib/db", () => ({
  db: {
    atsEmployer: {
      upsert: vi.fn().mockResolvedValue({}),
    },
  },
}))

// Mock the pace module to skip rate-limiting in tests
vi.mock("../pace/policies", () => ({
  acquire: vi.fn().mockResolvedValue(undefined),
}))

import { fetchViaAtsApi } from "./t0-ats-fetch"
import type { AtsMatch } from "./ats-url-detector"

// Helper: create a mock fetch that returns the given JSON
function mockFetchOnce(body: unknown, status = 200) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("fetchViaAtsApi", () => {
  it("fetches Greenhouse job from API and returns EnrichedJob", async () => {
    mockFetchOnce({
      title: "Software Engineer",
      content: "<p>We are looking for a skilled Software Engineer to join our team. You will design, develop, and maintain scalable backend services using Python and AWS. Experience with distributed systems and microservices architecture is a strong plus.</p>",
      absolute_url: "https://boards.greenhouse.io/shopify/jobs/6789",
    })

    const match: AtsMatch = { ats: "greenhouse", slug: "shopify", jobId: "6789" }
    const result = await fetchViaAtsApi(match)

    expect(result).not.toBeNull()
    expect(result!.method).toBe("t0-ats")
    expect(result!.description).toContain("Software Engineer")
    expect(result!.description).toContain("distributed systems")
    expect(result!.applyUrl).toBe("https://boards.greenhouse.io/shopify/jobs/6789")
  })

  it("fetches Lever job from API and returns EnrichedJob", async () => {
    mockFetchOnce([
      {
        id: "abc-123",
        text: "Data Scientist",
        hostedUrl: "https://jobs.lever.co/stripe/abc-123",
        descriptionPlain: "We are hiring a Data Scientist to build predictive models and analyze large-scale datasets. You will work closely with our product and engineering teams to drive data-informed decisions across the organization.",
      },
    ])

    const match: AtsMatch = { ats: "lever", slug: "stripe", jobId: "abc-123" }
    const result = await fetchViaAtsApi(match)

    expect(result).not.toBeNull()
    expect(result!.method).toBe("t0-ats")
    expect(result!.description).toContain("Data Scientist")
    expect(result!.description).toContain("predictive models")
    expect(result!.applyUrl).toBe("https://jobs.lever.co/stripe/abc-123")
  })

  it("returns null when API returns 404", async () => {
    mockFetchOnce({}, 404)

    const match: AtsMatch = { ats: "greenhouse", slug: "nonexistent", jobId: "999" }
    const result = await fetchViaAtsApi(match)

    expect(result).toBeNull()
  })

  it("returns null when fetch throws (network error)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")))

    const match: AtsMatch = { ats: "lever", slug: "testco", jobId: "xxx" }
    const result = await fetchViaAtsApi(match)

    expect(result).toBeNull()
  })
})
