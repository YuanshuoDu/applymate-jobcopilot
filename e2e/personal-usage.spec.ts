import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test'

const labels = {
  en: {
    keys: 'Keys & connections', title: 'Usage & activity', refresh: 'Refresh usage', period: 'Time range', signInRequired: 'Sign in to view your usage and activity.',
    error: 'Usage is unavailable right now. Try again shortly.', activityError: 'Activity could not be loaded.',
    retry: 'Try again', empty: 'No recorded AI requests in this period.',
    loading: 'Loading your usage…', details: 'View daily numbers', daily: 'Daily requests',
  },
  zh: {
    keys: '密钥与连接', title: '使用量与活动', refresh: '刷新使用量', period: '统计时段', signInRequired: '请登录后查看用量与活动。',
    error: '暂时无法加载使用量，请稍后重试。', activityError: '暂时无法加载活动记录。',
    retry: '重试', empty: '这个时段还没有已记录的 AI 请求。',
    loading: '正在加载使用量…', details: '查看每日明细', daily: '每日请求',
  },
} as const

async function openUsage(page: Page, testInfo: TestInfo) {
  const locale = testInfo.project.metadata.appLocale === 'zh' ? 'zh' : 'en'
  await page.goto(`/agent-preview?surface=settings&tab=usage&locale=${locale}`)
  await expect(page.locator('html')).toHaveAttribute('lang', locale)
  await expect(page.getByRole('button', { name: labels[locale].keys })).toBeVisible()
  await expect(page.getByRole('region', { name: labels[locale].title, exact: true })).toBeVisible()
  return labels[locale]
}

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

async function refreshClientSession(page: Page, expectedOwner: Owner) {
  expect(await page.evaluate(() => document.visibilityState)).toBe('visible')
  const response = page.waitForResponse(result => new URL(result.url()).pathname === '/api/auth/session')
  // Exercise SessionProvider's real refocus handler and verify its fetched identity.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  expect(await (await response).json()).toEqual(session(expectedOwner))
}

test('account switch and sign out hide old usage even when an earlier refresh finishes late', async ({ page }, testInfo) => {
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
    const c = await openUsage(page, testInfo)
    await expect(page.getByText('A account activity', { exact: true })).toBeVisible()
    await expect(page.getByText('1,111', { exact: true }).first()).toBeVisible()
    const refresh = page.getByRole('button', { name: c.refresh })
    await expect(refresh).toBeEnabled()
    holdOldRefresh = true
    await refresh.click()
    await expect.poll(() => held.size).toBe(2)

    owner = 'b'
    await refreshClientSession(page, owner)
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
    await refreshClientSession(page, owner)
    await expect(page.getByRole('region', { name: c.title }).getByRole('status')).toHaveText(c.signInRequired)
    await expect(page.getByText('B account activity', { exact: true })).toHaveCount(0)
    await expect(page.getByText('2,222', { exact: true })).toHaveCount(0)
  } finally {
    release()
  }
})

test('invalid successful responses show separate retryable errors and recover', async ({ page }, testInfo) => {
  let usageValid = false
  let activityValid = false
  await installBaseRoutes(page, () => 'a')
  await page.route('**/api/me/usage**', route => usageValid
    ? json(route, usage('a'))
    : route.fulfill({ status: 200, contentType: 'application/json', body: '{' }))
  await page.route('**/api/me/activity**', route => json(route, activityValid
    ? activity('a') : { ownerId: ownerId('a'), items: [{ id: 'bad', text: 'Private invalid activity', createdAt: 'bad-date' }] }))

  const c = await openUsage(page, testInfo)
  const usageError = page.getByRole('alert').filter({ hasText: c.error })
  const activityError = page.getByRole('alert').filter({ hasText: c.activityError })
  await expect(usageError).toBeVisible()
  await expect(activityError).toBeVisible()
  await expect(page.getByText('Private invalid activity')).toHaveCount(0)
  await expect(page.getByText(c.empty)).toHaveCount(0)
  usageValid = true
  await usageError.getByRole('button', { name: c.retry }).click()
  activityValid = true
  await activityError.getByRole('button', { name: c.retry }).click()
  await expect(page.getByText('1,111', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('A account activity', { exact: true })).toBeVisible()
})


test('time-window changes wait for the selected period and do not show stale totals', async ({ page }, testInfo) => {
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
    const c = await openUsage(page, testInfo)
    await expect(page.getByText('1,111', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('A account activity', { exact: true })).toBeVisible()
    const initialActivityRequests = activityRequests
    expect(initialActivityRequests).toBeGreaterThan(0)
    const period = page.getByRole('combobox', { name: c.period })
    await expect(period).toBeEnabled()
    await period.focus()
    await period.press('ArrowUp')
    await expect(period).toHaveValue('7')
    await expect(period).toBeFocused()
    await expect.poll(() => sevenDayRequested).toBe(true)
    await expect(page.getByText(c.loading)).toBeVisible()
    await expect(page.getByText('1,111', { exact: true })).toHaveCount(0)
    release()
    await expect(page.getByText('7,777', { exact: true }).first()).toBeVisible()
    await expect(period).toBeFocused()
    await page.getByText(c.details, { exact: true }).click()
    await expect(page.getByRole('table', { name: c.daily }).locator('tbody tr')).toHaveCount(7)
    await period.selectOption('30')
    await expect(page.getByText('1,111', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('7,777', { exact: true })).toHaveCount(0)
    expect(activityRequests).toBe(initialActivityRequests)
  } finally {
    release()
  }
})


test('a late manual refresh for 30 days cannot overwrite the completed 7-day selection', async ({ page }, testInfo) => {
  let holdOldRefresh = false
  let oldRefreshHeld = false
  let oldRefreshDelivered = false
  let release!: () => void
  const waitForRelease = new Promise<void>(resolve => { release = resolve })
  await installBaseRoutes(page, () => 'a')
  await page.route('**/api/me/activity**', route => json(route, activity('a')))
  await page.route('**/api/me/usage**', async route => {
    const days = Number(new URL(route.request().url()).searchParams.get('days')) || 30
    const payload = usage('a', days)
    if (days === 30 && holdOldRefresh) {
      oldRefreshHeld = true
      await waitForRelease
      await json(route, payload)
      oldRefreshDelivered = true
      return
    }
    await json(route, payload)
  })

  try {
    const c = await openUsage(page, testInfo)
    await expect(page.getByText('1,111', { exact: true }).first()).toBeVisible()
    const refresh = page.getByRole('button', { name: c.refresh })
    await expect(refresh).toBeEnabled()

    // Start A as a manual refetch, which is independent of the URL-change request.
    holdOldRefresh = true
    await refresh.click()
    await expect.poll(() => oldRefreshHeld).toBe(true)
    await expect(page.getByText(c.loading)).toBeVisible()
    const period = page.getByRole('combobox', { name: c.period })
    await expect(period).toBeEnabled()
    await period.selectOption('7')
    // B must finish while A is still held; only then may the old response arrive.
    await expect(page.getByText('7,777', { exact: true }).first()).toBeVisible()
    await expect(refresh).toBeEnabled()
    await expect(period).toHaveValue('7')
    expect(oldRefreshDelivered).toBe(false)
    await expect(page.getByText('1,111', { exact: true })).toHaveCount(0)

    const oldResponse = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/me/usage' && url.searchParams.get('days') === '30'
    })
    release()
    await (await oldResponse).finished()
    await expect.poll(() => oldRefreshDelivered).toBe(true)
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect(period).toHaveValue('7')
    await expect(page.getByText('7,777', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('1,111', { exact: true })).toHaveCount(0)
    await expect(page.getByText(c.loading)).toHaveCount(0)
    await expect(page.getByRole('alert').filter({ hasText: c.error })).toHaveCount(0)
    await page.getByText(c.details, { exact: true }).click()
    await expect(page.getByRole('table', { name: c.daily }).locator('tbody tr')).toHaveCount(7)
  } finally {
    release()
  }
})

test('a new cookie owner is not displayed under an old client session', async ({ page }, testInfo) => {
  let sessionOwner: Owner = 'a'
  let cookieOwner: Exclude<Owner, null> = 'a'
  await installBaseRoutes(page, () => sessionOwner)
  await page.route('**/api/me/usage**', route => json(route, usage(cookieOwner)))
  await page.route('**/api/me/activity**', route => json(route, activity(cookieOwner)))

  const c = await openUsage(page, testInfo)
  await expect(page.getByText('A account activity', { exact: true })).toBeVisible()
  await expect(page.getByText('1,111', { exact: true }).first()).toBeVisible()
  const refresh = page.getByRole('button', { name: c.refresh })
  await expect(refresh).toBeEnabled()

  // The HTTP cookie belongs to B, while the React session still says A.
  cookieOwner = 'b'
  await refresh.click()
  await expect(page.getByRole('alert').filter({ hasText: c.error })).toBeVisible()
  await expect(page.getByRole('alert').filter({ hasText: c.activityError })).toBeVisible()
  await expect(page.getByText('B account activity', { exact: true })).toHaveCount(0)
  await expect(page.getByText('2,222', { exact: true })).toHaveCount(0)
  await expect(page.getByText(c.empty)).toHaveCount(0)

  sessionOwner = 'b'
  await refreshClientSession(page, sessionOwner)
  await expect(page.getByText('B account activity', { exact: true })).toBeVisible()
  await expect(page.getByText('2,222', { exact: true }).first()).toBeVisible()
})
