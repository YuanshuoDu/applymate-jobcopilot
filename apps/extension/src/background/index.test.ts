import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionSettings, ExtMessage, SavedJob, ScrapedJob } from '@/lib/types'

const api = vi.hoisted(() => ({ login: vi.fn(), saveJob: vi.fn(), getRecentJobs: vi.fn(), getStats: vi.fn(), updateJob: vi.fn(), scoreSavedJob: vi.fn() }))
const storage = vi.hoisted(() => ({ clearAccountLocalState: vi.fn(), getAccountStorageKey: vi.fn(), getSettings: vi.fn(), setCurrentJob: vi.fn(), setBadge: vi.fn(), clearBadge: vi.fn() }))
vi.mock('@/lib/api', () => api)
vi.mock('@/lib/storage', () => storage)

const accountA: ExtensionSettings = { apiBaseUrl: 'https://applymate.site', apiToken: 'a-token', userEmail: 'a@example.test', userName: 'Candidate A', autoSave: false }
const accountB = { ...accountA, apiToken: 'b-token', userEmail: 'b@example.test', userName: 'Candidate B' }
const scraped: ScrapedJob = { title: 'Software Engineer', company: 'Example employer', location: 'Remote', description: 'Sample job', salary: null, url: 'https://company.test/jobs/123', source: 'unknown' }
const saved: SavedJob = { id: 'saved-a', company: scraped.company, role: scraped.title, location: scraped.location, status: 'saved', score: null, salary: null, notes: null, source: 'unknown', createdAt: '2026-11-02T00:00:00Z', url: scraped.url, finalResumeId: null, finalCoverLetterId: null }
type Listener = (message: ExtMessage, sender: chrome.runtime.MessageSender, respond: (value: unknown) => void) => unknown
type SettingsListener = (changes: Record<string, { oldValue: ExtensionSettings; newValue: ExtensionSettings }>, area: string) => void
let listener: Listener
let settingsListener: SettingsListener
let current: ExtensionSettings

const event = () => ({ addListener: vi.fn() })
function makeChrome() {
  return {
    runtime: { id: 'test-extension', onMessage: { addListener: vi.fn((value: Listener) => { listener = value }) }, onInstalled: event(), onStartup: event(), sendMessage: vi.fn(async (_message: unknown) => ({})) },
    tabs: { query: vi.fn(async () => [{ id: 90, url: 'https://applymate.site/?page=jobs' }]), sendMessage: vi.fn(async () => ({ ok: true })), onActivated: event(), onRemoved: event(), onUpdated: event() },
    storage: { onChanged: { addListener: vi.fn((value: SettingsListener) => { settingsListener = value }) }, local: { get: vi.fn(async (_key: string) => ({})), set: vi.fn(async (_value: unknown) => undefined) } },
    scripting: { executeScript: vi.fn(async () => []) },
    commands: { onCommand: event() },
  }
}
let browser: ReturnType<typeof makeChrome>

function changeAccount(next: ExtensionSettings) {
  const old = current
  current = { ...next }
  settingsListener({ settings: { oldValue: old, newValue: current } }, 'sync')
}
function send(message: ExtMessage): Promise<unknown> {
  return new Promise(resolve => listener(message, { id: 'test-extension' }, resolve))
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(complete => { resolve = complete })
  return { promise, resolve }
}
async function until(predicate: () => boolean) {
  for (let turn = 0; turn < 30 && !predicate(); turn++) await Promise.resolve()
  expect(predicate()).toBe(true)
}

beforeEach(async () => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.useFakeTimers()
  current = { ...accountA }
  browser = makeChrome()
  vi.stubGlobal('chrome', browser)
  storage.getSettings.mockImplementation(async () => ({ ...current }))
  storage.getAccountStorageKey.mockImplementation((name: string, email: string) => `${email}:${name}`)
  storage.clearAccountLocalState.mockResolvedValue(undefined)
  api.saveJob.mockResolvedValue(saved)
  api.scoreSavedJob.mockResolvedValue({ ...saved, score: 90 })
  api.getRecentJobs.mockResolvedValue([saved])
  api.getStats.mockResolvedValue({ total: 1 })
  await import('./index')
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('background wrapper recovery boundaries', () => {
  it.each([
    { type: 'SAVE_JOB', method: 'saveJob', job: scraped },
    { type: 'MATCH_JOB', method: 'scoreSavedJob', job: saved },
    { type: 'GET_RECENT_JOBS', method: 'getRecentJobs' },
    { type: 'GET_STATS', method: 'getStats' },
  ] as const)('does not bypass API identity guards in $type', async ({ type, method, ...payload }) => {
    api[method].mockRejectedValueOnce({ status: 401 })
    browser.tabs.sendMessage.mockImplementation(async () => { changeAccount(accountB); return { ok: true } })
    const response = await send({ type, ...payload } as ExtMessage)
    expect(api[method]).toHaveBeenCalledTimes(1)
    expect(api[method].mock.calls[0][0]).toEqual(accountA)
    expect(response).toMatchObject({ error: expect.any(String) })
    expect(browser.runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('allows same-account token recovery through the real SAVE_JOB handler', async () => {
    api.saveJob.mockRejectedValueOnce({ status: 401 })
    const refreshed = { ...accountA, apiToken: 'a-fresh-token', userEmail: ' A@example.test ' }
    browser.tabs.sendMessage.mockImplementation(async () => { changeAccount(refreshed); return { ok: true } })
    expect(await send({ type: 'SAVE_JOB', job: scraped })).toMatchObject({ success: true, savedJob: saved })
    expect(api.saveJob).toHaveBeenCalledTimes(2)
    expect(api.saveJob).toHaveBeenNthCalledWith(2, refreshed, scraped)
  })

  it('connects an unknown first account without sending the pending payload until a new click', async () => {
    current = { ...accountA, apiToken: '', userEmail: '' }
    browser.tabs.sendMessage.mockImplementation(async () => { changeAccount(accountB); return { ok: true } })
    expect(await send({ type: 'SAVE_JOB', job: scraped })).toMatchObject({ success: false, error: expect.stringContaining('Check the selected account') })
    expect(api.saveJob).not.toHaveBeenCalled()
    expect(await send({ type: 'SAVE_JOB', job: scraped })).toMatchObject({ success: true })
    expect(api.saveJob).toHaveBeenCalledExactlyOnceWith(accountB, scraped)
  })
})

describe('in-flight results after account changes', () => {
  it.each(['B', 'A again'])('does not publish an old save or delete the new account’s pending save (%s)', async destination => {
    const old = deferred<SavedJob>()
    const newer = deferred<SavedJob>()
    api.saveJob.mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise)
    const oldResponse = send({ type: 'SAVE_JOB', job: scraped })
    await until(() => api.saveJob.mock.calls.length === 1)
    changeAccount(accountB)
    if (destination === 'A again') changeAccount(accountA)
    const selected = { ...current }
    const newResponse = send({ type: 'SAVE_JOB', job: scraped })
    await until(() => api.saveJob.mock.calls.length === 2)

    old.resolve(saved)
    expect(await oldResponse).toMatchObject({ success: false, error: expect.stringContaining('account changed') })
    expect(browser.storage.local.set).not.toHaveBeenCalled()
    expect(browser.runtime.sendMessage).not.toHaveBeenCalled()

    const duplicate = send({ type: 'SAVE_JOB', job: scraped })
    await Promise.resolve(); await Promise.resolve()
    expect(api.saveJob).toHaveBeenCalledTimes(2)
    const newSaved = { ...saved, id: 'new-account-save' }
    newer.resolve(newSaved)
    expect(await newResponse).toMatchObject({ success: true, savedJob: newSaved })
    expect(await duplicate).toMatchObject({ success: true, savedJob: newSaved })
    expect(api.saveJob).toHaveBeenLastCalledWith(selected, scraped)
    expect(browser.runtime.sendMessage.mock.calls.every(([message]) => (message as { savedJob: SavedJob }).savedJob.id === 'new-account-save')).toBe(true)

    expect(await send({ type: 'SAVE_JOB', job: scraped })).toMatchObject({ alreadySaved: true, savedJob: newSaved })
    expect(api.saveJob).toHaveBeenCalledTimes(2)
  })

  it('does not write an old URL cache entry when the account changes during its storage read', async () => {
    const cache = deferred<Record<string, unknown>>()
    browser.storage.local.get.mockReturnValue(cache.promise)
    const response = send({ type: 'SAVE_JOB', job: scraped })
    await until(() => browser.storage.local.get.mock.calls.length === 1)
    changeAccount(accountB)
    cache.resolve({})
    expect(await response).toMatchObject({ success: false, error: expect.stringContaining('account changed') })
    expect(browser.storage.local.set).not.toHaveBeenCalled()
    expect(browser.runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('does not broadcast a stale MATCH_JOB score after switching accounts', async () => {
    const scoring = deferred<SavedJob>()
    api.scoreSavedJob.mockReturnValue(scoring.promise)
    const response = send({ type: 'MATCH_JOB', job: saved })
    await until(() => api.scoreSavedJob.mock.calls.length === 1)
    changeAccount(accountB)
    scoring.resolve({ ...saved, score: 80 })
    expect(await response).toMatchObject({ success: false, error: expect.stringContaining('account changed') })
    expect(browser.runtime.sendMessage).not.toHaveBeenCalled()
  })

  it.each(['GET_RECENT_JOBS', 'GET_STATS'] as const)('does not return old account data from an in-flight %s', async type => {
    const data = deferred<unknown>()
    const method = type === 'GET_STATS' ? api.getStats : api.getRecentJobs
    method.mockReturnValue(data.promise)
    const response = send({ type })
    await until(() => method.mock.calls.length === 1)
    changeAccount(accountB)
    data.resolve(type === 'GET_STATS' ? { total: 10 } : [saved])
    expect(await response).toMatchObject({ error: expect.stringContaining('account changed') })
  })
})
