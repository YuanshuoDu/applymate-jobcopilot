import { describe, it, expect } from "vitest"
import {
  dedupJobs,
  normalizeCompany,
  normalizeTitle,
  normalizeLocation,
} from "./dedup"
import type { DiscoveredJob } from "./discover"

function job(overrides: Partial<DiscoveredJob> = {}): DiscoveredJob {
  return {
    title:       "Software Engineer",
    company:     "Acme Corp",
    location:    "Berlin, Germany",
    url:         "https://example.com/job/1",
    description: "Build great software at Acme.",
    salary:      null,
    logo:        null,
    source:      "greenhouse",
    ...overrides,
  }
}

describe("normalizeCompany", () => {
  it("strips AG suffix", () => {
    expect(normalizeCompany("Siemens AG")).toBe("siemens")
  })

  it("strips GmbH suffix", () => {
    expect(normalizeCompany("SAP GmbH")).toBe("sap")
  })

  it("strips B.V. suffix with dots", () => {
    expect(normalizeCompany("Booking.com B.V.")).toBe("bookingcom")
  })

  it("strips multiple suffixes", () => {
    expect(normalizeCompany("Acme Corp Ltd")).toBe("acme")
  })
})

describe("normalizeTitle", () => {
  it("strips (m/f/d)", () => {
    expect(normalizeTitle("Senior Software Engineer (m/f/d)")).toBe("senior software engineer")
  })

  it("strips (m/w/d)", () => {
    expect(normalizeTitle("Backend Developer (m/w/d)")).toBe("backend developer")
  })

  it("strips (all genders)", () => {
    expect(normalizeTitle("Product Manager (all genders)")).toBe("product manager")
  })
})

describe("normalizeLocation", () => {
  it("replaces umlauts", () => {
    expect(normalizeLocation("München, Bayern")).toBe("munich")
  })

  it("keeps ASCII location unchanged", () => {
    expect(normalizeLocation("Berlin, Germany")).toBe("berlin")
  })

  it("normalizes Zürich", () => {
    expect(normalizeLocation("Zürich, Switzerland")).toBe("zurich")
  })
})

describe("dedupJobs", () => {
  it("exact duplicate — keeps first", () => {
    const jobs = [
      job({ company: "Siemens", title: "Engineer", location: "Berlin" }),
      job({ company: "Siemens", title: "Engineer", location: "Berlin" }),
    ]
    expect(dedupJobs(jobs)).toHaveLength(1)
  })

  it("company legal suffix — matches", () => {
    const jobs = [
      job({ company: "Siemens AG", title: "Engineer", location: "Berlin" }),
      job({ company: "Siemens",    title: "Engineer", location: "Berlin" }),
    ]
    const result = dedupJobs(jobs)
    expect(result).toHaveLength(1)
    expect(result[0].company).toBe("Siemens AG") // first found kept
  })

  it("title (m/f/d) — matches", () => {
    const jobs = [
      job({ title: "Engineer (m/f/d)", company: "Acme" }),
      job({ title: "Engineer",         company: "Acme" }),
    ]
    expect(dedupJobs(jobs)).toHaveLength(1)
  })

  it("location umlaut variant — matches", () => {
    const jobs = [
      job({ company: "Acme", title: "Dev", location: "München, Bayern" }),
      job({ company: "Acme", title: "Dev", location: "Munich, Germany" }),
    ]
    expect(dedupJobs(jobs)).toHaveLength(1)
  })

  it("location city-only vs city+country — matches by city", () => {
    const jobs = [
      job({ company: "Acme", title: "Dev", location: "Berlin" }),
      job({ company: "Acme", title: "Dev", location: "Berlin, Germany" }),
    ]
    expect(dedupJobs(jobs)).toHaveLength(1)
  })

  it("keeps job with full description over short snippet", () => {
    const short = job({
      company: "Siemens", title: "Engineer",
      description: "Short snippet under 200 chars.",
      source: "linkedin",
    })
    const full = job({
      company: "Siemens AG", title: "Engineer (m/f/d)",
      description: "L".repeat(250),
      source: "greenhouse",
    })
    const result = dedupJobs([short, full])
    expect(result).toHaveLength(1)
    expect(result[0].source).toBe("greenhouse")
    expect(result[0].description!.length).toBeGreaterThanOrEqual(200)
  })

  it("keeps longer description when both have full descriptions", () => {
    const shorter = job({
      company: "Acme", title: "Dev",
      description: "A".repeat(200),
      source: "lever",
    })
    const longer = job({
      company: "Acme Corp", title: "Dev (m/f/d)",
      description: "B".repeat(500),
      source: "greenhouse",
    })
    const result = dedupJobs([shorter, longer])
    expect(result).toHaveLength(1)
    expect(result[0].source).toBe("greenhouse")
  })

  it("3-way duplicate — keeps best description", () => {
    const noDesc = job({ company: "A", title: "X", description: "" })
    const short  = job({ company: "A Inc", title: "X (m/f/d)", description: "x".repeat(50) })
    const full   = job({ company: "A Inc.", title: "X (m/w/d)", description: "y".repeat(300) })
    const result = dedupJobs([noDesc, short, full])
    expect(result).toHaveLength(1)
    expect(result[0].description).toBe("y".repeat(300))
  })

  it("no duplicates — returns all jobs unchanged", () => {
    const jobs = [
      job({ company: "A", title: "X", location: "Berlin" }),
      job({ company: "B", title: "Y", location: "Munich" }),
      job({ company: "A", title: "Z", location: "Berlin" }), // different title
    ]
    expect(dedupJobs(jobs)).toHaveLength(3)
  })

  it("empty array — returns empty", () => {
    expect(dedupJobs([])).toHaveLength(0)
  })

  it("company with SE suffix", () => {
    const jobs = [
      job({ company: "Flix SE", title: "Engineer", location: "Munich" }),
      job({ company: "Flix",    title: "Engineer", location: "Munich" }),
    ]
    expect(dedupJobs(jobs)).toHaveLength(1)
  })
})