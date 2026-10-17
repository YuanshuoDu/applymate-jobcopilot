import { describe, expect, it, vi } from 'vitest'
import { schemaVersion } from '@jobcopilot/agent-protocol'
import { startAgentObjective, type StartAgentObjectiveRequest } from './agent-objective-start-command'

const request: StartAgentObjectiveRequest = {
  sessionId: 'session/one',
  clientMessageId: 'objective-key-1',
  objective: '  Find backend roles in Dublin  ',
  content: [{ type: 'text', text: 'Reference notes stay exactly as entered.\n' }],
}

function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
}

describe('startAgentObjective', () => {
  it('posts the strict fresh-objective body once and preserves supporting text', async () => {
    const result = { inputId: 'input-1', turnId: 'turn-1', disposition: 'started', sequence: '7' }
    const fetcher = vi.fn<typeof fetch>(async () => response(202, result))
    await expect(startAgentObjective(request, fetcher)).resolves.toEqual(result)

    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe('/api/agent/sessions/session%2Fone/start-objective')
    expect(init).toMatchObject({
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': request.clientMessageId },
    })
    expect(JSON.parse(String(init?.body))).toEqual({
      schemaVersion,
      clientMessageId: request.clientMessageId,
      objective: 'Find backend roles in Dublin',
      content: request.content,
    })
  })

  it('accepts a 2,000-byte Unicode objective without changing its content', async () => {
    const objective = '你'.repeat(666) + 'ab'
    expect(new TextEncoder().encode(objective).byteLength).toBe(2_000)
    const fetcher = vi.fn<typeof fetch>(async () => response(202, {
      inputId: 'input-1', turnId: 'turn-1', disposition: 'started', sequence: '7',
    }))
    await startAgentObjective({ ...request, objective }, fetcher)
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).objective).toBe(objective)
  })

  it('preserves supporting context at the 20,000-character limit', async () => {
    const context = 'x'.repeat(20_000)
    const fetcher = vi.fn<typeof fetch>(async () => response(202, {
      inputId: 'input-1', turnId: 'turn-1', disposition: 'started', sequence: '7',
    }))
    await startAgentObjective({ ...request, content: [{ type: 'text', text: context }] }, fetcher)
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).content).toEqual([{ type: 'text', text: context }])
  })

  it('rejects objectives above 2,000 UTF-8 bytes and oversized context before fetch', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response(202, {}))
    await expect(startAgentObjective({ ...request, objective: '你'.repeat(667) }, fetcher))
      .rejects.toMatchObject({ status: 422, code: 'invalid_command' })
    await expect(startAgentObjective({ ...request, content: [{ type: 'text', text: 'x'.repeat(20_001) }] }, fetcher))
      .rejects.toMatchObject({ status: 422, code: 'invalid_command' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('parses an idempotent duplicate result without exposing arbitrary response fields', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response(202, {
      inputId: 'input-1', turnId: 'turn-1', disposition: 'duplicate', originalDisposition: 'started',
      sequence: '7', internal: 'ignored',
    }))
    await expect(startAgentObjective(request, fetcher)).resolves.toEqual({
      inputId: 'input-1', turnId: 'turn-1', disposition: 'duplicate', originalDisposition: 'started', sequence: '7',
    })
  })

  it('preserves typed conflicts and performs no automatic retry', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response(409, {
      error: { code: 'session_not_fresh', message: 'A task is already active.', details: { status: 'running' } },
    }))
    await expect(startAgentObjective(request, fetcher)).rejects.toMatchObject({
      name: 'ObjectiveStartCommandError', status: 409, code: 'session_not_fresh', message: 'A task is already active.',
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('keeps an uncertain network result as one call and rejects malformed success data', async () => {
    const network = new Error('connection lost')
    const failing = vi.fn<typeof fetch>(async () => { throw network })
    await expect(startAgentObjective(request, failing)).rejects.toBe(network)
    const malformed = vi.fn<typeof fetch>(async () => response(202, { inputId: 'input-1', disposition: 'started' }))
    await expect(startAgentObjective(request, malformed)).rejects.toThrow('invalid response')
    const wrongStatus = vi.fn<typeof fetch>(async () => ({ ...response(200, {
      inputId: 'input-1', turnId: 'turn-1', disposition: 'started', sequence: '7',
    }) }))
    await expect(startAgentObjective(request, wrongStatus)).rejects.toThrow('unexpected status')
    expect(failing).toHaveBeenCalledTimes(1)
    expect(malformed).toHaveBeenCalledTimes(1)
    expect(wrongStatus).toHaveBeenCalledTimes(1)
  })
})
