import type { Page } from '@/lib/types'

type Navigate = (page: Page) => void

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

export function openApplication(jobId: string, navigate: Navigate): void {
  if (!jobId.trim()) return
  navigate('jobs')
  window.history.replaceState(window.history.state, '', applicationUrl(window.location.href, jobId))
  window.dispatchEvent(new Event('popstate'))
}

/** Attach the existing Agent page to a real session; never create a new run. */
export function openApplicationSession(sessionId: string, navigate: Navigate): void {
  if (!sessionId.trim()) return
  navigate('agent')
  const url = new URL(window.location.href)
  clearResumeContext(url)
  url.searchParams.delete('highlight')
  url.searchParams.set('sessionId', sessionId)
  window.history.replaceState(window.history.state, '', url.toString())
  window.dispatchEvent(new Event('popstate'))
}

export async function openApplicationWhenSaved(jobId: string, navigate: Navigate, edits: {
  isSaving: () => boolean
  hasChanges: () => boolean
  save: () => Promise<boolean>
}): Promise<boolean> {
  if (!jobId.trim() || edits.isSaving()) return false
  if (edits.hasChanges() && !(await edits.save())) return false
  if (edits.isSaving() || edits.hasChanges()) return false
  openApplication(jobId, navigate)
  return true
}
