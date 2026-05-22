/**
 * Scout queue — automated job discovery via Greenhouse + Lever sources.
 *
 * BullMQ worker that runs per-user discovery: fetches new jobs from
 * Greenhouse and Lever public APIs, deduplicates by URL, and inserts
 * new jobs into the DB with status='saved'.
 */
import { Queue, Worker } from "bullmq"
import { Redis } from "ioredis"
import { randomUUID } from "node:crypto"
import { getPool } from "../db/apply-results.js"

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379"
const connection = new Redis(redisUrl, { maxRetriesPerRequest: null })

export const SCOUT_QUEUE_NAME = "scout-tasks"

export interface ScoutTaskPayload {
  userId: string
}

export const scoutQueue = new Queue<ScoutTaskPayload>(SCOUT_QUEUE_NAME, {
  connection,
})

// -- Types -------------------------------------------------------------

interface DiscoveredJob {
  title:       string
  company:     string
  location:    string
  url:         string
  description: string
  salary:      string | null
  logo:        string | null
  source:      string
}

// -- HTML stripping ----------------------------------------------------

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&[a-z]+;/gi, "")
    .replace(/\s+/g, " ")
    .trim()
}

// -- Simple rate limiter (250ms between calls) -------------------------

let lastCall = 0
async function scoutPace(): Promise<void> {
  const now = Date.now()
  const wait = Math.max(0, 250 - (now - lastCall))
  lastCall = now + wait
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
}

// -- Greenhouse source (inlined from apps/web/src/lib/agent/sources/greenhouse.ts)

interface GreenhouseJob {
  id:           number
  title:        string
  absolute_url: string
  location:     { name: string }
  content?:     string
}

interface GreenhouseResponse {
  jobs: GreenhouseJob[]
}

async function fetchGreenhouse(slugs: string[]): Promise<DiscoveredJob[]> {
  const results: DiscoveredJob[] = []
  for (const slug of slugs) {
    await scoutPace()
    try {
      const url = "https://boards-api.greenhouse.io/v1/boards/" + slug + "/jobs?content=true"
      const r = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(8_000),
      })
      if (!r.ok) continue
      const json = (await r.json()) as GreenhouseResponse
      if (!json.jobs?.length) continue
      for (const j of json.jobs) {
        results.push({
          title:       j.title,
          company:     slug,
          location:    j.location?.name ?? "",
          url:         j.absolute_url,
          description: j.content ? stripHtml(j.content) : "",
          salary:      null,
          logo:        null,
          source:      "greenhouse",
        })
      }
    } catch { continue }
  }
  return results
}

// -- Lever source (inlined from apps/web/src/lib/agent/sources/lever.ts)

interface LeverPosting {
  id:               string
  text:             string
  hostedUrl:        string
  descriptionPlain?: string
  description?:     string
  categories?: {
    location?:   string
    commitment?: string
    department?: string
  }
}

async function fetchLever(slugs: string[]): Promise<DiscoveredJob[]> {
  const results: DiscoveredJob[] = []
  for (const slug of slugs) {
    await scoutPace()
    try {
      const url = "https://api.lever.co/v0/postings/" + slug + "?mode=json"
      const r = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(8_000),
      })
      if (!r.ok) continue
      const postings = (await r.json()) as LeverPosting[]
      if (!postings?.length) continue
      for (const p of postings) {
        results.push({
          title:       p.text,
          company:     slug,
          location:    p.categories?.location ?? "",
          url:         p.hostedUrl,
          description: p.descriptionPlain ?? (p.description ? stripHtml(p.description) : ""),
          salary:      null,
          logo:        null,
          source:      "lever",
        })
      }
    } catch { continue }
  }
  return results
}

// -- Employer slugs (top tech employers on each ATS) -------------------

const GREENHOUSE_SLUGS = [
  "n26", "personio", "contentful", "deliveroo",
  "zalando", "spotify", "revolut", "klarna", "checkout",
  "stripe", "datadog", "figma", "airtable", "notion", "vercel",
  "hubspot", "gitlab", "databricks", "snowflake", "confluent",
]

const LEVER_SLUGS = [
  "spotify", "klarna", "tiermobility", "n26", "deliveroo",
  "monzo", "revolut", "checkout", "wefox", "tradeRepublic",
  "personio", "zalando", "deliveryHero", "bolt", "northvolt",
]

// -- Scout worker ------------------------------------------------------

export const scoutWorker = new Worker<ScoutTaskPayload>(
  SCOUT_QUEUE_NAME,
  async (job) => {
    const { userId } = job.data
    const pool = getPool()
    const startedAt = Date.now()

    // 1. Load AgentConfig
    const cfgRes = await pool.query(
      'SELECT "targetRoles", "targetLocations" FROM "AgentConfig" WHERE "userId" = $1',
      [userId]
    )
    const cfg = cfgRes.rows[0]
    if (!cfg || !cfg.targetRoles?.length) {
      console.log('[scout-worker] User %s has no target roles configured -- skipping', userId)
      return { skipped: true, reason: 'no-target-roles' }
    }

    const targetRoles = cfg.targetRoles as string[]
    const targetLocations = cfg.targetLocations as string[]

    console.log(
      '[scout-worker] Starting discovery for user %s (roles: %s, locations: %s)',
      userId, targetRoles.slice(0, 3).join(', '), targetLocations.slice(0, 2).join(', ') || 'any'
    )

    // 2. Get existing job URLs for dedup
    const existingRes = await pool.query(
      'SELECT url FROM "Job" WHERE "userId" = $1 AND url IS NOT NULL',
      [userId]
    )
    const existingUrls = new Set<string>(
      existingRes.rows.map((r: { url: string }) => r.url).filter(Boolean)
    )

    // 3. Fetch from Greenhouse + Lever
    const [ghJobs, lvJobs] = await Promise.all([
      fetchGreenhouse(GREENHOUSE_SLUGS).catch(() => [] as DiscoveredJob[]),
      fetchLever(LEVER_SLUGS).catch(() => [] as DiscoveredJob[]),
    ])

    const allDiscovered = [...ghJobs, ...lvJobs]

    // 4. Filter by target roles (keyword match in title)
    const matching = allDiscovered.filter(j => {
      if (!j.url || existingUrls.has(j.url)) return false
      if (!j.title || !j.company) return false
      const titleLower = j.title.toLowerCase()
      return targetRoles.some(role => {
        const rl = role.toLowerCase()
        return titleLower.includes(rl) ||
          rl.split(/\s+/).every(w => titleLower.includes(w))
      })
    })

    // 5. Insert new jobs
    let inserted = 0
    const duplicates = allDiscovered.length - matching.length

    for (const j of matching) {
      if (existingUrls.has(j.url)) continue
      try {
        await pool.query(
          'INSERT INTO "Job" ("id", "userId", "company", "role", "location", "url", "description", "salary", "logo", "source", "status") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT DO NOTHING',
          [
            randomUUID(), userId,
            j.company, j.title, j.location || null, j.url,
            j.description || null, j.salary || null,
            j.logo || j.company.slice(0, 2).toUpperCase(),
            j.source, 'saved',
          ]
        )
        existingUrls.add(j.url)
        inserted++
      } catch (err) {
        console.warn('[scout-worker] Failed to insert job %s: %s', j.url, String(err))
      }
    }

    const durationMs = Date.now() - startedAt
    console.log(
      '[scout-worker] User %s: %d total discovered, %d matching, %d inserted, %d duplicates, %dms',
      userId, allDiscovered.length, matching.length, inserted, duplicates, durationMs
    )

    return {
      discovered: allDiscovered.length,
      matching: matching.length,
      inserted,
      duplicates,
      durationMs,
    }
  },
  {
    connection,
    concurrency: 1,
  }
)
