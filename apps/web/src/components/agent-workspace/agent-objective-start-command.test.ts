import { describe, expect, it } from 'vitest'
import { schemaVersion } from '@jobcopilot/agent-protocol'
import {
  AgentObjectiveStartCoordinator,
  validateObjectiveContextDraft,
} from './agent-objective-start-command'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function successBody() {
  return { inputId: 'input_1', turnId: 'turn_1', disposition: 'started', sequence: '1' }
}

describe('objective start command', () => {
  it('trims and bounds the objective in UTF-8 bytes while preserving context exactly', () => {
    const objective = `${'a'.repeat(1_998)}é`
    const context = '\n  Reference text is unchanged.  \n'
    expect(validateObjectiveContextDraft({ objective: `  ${objective}  `, context })).toEqual({ objective, context })
    const maxContext = 'x'.repeat(20_000)
    expect(validateObjectiveContextDraft({ objective: 'Objective', context: maxContext }).context).toBe(maxContext)
    expect(() => validateObjectiveContextDraft({ objective: '界'.repeat(667), context: '' }))
      .toThrow('Objective must contain 1 to 2,000 UTF-8 bytes')
    expect(() => validateObjectiveContextDraft({ objective: '   ', context: '' }))
      .toThrow('Objective must contain 1 to 2,000 UTF-8 bytes')
    expect(() => validateObjectiveContextDraft({ objective: 'Find roles', context: 'x'.repeat(20_001) }))
      .toThrow('Background context must be 20,000 characters or fewer')
  })

  it('creates metadata with the objective and sends one exact authenticated start request', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init })
      return calls.length === 1
        ? jsonResponse({ session: { id: 'session/1' } }, 201)
        : jsonResponse(successBody(), 202)
    }) as typeof fetch
    const coordinator = new AgentObjectiveStartCoordinator(fetcher, () => 'start-key-1')
    const result = await coordinator.start('  Find senior roles in Dublin  ', '\nPortfolio details.\n')

    expect(result).toMatchObject({ sessionId: 'session/1', objective: 'Find senior roles in Dublin', disposition: 'started' })
    expect(calls).toHaveLength(2)
    expect(calls[0]?.input).toBe('/api/agent/sessions')
    expect(calls[0]?.init).toMatchObject({ method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } })
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ goal: 'Find senior roles in Dublin' })
    expect(calls[1]?.input).toBe('/api/agent/sessions/session%2F1/start-objective')
    expect(calls[1]?.init).toMatchObject({ method: 'POST', credentials: 'same-origin' })
    expect(calls[1]?.init?.headers).toEqual({ 'Content-Type': 'application/json', 'Idempotency-Key': 'start-key-1' })
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      schemaVersion,
      clientMessageId: 'start-key-1',
      objective: 'Find senior roles in Dublin',
      content: [{ type: 'text', text: '\nPortfolio details.\n' }],
    })
  })

  it('uses the objective only for exactly empty background and preserves whitespace-only text', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init })
      return calls.length === 1 || calls.length === 3
        ? jsonResponse({ session: { id: 'session_1' } }, 201)
        : jsonResponse(successBody(), 202)
    }) as typeof fetch
    await new AgentObjectiveStartCoordinator(fetcher, () => 'key_empty').start('Objective', '')
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      schemaVersion, clientMessageId: 'key_empty', objective: 'Objective', content: [{ type: 'text', text: 'Objective' }],
    })
    await new AgentObjectiveStartCoordinator(fetcher, () => 'key_whitespace').start('Objective', '\n  \n')
    expect(JSON.parse(String(calls[3]?.init?.body))).toEqual({
      schemaVersion, clientMessageId: 'key_whitespace', objective: 'Objective', content: [{ type: 'text', text: '\n  \n' }],
    })
  })

  it('single-flights concurrent submits through Session creation and admission', async () => {
    let resolveMetadata!: (response: Response) => void
    const metadata = new Promise<Response>(resolve => { resolveMetadata = resolve })
    const calls: Array<RequestInfo | URL> = []
    const fetcher = (async (input: RequestInfo | URL) => {
      calls.push(input)
      return calls.length === 1 ? metadata : jsonResponse(successBody(), 202)
    }) as typeof fetch
    const coordinator = new AgentObjectiveStartCoordinator(fetcher, () => 'key_single')
    const first = coordinator.start('Objective', 'Background')
    const second = coordinator.start('Changed while pending', 'Other')
    expect(second).toBe(first)
    resolveMetadata(jsonResponse({ session: { id: 'session_1' } }, 201))
    await expect(first).resolves.toMatchObject({ sessionId: 'session_1', objective: 'Objective' })
    expect(calls).toHaveLength(2)
  })

  it('retains Session and request identity after an uncertain result, then reuses both on manual retry', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init })
      if (calls.length === 1) return jsonResponse({ session: { id: 'session_1' } }, 201)
      if (calls.length === 2) throw new TypeError('Network outcome unknown')
      return jsonResponse({ ...successBody(), disposition: 'duplicate' }, 202)
    }) as typeof fetch
    const coordinator = new AgentObjectiveStartCoordinator(fetcher, () => 'key_retry')
    await expect(coordinator.start('Objective', 'Background')).rejects.toThrow('Network outcome unknown')
    await expect(coordinator.start('Objective', 'Background')).resolves.toMatchObject({ disposition: 'duplicate' })
    expect(calls).toHaveLength(3)
    expect(calls[1]?.input).toBe(calls[2]?.input)
    expect(calls[1]?.init?.body).toBe(calls[2]?.init?.body)
    expect((calls[1]?.init?.headers as Record<string, string>)['Idempotency-Key']).toBe('key_retry')
    expect((calls[2]?.init?.headers as Record<string, string>)['Idempotency-Key']).toBe('key_retry')
  })

  it('keeps a 409 draft identity and changes only the key when the user edits it', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init })
      if (calls.length === 1) return jsonResponse({ session: { id: 'session_1' } }, 201)
      if (calls.length < 4) return jsonResponse({ error: { code: 'conflict', message: 'Session changed' } }, 409)
      return jsonResponse(successBody(), 202)
    }) as typeof fetch
    let identity = 0
    const coordinator = new AgentObjectiveStartCoordinator(fetcher, () => `key_${++identity}`)
    await expect(coordinator.start('First objective', 'Context')).rejects.toMatchObject({ status: 409 })
    await expect(coordinator.start('First objective', 'Context')).rejects.toMatchObject({ status: 409 })
    await expect(coordinator.start('Edited objective', 'Context')).resolves.toMatchObject({ objective: 'Edited objective' })
    expect(calls).toHaveLength(4)
    expect(calls[1]?.input).toBe(calls[2]?.input)
    expect(calls[2]?.input).toBe(calls[3]?.input)
    expect(calls.slice(1).map(call => (call.init?.headers as Record<string, string>)['Idempotency-Key']))
      .toEqual(['key_1', 'key_1', 'key_2'])
    expect(JSON.parse(String(calls[3]?.init?.body))).toMatchObject({ objective: 'Edited objective' })
  })

  it('rotates identity after any draft edit while retaining a known Session', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init })
      if (calls.length === 1) return jsonResponse({ session: { id: 'session_1' } }, 201)
      if (calls.length === 2) throw new TypeError('Network outcome unknown')
      return jsonResponse(successBody(), 202)
    }) as typeof fetch
    let identity = 0
    const coordinator = new AgentObjectiveStartCoordinator(fetcher, () => `edit_${++identity}`)
    await expect(coordinator.start('Objective', 'Context')).rejects.toThrow('Network outcome unknown')
    coordinator.draftEdited()
    await expect(coordinator.start('Objective', 'Context')).resolves.toMatchObject({ sessionId: 'session_1' })
    expect(calls).toHaveLength(3)
    expect(calls[0]?.input).toBe('/api/agent/sessions')
    expect(calls[1]?.input).toBe(calls[2]?.input)
    expect((calls[1]?.init?.headers as Record<string, string>)['Idempotency-Key']).toBe('edit_1')
    expect((calls[2]?.init?.headers as Record<string, string>)['Idempotency-Key']).toBe('edit_2')
  })

  it('does not admit a root or create a second request when metadata has no usable Session ID', async () => {
    let calls = 0
    const fetcher = (async () => {
      calls += 1
      return jsonResponse({ session: { id: '  ' } }, 201)
    }) as typeof fetch
    const coordinator = new AgentObjectiveStartCoordinator(fetcher, () => 'key_missing')
    await expect(coordinator.start('Objective', '')).rejects.toMatchObject({
      status: 502, code: 'invalid_session_response',
    })
    expect(calls).toBe(1)
  })

  it('does not send another admission after the accepted result', async () => {
    const calls: RequestInfo[] = []
    const fetcher = (async (input: RequestInfo | URL) => {
      calls.push(input as RequestInfo)
      return calls.length === 1 ? jsonResponse({ session: { id: 'session_1' } }, 201) : jsonResponse(successBody(), 202)
    }) as typeof fetch
    const coordinator = new AgentObjectiveStartCoordinator(fetcher, () => 'key_accept')
    const accepted = await coordinator.start('Objective', '')
    await expect(coordinator.start('Changed after acceptance', 'Other')).resolves.toEqual(accepted)
    expect(calls).toHaveLength(2)
  })
})
