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
  else if (host.includes('indeed.com') ||
           host.includes('indeed.de') ||
           host.includes('indeed.co.uk') ||
           host.includes('indeed.fr'))        job = scrapeIndeed()
  else if (host.includes('glassdoor.com'))    job = scrapeGlassdoor()
  else if (host.includes('stepstone'))        job = scrapeStepstone()
  else if (host.includes('xing.com'))         job = scrapeXing()
  else if (host.includes('wellfound.com'))    job = scrapeWellfound()
  else if (host.includes('greenhouse.io'))    job = scrapeGreenhouse()
  else if (host.includes('lever.co'))         job = scrapeLever()
  else if (host.includes('workday.com') ||
           host.includes('myworkdayjobs'))    job = scrapeWorkday()
  else if (host.includes('monster'))          job = scrapeMonster()
  else if (host.includes('arbeitsagentur'))   job = scrapeArbeitsagentur()
  else if (host.includes('jobs.de'))          job = scrapeJobsDe()
  else if (host.includes('localhost'))        job = scrapeTestMode()

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
  if (host.includes('indeed'))            return 'indeed'
  if (host.includes('glassdoor.com'))     return 'glassdoor'
  if (host.includes('stepstone'))         return 'stepstone'
  if (host.includes('xing.com'))          return 'xing'
  if (host.includes('wellfound.com'))     return 'wellfound'
  if (host.includes('greenhouse.io'))     return 'greenhouse'
  if (host.includes('lever.co'))          return 'lever'
  if (host.includes('workday') || host.includes('myworkdayjobs')) return 'workday'
  if (host.includes('localhost'))         return 'linkedin' // test mode
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
  const title   = document.querySelector<HTMLElement>('h1.app-title')?.innerText.trim() ?? null
  const company = document.querySelector<HTMLElement>('#header .company-name')?.innerText.trim() ??
                  document.title.split(' at ')[1]?.split(' - ')[0] ?? null
  const location = document.querySelector<HTMLElement>('.location')?.innerText.trim() ?? 'Unknown'
  const description = document.querySelector<HTMLElement>('#content .body')?.innerText.trim() ?? ''
  if (!title || !company) return null
  return { title, company, location, description, salary: null, url: window.location.href, source: 'greenhouse' }
}

function scrapeLever(): ScrapedJob | null {
  const title   = document.querySelector<HTMLElement>('.posting-headline h2')?.innerText.trim() ?? null
  const company = document.querySelector<HTMLElement>('.main-header-logo img')?.getAttribute('alt') ??
                  window.location.hostname.replace('jobs.lever.co/', '').split('.')[0] ?? null
  const location = document.querySelector<HTMLElement>('.posting-categories .location')?.innerText.trim() ?? 'Unknown'
  const description = document.querySelector<HTMLElement>('.posting-page .content')?.innerText.trim() ?? ''
  if (!title || !company) return null
  return { title, company, location, description, salary: null, url: window.location.href, source: 'lever' }
}

function scrapeWorkday(): ScrapedJob | null {
  const title   = document.querySelector<HTMLElement>('[data-automation-id="jobPostingHeader"]')?.innerText.trim() ?? null
  const location = document.querySelector<HTMLElement>('[data-automation-id="locations"]')?.innerText.trim() ?? 'Unknown'
  const description = document.querySelector<HTMLElement>('[data-automation-id="jobPostingDescription"]')?.innerText.trim() ?? ''
  // Company from subdomain: acme.myworkdayjobs.com
  const company = window.location.hostname.split('.')[0] ?? null
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
