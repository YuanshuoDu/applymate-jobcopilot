import React from 'react'
import { readFileSync } from 'node:fs'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  acquireObjectiveReplacementRequest,
  AgentComposerActiveTurn,
  canSubmitObjectiveReplacement,
  objectiveReplacementFormReducer,
  type ObjectiveReplacementFormState,
} from './AgentComposerActiveTurn'
import type { TurnComposerController } from './agent-turn-commands'

const componentSource = readFileSync(new URL('./AgentComposerActiveTurn.tsx', import.meta.url), 'utf8')

describe('AgentComposerActiveTurn', () => {
  it('shows delivery choices, all command states, and the interrupt affordance', () => {
    const controller: TurnComposerController = {
      sessionId: 'session_1', activeTurn: { id: 'turn_1', status: 'in_progress', revision: 2 }, sessionStatus: 'running', refresh: vi.fn(), delivery: 'steer',
      setDelivery: vi.fn(), chatInput: '', setChatInput: vi.fn(), sending: false,
      messages: [
        { clientMessageId: 'sending', text: 'One', delivery: 'steer', status: 'sending' },
        { clientMessageId: 'accepted', text: 'Two', delivery: 'follow_up', status: 'accepted' },
        { clientMessageId: 'consumed', text: 'Three', delivery: 'steer', status: 'consumed' },
        { clientMessageId: 'failed', text: 'Four', delivery: 'steer', status: 'failed' },
      ],
      commandError: null, send: vi.fn(), interrupt: vi.fn(), interrupting: false,
    }
    const html = renderToString(<AgentComposerActiveTurn controller={controller} />)

    expect(html).toContain('Steer current Turn')
    expect(html).toContain('Queue follow-up')
    expect(html).toContain('data-testid="interrupt-turn"')
    expect(html).toContain('Sending')
    expect(html).toContain('Accepted')
    expect(html).toContain('Consumed')
    expect(html).toContain('Failed')
    expect(html).toContain('Replace objective')
    expect(html).not.toContain('objective-replacement-form')
  })

  it('only opens replacement for a running Session with an active Turn', () => {
    const controller: TurnComposerController = {
      sessionId: 'session_1', activeTurn: { id: 'turn_1', status: 'in_progress', revision: 2 }, sessionStatus: 'paused', delivery: 'steer',
      setDelivery: vi.fn(), chatInput: '', setChatInput: vi.fn(), sending: false, messages: [], commandError: null,
      send: vi.fn(), interrupt: vi.fn(), interrupting: false,
    }
    expect(renderToString(<AgentComposerActiveTurn controller={controller} />)).not.toContain('open-objective-replacement')
    expect(renderToString(<AgentComposerActiveTurn controller={{ ...controller, sessionStatus: 'running', activeTurn: null }} />)).not.toContain('open-objective-replacement')
  })

  it('keeps the captured target and request identity through conflict and uncertain retry', () => {
    const initial: ObjectiveReplacementFormState = {
      open: false, target: null, draft: '', clientMessageId: null, pending: false, error: null,
    }
    const opened = objectiveReplacementFormReducer(initial, {
      type: 'open', target: { turnId: 'turn_1', revision: 2 }, clientMessageId: 'request_1',
    })
    const edited = objectiveReplacementFormReducer(opened, { type: 'edit', draft: 'New goal', clientMessageId: 'request_2' })
    expect(canSubmitObjectiveReplacement(opened)).toBe(false)
    expect(canSubmitObjectiveReplacement(edited)).toBe(true)
    const lock = { current: false }
    expect(acquireObjectiveReplacementRequest(lock, edited)).toBe(true)
    expect(acquireObjectiveReplacementRequest(lock, edited)).toBe(false)
    expect(objectiveReplacementFormReducer(edited, { type: 'edit', draft: 'New goal', clientMessageId: 'unused' })).toBe(edited)
    const conflicted = objectiveReplacementFormReducer(
      objectiveReplacementFormReducer(edited, { type: 'pending' }),
      { type: 'failed', error: { message: 'Turn changed', conflict: true } },
    )

    expect(conflicted).toMatchObject({ open: true, target: { turnId: 'turn_1', revision: 2 }, draft: 'New goal', clientMessageId: 'request_2', pending: false, error: { conflict: true } })
    const retry = objectiveReplacementFormReducer(conflicted, { type: 'pending' })
    expect(retry.clientMessageId).toBe('request_2')
    const uncertain = objectiveReplacementFormReducer(retry, { type: 'failed', error: { message: 'Network outcome unknown', conflict: false } })
    expect(uncertain).toMatchObject({ target: { turnId: 'turn_1', revision: 2 }, draft: 'New goal', clientMessageId: 'request_2' })
    const changed = objectiveReplacementFormReducer(conflicted, { type: 'edit', draft: 'Another goal', clientMessageId: 'request_3' })
    expect(changed).toMatchObject({ target: { turnId: 'turn_1', revision: 2 }, draft: 'Another goal', clientMessageId: 'request_3', error: null })
    const closed = objectiveReplacementFormReducer(changed, { type: 'discard' })
    const reopened = objectiveReplacementFormReducer(closed, { type: 'open', target: { turnId: 'turn_2', revision: 7 }, clientMessageId: 'request_4' })
    expect(reopened).toMatchObject({ open: true, target: { turnId: 'turn_2', revision: 7 }, draft: '', clientMessageId: 'request_4' })
    expect(objectiveReplacementFormReducer(reopened, { type: 'success' })).toMatchObject({ open: false, target: null, draft: '', clientMessageId: null })
  })

  it('warns after the active Turn changes and submits the originally captured target', async () => {
    const replacement: ObjectiveReplacementFormState = {
      open: true,
      target: { turnId: 'turn_1', revision: 2 },
      draft: 'New objective from the open form',
      clientMessageId: 'request_1',
      pending: false,
      error: null,
    }
    const dispatch = vi.fn()
    const pendingRef = { current: false }
    const replaceAgentObjective = vi.fn().mockResolvedValue(undefined)

    vi.resetModules()
    vi.doMock('react', async importOriginal => {
      const actual = await importOriginal<typeof import('react')>()
      return {
        ...actual,
        useReducer: () => [replacement, dispatch],
        useRef: () => pendingRef,
      }
    })
    vi.doMock('./agent-objective-replacement-command', () => ({
      ObjectiveReplacementCommandError: class extends Error {},
      replaceAgentObjective,
    }))

    try {
      const { AgentComposerActiveTurn: renderComposer } = await import('./AgentComposerActiveTurn')
      const controller: TurnComposerController = {
        sessionId: 'session_1', activeTurn: { id: 'turn_1', status: 'in_progress', revision: 2 },
        sessionStatus: 'running', delivery: 'steer', setDelivery: vi.fn(), chatInput: '',
        setChatInput: vi.fn(), sending: false, messages: [], commandError: null,
        send: vi.fn(), interrupt: vi.fn(), interrupting: false,
      }
      const outer = renderComposer({ controller })
      if (typeof outer.type !== 'function') throw new Error('Expected the composer to render its active Turn session.')

      const renderSession = outer.type as (props: { controller: TurnComposerController }) => React.ReactElement
      const initialTree = renderSession({ controller })
      expect(findElement(initialTree, props => props.role === 'status')).toBeNull()
      const changedTurnTree = renderSession({
        controller: { ...controller, activeTurn: { id: 'turn_2', status: 'in_progress', revision: 7 } },
      })
      const status = findElement(changedTurnTree, props => props.role === 'status')
      expect(readElementText(status)).toContain('The run changed after you opened this form.')
      expect(renderToString(changedTurnTree)).toContain('The run changed after you opened this form.')

      const form = findElement(changedTurnTree, props => props['data-testid'] === 'objective-replacement-form')
      expect(form).not.toBeNull()
      const onSubmit = form?.props.onSubmit
      if (typeof onSubmit !== 'function') throw new Error('Expected the objective replacement form to have a submit handler.')
      const submit = onSubmit as React.FormEventHandler<HTMLFormElement>
      const preventDefault = vi.fn()
      submit({ preventDefault } as unknown as React.FormEvent<HTMLFormElement>)

      expect(preventDefault).toHaveBeenCalledOnce()
      expect(replaceAgentObjective).toHaveBeenCalledWith({
        sessionId: 'session_1',
        expectedTurnId: 'turn_1',
        expectedRevision: 2,
        clientMessageId: 'request_1',
        text: 'New objective from the open form',
      })
    } finally {
      vi.doUnmock('./agent-objective-replacement-command')
      vi.doUnmock('react')
      vi.resetModules()
    }
  })

  it('submits only the captured target through the replacement helper and refreshes on acceptance', () => {
    const requestStart = componentSource.indexOf('void replaceAgentObjective({')
    const requestEnd = componentSource.indexOf('}).then(() => {', requestStart)
    const acceptedEnd = componentSource.indexOf('}).catch((reason: unknown) => {', requestEnd)
    const request = componentSource.slice(requestStart, requestEnd)
    const accepted = componentSource.slice(requestEnd, acceptedEnd)

    expect(request).toContain('expectedTurnId: replacement.target.turnId')
    expect(request).toContain('expectedRevision: replacement.target.revision')
    expect(request).not.toContain('controller.activeTurn.id')
    expect(accepted).toContain("dispatch({ type: 'success' })")
    expect(accepted).toContain('controller.refresh?.()')
    expect(componentSource).toContain('Write a short objective; send detailed context separately.')
    expect(componentSource).not.toContain('maxLength=')
    expect(componentSource).toContain('<ActiveTurnSession key={controller.sessionId}')
    expect(componentSource).not.toContain('controller.send(')
  })
})

type ElementProps = Record<string, unknown> & { children?: React.ReactNode }

function findElement(
  node: React.ReactNode,
  matches: (props: ElementProps) => boolean,
): React.ReactElement<ElementProps> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, matches)
      if (found) return found
    }
    return null
  }
  if (node === null || typeof node !== 'object' || !('props' in node)) return null

  const element = node as React.ReactElement<ElementProps>
  if (matches(element.props)) return element
  return findElement(element.props.children, matches)
}

function readElementText(element: React.ReactElement<ElementProps> | null): string {
  if (!element) return ''
  const read = (node: React.ReactNode): string => {
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(read).join(' ')
    if (node !== null && typeof node === 'object' && 'props' in node) {
      return read((node as React.ReactElement<ElementProps>).props.children)
    }
    return ''
  }
  return read(element.props.children)
}
