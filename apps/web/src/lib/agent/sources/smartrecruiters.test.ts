/**
 * Unit tests for the SmartRecruiters discovery source.
 *
 * Uses vitest. No live API calls — all fetch calls are mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { fetchSmartRecruiters } from "./smartrecruiters"

function listResponse() {
  return {
    offset: 0,
    limit: 100,
    totalFound: 1,
    content: [{
      id: "744000129815717",
      name: "Product Designer",
      ref: "https://api.smartrecruiters.com/v1/companies/SmartRecruiters/postings/744000129815717",
      company: {
        identifier: "smartrecruiters",
        name: "SmartRecruiters Inc",
      },
      location: {
        city: "United Kingdom",
        region: "REMOTE",
        country: "gb",
        remote: true,
        fullLocation: "United Kingdom, REMOTE, United Kingdom",
      },
    }],
  }
}

function detailResponse() {
  return {
    id: "744000129815717",
    name: "Product Designer",
    company: {
      identifier: "smartrecruiters",
      name: "SmartRecruiters Inc",
    },
    location: {
      city: "United Kingdom",
      region: "REMOTE",
      country: "gb",
      remote: true,
      fullLocation: "United Kingdom, REMOTE, United Kingdom",
    },
    postingUrl: "https://jobs.smartrecruiters.com/smartrecruiters/744000129815717-product-designer",
    applyUrl: "https://jobs.smartrecruiters.com/smartrecruiters/744000129815717-product-designer?oga=true",
    jobAd: {
      sections: {
        companyDescription: {
          title: "Company Description",
          text: "<p>SmartRecruiters is the Recruiting AI Company.</p>",
        },
        jobDescription: {
          title: "Job Description",
          text: "<p>Design clear product experiences.</p><ul><li>Prototype</li><li>Research</li></ul>",
        },
        qualifications: {
          title: "Qualifications",
          text: "<p>3+ years of product design experience.</p>",
        },
      },
    },
  }
}

describe("fetchSmartRecruiters", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("maps SmartRecruiters responses to DiscoveredJob shape with full descriptions", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify(listResponse()), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(detailResponse()), { status: 200 }))

    const jobs = await fetchSmartRecruiters("SmartRecruiters")

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({
      title:    "Product Designer",
      company:  "SmartRecruiters Inc",
      location: "United Kingdom, REMOTE, United Kingdom",
      url:      "https://jobs.smartrecruiters.com/smartrecruiters/744000129815717-product-designer?oga=true",
      source:   "smartrecruiters",
    })
    expect(jobs[0].description).toContain("SmartRecruiters is the Recruiting AI Company.")
    expect(jobs[0].description).toContain("Design clear product experiences.")
    expect(jobs[0].description).not.toContain("<p>")
    expect(jobs[0].description).not.toContain("<li>")
  })

  it("returns empty array when API returns no postings", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ offset: 0, limit: 100, totalFound: 0, content: [] }), { status: 200 })
    )

    const jobs = await fetchSmartRecruiters("empty-company")

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(jobs).toHaveLength(0)
  })
})
