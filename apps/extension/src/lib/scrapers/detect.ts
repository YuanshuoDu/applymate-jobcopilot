import type { ScrapedJob } from '../types'
import { scrapeLinkedIn }   from './linkedin'
import { scrapeIndeed }     from './indeed'
import { scrapeGlassdoor }  from './glassdoor'
import { scrapeStepstone }  from './stepstone'
import { scrapeXing }       from './xing'
import { scrapeSchemaOrg }  from './schema-org'

export function detectAndScrape(): ScrapedJob | null {
  const host = window.location.hostname

  // Site-specific scrapers — try first for best accuracy
  let job: ScrapedJob | null = null

  if (host.includes('linkedin.com'))          job = scrapeLinkedIn()
  else if (/(^|\.)indeed\./i.test(host))     job = scrapeIndeed()
  else if (host.includes('glassdoor.com'))    job = scrapeGlassdoor()
  else if (host.includes('stepstone'))        job = scrapeStepstone()
  else if (host.includes('xing.com'))         job = scrapeXing()
  else if (host.includes('wellfound.com'))       job = scrapeWellfound()
  else if (host.includes('greenhouse.io'))       job = scrapeGreenhouse()
  else if (host.includes('lever.co'))            job = scrapeLever()
  else if (host.includes('workday.com') ||
           host.includes('myworkdayjobs'))       job = scrapeWorkday()
  else if (host.includes('smartrecruiters.com')) job = scrapeSmartRecruiters()
  else if (host.includes('ashbyhq.com'))         job = scrapeAshby()
  else if (host.includes('bamboohr.com'))        job = scrapeBambooHR()
  else if (host.includes('jobvite.com'))         job = scrapeJobvite()
  else if (host.includes('icims.com'))           job = scrapeICIMS()
  else if (host.includes('monster'))             job = scrapeMonster()
  else if (host.includes('arbeitsagentur'))      job = scrapeArbeitsagentur()
  else if (host.includes('jobs.de'))             job = scrapeJobsDe()
  else if (host.includes('localhost'))           job = scrapeTestMode()

  // If site-specific scraper failed, try schema.org structured data
  if (!job) {
    job = scrapeSchemaOrg()
    if (job) {
      // Override source with detected platform
      const source = detectSourceFromHost(host)
      if (source !== 'unknown') job.source = source
    }
  }

  return job
}

function detectSourceFromHost(host: string): ScrapedJob['source'] {
  if (host.includes('linkedin.com'))      return 'linkedin'
  if (/(^|\.)indeed\./i.test(host))       return 'indeed'
  if (host.includes('glassdoor.com'))     return 'glassdoor'
  if (host.includes('stepstone'))         return 'stepstone'
  if (host.includes('xing.com'))          return 'xing'
  if (host.includes('wellfound.com'))     return 'wellfound'
  if (host.includes('greenhouse.io'))        return 'greenhouse'
  if (host.includes('lever.co'))             return 'lever'
  if (host.includes('workday') || host.includes('myworkdayjobs')) return 'workday'
  if (host.includes('smartrecruiters.com')) return 'smartrecruiters'
  if (host.includes('ashbyhq.com'))         return 'ashby'
  if (host.includes('bamboohr.com'))        return 'bamboohr'
  if (host.includes('jobvite.com'))         return 'jobvite'
  if (host.includes('icims.com'))           return 'icims'
  if (host.includes('localhost'))           return 'linkedin' // test mode
  return 'unknown'
}

// ── Test-mode scraper (localhost) ─────────────────────────────

function scrapeTestMode(): ScrapedJob | null {
  const title   = document.querySelector<HTMLElement>('.am-test-detail-title')?.innerText.trim() ?? null
  const company = document.querySelector<HTMLElement>('.am-test-detail-company')?.innerText.trim() ?? null
  const location = document.querySelector<HTMLElement>('.am-test-detail-location')?.innerText.trim() ?? 'Remote'
  const description = document.querySelector<HTMLElement>('.am-test-detail-desc')?.innerText.trim() ?? ''
  if (!title || !company) return null
  return { title, company, location, description, salary: null, url: window.location.href, source: 'linkedin' }
}

// ── Lightweight scrapers for ATS platforms ────────────────────

function scrapeWellfound(): ScrapedJob | null {
  const title   = document.querySelector<HTMLElement>('h1')?.innerText.trim() ?? null
  const company = document.querySelector<HTMLElement>('[class*="company-name"], [data-test="company-name"]')?.innerText.trim() ?? null
  const location = document.querySelector<HTMLElement>('[class*="location"]')?.innerText.trim() ?? 'Remote'
  const description = document.querySelector<HTMLElement>('[class*="job-description"], .description')?.innerText.trim() ?? ''
  if (!title || !company) return null
  return { title, company, location, description, salary: null, url: window.location.href, source: 'wellfound' }
}

function scrapeGreenhouse(): ScrapedJob | null {
  const title =
    document.querySelector<HTMLElement>('h1.app-title')?.innerText.trim() ||
    document.querySelector<HTMLElement>('h1[class*="job-title"], h1[class*="title"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('h1')?.innerText.trim() ||
    null

  // Company: DOM → page title → logo alt → URL path
  let company: string | null =
    document.querySelector<HTMLElement>('#header .company-name')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[class*="company-name"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.company-name')?.innerText.trim() ||
    null

  if (!company) {
    // Page title format: "Job Title at Company Name" or "Job Title - Company Name"
    const t = document.title
    const atIdx = t.lastIndexOf(' at ')
    if (atIdx !== -1) company = t.slice(atIdx + 4).split(' - ')[0].trim()
    else if (t.includes(' - ')) company = t.split(' - ').pop()?.trim() ?? null
  }

  if (!company) {
    // Logo alt attribute (Greenhouse sets alt to company name)
    const logoAlt = document.querySelector<HTMLImageElement>('img.company-logo, img[class*="logo"]')?.alt?.trim()
    if (logoAlt && logoAlt.toLowerCase() !== 'logo') company = logoAlt
  }

  if (!company) {
    // URL path: boards.greenhouse.io/companyslug/jobs/123 → companyslug
    const pathParts = window.location.pathname.split('/').filter(Boolean)
    if (pathParts.length > 0 && pathParts[0] !== 'jobs') company = pathParts[0]
  }

  const location = document.querySelector<HTMLElement>('.location')?.innerText.trim() ?? 'Unknown'
  const description =
    document.querySelector<HTMLElement>('#content .body')?.innerText.trim() ||
    document.querySelector<HTMLElement>('#job-description')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[class*="job-description"]')?.innerText.trim() ||
    ''
  if (!title || !company) return null
  return { title, company, location, description, salary: null, url: window.location.href, source: 'greenhouse' }
}

function scrapeLever(): ScrapedJob | null {
  const title =
    document.querySelector<HTMLElement>('.posting-headline h2')?.innerText.trim() ||
    document.querySelector<HTMLElement>('h1[class*="title"], h2[class*="title"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('h1')?.innerText.trim() ||
    null

  // Company: logo alt → DOM → URL path (jobs.lever.co/company-slug/uuid)
  const logoAlt = document.querySelector<HTMLImageElement>('.main-header-logo img')?.getAttribute('alt')?.trim()
  const company =
    (logoAlt && logoAlt.toLowerCase() !== 'logo' ? logoAlt.replace(/ logo$/i, '').trim() : null) ||
    document.querySelector<HTMLElement>('[class*="company-name"]')?.innerText.trim() ||
    // Extract company slug from URL path: /company-slug/uuid
    window.location.pathname.split('/').filter(Boolean)[0] ||
    null

  const location =
    document.querySelector<HTMLElement>('.posting-categories .location')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[class*="location"]')?.innerText.trim() ||
    'Unknown'
  const description =
    document.querySelector<HTMLElement>('.posting-page .content')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[class*="posting-description"]')?.innerText.trim() ||
    ''
  if (!title || !company) return null
  return { title, company, location, description, salary: null, url: window.location.href, source: 'lever' }
}

function scrapeWorkday(): ScrapedJob | null {
  const title =
    document.querySelector<HTMLElement>('[data-automation-id="jobPostingHeader"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[data-automation-id="Job_Posting_Header"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('h1[class*="title" i]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('h1')?.innerText.trim() ||
    null

  const location =
    document.querySelector<HTMLElement>('[data-automation-id="locations"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[data-automation-id="Location"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[class*="location" i]')?.innerText.trim() ||
    'Unknown'

  const description =
    document.querySelector<HTMLElement>('[data-automation-id="jobPostingDescription"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[class*="job-description" i]')?.innerText.trim() ||
    ''

  // Company from subdomain: qualcomm.myworkdayjobs.com → qualcomm
  // But wd3.myworkdayjobs.com → extract company from URL path instead
  const hostname = window.location.hostname
  let company: string | null = hostname.split('.')[0]

  if (/^wd\d+$/.test(company)) {
    // wd3.myworkdayjobs.com/CompanyName/job/... — company is in path
    const skipSegments = new Set(['en-US', 'en-GB', 'de-DE', 'fr-FR', 'nl-NL', 'jobs', 'job', 'apply', 'hiring'])
    const pathParts = window.location.pathname.split('/').filter(p => p && !skipSegments.has(p))
    company = pathParts[0] ?? company
  }

  if (!title || !company) return null
  return { title, company, location, description, salary: null, url: window.location.href, source: 'workday' }
}

function scrapeMonster(): ScrapedJob | null {
  const title =
    document.querySelector<HTMLElement>('h1[class*="title"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.job-header__title')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[data-testid="job-title"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('h1')?.innerText.trim() ||
    null
  const company =
    document.querySelector<HTMLElement>('[data-testid="company-name"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.job-header__company a')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[class*="company-name"]')?.innerText.trim() ||
    null
  const location =
    document.querySelector<HTMLElement>('[data-testid="job-location"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.job-header__location')?.innerText.trim() ||
    'Unknown'
  const salary =
    document.querySelector<HTMLElement>('[data-testid="salary"]')?.innerText.trim() ||
    null
  const description =
    document.querySelector<HTMLElement>('[data-testid="job-description"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.job-description')?.innerText.trim() ||
    ''
  if (!title || !company) return null
  return { title, company, location, description, salary, url: window.location.href, source: 'unknown' }
}

function scrapeArbeitsagentur(): ScrapedJob | null {
  const title =
    document.querySelector<HTMLElement>('[data-cy="detail-job-title"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('ba-detail-page h1')?.innerText.trim() ||
    document.querySelector<HTMLElement>('h1[class*="title"]')?.innerText.trim() ||
    null
  const company =
    document.querySelector<HTMLElement>('[data-cy="detail-company-name"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[class*="company-name"]')?.innerText.trim() ||
    null
  const location =
    document.querySelector<HTMLElement>('[data-cy="detail-location"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[class*="location"]')?.innerText.trim() ||
    'Unknown'
  const description =
    document.querySelector<HTMLElement>('[data-cy="detail-description"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[class*="job-description"]')?.innerText.trim() ||
    ''
  if (!title || !company) return null
  return { title, company, location, description, salary: null, url: window.location.href, source: 'unknown' }
}

function scrapeSmartRecruiters(): ScrapedJob | null {
  const title =
    document.querySelector<HTMLElement>('h1[itemprop="title"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('h1.job-title')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[class*="job-title" i]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('h1')?.innerText.trim() ||
    null
  const company =
    document.querySelector<HTMLElement>('[itemprop="hiringOrganization"] [itemprop="name"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[class*="company-name" i]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[itemprop="hiringOrganization"]')?.innerText.trim() ||
    null
  const location =
    document.querySelector<HTMLElement>('[itemprop="jobLocation"] [itemprop="name"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[itemprop="jobLocation"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[class*="location" i]')?.innerText.trim() ||
    'Unknown'
  const description =
    document.querySelector<HTMLElement>('[itemprop="description"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('#job-description')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[class*="job-description" i]')?.innerText.trim() ||
    ''
  if (!title || !company) return null
  return { title, company, location, description, salary: null, url: window.location.href, source: 'smartrecruiters' }
}

function scrapeAshby(): ScrapedJob | null {
  const title =
    document.querySelector<HTMLElement>('h1[class*="Title" i]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[class*="JobTitle" i]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('h1')?.innerText.trim() ||
    null
  // Company: from URL path (jobs.ashbyhq.com/company/uuid) or logo
  const logoAlt = document.querySelector<HTMLImageElement>('[class*="Logo" i] img, [class*="logo" i] img')?.alt?.trim()
  const company =
    (logoAlt && logoAlt.toLowerCase() !== 'logo' ? logoAlt.replace(/ logo$/i, '').trim() : null) ||
    document.querySelector<HTMLElement>('[class*="company-name" i], [class*="CompanyName" i]')?.innerText.trim() ||
    window.location.pathname.split('/').filter(Boolean)[0] ||
    null
  const location =
    document.querySelector<HTMLElement>('[class*="Location" i]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[class*="location" i]')?.innerText.trim() ||
    'Unknown'
  const description =
    document.querySelector<HTMLElement>('[class*="Description" i], [class*="job-description" i]')?.innerText.trim() ||
    ''
  if (!title || !company) return null
  return { title, company, location, description, salary: null, url: window.location.href, source: 'ashby' }
}

function scrapeBambooHR(): ScrapedJob | null {
  const title =
    document.querySelector<HTMLElement>('h2.BambooRichText, [class*="HeadlineMain"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[class*="job-title" i]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('h1')?.innerText.trim() ||
    null
  const company =
    document.querySelector<HTMLElement>('[class*="company-name" i]')?.innerText.trim() ||
    // BambooHR hosted: company.bamboohr.com → company from subdomain
    window.location.hostname.split('.')[0] ||
    null
  const location =
    document.querySelector<HTMLElement>('[class*="location" i]')?.innerText.trim() ||
    'Unknown'
  const description =
    document.querySelector<HTMLElement>('[class*="description" i]')?.innerText.trim() ||
    ''
  if (!title || !company) return null
  return { title, company, location, description, salary: null, url: window.location.href, source: 'bamboohr' }
}

function scrapeJobvite(): ScrapedJob | null {
  const title =
    document.querySelector<HTMLElement>('.jv-job-detail-name')?.innerText.trim() ||
    document.querySelector<HTMLElement>('h1[class*="title"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('h1')?.innerText.trim() ||
    null
  const company =
    document.querySelector<HTMLElement>('.jv-company-name')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[class*="company-name" i]')?.innerText.trim() ||
    null
  const location =
    document.querySelector<HTMLElement>('.jv-job-detail-about li:first-child')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[class*="location" i]')?.innerText.trim() ||
    'Unknown'
  const description =
    document.querySelector<HTMLElement>('.jv-job-detail-description')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[class*="description" i]')?.innerText.trim() ||
    ''
  if (!title || !company) return null
  return { title, company, location, description, salary: null, url: window.location.href, source: 'jobvite' }
}

function scrapeICIMS(): ScrapedJob | null {
  const title =
    document.querySelector<HTMLElement>('.iCIMS_Header h1')?.innerText.trim() ||
    document.querySelector<HTMLElement>('h1.iCIMS_Header')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[class*="job-title" i]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('h1')?.innerText.trim() ||
    null
  const company =
    document.querySelector<HTMLElement>('.iCIMS_CompanyName, [class*="company-name" i]')?.innerText.trim() ||
    window.location.hostname.split('.')[0] ||
    null
  const location =
    document.querySelector<HTMLElement>('[id*="Location"], [class*="location" i]')?.innerText.trim() ||
    'Unknown'
  const description =
    document.querySelector<HTMLElement>('[id*="Description"], [class*="job-description" i]')?.innerText.trim() ||
    ''
  if (!title || !company) return null
  return { title, company, location, description, salary: null, url: window.location.href, source: 'icims' }
}

function scrapeJobsDe(): ScrapedJob | null {
  const title =
    document.querySelector<HTMLElement>('h1[class*="title"]')?.innerText.trim() ||
    document.querySelector<HTMLElement>('.job-detail__title')?.innerText.trim() ||
    document.querySelector<HTMLElement>('h1')?.innerText.trim() ||
    null
  const company =
    document.querySelector<HTMLElement>('.job-detail__company a')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[class*="company-name"]')?.innerText.trim() ||
    null
  const location =
    document.querySelector<HTMLElement>('.job-detail__location')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[class*="location"]')?.innerText.trim() ||
    'Unknown'
  const description =
    document.querySelector<HTMLElement>('.job-detail__description')?.innerText.trim() ||
    document.querySelector<HTMLElement>('[class*="description"]')?.innerText.trim() ||
    ''
  if (!title || !company) return null
  return { title, company, location, description, salary: null, url: window.location.href, source: 'unknown' }
}
