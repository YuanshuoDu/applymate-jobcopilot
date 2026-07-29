import type { JobStatus } from '@prisma/client'
import type { InferredApplicationMetadata } from './classification'

export interface GmailMatchableJob {
  id: string
  company: string
  role: string
  status: JobStatus
}

export interface GmailJobMatch<TJob extends GmailMatchableJob = GmailMatchableJob> {
  job: TJob
  confidence: number
}

interface MatchInput extends InferredApplicationMetadata {
  subject: string
  senderEmail: string | null
}

/**
 * Require both an employer and a role signal before automatic linking. A single
 * company mention is deliberately kept for the user to match manually.
 */
export function findConfidentGmailJobMatch<TJob extends GmailMatchableJob>(
  jobs: TJob[],
  input: MatchInput,
): GmailJobMatch<TJob> | null {
  let best: GmailJobMatch<TJob> | null = null
  for (const job of jobs) {
    const confidence = scoreJobMatch(job, input)
    if (!best || confidence > best.confidence) best = { job, confidence }
  }
  return best && best.confidence >= 0.86 ? best : null
}

function scoreJobMatch(job: GmailMatchableJob, input: MatchInput): number {
  const company = normalize(job.company)
  const role = normalize(job.role)
  const allText = normalize(`${input.subject} ${input.senderEmail ?? ''}`)
  const inferredCompany = normalize(input.company ?? '')
  const inferredRole = normalize(input.role ?? '')

  const companyInSubject = containsTerm(allText, company)
  const companyInferred = sameOrContains(company, inferredCompany)
  const roleInSubject = containsTerm(normalize(input.subject), role)
  const roleInferred = sameOrContains(role, inferredRole)
  const companyScore = companyInferred ? 0.62 : companyInSubject ? 0.5 : 0
  const roleScore = roleInferred ? 0.42 : roleInSubject ? 0.36 : 0

  // A sender domain can support, but never replace, an explicit role match.
  const senderSupport = company.length >= 4 && normalize(input.senderEmail ?? '').includes(company) ? 0.08 : 0
  return Math.min(companyScore + roleScore + senderSupport, 1)
}

function sameOrContains(left: string, right: string): boolean {
  return Boolean(left && right && (left === right || containsTerm(left, right) || containsTerm(right, left)))
}

function containsTerm(text: string, term: string): boolean {
  return Boolean(term && term.length >= 3 && text.includes(term))
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ')
}
