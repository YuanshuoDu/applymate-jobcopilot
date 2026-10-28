import { expect, test, type Page, type Route } from '@playwright/test'

type Owner = 'a' | 'b' | null
const ownerId = (owner: Exclude<Owner, null>) => owner === 'a' ? 'agent-supervisor-fixture' : 'second-fixture-user'
const session = (owner: Owner) => owner === null ? null : {
  user: { id: ownerId(owner), email: 'fixture@applymate.local', name: 'Fixture' },
  expires: '2099-01-01T00:00:00.000Z',
}

function usage(owner: Exclude<Owner, null>, days = 30) {
  const tokens = owner === 'a' ? (days === 7 ? 7777 : 1111) : 2222
  const dateFrom = Date.UTC(2026, 9, 29 - days)
  const empty = { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  const totals = { calls: 1, inputTokens: tokens, outputTokens: 0, totalTokens: tokens }
  return {
    ownerId: ownerId(owner), days, timezone: 'UTC', from: new Date(dateFrom).toISOString(), to: '2026-10-28T12:00:00.000Z',
    summary: totals,
    daily: Array.from({ length: days }, (_, index) => ({ date: new Date(dateFrom + index * 86_400_000).toISOString().slice(0, 10), ...(index === days - 1 ? totals : empty) })),
    models: [{ provider: 'fixture-provider', model: 'fixture-model', ...totals }],
  }
}

function activity(owner: Exclude<Owner, null>) {
  return { ownerId: ownerId(owner), items: [{ id: `activity-${owner}`, text: `${owner.toUpperCase()} account activity`, createdAt: '2026-10-28T10:00:00.000Z' }] }
}

async function json(route: Route, value: unknown) {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) })
}

async function installBaseRoutes(page: Page, currentOwner: () => Owner) {
  // Every API call is intercepted; this browser fixture cannot reach a real account.
  await page.route('**/api/**', route => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }))
  await page.route('**/api/auth/session**', route => json(route, session(currentOwner())))
  await page.route('**/api/me', route => json(route, { id: 'fixture', name: 'Fixture', email: 'fixture@applymate.local' }))
  await page.route('**/api/plans', route => json(route, { plans: [] }))
}

test('account switch and sign out hide old usage even when an earlier refresh finishes late', async ({ page }) => {
  let owner: Owner = 'a'
  let holdOldRefresh = false
  const held = new Set<string>()
  const delivered = new Set<string>()
  let release!: () => void
  const waitForRelease = new Promise<void>(resolve => { release = resolve })
  await installBaseRoutes(page, () => owner)
  for (const [pattern, name] of [['**/api/me/usage**', 'usage'], ['**/api/me/activity**', 'activity']] as const) {
    await page.route(pattern, async route => {
      const requestOwner = owner
      if (requestOwner === null) return route.fulfill({ status: 401, contentType: 'application/json', body: '{}' })
      const payload = name === 'usage' ? usage(requestOwner, Number(new URL(route.request().url()).searchParams.get('days')) || 30) : activity(requestOwner)
      if (requestOwner === 'a' && holdOldRefresh) {
        held.add(name)
        await waitForRelease
        await json(route, payload)
        delivered.add(name)
        return
      }
      await json(route, payload)
    })
  }

  try {
    await page.goto('/agent-preview?surface=settings&tab=usage')
    await expect(page.getByText('A account activity', { exact: true })).toBeVisible()
    await expect(page.getByText('1,111', { exact: true }).first()).toBeVisible()
    const refresh = page.getByRole('button', { name: 'Refresh usage' })
    await expect(refresh).toBeEnabled()
    holdOldRefresh = true
    await refresh.click()
    await expect.poll(() => held.size).toBe(2)

    owner = 'b'
    expect(await page.evaluate(() => document.visibilityState)).toBe('visible')
    // SessionProvider uses the real visibility handler to re-fetch /api/auth/session.
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await expect(page.getByText('B account activity', { exact: true })).toBeVisible()
    await expect(page.getByText('2,222', { exact: true }).first()).toBeVisible()
    const oldUsage = page.waitForResponse(response => new URL(response.url()).pathname === '/api/me/usage')
    const oldActivity = page.waitForResponse(response => new URL(response.url()).pathname === '/api/me/activity')
    release()
    const responses = await Promise.all([oldUsage, oldActivity])
    await Promise.all(responses.map(response => response.finished()))
    await expect.poll(() => delivered.size).toBe(2)
    // Allow fetch decoding and React's asynchronous state updates to commit.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect(page.getByText('A account activity', { exact: true })).toHaveCount(0)
    await expect(page.getByText('1,111', { exact: true })).toHaveCount(0)
    await expect(page.getByText('B account activity', { exact: true })).toBeVisible()
    await expect(page.getByText('2,222', { exact: true }).first()).toBeVisible()

    owner = null
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await expect(page.getByRole('region', { name: 'Usage & activity' }).getByRole('status')).toBeVisible()
    await expect(page.getByText('B account activity', { exact: true })).toHaveCount(0)
    await expect(page.getByText('2,222', { exact: true })).toHaveCount(0)
  } finally {
    release()
  }
})

test('invalid successful responses show separate retryable errors and recover', async ({ page }) => {
  let usageValid = false
  let activityValid = false
  await installBaseRoutes(page, () => 'a')
  await page.route('**/api/me/usage**', route => usageValid
    ? json(route, usage('a'))
    : route.fulfill({ status: 200, contentType: 'application/json', body: '{' }))
  await page.route('**/api/me/activity**', route => json(route, activityValid
    ? activity('a') : { ownerId: ownerId('a'), items: [{ id: 'bad', text: 'Private invalid activity', createdAt: 'bad-date' }] }))

  await page.goto('/agent-preview?surface=settings&tab=usage')
  const usageError = page.getByRole('alert').filter({ hasText: 'Usage is unavailable right now' })
  const activityError = page.getByRole('alert').filter({ hasText: 'Activity could not be loaded' })
  await expect(usageError).toBeVisible()
  await expect(activityError).toBeVisible()
  await expect(page.getByText('Private invalid activity')).toHaveCount(0)
  await expect(page.getByText('No recorded AI requests in this period.')).toHaveCount(0)
  usageValid = true
  await usageError.getByRole('button', { name: 'Try again' }).click()
  activityValid = true
  await activityError.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByText('1,111', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('A account activity', { exact: true })).toBeVisible()
})


test('time-window changes wait for the selected period and do not show stale totals', async ({ page }) => {
  let release!: () => void
  let sevenDayRequested = false
  let activityRequests = 0
  const waitForRelease = new Promise<void>(resolve => { release = resolve })
  await installBaseRoutes(page, () => 'a')
  await page.route('**/api/me/activity**', route => { activityRequests += 1; return json(route, activity('a')) })
  await page.route('**/api/me/usage**', async route => {
    const days = Number(new URL(route.request().url()).searchParams.get('days')) || 30
    if (days === 7) {
      sevenDayRequested = true
      await waitForRelease
    }
    await json(route, usage('a', days))
  })

  try {
    await page.goto('/agent-preview?surface=settings&tab=usage')
    await expect(page.getByText('1,111', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('A account activity', { exact: true })).toBeVisible()
    const initialActivityRequests = activityRequests
    expect(initialActivityRequests).toBeGreaterThan(0)
    const period = page.getByRole('combobox', { name: 'Time range' })
    await expect(period).toBeEnabled()
    await period.focus()
    await period.press('ArrowUp')
    await expect(period).toHaveValue('7')
    await expect(period).toBeFocused()
    await expect.poll(() => sevenDayRequested).toBe(true)
    await expect(page.getByText('Loading your usage…')).toBeVisible()
    await expect(page.getByText('1,111', { exact: true })).toHaveCount(0)
    release()
    await expect(page.getByText('7,777', { exact: true }).first()).toBeVisible()
    await expect(period).toBeFocused()
    await page.getByText('View daily numbers', { exact: true }).click()
    await expect(page.getByRole('table', { name: 'Daily requests' }).locator('tbody tr')).toHaveCount(7)
    await page.getByRole('combobox', { name: 'Time range' }).selectOption('30')
    await expect(page.getByText('1,111', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('7,777', { exact: true })).toHaveCount(0)
    expect(activityRequests).toBe(initialActivityRequests)
  } finally {
    release()
  }
})


test('a new cookie owner is not displayed under an old client session', async ({ page }) => {
  let sessionOwner: Owner = 'a'
  let cookieOwner: Exclude<Owner, null> = 'a'
  await installBaseRoutes(page, () => sessionOwner)
  await page.route('**/api/me/usage**', route => json(route, usage(cookieOwner)))
  await page.route('**/api/me/activity**', route => json(route, activity(cookieOwner)))

  await page.goto('/agent-preview?surface=settings&tab=usage')
  await expect(page.getByText('A account activity', { exact: true })).toBeVisible()
  await expect(page.getByText('1,111', { exact: true }).first()).toBeVisible()
  const refresh = page.getByRole('button', { name: 'Refresh usage' })
  await expect(refresh).toBeEnabled()

  // The HTTP cookie belongs to B, while the React session still says A.
  cookieOwner = 'b'
  await refresh.click()
  await expect(page.getByRole('alert').filter({ hasText: 'Usage is unavailable right now' })).toBeVisible()
  await expect(page.getByRole('alert').filter({ hasText: 'Activity could not be loaded' })).toBeVisible()
  await expect(page.getByText('B account activity', { exact: true })).toHaveCount(0)
  await expect(page.getByText('2,222', { exact: true })).toHaveCount(0)
  await expect(page.getByText('No recorded AI requests in this period.')).toHaveCount(0)

  sessionOwner = 'b'
  expect(await page.evaluate(() => document.visibilityState)).toBe('visible')
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(page.getByText('B account activity', { exact: true })).toBeVisible()
  await expect(page.getByText('2,222', { exact: true }).first()).toBeVisible()
})
