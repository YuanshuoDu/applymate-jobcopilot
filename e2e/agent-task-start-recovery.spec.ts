import type { Page, Route } from '@playwright/test'
import { expect, test } from './fixtures'

const ACCOUNT_A = 'fixture-account-a'
const ACCOUNT_B = 'fixture-account-b'
const SELECTED_SESSION = 'fixture-idle-session'
const ACCEPTED_SESSION = 'fixture-accepted-session'

type StoredAttempt = {
  accountScope: string
  attemptKey: string
  targetSlot: string
  targetKind: 'new-session' | 'selected-session'
  sessionId: string | null
  createKey: string | null
  phase: 'prepared' | 'create-requested' | 'session-known' | 'start-requested' | 'unknown' | 'accepted' | 'abandoned'
  createdAt: number
  updatedAt: number
  expiresAt: number
}

type AcceptedReceipt = { sessionId: string; turnId: string; inputId: string; sequence: string }
type ServerAttempt = { state: 'unknown' | 'abandoned' | 'unavailable' } | { state: 'accepted'; receipt: AcceptedReceipt }

type Fixture = {
  scope: string
  receipts: Map<string, ServerAttempt>
  receiptGets: string[]
  sessionTurnGets: string[]
  acceptedTurnIdle: boolean
  createCalls: Array<{ key: string | undefined; expectedScope: string | undefined; durable: StoredAttempt | undefined }>
  startCalls: Array<{ key: string | undefined; expectedScope: string | undefined; body: Record<string, unknown>; durable: StoredAttempt | undefined }>
  abandonCalls: Array<{ key: string; body: string | null; expectedScope: string | undefined }>
  reconcileCreateCalls: string[]
  indexCalls: number
  secondTabIndexCalls: number
  pageErrors: string[]
  switchScopeAfterReservation: boolean
  scopeChangedAfterReservation: boolean
  holdCreate: boolean
  createHeld: boolean
  mocksInstalled: boolean
  holdSessionKnownVerification: boolean
  sessionKnownVerificationHeld: boolean
  releaseCreate?: () => void
  signalCreateHeld?: () => void
  releaseSessionKnownVerification?: () => void
  signalSessionKnownVerification?: () => void
}

function fixture(): Fixture {
  return {
    scope: ACCOUNT_A, receipts: new Map(), receiptGets: [], sessionTurnGets: [], acceptedTurnIdle: false, createCalls: [], startCalls: [], abandonCalls: [],
    reconcileCreateCalls: [], indexCalls: 0, secondTabIndexCalls: 0, pageErrors: [],
    switchScopeAfterReservation: false, scopeChangedAfterReservation: false,
    holdCreate: false, createHeld: false, mocksInstalled: false,
    holdSessionKnownVerification: false, sessionKnownVerificationHeld: false,
  }
}

function json(route: Route, body: unknown, status = 200, headers: Record<string, string> = {}) {
  return route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) })
}

async function readStoredAttempts(page: Page): Promise<StoredAttempt[]> {
  return page.evaluate(async () => {
    const name = 'applymate-agent-task-attempts-v1'
    if (!(await indexedDB.databases()).some(database => database.name === name)) return []
    return new Promise<StoredAttempt[]>((resolve, reject) => {
      const open = indexedDB.open(name, 1)
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const db = open.result
        if (!db.objectStoreNames.contains('attempts')) { db.close(); resolve([]); return }
        const request = db.transaction('attempts', 'readonly').objectStore('attempts').getAll()
        request.onerror = () => { db.close(); reject(request.error) }
        request.onsuccess = () => { const rows = request.result as StoredAttempt[]; db.close(); resolve(rows) }
      }
    })
  })
}

async function seedAttempt(page: Page, attemptKey: string, target: 'new-session' | 'selected-session', phase: StoredAttempt['phase'], selectedSessionId = SELECTED_SESSION) {
  const createdAt = Date.now()
  const sessionId = target === 'selected-session' ? selectedSessionId : null
  const row: StoredAttempt = {
    accountScope: ACCOUNT_A, attemptKey,
    targetSlot: target === 'new-session' ? 'new-session' : JSON.stringify(['session', sessionId]),
    targetKind: target, sessionId, createKey: target === 'new-session' ? `create-${attemptKey}` : null,
    phase, createdAt, updatedAt: createdAt, expiresAt: createdAt + 30 * 24 * 60 * 60 * 1000,
  }
  await page.evaluate(async value => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('applymate-agent-task-attempts-v1', 1)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
    })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('attempts', 'readwrite')
      tx.objectStore('attempts').put(value)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
    db.close()
  }, row)
}

async function installApiMocks(page: Page, state: Fixture) {
  await page.context().route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const { pathname } = url
    const method = request.method()
    const tab = new URL(request.frame().url()).searchParams.get('e2eTab')

    if (pathname === '/api/auth/session') return json(route, { user: { id: 'fixture-user' }, expires: '2099-01-01T00:00:00.000Z' })
    if (pathname === '/api/me') return json(route, { id: 'fixture-user', email: 'fixture@example.test', name: 'Fixture', plan: 'pro', onboardedAt: '2026-01-01T00:00:00.000Z' })
    if (pathname === '/api/jobs' || pathname === '/api/resume') return json(route, pathname === '/api/jobs' ? { jobs: [], total: 0, statusCounts: {} } : [])
    if (pathname === '/api/agent') return json(route, { autoApply: false, requireApproval: true, isRunning: false })
    if (pathname === '/api/agent/roles' || pathname === '/api/agent/roles/custom') return json(route, [])
    if (pathname === '/api/agent/automations') return json(route, { automations: [] })
    if (pathname === '/api/agent/health') return json(route, { successRate: 100, captchaRate: 0, avgDurationMs: 1, patternCacheRate: 100, last24hRuns: 0 })
    if (pathname === '/api/notifications' || pathname.startsWith('/api/notifications/')) return json(route, { notifications: [], unreadCount: 0 })
    if (pathname === '/api/gmail/unread') return json(route, { hasGmail: false, unread: 0 })
    if (pathname === '/api/me/agent-task-history-memory') return json(route, { enabled: false, version: 0 })
    if (pathname === '/api/me/agent-search-footprint-memory') return json(route, { enabled: false, version: 0 })

    if (pathname === '/api/agent/objective-start-attempts' && method === 'GET') {
      state.indexCalls += 1
      if (tab === 'second') state.secondTabIndexCalls += 1
      let accountScope = state.scope
      if (state.switchScopeAfterReservation) {
        try {
          const rows = await readStoredAttempts(request.frame().page())
          if (rows.some(row => row.accountScope === ACCOUNT_A)) {
            accountScope = ACCOUNT_B
            state.scopeChangedAfterReservation = true
            state.scope = ACCOUNT_B
          }
        } catch { /* Storage failure is exercised as a separate case. */ }
      }
      if (state.holdSessionKnownVerification && !state.sessionKnownVerificationHeld) {
        try {
          const rows = await readStoredAttempts(request.frame().page())
          if (rows.some(row => row.phase === 'session-known')) {
            state.sessionKnownVerificationHeld = true
            state.signalSessionKnownVerification?.()
            await new Promise<void>(resolve => { state.releaseSessionKnownVerification = resolve })
          }
        } catch { /* The task route records storage failure in its own test. */ }
      }
      return json(route, { accountScope, attempts: [] }, 200, { 'X-Account-Scope': accountScope })
    }

    const abandon = pathname.match(/^\/api\/agent\/objective-start-attempts\/([^/]+)\/abandon$/)
    if (abandon && method === 'POST') {
      const key = decodeURIComponent(abandon[1]!)
      state.abandonCalls.push({ key, body: request.postData(), expectedScope: request.headers()['x-expected-account-scope'] })
      state.receipts.set(key, { state: 'abandoned' })
      return json(route, { accountScope: state.scope, state: 'abandoned' }, 200, { 'X-Account-Scope': state.scope })
    }
    const receipt = pathname.match(/^\/api\/agent\/objective-start-attempts\/([^/]+)$/)
    if (receipt && method === 'GET') {
      const key = decodeURIComponent(receipt[1]!)
      state.receiptGets.push(key)
      const value = state.receipts.get(key) ?? { state: 'unknown' as const }
      return json(route, { accountScope: state.scope, ...value }, 200, { 'X-Account-Scope': state.scope })
    }
    if (pathname === '/api/agent/sessions/reconcile-create' && method === 'POST') {
      const body = request.postDataJSON() as { idempotencyKey?: string }
      state.reconcileCreateCalls.push(body.idempotencyKey ?? '')
      return json(route, { accountScope: state.scope, state: 'unknown' }, 200, { 'X-Account-Scope': state.scope })
    }

    if (pathname === '/api/agent/sessions' && method === 'POST') {
      const key = request.headers()['idempotency-key']
      const expectedScope = request.headers()['x-expected-account-scope']
      const rows = await readStoredAttempts(request.frame().page()).catch(() => [])
      const durable = rows.find(row => row.attemptKey === key)
      state.createCalls.push({ key, expectedScope, durable })
      if (state.holdCreate && !state.createHeld) {
        state.createHeld = true
        state.signalCreateHeld?.()
        await new Promise<void>(resolve => { state.releaseCreate = resolve })
      }
      return json(route, { session: { id: 'fixture-created-session' } }, 201,
        { 'X-Account-Scope': expectedScope ?? state.scope })
    }

    const start = pathname.match(/^\/api\/agent\/sessions\/([^/]+)\/start-objective$/)
    if (start && method === 'POST') {
      const key = request.headers()['idempotency-key']
      const expectedScope = request.headers()['x-expected-account-scope']
      const body = request.postDataJSON() as Record<string, unknown>
      const rows = await readStoredAttempts(request.frame().page()).catch(() => [])
      state.startCalls.push({ key, expectedScope, body, durable: rows.find(row => row.attemptKey === key) })
      return json(route, { inputId: `input-${key}`, turnId: `turn-${key}`, disposition: 'started', sequence: '1' }, 202,
        { 'X-Account-Scope': expectedScope ?? state.scope })
    }

    if (pathname === '/api/agent/sessions' && method === 'GET') {
      const ids = new Set([SELECTED_SESSION, ACCEPTED_SESSION, 'fixture-created-session'])
      return json(route, { sessions: [...ids].map(id => ({ id, goal: 'Fixture task', status: 'running', updatedAt: '2026-01-01T00:00:00.000Z' })), lastOpenedSessionId: null })
    }
    const session = pathname.match(/^\/api\/agent\/sessions\/([^/]+)(?:\/([^/]+))?$/)
    if (session) {
      const id = decodeURIComponent(session[1]!)
      const resource = session[2] ?? ''
      if (!resource) return json(route, { session: { id, status: 'running', goal: 'Fixture task' } })
      if (resource === 'turns') state.sessionTurnGets.push(id)
      if (resource === 'turns' && id === ACCEPTED_SESSION && !state.acceptedTurnIdle) return json(route, {
        turns: [{ id: 'accepted-turn', sessionId: id, source: 'message', goal: 'Original accepted task', status: 'in_progress', revision: 1, activeStepId: null }],
        projection: { activeTurnId: 'accepted-turn', activeTurn: { id: 'accepted-turn', status: 'in_progress', revision: 1, goal: 'Original accepted task' }, queuedInputCount: 0 },
      })
      if (resource === 'turns') return json(route, { turns: [], projection: { activeTurnId: null, activeTurn: null, queuedInputCount: 0 } })
      if (resource === 'events' || resource === 'timeline') return json(route, { events: [], items: [], page: { hasMore: false, nextCursor: null } })
      if (resource === 'tasks') return json(route, { tasks: [] })
      return json(route, { session: { id, status: 'running', goal: 'Fixture task' } })
    }
    if (pathname.startsWith('/api/agent/sessions/')) return json(route, { ok: true })
    return json(route, {})
  })
}

function previewUrl(sessionId?: string, tab?: string): string {
  const query = new URLSearchParams({ supervisor: '1', locale: 'en' })
  if (sessionId) query.set('sessionId', sessionId)
  if (tab) query.set('e2eTab', tab)
  return `/agent-preview?${query.toString()}`
}

async function openComposer(page: Page, state: Fixture, sessionId?: string, tab?: string) {
  if (!state.mocksInstalled) {
    await installApiMocks(page, state)
    state.mocksInstalled = true
  }
  page.on('pageerror', error => state.pageErrors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') state.pageErrors.push(message.text()) })
  await page.goto(previewUrl(sessionId, tab))
  try { await expect.poll(() => state.indexCalls, { timeout: 5_000 }).toBeGreaterThan(0) }
  catch (error) { throw new Error(`${String(error)}\nBrowser console/page errors: ${state.pageErrors.join(' | ')}`) }
  await expect(page.getByTestId('composer-mode-task')).toBeEnabled({ timeout: 15_000 })
}

async function submitTask(page: Page, objective: string) {
  await page.getByTestId('composer-mode-task').click()
  await page.locator('#agent-composer-input').fill(objective)
  await page.getByTestId('composer-mode-send').click()
}

test('Chromium rejects an arbitrary object receiver for native fetch', async ({ page }) => {
  const state = fixture()
  await installApiMocks(page, state)
  await page.goto(previewUrl())
  const evidence = await page.evaluate(async () => {
    const path = '/api/agent/objective-start-attempts?limit=20'
    const invoke = async (call: () => Promise<Response>) => {
      try {
        const response = await call()
        return `status:${response.status}`
      } catch (error) {
        return `${error instanceof Error ? error.name : 'Error'}:${error instanceof Error ? error.message : 'unknown'}`
      }
    }
    const unboundFetch = window.fetch
    return {
      wrong: await invoke(() => window.fetch.call({} as Window, path)),
      unbound: await invoke(() => unboundFetch(path)),
      correct: await invoke(() => window.fetch.call(window, path)),
    }
  })
  expect(evidence.wrong).toMatch(/Illegal invocation/i)
  expect(evidence.unbound).toBe('status:200')
  expect(evidence.correct).toBe('status:200')
})

test('commits opaque IndexedDB reservation before create and start requests', async ({ page }) => {
  const state = fixture()
  await openComposer(page, state)
  await submitTask(page, 'Plan a small verification task')

  await expect.poll(() => state.createCalls.length).toBe(1)
  await expect.poll(() => state.startCalls.length).toBe(1)
  const create = state.createCalls[0]!
  const start = state.startCalls[0]!
  expect(create.key).toBeTruthy()
  expect(create.expectedScope).toBe(ACCOUNT_A)
  expect(start.expectedScope).toBe(ACCOUNT_A)
  expect(create.durable).toMatchObject({ attemptKey: create.key, targetSlot: 'new-session', targetKind: 'new-session', createKey: create.key, phase: 'create-requested' })
  expect(start.key).toBe(create.key)
  expect(start.body.clientMessageId).toBe(create.key)
  expect(start.durable).toMatchObject({ attemptKey: start.key, targetKind: 'selected-session', sessionId: 'fixture-created-session', phase: 'start-requested' })
  expect(Object.keys(start.durable ?? {}).sort()).toEqual(['accountScope', 'attemptKey', 'createKey', 'createdAt', 'expiresAt', 'phase', 'sessionId', 'targetKind', 'targetSlot', 'updatedAt'].sort())
})

test('does not POST a task when IndexedDB recovery storage is unavailable', async ({ page }) => {
  const state = fixture()
  await page.addInitScript(() => Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined }))
  if (!state.mocksInstalled) {
    await installApiMocks(page, state)
    state.mocksInstalled = true
  }
  await page.goto(previewUrl())
  await expect(page.getByTestId('composer-mode-task')).toBeVisible({ timeout: 20_000 })

  await expect(page.getByTestId('composer-mode-task')).toBeDisabled()
  await expect(page.locator('#composer-task-mode-help')).toContainText('Task recovery is unavailable')
  await expect(page.locator('#composer-task-mode-help')).not.toContainText('Checking task recovery')
  expect(state.createCalls).toHaveLength(0)
  expect(state.startCalls).toHaveLength(0)
})

test('refresh reconciles an accepted receipt without creating a Session or starting another task', async ({ page }) => {
  const state = fixture()
  const key = 'accepted-attempt-key'
  state.receipts.set(key, { state: 'accepted', receipt: { sessionId: ACCEPTED_SESSION, turnId: 'accepted-turn', inputId: 'accepted-input', sequence: '7' } })
  await openComposer(page, state)
  await seedAttempt(page, key, 'selected-session', 'accepted', ACCEPTED_SESSION)
  state.receiptGets.length = 0
  await page.reload()

  await expect(page.locator('[data-task-recovery-notice="accepted"]')).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => state.receiptGets.filter(value => value === key).length).toBeGreaterThan(0)
  expect(state.createCalls).toHaveLength(0)
  expect(state.startCalls).toHaveLength(0)

  await page.locator('[data-task-recovery-notice="accepted"]').getByRole('button', { name: 'Open accepted task' }).click()
  await expect.poll(() => new URL(page.url()).searchParams.get('sessionId')).toBe(ACCEPTED_SESSION)
  await expect.poll(() => state.sessionTurnGets.includes(ACCEPTED_SESSION)).toBe(true)
  await expect(page.locator('[data-agent-current-objective="true"]')).toContainText('Original accepted task')
  expect(state.createCalls).toHaveLength(0)
  expect(state.startCalls).toHaveLength(0)

  state.acceptedTurnIdle = true
  await page.reload()
  await expect(page.getByTestId('composer-mode-task')).toBeEnabled({ timeout: 20_000 })
  await submitTask(page, 'Start a follow-up plan in the same idle Session')
  await expect.poll(() => state.startCalls.length).toBe(1)
  expect(state.startCalls[0]?.key).not.toBe(key)
  expect(state.startCalls[0]?.expectedScope).toBe(ACCOUNT_A)
  expect(state.createCalls).toHaveLength(0)
})

test('fails closed when authenticated account scope changes after reservation', async ({ page }) => {
  const state = fixture()
  await openComposer(page, state)
  state.switchScopeAfterReservation = true
  await submitTask(page, 'Do not send across account changes')

  await expect.poll(() => state.scopeChangedAfterReservation).toBe(true)
  expect(state.scope).toBe(ACCOUNT_B)
  await expect.poll(() => page.getByTestId('composer-mode-send').isEnabled()).toBe(true)
  expect(state.createCalls).toHaveLength(0)
  expect(state.startCalls).toHaveLength(0)
  expect(await readStoredAttempts(page)).toHaveLength(1)
})

test('passive refresh and explicit recheck cannot demote a live admission phase', async ({ page }) => {
  const state = fixture()
  let signalKnownVerification!: () => void
  const knownVerificationHeld = new Promise<void>(resolve => { signalKnownVerification = resolve })
  state.holdSessionKnownVerification = true
  state.signalSessionKnownVerification = signalKnownVerification
  await openComposer(page, state)

  await submitTask(page, 'Keep admission safe during receipt refresh')
  await knownVerificationHeld
  const attemptKey = state.createCalls[0]?.key
  expect(attemptKey).toBeTruthy()
  const live = (await readStoredAttempts(page)).find(row => row.attemptKey === attemptKey)
  expect(live).toMatchObject({ attemptKey, phase: 'session-known', targetSlot: JSON.stringify(['session', 'fixture-created-session']),
    targetKind: 'selected-session', sessionId: 'fixture-created-session' })

  try {
    const readsBeforeFocus = state.receiptGets.length
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(page.locator('[data-task-recovery-notice="unknown"]')).toBeVisible({ timeout: 10_000 })
    await expect.poll(() => state.receiptGets.length).toBeGreaterThan(readsBeforeFocus)
    const readsBeforeCheck = state.receiptGets.length
    await page.locator('[data-task-recovery-notice="unknown"]').getByRole('button', { name: 'Check start status' }).click()
    await expect.poll(() => state.receiptGets.length).toBeGreaterThan(readsBeforeCheck)

    state.releaseSessionKnownVerification?.()
    await expect.poll(() => state.startCalls.length).toBe(1)
    expect(state.startCalls[0]?.durable).toMatchObject({ attemptKey: state.startCalls[0]?.key, phase: 'start-requested',
      targetKind: 'selected-session', sessionId: 'fixture-created-session' })
  } finally {
    state.releaseSessionKnownVerification?.()
  }
})

test('rechecks unknown, explicitly abandons, removes its local notice, then reserves a fresh key', async ({ page }) => {
  const state = fixture()
  const oldKey = 'old-unknown-attempt'
  state.receipts.set(oldKey, { state: 'unknown' })
  await openComposer(page, state, SELECTED_SESSION)
  await seedAttempt(page, oldKey, 'selected-session', 'unknown')
  await page.reload()
  const notice = page.locator('[data-task-recovery-notice="unknown"]')
  await expect(notice).toBeVisible({ timeout: 20_000 })
  expect(state.startCalls).toHaveLength(0)

  const initialChecks = state.receiptGets.filter(value => value === oldKey).length
  await notice.getByRole('button', { name: 'Check start status' }).click()
  await expect.poll(() => state.receiptGets.filter(value => value === oldKey).length).toBeGreaterThan(initialChecks)
  expect(state.startCalls).toHaveLength(0)
  await notice.getByRole('button', { name: 'Abandon this start attempt' }).click()
  await expect(page.locator('[data-task-recovery-notice="abandoned"]')).toBeVisible({ timeout: 10_000 })
  expect(state.abandonCalls).toHaveLength(1)
  expect(state.abandonCalls[0]).toMatchObject({ key: oldKey, body: null, expectedScope: ACCOUNT_A })
  expect(state.startCalls).toHaveLength(0)

  await page.getByRole('button', { name: 'Remove local recovery notice' }).click()
  await expect(page.locator('[data-task-recovery-notice]')).toHaveCount(0, { timeout: 10_000 })
  await expect(page.getByTestId('composer-mode-task')).toBeEnabled({ timeout: 10_000 })
  expect(state.startCalls).toHaveLength(0)
  await submitTask(page, 'Start a new task after removing the old notice')
  await expect.poll(() => state.startCalls.length).toBe(1)
  expect(state.startCalls[0]?.key).toBeTruthy()
  expect(state.startCalls[0]?.key).not.toBe(oldKey)
  expect(state.startCalls[0]?.body.clientMessageId).toBe(state.startCalls[0]?.key)
  expect(state.startCalls[0]?.expectedScope).toBe(ACCOUNT_A)
})

test('two tabs cannot reserve and POST separate attempts for the same blank target', async ({ page, context }) => {
  const state = fixture()
  let releaseCreate!: () => void
  let signalCreateHeld!: () => void
  const createHeld = new Promise<void>(resolve => { signalCreateHeld = resolve })
  state.holdCreate = true
  state.releaseCreate = () => releaseCreate()
  state.signalCreateHeld = signalCreateHeld
  await openComposer(page, state, undefined, 'first')
  const second = await context.newPage()
  await openComposer(second, state, undefined, 'second')

  try {
    await submitTask(page, 'First tab task')
    await createHeld
    expect(state.createCalls).toHaveLength(1)
    const indexBefore = state.secondTabIndexCalls
    await submitTask(second, 'Different second tab task')
    await expect.poll(() => state.secondTabIndexCalls).toBeGreaterThan(indexBefore)
    await expect.poll(() => readStoredAttempts(page)).toHaveLength(1)
    expect(state.createCalls).toHaveLength(1)
    expect(state.startCalls).toHaveLength(0)
    expect(state.createCalls[0]?.durable).toMatchObject({ phase: 'create-requested', targetSlot: 'new-session' })
  } finally {
    state.releaseCreate?.()
  }

  await expect.poll(() => state.startCalls.length).toBe(1)
  expect(state.createCalls).toHaveLength(1)
  expect(state.startCalls[0]?.key).toBe(state.createCalls[0]?.key)
})
