import type { ResumeContent, TemplateOptions } from './types'
import type { ApplicationListState } from './application-list-state'

export type RecoveryDraft = {
  userId: string
  resumeId: string
  name: string
  content: ResumeContent
  sectionOrder: string[]
  templateId: string
  templateOptions: TemplateOptions
  applicationContext?: { jobId: string; list: ApplicationListState; attention: boolean }
}

/** In-memory only. Detached drafts remain private to their original owner. */
export function createRecoveryDraftStore() {
  const drafts = new Map<string, { draft: RecoveryDraft; detached: boolean }>()
  return {
    publish(draft: RecoveryDraft) {
      if (!drafts.get(draft.userId)?.detached) drafts.set(draft.userId, { draft, detached: false })
    },
    clearActive(userId: string) {
      if (!drafts.get(userId)?.detached) drafts.delete(userId)
    },
    detach(userId: string) {
      const entry = drafts.get(userId)
      if (entry) entry.detached = true
    },
    reattach(userId: string) {
      const entry = drafts.get(userId)
      if (entry) entry.detached = false
    },
    getDetached(userId: string | null) {
      const entry = userId ? drafts.get(userId) : undefined
      return entry?.detached ? entry.draft : null
    },
    hasAny: () => drafts.size > 0,
    discard(userId: string) { drafts.delete(userId) },
  }
}
