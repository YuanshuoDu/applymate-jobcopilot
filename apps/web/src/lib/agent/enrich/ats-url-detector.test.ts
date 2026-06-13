import { describe, it, expect } from "vitest"
import { detectAtsUrl, AtsMatch } from "./ats-url-detector"

describe("detectAtsUrl", () => {
  it("detects standard Greenhouse boards URL", () => {
    const r = detectAtsUrl("https://boards.greenhouse.io/shopify/jobs/6789123")
    expect(r).not.toBeNull()
    expect(r!.ats).toBe("greenhouse")
    expect(r!.slug).toBe("shopify")
    expect(r!.jobId).toBe("6789123")
  })

  it("detects Greenhouse subdomain variant", () => {
    const r = detectAtsUrl("https://booking.greenhouse.io/jobs/123456")
    expect(r).not.toBeNull()
    expect(r!.ats).toBe("greenhouse")
    expect(r!.slug).toBe("booking")
    expect(r!.jobId).toBe("123456")
  })

  it("detects standard Lever jobs URL", () => {
    const r = detectAtsUrl("https://jobs.lever.co/stripe/abc-123-def-456")
    expect(r).not.toBeNull()
    expect(r!.ats).toBe("lever")
    expect(r!.slug).toBe("stripe")
    expect(r!.jobId).toBe("abc-123-def-456")
  })

  it("detects Lever app posting variant", () => {
    const r = detectAtsUrl("https://app.lever.co/posting/spotify/def789abc012")
    expect(r).not.toBeNull()
    expect(r!.ats).toBe("lever")
    expect(r!.slug).toBe("spotify")
    expect(r!.jobId).toBe("def789abc012")
  })

  it("returns null for LinkedIn URL", () => {
    expect(detectAtsUrl("https://www.linkedin.com/jobs/view/12345")).toBeNull()
  })

  it("returns null for company homepage", () => {
    expect(detectAtsUrl("https://example.com/careers")).toBeNull()
  })

  it("returns null for empty string", () => {
    expect(detectAtsUrl("")).toBeNull()
  })

  it("returns null for malformed URL — no throw", () => {
    expect(() => detectAtsUrl("not a url at all")).not.toThrow()
    expect(detectAtsUrl("not a url at all")).toBeNull()
  })
})
