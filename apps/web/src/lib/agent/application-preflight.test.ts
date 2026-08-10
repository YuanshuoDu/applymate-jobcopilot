import { describe, expect, it } from "vitest"
import { assessApplicationPreflight, isSupportedAutomatedApplyUrl } from "./application-preflight"

describe("application preflight", () => {
  const base = {
    company: "Learnosity",
    description: "Join the product team with Learnosity. At Learnosity, we build assessment tools.",
    source: "ats",
    url: "https://jobs.lever.co/learnosity/abc123",
  }

  it("allows a consistent job with a direct supported ATS destination", () => {
    expect(assessApplicationPreflight(base)).toEqual({ canPrepare: true, canAutomate: true, issues: [] })
  })

  it("blocks material generation when an explicit description claim contradicts the saved company", () => {
    const result = assessApplicationPreflight({ ...base, company: "Questionmark", url: "https://www.linkedin.com/jobs/view/1" })
    expect(result.canPrepare).toBe(false)
    expect(result.canAutomate).toBe(false)
    expect(result.issues.map(issue => issue.code)).toEqual(["company_mismatch", "unsupported_destination"])
  })

  it("keeps a valid manual-only listing out of autonomous application", () => {
    const result = assessApplicationPreflight({ ...base, url: "https://www.linkedin.com/jobs/view/1" })
    expect(result.canPrepare).toBe(true)
    expect(result.canAutomate).toBe(false)
    expect(result.issues.map(issue => issue.code)).toEqual(["unsupported_destination"])
  })

  it("recognizes every worker-supported ATS destination", () => {
    for (const url of [
      "https://boards.greenhouse.io/acme/jobs/1",
      "https://acme.wd3.myworkdayjobs.com/en-US/jobs/1",
      "https://jobs.lever.co/acme/1",
      "https://jobs.smartrecruiters.com/Acme/1",
      "https://acme.jobs.personio.com/job/1",
    ]) expect(isSupportedAutomatedApplyUrl(url)).toBe(true)
    expect(isSupportedAutomatedApplyUrl("https://www.linkedin.com/jobs/view/1")).toBe(false)
  })

  it("does not treat a vendor marketing page as an automated application", () => {
    expect(isSupportedAutomatedApplyUrl("https://greenhouse.io/products")).toBe(false)
    expect(isSupportedAutomatedApplyUrl("https://lever.co/blog")).toBe(false)
    expect(isSupportedAutomatedApplyUrl("https://smartrecruiters.com/resources")).toBe(false)
  })
})
