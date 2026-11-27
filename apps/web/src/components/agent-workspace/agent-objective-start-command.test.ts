import { describe, expect, it, vi } from 'vitest'
import { schemaVersion } from '@jobcopilot/agent-protocol'
import { OBJECTIVE_SPONSORSHIP_TARGET_COUNTRY_SCHEMA_VERSION } from '@jobcopilot/shared'
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
    expect(calls[0]?.init).toMatchObject({ method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'start-key-1' } })
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

  it('sends explicit locations as a versioned requirement with a stable criterion ID', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init })
      return calls.length === 1
        ? jsonResponse({ session: { id: 'session_1' } }, 201)
        : jsonResponse(successBody(), 202)
    }) as typeof fetch
    const coordinator = new AgentObjectiveStartCoordinator(fetcher, () => 'location-key')
    await coordinator.start('Find roles', '', 'Dublin, Ireland\nBerlin\n Dublin ')

    expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({
      verificationRequirements: {
        schemaVersion: 'agent-harness.v2.objective-requirements.v2',
        requirements: [{
          id: 'candidate-location',
          check: { kind: 'candidate_location_in', locations: ['berlin', 'dublin', 'dublin, ireland'] },
        }],
      },
    })
  })

  it('preserves existing count requirements when appending the location criterion', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init })
      return calls.length === 1
        ? jsonResponse({ session: { id: 'session_1' } }, 201)
        : jsonResponse(successBody(), 202)
    }) as typeof fetch
    const existingRequirements = {
      schemaVersion: 'agent-harness.v2.objective-requirements.v1' as const,
      requirements: [{ id: 'candidate-count', check: { kind: 'candidate_count_gte' as const, minimum: 3 } }],
    }
    await new AgentObjectiveStartCoordinator(fetcher, () => 'mixed-requirements')
      .start('Find roles', '', 'Dublin', existingRequirements)

    expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({
      verificationRequirements: {
        schemaVersion: 'agent-harness.v2.objective-requirements.v2',
        requirements: [
          { id: 'candidate-count', check: { kind: 'candidate_count_gte', minimum: 3 } },
          { id: 'candidate-location', check: { kind: 'candidate_location_in', locations: ['dublin'] } },
        ],
      },
    })
  })

  it('rejects invalid explicit location lists before creating a Session', async () => {
    let calls = 0
    const fetcher = (async () => {
      calls += 1
      return jsonResponse({ session: { id: 'session_1' } }, 201)
    }) as typeof fetch
    const coordinator = new AgentObjectiveStartCoordinator(fetcher, () => 'invalid-locations')
    await expect(coordinator.start('Find roles', '', 'x'.repeat(129)))
      .rejects.toMatchObject({ status: 422, code: 'invalid_command' })
    await expect(coordinator.start('Find roles', '', Array.from({ length: 9 }, (_, index) => `City ${index}`).join('\n')))
      .rejects.toMatchObject({ status: 422, code: 'invalid_command' })
    expect(calls).toBe(0)
  })

  it('does not replace a requirement that already uses the stable location criterion ID', async () => {
    let calls = 0
    const fetcher = (async () => {
      calls += 1
      return jsonResponse({ session: { id: 'session_1' } }, 201)
    }) as typeof fetch
    const existingRequirements = {
      schemaVersion: 'agent-harness.v2.objective-requirements.v1' as const,
      requirements: [{ id: 'candidate-location', check: { kind: 'candidate_count_gte' as const, minimum: 3 } }],
    }

    await expect(new AgentObjectiveStartCoordinator(fetcher, () => 'collision')
      .start('Find roles', '', 'Dublin', existingRequirements))
      .rejects.toMatchObject({ status: 422, code: 'invalid_command' })
    expect(calls).toBe(0)
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

  it('single-flights the same normalized task through Session creation and admission', async () => {
    let resolveMetadata!: (response: Response) => void
    const metadata = new Promise<Response>(resolve => { resolveMetadata = resolve })
    const calls: Array<RequestInfo | URL> = []
    const fetcher = (async (input: RequestInfo | URL) => {
      calls.push(input)
      return calls.length === 1 ? metadata : jsonResponse(successBody(), 202)
    }) as typeof fetch
    const coordinator = new AgentObjectiveStartCoordinator(fetcher, () => 'key_single')
    const first = coordinator.start('  Objective  ', 'Background')
    const second = coordinator.start('Objective', 'Background')
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

  it('reuses the creation key when the Session response is uncertain', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init })
      if (calls.length === 1) throw new TypeError('Session creation outcome unknown')
      return calls.length === 2
        ? jsonResponse({ session: { id: 'session_1' } }, 201)
        : jsonResponse(successBody(), 202)
    }) as typeof fetch
    const coordinator = new AgentObjectiveStartCoordinator(fetcher, () => 'key_create_retry')

    await expect(coordinator.start('Objective', 'Background')).rejects.toThrow('Session creation outcome unknown')
    await expect(coordinator.start('Objective', 'Background')).resolves.toMatchObject({ sessionId: 'session_1' })

    expect(calls).toHaveLength(3)
    expect(calls[0]?.input).toBe('/api/agent/sessions')
    expect(calls[1]?.input).toBe('/api/agent/sessions')
    expect(calls[0]?.init?.body).toBe(calls[1]?.init?.body)
    expect((calls[0]?.init?.headers as Record<string, string>)['Idempotency-Key']).toBe('key_create_retry')
    expect((calls[1]?.init?.headers as Record<string, string>)['Idempotency-Key']).toBe('key_create_retry')
    expect((calls[2]?.init?.headers as Record<string, string>)['Idempotency-Key']).toBe('key_create_retry')
  })

  it('starts in a selected Session and reuses its ID and request identity after an uncertain result', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init })
      if (calls.length === 1) throw new TypeError('Network outcome unknown')
      return jsonResponse({ ...successBody(), disposition: 'duplicate' }, 202)
    }) as typeof fetch
    const coordinator = new AgentObjectiveStartCoordinator(fetcher, () => 'key_selected_retry')

    await expect(coordinator.start('Objective', 'Background', '', undefined, 'selected/1')).rejects.toThrow('Network outcome unknown')
    await expect(coordinator.start('Objective', 'Background', '', undefined, 'selected/1')).resolves.toMatchObject({
      sessionId: 'selected/1', disposition: 'duplicate',
    })

    expect(calls).toHaveLength(2)
    expect(calls[0]?.input).toBe('/api/agent/sessions/selected%2F1/start-objective')
    expect(calls[1]?.input).toBe(calls[0]?.input)
    expect(calls[1]?.init?.body).toBe(calls[0]?.init?.body)
    expect((calls[0]?.init?.headers as Record<string, string>)['Idempotency-Key']).toBe('key_selected_retry')
    expect((calls[1]?.init?.headers as Record<string, string>)['Idempotency-Key']).toBe('key_selected_retry')
  })

  it('rotates request identity when the selected Session changes', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init })
      return calls.length === 1
        ? jsonResponse({ error: { code: 'objective_start_state_conflict', message: 'Session changed' } }, 409)
        : jsonResponse(successBody(), 202)
    }) as typeof fetch
    let identity = 0
    const coordinator = new AgentObjectiveStartCoordinator(fetcher, () => `selected_${++identity}`)

    await expect(coordinator.start('Objective', 'Background', '', undefined, 'session_a')).rejects.toMatchObject({ status: 409 })
    await expect(coordinator.start('Objective', 'Background', '', undefined, 'session_b')).resolves.toMatchObject({
      sessionId: 'session_b', disposition: 'started',
    })

    expect(calls).toHaveLength(2)
    expect(calls.map(call => call.input)).toEqual([
      '/api/agent/sessions/session_a/start-objective',
      '/api/agent/sessions/session_b/start-objective',
    ])
    expect(calls.map(call => (call.init?.headers as Record<string, string>)['Idempotency-Key']))
      .toEqual(['selected_1', 'selected_2'])
  })

  it('does not share a pending request or result with a different selected Session', async () => {
    let resolveFirst!: (response: Response) => void
    const firstResponse = new Promise<Response>(resolve => { resolveFirst = resolve })
    const calls: Array<RequestInfo | URL> = []
    const fetcher = (async (input: RequestInfo | URL) => {
      calls.push(input)
      return calls.length === 1 ? firstResponse : jsonResponse(successBody(), 202)
    }) as typeof fetch
    const coordinator = new AgentObjectiveStartCoordinator(fetcher, () => `pending_${calls.length + 1}`)

    const first = coordinator.start('Objective', 'Background', '', undefined, 'session_a')
    const differentTarget = coordinator.start('Objective', 'Background', '', undefined, 'session_b')
    expect(differentTarget).not.toBe(first)
    await expect(differentTarget).rejects.toMatchObject({ status: 409, code: 'objective_start_in_progress' })

    resolveFirst(jsonResponse(successBody(), 202))
    await expect(first).resolves.toMatchObject({ sessionId: 'session_a' })
    await expect(coordinator.start('Objective', 'Background', '', undefined, 'session_b')).resolves.toMatchObject({ sessionId: 'session_b' })
    expect(calls).toEqual([
      '/api/agent/sessions/session_a/start-objective',
      '/api/agent/sessions/session_b/start-objective',
    ])
  })

  it('rejects a different draft while the same selected Session request is pending', async () => {
    let resolveFirst!: (response: Response) => void
    const firstResponse = new Promise<Response>(resolve => { resolveFirst = resolve })
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init })
      return calls.length === 1 ? firstResponse : jsonResponse(successBody(), 202)
    }) as typeof fetch
    let identity = 0
    const coordinator = new AgentObjectiveStartCoordinator(fetcher, () => `same-session-${++identity}`)

    const first = coordinator.start('First objective', 'Context', '', undefined, 'session_a')
    const differentDraft = coordinator.start('Second objective', 'Context', '', undefined, 'session_a')
    expect(differentDraft).not.toBe(first)
    await expect(differentDraft).rejects.toMatchObject({ status: 409, code: 'objective_start_in_progress' })

    resolveFirst(jsonResponse(successBody(), 202))
    await expect(first).resolves.toMatchObject({ objective: 'First objective' })
    await expect(coordinator.start('Second objective', 'Context', '', undefined, 'session_a')).resolves.toMatchObject({
      sessionId: 'session_a', objective: 'Second objective',
    })
    expect(calls).toHaveLength(2)
    expect(calls.map(call => call.input)).toEqual([
      '/api/agent/sessions/session_a/start-objective',
      '/api/agent/sessions/session_a/start-objective',
    ])
    expect(calls.map(call => (call.init?.headers as Record<string, string>)['Idempotency-Key']))
      .toEqual(['same-session-1', 'same-session-2'])
  })

  it('keeps identity when a newly created Session becomes selected during the same pending attempt', async () => {
    let resolveStart!: (response: Response) => void
    let markStartDispatched!: () => void
    const startResponse = new Promise<Response>(resolve => { resolveStart = resolve })
    const startDispatched = new Promise<void>(resolve => { markStartDispatched = resolve })
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init })
      if (calls.length === 1) return jsonResponse({ session: { id: 'session_1' } }, 201)
      markStartDispatched()
      return startResponse
    }) as typeof fetch
    const coordinator = new AgentObjectiveStartCoordinator(fetcher, () => 'created_then_selected')

    const first = coordinator.start('  Objective  ', 'Background')
    await startDispatched
    const selected = coordinator.start('Objective', 'Background', '', undefined, 'session_1')
    expect(selected).toBe(first)

    resolveStart(jsonResponse(successBody(), 202))
    await expect(first).resolves.toMatchObject({ sessionId: 'session_1', objective: 'Objective' })
    expect(calls).toHaveLength(2)
    expect(calls[0]?.input).toBe('/api/agent/sessions')
    expect(calls[1]?.input).toBe('/api/agent/sessions/session_1/start-objective')
    expect((calls[0]?.init?.headers as Record<string, string>)['Idempotency-Key']).toBe('created_then_selected')
    expect((calls[1]?.init?.headers as Record<string, string>)['Idempotency-Key']).toBe('created_then_selected')
  })

  it('starts a new attempt for a different task in the same selected Session after acceptance', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init })
      return jsonResponse(successBody(), 202)
    }) as typeof fetch
    let identity = 0
    const coordinator = new AgentObjectiveStartCoordinator(fetcher, () => `sequential-${++identity}`)

    const first = await coordinator.start('First objective', 'First context', '', undefined, 'session_1')
    const second = await coordinator.start('Second objective', 'Second context', '', undefined, 'session_1')

    expect(first).toMatchObject({ sessionId: 'session_1', objective: 'First objective' })
    expect(second).toMatchObject({ sessionId: 'session_1', objective: 'Second objective' })
    expect(calls).toHaveLength(2)
    expect(calls.map(call => call.input)).toEqual([
      '/api/agent/sessions/session_1/start-objective',
      '/api/agent/sessions/session_1/start-objective',
    ])
    expect(calls.map(call => (call.init?.headers as Record<string, string>)['Idempotency-Key']))
      .toEqual(['sequential-1', 'sequential-2'])
    expect(calls.map(call => JSON.parse(String(call.init?.body)).objective))
      .toEqual(['First objective', 'Second objective'])
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

  it('rotates identity when the normalized draft changes while retaining a known Session', async () => {
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
    await expect(coordinator.start('Edited objective', 'Context')).resolves.toMatchObject({ sessionId: 'session_1' })
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

  it('reuses an accepted result only for the same normalized task', async () => {
    const calls: RequestInfo[] = []
    const fetcher = (async (input: RequestInfo | URL) => {
      calls.push(input as RequestInfo)
      return calls.length === 1 ? jsonResponse({ session: { id: 'session_1' } }, 201) : jsonResponse(successBody(), 202)
    }) as typeof fetch
    const coordinator = new AgentObjectiveStartCoordinator(fetcher, () => 'key_accept')
    const accepted = await coordinator.start('  Objective  ', '')
    await expect(coordinator.start('Objective', '')).resolves.toEqual(accepted)
    expect(calls).toHaveLength(2)
  })

  it('starts the same normalized task again with a fresh request identity after discard', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init })
      return jsonResponse(successBody(), 202)
    }) as typeof fetch
    let identity = 0
    const coordinator = new AgentObjectiveStartCoordinator(fetcher, () => `discard-${++identity}`)

    const first = await coordinator.start('  Objective  ', 'Exact context', '', undefined, 'session_1')
    await expect(coordinator.start('Objective', 'Exact context', '', undefined, 'session_1')).resolves.toEqual(first)
    expect(calls).toHaveLength(1)

    coordinator.discard()
    const next = await coordinator.start('Objective', 'Exact context', '', undefined, 'session_1')

    expect(next).toMatchObject({ sessionId: 'session_1', objective: 'Objective' })
    expect(calls).toHaveLength(2)
    expect(calls[1]?.input).toBe(calls[0]?.input)
    expect(calls.map(call => (call.init?.headers as Record<string, string>)['Idempotency-Key']))
      .toEqual(['discard-1', 'discard-2'])
    expect(calls.map(call => JSON.parse(String(call.init?.body)).clientMessageId))
      .toEqual(['discard-1', 'discard-2'])
  })

  it('binds retries to both the selected Session and the location requirements', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init })
      return jsonResponse(successBody(), 202)
    }) as typeof fetch
    let identity = 0
    const coordinator = new AgentObjectiveStartCoordinator(fetcher, () => `location-${++identity}`)
    await coordinator.start('Objective', '', 'Dublin', undefined, 'session_1')
    await coordinator.start('Objective', '', 'Berlin', undefined, 'session_1')
    expect(calls.map(call => call.input)).toEqual([
      '/api/agent/sessions/session_1/start-objective', '/api/agent/sessions/session_1/start-objective',
    ])
    expect(calls.map(call => (call.init?.headers as Record<string, string>)['Idempotency-Key']))
      .toEqual(['location-1', 'location-2'])
    expect(calls.map(call => JSON.parse(String(call.init?.body)).verificationRequirements.requirements[0].check.locations))
      .toEqual([['dublin'], ['berlin']])
  })

  it('rejects changed location requirements while the selected Session request is pending', async () => {
    let finish!: (response: Response) => void
    const response = new Promise<Response>(resolve => { finish = resolve })
    const fetcher = vi.fn(async () => response) as unknown as typeof fetch
    const coordinator = new AgentObjectiveStartCoordinator(fetcher, () => 'pending-location')
    const first = coordinator.start('Objective', '', 'Dublin', undefined, 'session_1')
    await expect(coordinator.start('Objective', '', 'Berlin', undefined, 'session_1'))
      .rejects.toMatchObject({ status: 409, code: 'objective_start_in_progress' })
    finish(jsonResponse(successBody(), 202))
    await expect(first).resolves.toMatchObject({ sessionId: 'session_1' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('starts a different task after an accepted result on the same Session', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init })
      return jsonResponse(successBody(), 202)
    }) as typeof fetch
    let identity = 0
    const coordinator = new AgentObjectiveStartCoordinator(fetcher, () => `accepted-${++identity}`)

    const first = await coordinator.start('First objective', '', '', undefined, 'session_1')
    const second = await coordinator.start('Different objective', '', '', undefined, 'session_1')

    expect(first.objective).toBe('First objective')
    expect(second.objective).toBe('Different objective')
    expect(calls).toHaveLength(2)
    expect(calls[0]?.input).toBe(calls[1]?.input)
    expect(calls.map(call => (call.init?.headers as Record<string, string>)['Idempotency-Key']))
      .toEqual(['accepted-1', 'accepted-2'])
  })
  it("binds a versioned explicit country into the payload and retry identity", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init })
      return jsonResponse(successBody(), 202)
    }) as typeof fetch
    let identity = 0
    const coordinator = new AgentObjectiveStartCoordinator(fetcher, () => 'country-' + (++identity))

    await coordinator.start('Find sponsorship-compatible roles', '', '', undefined, 'session_1', 'IE')
    await coordinator.start('Find sponsorship-compatible roles', '', '', undefined, 'session_1', 'US')

    expect(calls).toHaveLength(2)
    expect(calls.map(call => (call.init?.headers as Record<string, string>)['Idempotency-Key']))
      .toEqual(['country-1', 'country-2'])
    expect(calls.map(call => JSON.parse(String(call.init?.body)).sponsorshipTargetCountry)).toEqual([
      { schemaVersion: OBJECTIVE_SPONSORSHIP_TARGET_COUNTRY_SCHEMA_VERSION, countryCode: 'IE' },
      { schemaVersion: OBJECTIVE_SPONSORSHIP_TARGET_COUNTRY_SCHEMA_VERSION, countryCode: 'US' },
    ])
  })

  it("rejects unsupported country values before sending any request", async () => {
    const fetcher = vi.fn(async () => jsonResponse(successBody(), 202)) as unknown as typeof fetch
    const coordinator = new AgentObjectiveStartCoordinator(fetcher, () => 'country-invalid')
    await expect(coordinator.start('Objective', '', '', undefined, 'session_1', 'XK'))
      .rejects.toMatchObject({ status: 422, code: 'invalid_command' })
    expect(fetcher).not.toHaveBeenCalled()
  })

})
