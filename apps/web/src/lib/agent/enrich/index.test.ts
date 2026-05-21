import { describe, it, expect, vi, beforeEach } from "vitest"

// ── Hoist mock fns so vi.mock factory can reference them ────────────────
const {
  mockFetchViaAtsApi,
  mockDetectAtsUrl,
  mockExtractJsonLdJobPosting,
  mockDetectAtsByUrl,
  mockExtractByCssSelectors,
} = vi.hoisted(() => ({
  mockFetchViaAtsApi: vi.fn(),
  mockDetectAtsUrl: vi.fn(),
  mockExtractJsonLdJobPosting: vi.fn(),
  mockDetectAtsByUrl: vi.fn(),
  mockExtractByCssSelectors: vi.fn(),
}))

vi.mock("./t0-ats-fetch", () => ({
  fetchViaAtsApi: mockFetchViaAtsApi,
}))

vi.mock("./ats-url-detector", () => ({
  detectAtsUrl: mockDetectAtsUrl,
}))

vi.mock("./jsonld", () => ({
  extractJsonLdJobPosting: mockExtractJsonLdJobPosting,
}))

vi.mock("./detect", () => ({
  detectAtsByUrl: mockDetectAtsByUrl,
}))

vi.mock("./css", () => ({
  extractByCssSelectors: mockExtractByCssSelectors,
}))

import { enrichJob } from "./index"
import type { EnrichedJob } from "../types"

const FAKE_HTML = "<html><body>job page</body></html>"
const FAKE_URL = "https://jobs.example.com/job/123"

beforeEach(() => {
  vi.clearAllMocks()
})

describe("enrichJob cascade", () => {
  it("T0 hit: returns ATS API result and short-circuits", async () => {
    const enriched: EnrichedJob = {
      description: "Backend Engineer role at Stripe. Build payment systems.",
      applyUrl: "https://jobs.lever.co/stripe/abc-123",
      method: "t0-ats",
    }

    mockDetectAtsUrl.mockReturnValue({ ats: "lever", slug: "stripe", jobId: "abc-123" })
    mockFetchViaAtsApi.mockResolvedValue(enriched)

    const result = await enrichJob({ html: FAKE_HTML, url: FAKE_URL })

    expect(result).not.toBeNull()
    expect(result!.method).toBe("t0-ats")
    expect(result!.description).toContain("Backend Engineer")
    expect(result!.applyUrl).toBe("https://jobs.lever.co/stripe/abc-123")

    // T1 + T2 should never have been called
    expect(mockExtractJsonLdJobPosting).not.toHaveBeenCalled()
    expect(mockDetectAtsByUrl).not.toHaveBeenCalled()
  })

  it("T1 hit: falls through T0 miss and returns JSON-LD result", async () => {
    // T0 miss
    mockDetectAtsUrl.mockReturnValue(null)

    // T1 hit
    const enriched: EnrichedJob = {
      description: "We are hiring a Senior Frontend Engineer to join our team in Berlin. You will build performant React applications, mentor junior developers, and contribute to our design system. Experience with TypeScript, Next.js, and accessibility is required. We offer competitive salary, remote flexibility, and 30 days vacation.",
      applyUrl: "https://www.example.com/careers/senior-fe",
      employmentType: "FULL_TIME",
      datePosted: "2026-05-15",
      method: "jsonld",
    }
    mockExtractJsonLdJobPosting.mockReturnValue(enriched)

    const result = await enrichJob({ html: FAKE_HTML, url: FAKE_URL })

    expect(result).not.toBeNull()
    expect(result!.method).toBe("jsonld")
    expect(result!.description).toContain("Senior Frontend Engineer")
    expect(result!.employmentType).toBe("FULL_TIME")

    // T0 was queried but no match; T2 should never have been called
    expect(mockFetchViaAtsApi).not.toHaveBeenCalled()
    expect(mockDetectAtsByUrl).not.toHaveBeenCalled()
  })

  it("T2 fallback: returns CSS result when T0+T1 both miss", async () => {
    // T0 miss
    mockDetectAtsUrl.mockReturnValue(null)

    // T1 miss
    mockExtractJsonLdJobPosting.mockReturnValue(null)

    // T2 hit
    mockDetectAtsByUrl.mockReturnValue("greenhouse")
    const enriched: EnrichedJob = {
      description: "Shopify is looking for a Staff Backend Engineer to join our Payments team. You will architect and build the next generation of our payment processing infrastructure, handling billions in transaction volume across multiple markets. This role requires deep expertise in distributed systems, database design, and a commitment to engineering excellence.",
      applyUrl: "https://boards.greenhouse.io/shopify/jobs/6789/apply",
      method: "css",
    }
    mockExtractByCssSelectors.mockReturnValue(enriched)

    const result = await enrichJob({ html: FAKE_HTML, url: FAKE_URL })

    expect(result).not.toBeNull()
    expect(result!.method).toBe("css")
    expect(result!.description).toContain("Staff Backend Engineer")
    expect(result!.description).toContain("payment processing")

    // T1 was tried (returned null), T0 fetch never called (no match)
    expect(mockFetchViaAtsApi).not.toHaveBeenCalled()
    expect(mockExtractJsonLdJobPosting).toHaveBeenCalled()
  })

  it("T3 last resort: returns null when every tier misses", async () => {
    // T0 miss
    mockDetectAtsUrl.mockReturnValue(null)

    // T1 miss
    mockExtractJsonLdJobPosting.mockReturnValue(null)

    // T2 miss
    mockDetectAtsByUrl.mockReturnValue(null)

    const result = await enrichJob({ html: FAKE_HTML, url: FAKE_URL })

    expect(result).toBeNull()

    // All tiers were tried
    expect(mockDetectAtsUrl).toHaveBeenCalled()
    expect(mockExtractJsonLdJobPosting).toHaveBeenCalled()
    expect(mockDetectAtsByUrl).toHaveBeenCalled()
    // extractByCssSelectors never called since detectAtsByUrl returned null
    expect(mockExtractByCssSelectors).not.toHaveBeenCalled()
  })
})
