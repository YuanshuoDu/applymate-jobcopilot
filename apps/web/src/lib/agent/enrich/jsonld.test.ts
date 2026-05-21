import { describe, it, expect } from "vitest"
import { extractJsonLdJobPosting } from "./jsonld"

/**
 * All 6 test cases use inline HTML string constants — no external fixture files.
 * Fixtures are modeled on real job page JSON-LD structures.
 */

const SINGLE_POSTING = `<!DOCTYPE html>
<html>
<head>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "JobPosting",
  "title": "Senior Frontend Engineer",
  "description": "<p>We are looking for a <strong>Senior Frontend Engineer</strong> to join our team in Berlin. You will build performant React applications, mentor junior developers, and contribute to our design system. Experience with TypeScript, Next.js, and accessibility is required. We offer competitive salary, remote flexibility, and 30 days vacation.</p>",
  "hiringOrganization": {
    "@type": "Organization",
    "name": "Example GmbH",
    "sameAs": "https://www.example.com/careers/senior-fe"
  },
  "employmentType": "FULL_TIME",
  "datePosted": "2026-05-15"
}
</script>
</head>
<body><h1>Senior Frontend Engineer</h1></body>
</html>`

const ARRAY_WITH_JOBPOSTING = `<!DOCTYPE html>
<html>
<head>
<script type="application/ld+json">
[
  {
    "@context": "https://schema.org",
    "@type": "Organization",
    "name": "TechCorp",
    "url": "https://techcorp.example.com"
  },
  {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    "title": "DevOps Engineer",
    "description": "TechCorp is hiring a DevOps Engineer to manage our cloud infrastructure. You will work with AWS, Kubernetes, Terraform, and CI/CD pipelines. The role involves on-call rotation and close collaboration with our engineering teams across Europe. We value reliability, automation, and continuous improvement in everything we do.",
    "hiringOrganization": {
      "@type": "Organization",
      "name": "TechCorp",
      "sameAs": "https://techcorp.example.com/jobs/devops"
    },
    "employmentType": "FULL_TIME"
  }
]
</script>
</head>
<body><h1>DevOps Engineer</h1></body>
</html>`

const GRAPH_WITH_JOBPOSTING = `<!DOCTYPE html>
<html>
<head>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "name": "Company Careers",
      "url": "https://company.example.com/careers"
    },
    {
      "@type": "JobPosting",
      "title": "Product Manager",
      "description": "<p>We are seeking an experienced Product Manager to lead our SaaS platform. You will define product strategy, work with engineering and design teams, and drive product launches. This role requires strong analytical skills, user empathy, and at least 3 years of product management experience in a B2B SaaS environment.</p>",
      "hiringOrganization": {
        "@type": "Organization",
        "name": "Company Inc.",
        "sameAs": "https://company.example.com"
      },
      "datePosted": "2026-05-01",
      "url": "https://company.example.com/careers/pm"
    }
  ]
}
</script>
</head>
<body><h1>Product Manager</h1></body>
</html>`

const MULTI_POSTING = `<!DOCTYPE html>
<html>
<head>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "JobPosting",
      "@id": "job-001",
      "title": "Backend Developer",
      "description": "We are seeking a Backend Developer to build and maintain our distributed services platform. You will work with Python, PostgreSQL, Redis, and AWS infrastructure across multiple projects in our growing engineering organization.",
      "hiringOrganization": {
        "@type": "Organization",
        "name": "MultiCorp",
        "sameAs": "https://multicorp.example.com"
      }
    },
    {
      "@type": "JobPosting",
      "@id": "job-002",
      "title": "Frontend Developer",
      "description": "We are looking for a Frontend Developer to build beautiful, accessible user interfaces. You should have deep experience with React, TypeScript, CSS-in-JS, and modern browser APIs. The role involves close collaboration with our design team and a strong focus on web performance and accessibility standards like WCAG 2.1 AA.",
      "hiringOrganization": {
        "@type": "Organization",
        "name": "MultiCorp",
        "sameAs": "https://multicorp.example.com/jobs/frontend"
      },
      "url": "https://multicorp.example.com/jobs/frontend",
      "employmentType": "FULL_TIME"
    }
  ]
}
</script>
</head>
<body><h1>Careers at MultiCorp</h1></body>
</html>`

const NO_JSONLD = `<!DOCTYPE html>
<html>
<head><title>Job Page</title></head>
<body>
<h1>Software Engineer</h1>
<p>Apply now by sending your resume to jobs@example.com.</p>
</body>
</html>`

const SHORT_DESCRIPTION = `<!DOCTYPE html>
<html>
<head>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "JobPosting",
  "title": "Short Role",
  "description": "We are hiring.",
  "hiringOrganization": {
    "@type": "Organization",
    "name": "MinimalCorp"
  }
}
</script>
</head>
<body><h1>Short Role</h1></body>
</html>`

describe("extractJsonLdJobPosting", () => {
  it("(a) extracts from a standard single JobPosting", () => {
    const result = extractJsonLdJobPosting(SINGLE_POSTING)
    expect(result).not.toBeNull()
    expect(result!.method).toBe("jsonld")
    expect(result!.description).toContain("Senior Frontend Engineer")
    expect(result!.description).toContain("TypeScript")
    expect(result!.description.length).toBeGreaterThanOrEqual(200)
    expect(result!.applyUrl).toBe("https://www.example.com/careers/senior-fe")
    expect(result!.employmentType).toBe("FULL_TIME")
    expect(result!.datePosted).toBe("2026-05-15")
  })

  it("(b) finds JobPosting inside a JSON-LD array", () => {
    const result = extractJsonLdJobPosting(ARRAY_WITH_JOBPOSTING)
    expect(result).not.toBeNull()
    expect(result!.method).toBe("jsonld")
    expect(result!.description).toContain("DevOps Engineer")
    expect(result!.description).toContain("Kubernetes")
    expect(result!.applyUrl).toBe("https://techcorp.example.com/jobs/devops")
    expect(result!.employmentType).toBe("FULL_TIME")
  })

  it("(c) finds JobPosting inside @graph structure", () => {
    const result = extractJsonLdJobPosting(GRAPH_WITH_JOBPOSTING)
    expect(result).not.toBeNull()
    expect(result!.method).toBe("jsonld")
    expect(result!.description).toContain("Product Manager")
    expect(result!.description).toContain("B2B SaaS")
    expect(result!.applyUrl).toBe("https://company.example.com")
    expect(result!.datePosted).toBe("2026-05-01")
  })

  it("(d) disambiguates multiple JobPostings by sourceUrl match", () => {
    // Without sourceUrl: should pick the longer description (Frontend Developer)
    const noUrl = extractJsonLdJobPosting(MULTI_POSTING)
    expect(noUrl).not.toBeNull()
    expect(noUrl!.description).toContain("Frontend Developer")
    expect(noUrl!.description.length).toBeGreaterThan(200)

    // With sourceUrl matching job-001 @id: should pick Backend Developer
    const withUrl = extractJsonLdJobPosting(
      MULTI_POSTING,
      "https://multicorp.example.com/careers/job-001",
    )
    expect(withUrl).not.toBeNull()
    expect(withUrl!.description).toContain("Backend Developer")

    // With sourceUrl matching the Frontend Developer job URL
    const withExact = extractJsonLdJobPosting(
      MULTI_POSTING,
      "https://multicorp.example.com/jobs/frontend",
    )
    expect(withExact).not.toBeNull()
    expect(withExact!.description).toContain("Frontend Developer")
  })

  it("(e) returns null when no JSON-LD present", () => {
    const result = extractJsonLdJobPosting(NO_JSONLD)
    expect(result).toBeNull()
  })

  it("(f) returns null when description is too short (< 200 chars)", () => {
    const result = extractJsonLdJobPosting(SHORT_DESCRIPTION)
    expect(result).toBeNull()
  })
})
