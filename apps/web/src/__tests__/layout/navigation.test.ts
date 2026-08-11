import { describe, expect, it } from 'vitest'
import { getSidebarNavItems } from '@/components/layout/Sidebar'
import { getMobileMoreItems, getMobileNavItems, getNotificationTargetPage } from '@/components/layout/AppShell'

describe('app navigation', () => {
  it('does not expose apply history as a standalone sidebar destination', () => {
    const items = getSidebarNavItems((key) => key)

    expect(items.map((item) => item.id)).not.toContain('apply-history')
  })

  it('does not expose the removed extension section', () => {
    const items = getSidebarNavItems((key) => key)

    expect(items.map((item) => item.id)).not.toContain('extension')
  })

  it('keeps settings out of the primary navigation', () => {
    const items = getSidebarNavItems((key) => key)

    expect(items.map((item) => item.id)).not.toContain('settings')
  })

  it('routes apply notifications to jobs instead of the removed apply history page', () => {
    expect(getNotificationTargetPage('apply_submitted')).toBe('jobs')
    expect(getNotificationTargetPage('message_received')).toBeNull()
  })

  it('routes Gmail recommendations to their review queue and application alerts to Gmail', () => {
    expect(getNotificationTargetPage('gmail_recommendations')).toBe('gmail-recommendations')
    expect(getNotificationTargetPage('gmail_application_update')).toBe('gmail')
  })

  it('keeps the approved mobile navigation order', () => {
    expect(getMobileNavItems().map(item => item.id)).toEqual(['jobs', 'search', 'dashboard', 'agent', 'more'])
    expect(getMobileNavItems()[2].label).toBe('Home')
  })

  it('puts Gmail, Settings, and Sign out in the mobile More menu', () => {
    expect(getMobileMoreItems().map(item => item.id)).toEqual(['gmail', 'settings', 'signout'])
    expect(getMobileMoreItems('退出登录').find(item => item.id === 'signout')?.label).toBe('退出登录')
  })
})
