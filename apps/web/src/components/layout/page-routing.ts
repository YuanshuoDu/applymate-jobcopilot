import type { Page } from '@/lib/types'

const knownPages: Record<Page, true> = {
  dashboard: true,
  jobs: true,
  search: true,
  resume: true,
  gmail: true,
  'gmail-recommendations': true,
  agent: true,
  'agent-history': true,
  observability: true,
  settings: true,
  'contact-us': true,
}

export function pageFromSearch(search: string): Page {
  const page = new URLSearchParams(search).get('page')
  return page && Object.hasOwn(knownPages, page) ? page as Page : 'dashboard'
}
