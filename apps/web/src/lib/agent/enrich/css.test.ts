import { describe, it, expect } from "vitest"
import { extractByCssSelectors } from "./css"

const WORKDAY_HTML = `<!DOCTYPE html>
<html>
<body>
<div data-automation-id="jobPostingDescription">
  <p>As a Senior Software Engineer at Booking.com, you will design and build scalable microservices that power our travel platform serving millions of users daily. You will work with Java, Kubernetes, and AWS in an agile environment, collaborating closely with product and design teams across our Amsterdam headquarters. Strong problem-solving skills and a passion for clean, maintainable code are essential for success in this role.</p>
</div>
<div data-automation-id="adventureButton">
  <a href="https://booking.wd3.myworkdayjobs.com/Careers/apply/123">Apply Now</a>
</div>
</body>
</html>`

const GREENHOUSE_HTML = `<!DOCTYPE html>
<html>
<body>
<div class="opening">
  <section>
    <h2>About the role</h2>
    <p>Shopify is looking for a Staff Backend Engineer to join our Payments team. You will architect and build the next generation of our payment processing infrastructure, handling billions in transaction volume across multiple markets. This role requires deep expertise in distributed systems, database design, and a commitment to engineering excellence. You will mentor senior engineers and drive technical strategy across multiple teams.</p>
  </section>
</div>
<a class="application-button" href="https://boards.greenhouse.io/shopify/jobs/6789/apply">Apply</a>
</body>
</html>`

const LEVER_HTML = `<!DOCTYPE html>
<html>
<body>
<div class="section posting-page">
  <div class="posting-description">
    <h3>Data Engineer</h3>
    <p>Spotify is seeking a Data Engineer to build and maintain the data pipelines that power our recommendation systems. You will work with Apache Spark, Airflow, and Google Cloud Platform to process petabytes of user data. The role involves close collaboration with data scientists and machine learning engineers across our Stockholm and New York offices to deliver insights that improve the listening experience for hundreds of millions of users worldwide.</p>
  </div>
</div>
<a class="postings-btn" href="https://jobs.lever.co/spotify/apply/abc123">Apply for this job</a>
</body>
</html>`

const SMARTRECRUITERS_HTML = `<!DOCTYPE html>
<html>
<body>
<div class="job-sections">
  <section>
    <h1>Product Designer</h1>
    <p>We are hiring a Product Designer to shape the user experience of our enterprise SaaS platform. You will conduct user research, create wireframes and prototypes, and collaborate with engineering to bring designs to life. The ideal candidate has 4+ years of experience designing complex web applications, strong visual design skills, and a portfolio demonstrating user-centered design thinking across B2B products.</p>
  </section>
</div>
<a href="https://careers.smartrecruiters.com/Company/apply/456">Apply</a>
</body>
</html>`

const NO_MATCH_HTML = `<!DOCTYPE html>
<html>
<body>
<h1>Welcome to our careers page</h1>
<p>Check out our open positions below.</p>
<div class="generic-content">
  <p>Short text.</p>
</div>
</body>
</html>`

describe("extractByCssSelectors", () => {
  it("extracts from Workday HTML using data-automation-id selectors", () => {
    const r = extractByCssSelectors(WORKDAY_HTML, "workday")
    expect(r).not.toBeNull()
    expect(r!.method).toBe("css")
    expect(r!.description).toContain("Senior Software Engineer")
    expect(r!.description).toContain("microservices")
    expect(r!.description.length).toBeGreaterThanOrEqual(200)
    expect(r!.applyUrl).toBe("https://booking.wd3.myworkdayjobs.com/Careers/apply/123")
  })

  it("extracts from Greenhouse HTML using .opening section selector", () => {
    const r = extractByCssSelectors(GREENHOUSE_HTML, "greenhouse")
    expect(r).not.toBeNull()
    expect(r!.method).toBe("css")
    expect(r!.description).toContain("Staff Backend Engineer")
    expect(r!.description).toContain("payment processing")
    expect(r!.description.length).toBeGreaterThanOrEqual(200)
    expect(r!.applyUrl).toBe("https://boards.greenhouse.io/shopify/jobs/6789/apply")
  })

  it("extracts from Lever HTML using posting-description selector", () => {
    const r = extractByCssSelectors(LEVER_HTML, "lever")
    expect(r).not.toBeNull()
    expect(r!.method).toBe("css")
    expect(r!.description).toContain("Data Engineer")
    expect(r!.description).toContain("Apache Spark")
    expect(r!.description.length).toBeGreaterThanOrEqual(200)
    expect(r!.applyUrl).toBe("https://jobs.lever.co/spotify/apply/abc123")
  })

  it("extracts from SmartRecruiters HTML using .job-sections selector", () => {
    const r = extractByCssSelectors(SMARTRECRUITERS_HTML, "smartrecruiters")
    expect(r).not.toBeNull()
    expect(r!.method).toBe("css")
    expect(r!.description).toContain("Product Designer")
    expect(r!.description).toContain("user research")
    expect(r!.description.length).toBeGreaterThanOrEqual(200)
    expect(r!.applyUrl).toBe("https://careers.smartrecruiters.com/Company/apply/456")
  })

  it("returns null when no selectors match", () => {
    const r = extractByCssSelectors(NO_MATCH_HTML, "workday")
    expect(r).toBeNull()
  })
})
