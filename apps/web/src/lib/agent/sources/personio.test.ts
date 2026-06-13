import { describe, it, expect, vi, beforeEach } from "vitest"
import { fetchPersonio } from "./personio"

// ── Modern Personio XML feed fixtures ─────────────────────────────────────────

const MODERN_TWO_JOBS = `<?xml version="1.0" encoding="UTF-8"?>
<workzag-jobs>
  <position>
    <id>1834171</id>
    <subcompany>Personio SE &amp; Co. KG</subcompany>
    <office>Munich</office>
    <additionalOffices><office>Berlin</office></additionalOffices>
    <department>Product and Tech</department>
    <recruitingCategory>Engineering</recruitingCategory>
    <name>Staff Software Engineer, Data Platform</name>
    <jobDescriptions>Build and scale the data platform serving millions of HR transactions daily.</jobDescriptions>
    <employmentType>permanent</employmentType>
    <seniority>experienced</seniority>
    <schedule>full-time</schedule>
    <yearsOfExperience>7-10</yearsOfExperience>
    <occupation>software_and_web_development</occupation>
    <occupationCategory>it_software</occupationCategory>
    <createdAt>2024-11-13T14:10:41+00:00</createdAt>
  </position>
  <position>
    <id>2000123</id>
    <subcompany>Personio SE &amp; Co. KG</subcompany>
    <office>Berlin</office>
    <department>Engineering</department>
    <name>Senior Frontend Engineer</name>
    <jobDescriptions>Lead our React-based design system and frontend platform.</jobDescriptions>
    <employmentType>permanent</employmentType>
    <seniority>experienced</seniority>
    <schedule>full-time</schedule>
    <createdAt>2025-01-15T09:00:00+00:00</createdAt>
  </position>
</workzag-jobs>`

const MODERN_EMPTY = `<?xml version="1.0" encoding="UTF-8"?><workzag-jobs></workzag-jobs>`

const MODERN_CDATA = `<?xml version="1.0" encoding="UTF-8"?>
<workzag-jobs>
  <position>
    <id>999</id>
    <name>DevOps Engineer</name>
    <subcompany>Test GmbH</subcompany>
    <office>Hamburg</office>
    <jobDescriptions><![CDATA[Deploy & manage cloud infrastructure using Terraform and AWS.]]></jobDescriptions>
    <employmentType>contract</employmentType>
  </position>
</workzag-jobs>`

const MODERN_NO_DESC = `<?xml version="1.0" encoding="UTF-8"?>
<workzag-jobs>
  <position><id>555</id><name>Backend Developer</name><subcompany>SomeCo</subcompany><office>Remote</office><jobDescriptions></jobDescriptions></position>
</workzag-jobs>`

// ── Legacy German XML feed fixtures ───────────────────────────────────────────

const LEGACY_TWO_JOBS = `<?xml version="1.0" encoding="UTF-8"?>
<stellenanzeigen>
  <stellenanzeige>
    <id>42</id>
    <title>Senior Backend Engineer (m/f/d)</title>
    <unternehmen>Flix SE</unternehmen>
    <stadt>Berlin</stadt>
    <land>Deutschland</land>
    <stellenbeschreibung><![CDATA[We are looking for a Senior Backend Engineer.]]></stellenbeschreibung>
    <url>https://flixbus.jobs.personio.com/job/42</url>
  </stellenanzeige>
  <stellenanzeige>
    <id>43</id>
    <title>Product Manager</title>
    <unternehmen>Flix SE</unternehmen>
    <stadt>Munchen</stadt>
    <land>Deutschland</land>
    <stellenbeschreibung>Drive the mobile roadmap.</stellenbeschreibung>
    <url>https://flixbus.jobs.personio.com/job/43</url>
  </stellenanzeige>
</stellenanzeigen>`

const LEGACY_EMPTY = `<?xml version="1.0" encoding="UTF-8"?><stellenanzeigen></stellenanzeigen>`

const LEGACY_MISSING_FIELDS = `<?xml version="1.0" encoding="UTF-8"?>
<stellenanzeigen>
  <stellenanzeige>
    <id>10</id>
    <title>Has Title Has ID No URL</title>
    <unternehmen>SomeCorp</unternehmen>
    <stadt>Berlin</stadt>
  </stellenanzeige>
  <stellenanzeige>
    <url>https://only-url.jobs.personio.com/job/20</url>
  </stellenanzeige>
</stellenanzeigen>`

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("fetchPersonio — modern XML format", () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it("parses a valid modern XML feed with multiple jobs", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(MODERN_TWO_JOBS, { status: 200, headers: { "Content-Type": "application/xml" } })
    )
    const jobs = await fetchPersonio("personio")

    expect(jobs).toHaveLength(2)
    expect(jobs[0].title).toBe("Staff Software Engineer, Data Platform")
    expect(jobs[0].company).toBe("Personio SE & Co. KG")
    expect(jobs[0].location).toContain("Munich")
    expect(jobs[0].url).toBe("https://personio.jobs.personio.com/job/1834171")
    expect(jobs[0].description).toContain("data platform")
    expect(jobs[0].source).toBe("personio")
    expect(jobs[0].salary).toBe("permanent")
    expect(jobs[1].title).toBe("Senior Frontend Engineer")
    expect(jobs[1].url).toBe("https://personio.jobs.personio.com/job/2000123")
  })

  it("returns empty array for a feed with no jobs", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(MODERN_EMPTY, { status: 200 })
    )
    expect(await fetchPersonio("emptyco")).toHaveLength(0)
  })

  it("decodes CDATA in job descriptions", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(MODERN_CDATA, { status: 200 })
    )
    const jobs = await fetchPersonio("testgmbh")
    expect(jobs).toHaveLength(1)
    expect(jobs[0].description).toContain("Terraform and AWS")
    expect(jobs[0].salary).toBe("contract")
  })

  it("handles empty job descriptions gracefully", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(MODERN_NO_DESC, { status: 200 })
    )
    const jobs = await fetchPersonio("someco")
    expect(jobs).toHaveLength(1)
    expect(jobs[0].description).toBe("")
  })

  it("returns empty array on HTTP 404", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("NF", { status: 404 }))
    expect(await fetchPersonio("no")).toHaveLength(0)
  })

  it("returns empty array on network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("fail"))
    expect(await fetchPersonio("off")).toHaveLength(0)
  })
})

describe("fetchPersonio — legacy German XML format", () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it("parses a valid legacy German feed with multiple jobs", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(LEGACY_TWO_JOBS, { status: 200 })
    )
    const jobs = await fetchPersonio("flixbus")
    expect(jobs).toHaveLength(2)
    expect(jobs[0].title).toBe("Senior Backend Engineer (m/f/d)")
    expect(jobs[0].company).toBe("Flix SE")
    expect(jobs[0].location).toBe("Berlin, Deutschland")
    expect(jobs[0].url).toBe("https://flixbus.jobs.personio.com/job/42")
    expect(jobs[0].source).toBe("personio")
  })

  it("constructs URL from id when no explicit url tag, skips jobs without title", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(LEGACY_MISSING_FIELDS, { status: 200 })
    )
    const jobs = await fetchPersonio("incomplete")
    // Job 1: has title + id but no url → constructs URL. Job 2: url but no title → skipped.
    expect(jobs).toHaveLength(1)
    expect(jobs[0].title).toBe("Has Title Has ID No URL")
    expect(jobs[0].url).toBe("https://incomplete.jobs.personio.com/job/10")
  })

  it("returns empty for legacy feed with no jobs", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(LEGACY_EMPTY, { status: 200 }))
    expect(await fetchPersonio("empty")).toHaveLength(0)
  })
})