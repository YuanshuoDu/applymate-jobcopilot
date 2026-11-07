import type { JobStatus } from './types'

export interface ApplicationListState {
  search: string
  status: 'all' | JobStatus
  page: number
  pageSize: number
  sortBy: 'createdAt' | 'score' | 'company' | 'role'
  sortDir: 'asc' | 'desc'
  view: 'list' | 'kanban'
}

export function readApplicationListState(href: string): ApplicationListState {
  const params = new URL(href, 'https://applymate.local').searchParams
  const status = params.get('jobsStatus') ?? 'all'
  const sortBy = params.get('jobsSort') ?? 'createdAt'
  const page = Number(params.get('jobsPage') ?? 1)
  return {
    search: params.get('jobsSearch') ?? '',
    status: ['saved', 'applied', 'interview', 'offer', 'rejected'].includes(status) ? status as JobStatus : 'all',
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    pageSize: params.get('jobsSize') === '50' ? 50 : 20,
    sortBy: ['score', 'company', 'role'].includes(sortBy) ? sortBy as ApplicationListState['sortBy'] : 'createdAt',
    sortDir: params.get('jobsDirection') === 'asc' ? 'asc' : 'desc',
    view: params.get('jobsView') === 'kanban' ? 'kanban' : 'list',
  }
}

export function applicationListUrl(href: string, state: ApplicationListState): string {
  const url = new URL(href, 'https://applymate.local')
  for (const [key, value] of Object.entries({ jobsSearch: state.search, jobsStatus: state.status,
    jobsPage: state.page, jobsSize: state.pageSize, jobsSort: state.sortBy, jobsDirection: state.sortDir, jobsView: state.view })) {
    url.searchParams.set(key, String(value))
  }
  return `${url.pathname}${url.search}${url.hash}`
}

export async function loadLinkedApplication(jobId: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { signal })
  if (!response.ok) throw new Error('Application unavailable')
  const job: unknown = await response.json()
  if (!job || typeof job !== 'object' || !('id' in job) || job.id !== jobId) throw new Error('Application unavailable')
  return job
}
