import { describe, expect, it } from 'vitest'
import { createRecoveryDraftStore, type RecoveryDraft } from './application-recovery-draft'

const draft: RecoveryDraft = { userId: 'a', resumeId: 'r', name: 'Private A', content: { contact: { name: '', email: '', location: '' }, summary: '', experience: [], education: [], skills: [] }, sectionOrder: [], templateId: 'clean', templateOptions: {} }

describe('in-memory recovery drafts', () => {
  it('only returns a detached draft to its owner and does not replace it with a fresh editor', () => {
    const store = createRecoveryDraftStore()
    store.publish(draft)
    expect(store.getDetached('a')).toBeNull()
    store.detach('a')
    expect(store.getDetached(null)).toBeNull()
    expect(store.getDetached('b')).toBeNull()
    store.publish({ ...draft, name: 'fresh' })
    store.clearActive('a')
    expect(store.getDetached('a')?.name).toBe('Private A')
    store.discard('a')
    expect(store.hasAny()).toBe(false)
  })
})
