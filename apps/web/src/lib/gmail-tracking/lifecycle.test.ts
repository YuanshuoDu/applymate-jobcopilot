import { describe, expect, it } from 'vitest'
import {
  activityTypeForGmailMessage,
  canApplyGmailStatus,
  gmailEventLabel,
  statusForGmailMessage,
} from './lifecycle'

describe('Gmail lifecycle projection', () => {
  it('maps only reliable application evidence to lifecycle statuses', () => {
    expect(statusForGmailMessage('application_received')).toBe('applied')
    expect(statusForGmailMessage('interview_invitation')).toBe('interview')
    expect(statusForGmailMessage('offer')).toBe('offer')
    expect(statusForGmailMessage('rejection')).toBe('rejected')
    expect(statusForGmailMessage('application_update')).toBeNull()
    expect(statusForGmailMessage('recommendation_digest')).toBeNull()
    expect(statusForGmailMessage('other')).toBeNull()
  })

  it('allows valid forward transitions and protects terminal outcomes', () => {
    expect(canApplyGmailStatus('saved', 'applied')).toBe(true)
    expect(canApplyGmailStatus('applied', 'interview')).toBe(true)
    expect(canApplyGmailStatus('saved', 'offer')).toBe(true)
    expect(canApplyGmailStatus('interview', 'rejected')).toBe(true)
    expect(canApplyGmailStatus('applied', 'saved')).toBe(false)
    expect(canApplyGmailStatus('offer', 'rejected')).toBe(false)
    expect(canApplyGmailStatus('rejected', 'offer')).toBe(false)
  })

  it('creates timeline categories and labels without review or viewed states', () => {
    expect(activityTypeForGmailMessage('interview_invitation')).toBe('interview_scheduled')
    expect(activityTypeForGmailMessage('offer')).toBe('offer_received')
    expect(activityTypeForGmailMessage('rejection')).toBe('rejected')
    expect(activityTypeForGmailMessage('application_update')).toBe('note_added')
    expect(gmailEventLabel('application_update')).toBe('employer update')
  })
})
