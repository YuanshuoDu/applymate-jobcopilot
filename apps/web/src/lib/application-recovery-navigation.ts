import { applicationListUrl } from './application-list-state'
import type { RecoveryDraft } from './application-recovery-draft'

/** Open the recovered resume with only its original account-bound context. */
export function recoveryResumeUrl(currentHref: string, resumeId: string, context?: RecoveryDraft['applicationContext']): string | null {
  if (!resumeId.trim()) return null
  const url = new URL(currentHref)
  url.search = ''
  url.hash = ''
  url.searchParams.set('page', 'resume')
  url.searchParams.set('resumeId', resumeId)
  if (!context?.jobId.trim()) return `${url.pathname}${url.search}`
  url.searchParams.set('returnToJobs', '1')
  url.searchParams.set('returnJobId', context.jobId)
  if (context.attention) url.searchParams.set('jobsAttention', '1')
  return applicationListUrl(url.toString(), context.list)
}

/** Return false on failure so callers keep the recovery draft available. */
export function replaceWithRecoveryResume(win: Window, resumeId: string, context?: RecoveryDraft['applicationContext']): boolean {
  try {
    const url = recoveryResumeUrl(win.location.href, resumeId, context)
    if (!url) return false
    win.history.replaceState(win.history.state, '', url)
    return true
  } catch {
    return false
  }
}
