import type { Page } from '@/lib/types'

type Navigate = (page: Page) => void | boolean | Promise<boolean>
const applicationNavigationEvent = Symbol('application-navigation')

export function isApplicationNavigationEvent(event: Event): boolean {
  return applicationNavigationEvent in event
}

function notifyApplicationNavigation() {
  const event = new Event('popstate')
  Object.defineProperty(event, applicationNavigationEvent, { value: true })
  window.dispatchEvent(event)
}

function clearResumeContext(url: URL) {
  for (const key of ['resumeId', 'returnToJobs', 'returnJobId']) url.searchParams.delete(key)
}

/** Keep the Applications list context while selecting one exact job. */
export function applicationUrl(currentHref: string, jobId: string): string {
  const url = new URL(currentHref)
  clearResumeContext(url)
  url.searchParams.set('highlight', jobId)
  return url.toString()
}

export async function openApplication(jobId: string, navigate: Navigate): Promise<boolean> {
  if (!jobId.trim()) return false
  if ((await navigate('jobs')) === false) return false
  window.history.replaceState(window.history.state, '', applicationUrl(window.location.href, jobId))
  notifyApplicationNavigation()
  return true
}

/** Open the bounded recent-task view without carrying a stale selected job. */
export async function openApplicationAttention(navigate: Navigate): Promise<boolean> {
  if ((await navigate('jobs')) === false) return false
  const url = new URL(window.location.href)
  clearResumeContext(url)
  url.searchParams.delete('highlight')
  url.searchParams.set('jobsAttention', '1')
  window.history.replaceState(window.history.state, '', url.toString())
  notifyApplicationNavigation()
  return true
}

/** Attach the existing Agent page to a real session; never create a new run. */
export async function openApplicationSession(sessionId: string, navigate: Navigate): Promise<boolean> {
  if (!sessionId.trim()) return false
  if ((await navigate('agent')) === false) return false
  const url = new URL(window.location.href)
  clearResumeContext(url)
  url.searchParams.delete('highlight')
  url.searchParams.set('sessionId', sessionId)
  window.history.replaceState(window.history.state, '', url.toString())
  notifyApplicationNavigation()
  return true
}

export async function openApplicationWhenSaved(jobId: string, navigate: Navigate, edits: {
  isSaving: () => boolean
  hasChanges: () => boolean
  save: () => Promise<boolean>
}): Promise<boolean> {
  if (!jobId.trim()) return false
  if ((edits.isSaving() || edits.hasChanges()) && !(await edits.save())) return false
  if (edits.isSaving() || edits.hasChanges()) return false
  return openApplication(jobId, navigate)
}
