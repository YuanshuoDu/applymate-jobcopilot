import { Prisma } from '@prisma/client'

import { db } from '@/lib/db'

export type OptimizationRow = {
  eventType: string
  provider: string | null
  events: number
  requestsAvoided: number
  jobsReturned: number
  netNewJobs: number
  validApplyUrls: number
  completeDescriptions: number
}

export async function loadOptimizationRows(since: Date, provider: string | undefined): Promise<OptimizationRow[]> {
  const providerFilter = provider ? Prisma.sql`AND provider = ${provider}` : Prisma.empty
  try {
    return (await db.$queryRaw<OptimizationRow[]>`
      SELECT event_type AS "eventType", provider, COUNT(*)::int AS events,
        SUM(requests_avoided)::int AS "requestsAvoided", SUM(jobs_returned)::int AS "jobsReturned",
        SUM(net_new_jobs)::int AS "netNewJobs", SUM(valid_apply_urls)::int AS "validApplyUrls",
        SUM(complete_descriptions)::int AS "completeDescriptions"
      FROM discovery_optimization_events
      WHERE created_at >= ${since} ${providerFilter}
      GROUP BY event_type, provider ORDER BY "requestsAvoided" DESC`) ?? []
  } catch {
    return []
  }
}
