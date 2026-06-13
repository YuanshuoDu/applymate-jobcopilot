import { describe, it, expect } from "vitest"
import { detectAtsByUrl } from "./detect"

describe("detectAtsByUrl", () => {
  // Workday — 3 variants
  it("detects Workday URL — wd3 subdomain", () => {
    expect(detectAtsByUrl("https://booking.wd3.myworkdayjobs.com/Careers/job")).toBe("workday")
  })
  it("detects Workday URL — wd5 subdomain", () => {
    expect(detectAtsByUrl("https://siemens.wd5.myworkdayjobs.com/en-US/jobs")).toBe("workday")
  })
  it("detects Workday URL — wd1 subdomain", () => {
    expect(detectAtsByUrl("https://zalando.wd1.myworkdayjobs.com/external/job")).toBe("workday")
  })

  // Greenhouse — 3 variants
  it("detects Greenhouse URL — boards subdomain", () => {
    expect(detectAtsByUrl("https://boards.greenhouse.io/shopify/jobs/6789123")).toBe("greenhouse")
  })
  it("detects Greenhouse URL — company subdomain", () => {
    expect(detectAtsByUrl("https://booking.greenhouse.io/jobs/123456")).toBe("greenhouse")
  })
  it("detects Greenhouse URL — embed variant", () => {
    expect(detectAtsByUrl("https://job-boards.greenhouse.io/embed/job_app?for=stripe")).toBe("greenhouse")
  })

  // Lever — 3 variants
  it("detects Lever URL — jobs subdomain", () => {
    expect(detectAtsByUrl("https://jobs.lever.co/stripe/abc-123-def")).toBe("lever")
  })
  it("detects Lever URL — app subdomain", () => {
    expect(detectAtsByUrl("https://app.lever.co/posting/spotify/xyz789")).toBe("lever")
  })
  it("detects Lever URL — direct job listing", () => {
    expect(detectAtsByUrl("https://jobs.lever.co/aircall/8d9a2b3c")).toBe("lever")
  })

  // SmartRecruiters — 2 variants
  it("detects SmartRecruiters URL — careers subdomain", () => {
    expect(detectAtsByUrl("https://careers.smartrecruiters.com/Company/job/123")).toBe("smartrecruiters")
  })
  it("detects SmartRecruiters URL — company subdomain", () => {
    expect(detectAtsByUrl("https://company.smartrecruiters.com/jobs")).toBe("smartrecruiters")
  })

  // Null cases
  it("returns null for LinkedIn URL", () => {
    expect(detectAtsByUrl("https://www.linkedin.com/jobs/view/12345")).toBeNull()
  })
  it("returns null for company homepage", () => {
    expect(detectAtsByUrl("https://example.com/careers")).toBeNull()
  })
})
