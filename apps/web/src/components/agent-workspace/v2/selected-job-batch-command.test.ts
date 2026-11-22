import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VerifiedShortlistPreparationRequest } from './VerifiedShortlistPreparation'

const fetchMock = vi.fn<typeof fetch>()
const source = (overrides: Record<string, unknown> = {}) => ({
  sessionId: 'session:one', sourceTurnId: 'discovery_turn_1', rootTaskId: 'root_1', graphItemId: 'graph_1', graphRevision: 3,
  ...overrides,
})
const request = (overrides: { sessionId?: string; selectedJobIds?: readonly string[]; source?: ReturnType<typeof source> } = {}): VerifiedShortlistPreparationRequest => ({
  source: overrides.source ?? source({ ...(overrides.sessionId ? { sessionId: overrides.sessionId } : {}) }),
  selectedJobIds: overrides.selectedJobIds ?? ['job_1', 'job_2'],
})

function response(body: unknown, status = 202): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
function receipt(overrides: Record<string, unknown> = {}) {
  return { inputId: 'input_1', turnId: 'turn_1', disposition: 'started', sequence: '8', ...overrides }
}
function messageId(index: number): string {
  return (fetchMock.mock.calls[index]?.[1]?.headers as Record<string, string> | undefined)?.['Idempotency-Key'] ?? ''
}
async function loadCommand() { return import('./selected-job-batch-command') }

beforeEach(() => {
  vi.resetModules()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('selected Job batch client command', () => {
  it('posts the exact schema, route and idempotency header and returns the Turn receipt', async () => {
    fetchMock.mockResolvedValue(response(receipt()))
    const { startSelectedJobBatch } = await loadCommand()

    await expect(startSelectedJobBatch('session:one', request())).resolves.toEqual({ turnId: 'turn_1', disposition: 'started' })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith('/api/agent/sessions/session%3Aone/prepare-selected-jobs', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': messageId(0) },
      body: JSON.stringify({
        schemaVersion: 'agent-harness.v2.verified-shortlist-selection.v1', clientMessageId: messageId(0),
        source: source(), selectedJobIds: ['job_1', 'job_2'],
      }),
    }))
    expect(messageId(0)).toMatch(/^selected-job-batch-[!-~]+$/)
  })

  it('reuses the same ID for an explicit retry after an ambiguous failure without automatic retries', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network unavailable'))
    const { startSelectedJobBatch } = await loadCommand()

    await expect(startSelectedJobBatch('session:one', request())).rejects.toThrow('could not be confirmed')
    expect(fetchMock).toHaveBeenCalledOnce()
    const firstId = messageId(0)
    fetchMock.mockResolvedValueOnce(response(receipt({ disposition: 'duplicate', originalDisposition: 'started' })))

    await expect(startSelectedJobBatch('session:one', request())).resolves.toEqual({ turnId: 'turn_1', disposition: 'duplicate' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(messageId(1)).toBe(firstId)
  })

  it('keeps the ID through network ambiguity and 401 until a duplicate receipt confirms acceptance', async () => {
    const { startSelectedJobBatch } = await loadCommand()
    fetchMock.mockRejectedValueOnce(new TypeError('network unavailable'))
      .mockResolvedValueOnce(response({}, 401))
      .mockResolvedValueOnce(response(receipt({ disposition: 'duplicate', originalDisposition: 'started' })))

    await expect(startSelectedJobBatch('session:one', request())).rejects.toThrow('could not be confirmed')
    const firstId = messageId(0)
    await expect(startSelectedJobBatch('session:one', request())).rejects.toThrow('status 401')
    await expect(startSelectedJobBatch('session:one', request())).resolves.toEqual({ turnId: 'turn_1', disposition: 'duplicate' })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(messageId(1)).toBe(firstId)
    expect(messageId(2)).toBe(firstId)
  })

  it('restores the same pending ID from session storage after module reload', async () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => { values.set(key, value) }),
      removeItem: vi.fn((key: string) => { values.delete(key) }),
    }
    vi.stubGlobal('sessionStorage', storage)
    fetchMock.mockRejectedValueOnce(new TypeError('connection closed'))
    const firstCommand = await loadCommand()
    await expect(firstCommand.startSelectedJobBatch('session:one', request())).rejects.toThrow('could not be confirmed')
    const firstId = messageId(0)

    vi.resetModules()
    fetchMock.mockResolvedValueOnce(response(receipt()))
    const reloadedCommand = await loadCommand()
    await expect(reloadedCommand.startSelectedJobBatch('session:one', request())).resolves.toEqual({ turnId: 'turn_1', disposition: 'started' })
    expect(messageId(1)).toBe(firstId)
    expect(storage.removeItem).toHaveBeenCalledOnce()
  })

  it('keeps different session and selection scopes on different IDs', async () => {
    fetchMock.mockResolvedValueOnce(response(receipt())).mockResolvedValueOnce(response(receipt()))
    const { startSelectedJobBatch } = await loadCommand()

    await startSelectedJobBatch('session:one', request())
    await startSelectedJobBatch('session:two', request({ sessionId: 'session:two', selectedJobIds: ['job_3', 'job_4'] }))

    expect(messageId(0)).not.toBe(messageId(1))
  })

  it('uses an in-memory fallback when browser storage is unavailable or throws', async () => {
    vi.stubGlobal('sessionStorage', {
      getItem: vi.fn(() => { throw new Error('storage unavailable') }),
      setItem: vi.fn(() => { throw new Error('storage unavailable') }),
      removeItem: vi.fn(() => { throw new Error('storage unavailable') }),
    })
    fetchMock.mockRejectedValueOnce(new TypeError('network unavailable'))
    const { startSelectedJobBatch } = await loadCommand()
    await expect(startSelectedJobBatch('session:one', request())).rejects.toThrow('could not be confirmed')
    fetchMock.mockResolvedValueOnce(response(receipt()))

    await expect(startSelectedJobBatch('session:one', request())).resolves.toMatchObject({ disposition: 'started' })
    expect(messageId(1)).toBe(messageId(0))
  })

  it('requires an exact 202 and a valid positive Turn receipt', async () => {
    const { startSelectedJobBatch } = await loadCommand()
    fetchMock.mockResolvedValueOnce(response(receipt(), 200))
    await expect(startSelectedJobBatch('session:one', request())).rejects.toThrow('status 200')
    fetchMock.mockResolvedValueOnce(response(receipt({ turnId: '' }), 202))
    await expect(startSelectedJobBatch('session:one', request())).rejects.toThrow('invalid response')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(messageId(0)).toBe(messageId(1))
  })

  it('bounds unresolved intents separately for each exact shortlist source', async () => {
    const { startSelectedJobBatch } = await loadCommand()
    fetchMock.mockResolvedValueOnce(response({}, 409)).mockResolvedValue(response({}, 503))
    const sourceA = source()
    const selections = [['job_1', 'job_2'], ['job_1', 'job_3'], ['job_2', 'job_3'], ['job_1', 'job_2', 'job_3']] as const
    for (const selectedJobIds of selections) {
      await expect(startSelectedJobBatch('session:one', request({ source: sourceA, selectedJobIds })))
        .rejects.toMatchObject({ message: expect.stringMatching(/status (409|503)/) })
    }
    const firstSourceId = messageId(0)
    await expect(startSelectedJobBatch('session:one', request({ source: sourceA, selectedJobIds: ['job_1', 'job_4'] })))
      .rejects.toThrow('too many unresolved requests')
    expect(fetchMock).toHaveBeenCalledTimes(4)

    fetchMock.mockResolvedValueOnce(response(receipt()))
    const sourceB = source({ sourceTurnId: 'discovery_turn_2', rootTaskId: 'root_2', graphItemId: 'graph_2' })
    await expect(startSelectedJobBatch('session:one', request({ source: sourceB })))
      .resolves.toEqual({ turnId: 'turn_1', disposition: 'started' })
    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(messageId(4)).not.toBe(firstSourceId)
  })

  it('rejects malformed local scopes before fetch', async () => {
    const { startSelectedJobBatch } = await loadCommand()
    await expect(startSelectedJobBatch('session:other', request())).rejects.toThrow('request is invalid')
    await expect(startSelectedJobBatch('session:one', request({ selectedJobIds: ['job_1'] }))).rejects.toThrow('request is invalid')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
