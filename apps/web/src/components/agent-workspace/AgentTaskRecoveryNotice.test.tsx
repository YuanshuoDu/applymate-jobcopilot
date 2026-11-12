import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const language = vi.hoisted(() => ({ value: 'en' }))
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ lang: language.value }) }))

import { AgentTaskRecoveryNotice, type AgentTaskRecoveryNoticeProps } from './AgentTaskRecoveryNotice'

type ButtonProps = { 'aria-label'?: string; disabled?: boolean; onClick?: () => void; children?: React.ReactNode }

function findButton(node: React.ReactNode, label: string): React.ReactElement<ButtonProps> | null {
  let found: React.ReactElement<ButtonProps> | null = null
  React.Children.forEach(node, child => {
    if (!React.isValidElement(child) || found) return
    const element = child as React.ReactElement<ButtonProps>
    if (element.type === 'button' && element.props['aria-label'] === label) {
      found = element
      return
    }
    found = findButton(element.props.children, label)
  })
  return found
}

function render(props: AgentTaskRecoveryNoticeProps): string {
  return renderToStaticMarkup(<AgentTaskRecoveryNotice {...props} />)
}

describe('AgentTaskRecoveryNotice', () => {
  beforeEach(() => { language.value = 'en' })

  it('shows an accessible accepted notice and opens only the exact accepted Session and Turn', () => {
    const onOpenAccepted = vi.fn()
    const props: AgentTaskRecoveryNoticeProps = {
      state: { kind: 'accepted', sessionId: 'session-private-1', turnId: 'turn-private-1' },
      onOpenAccepted, onCheck: vi.fn(async () => undefined), onAbandonAttempt: vi.fn(async () => undefined),
      onRemoveRecoveryNotice: vi.fn(),
    }
    const html = render(props)
    expect(html).toContain('role="region"')
    expect(html).toContain('The task start was accepted.')
    expect(html).toContain('Open accepted task')
    expect(html).not.toContain('session-private-1')
    expect(html).not.toContain('turn-private-1')

    const tree = AgentTaskRecoveryNotice(props)
    const button = findButton(tree, 'Open accepted task')
    expect(button?.props.disabled).toBeUndefined()
    button?.props.onClick?.()
    expect(onOpenAccepted).toHaveBeenCalledWith('session-private-1', 'turn-private-1')
  })

  it('offers explicit check and abandon actions for unknown without implying server cancellation', () => {
    const onCheck = vi.fn(async () => undefined)
    const onAbandonAttempt = vi.fn(async () => undefined)
    const props: AgentTaskRecoveryNoticeProps = {
      state: { kind: 'unknown' }, onOpenAccepted: vi.fn(), onCheck, onAbandonAttempt, onRemoveRecoveryNotice: vi.fn(),
    }
    const html = render(props)
    expect(html).toContain('We can’t confirm whether this task started.')
    expect(html).toContain('it does not stop a task that may already have started')
    expect(html).toContain('Check start status')
    expect(html).toContain('Abandon this start attempt')
    expect(html).not.toContain('Stop task')

    const tree = AgentTaskRecoveryNotice(props)
    findButton(tree, 'Check start status')?.props.onClick?.()
    findButton(tree, 'Abandon this start attempt')?.props.onClick?.()
    expect(onCheck).toHaveBeenCalledOnce()
    expect(onAbandonAttempt).toHaveBeenCalledOnce()
  })

  it('disables unknown actions while reconciliation is running', () => {
    const props: AgentTaskRecoveryNoticeProps = {
      state: { kind: 'unknown', busy: true }, onOpenAccepted: vi.fn(), onCheck: vi.fn(async () => undefined),
      onAbandonAttempt: vi.fn(async () => undefined), onRemoveRecoveryNotice: vi.fn(),
    }
    expect(findButton(AgentTaskRecoveryNotice(props), 'Check start status')?.props.disabled).toBe(true)
    expect(findButton(AgentTaskRecoveryNotice(props), 'Abandon this start attempt')?.props.disabled).toBe(true)
    expect(render(props)).toContain('Checking whether the task was accepted')
  })

  it('says an abandoned start may leave an empty Session and offers only local notice removal', () => {
    const onRemoveRecoveryNotice = vi.fn()
    const props: AgentTaskRecoveryNoticeProps = {
      state: { kind: 'abandoned', sessionId: 'session-maybe-empty' }, onOpenAccepted: vi.fn(),
      onCheck: vi.fn(async () => undefined), onAbandonAttempt: vi.fn(async () => undefined), onRemoveRecoveryNotice,
    }
    expect(render(props)).toContain('may still remain without a task')
    expect(render(props)).not.toContain('session-maybe-empty')
    expect(findButton(AgentTaskRecoveryNotice(props), 'Abandon this start attempt')).toBeNull()
    findButton(AgentTaskRecoveryNotice(props), 'Remove local recovery notice')?.props.onClick?.()
    expect(onRemoveRecoveryNotice).toHaveBeenCalledOnce()
  })

  it('does not claim safe recovery after storage or server errors', () => {
    const props: AgentTaskRecoveryNoticeProps = {
      state: { kind: 'unavailable', reason: 'storage' }, onOpenAccepted: vi.fn(), onCheck: vi.fn(async () => undefined),
      onAbandonAttempt: vi.fn(async () => undefined), onRemoveRecoveryNotice: vi.fn(),
    }
    expect(render(props)).toContain('Recovery status could not be confirmed')
    expect(render(props)).toContain('starting another task could create a duplicate')
    expect(findButton(AgentTaskRecoveryNotice(props), 'Remove local recovery notice')).toBeNull()
  })

  it('allows removing only the local notice when an accepted target no longer exists', () => {
    const onRemoveRecoveryNotice = vi.fn()
    const props: AgentTaskRecoveryNoticeProps = {
      state: { kind: 'unavailable', reason: 'accepted-target-missing' }, onOpenAccepted: vi.fn(),
      onCheck: vi.fn(async () => undefined), onAbandonAttempt: vi.fn(async () => undefined), onRemoveRecoveryNotice,
    }
    expect(render(props)).toContain('The task was accepted, but its original Session or Turn is no longer available')
    expect(render(props)).toContain('This does not undo the accepted task')
    findButton(AgentTaskRecoveryNotice(props), 'Remove local recovery notice')?.props.onClick?.()
    expect(onRemoveRecoveryNotice).toHaveBeenCalledOnce()
  })

  it('renders the Chinese accessible copy', () => {
    language.value = 'zh'
    const props: AgentTaskRecoveryNoticeProps = {
      state: { kind: 'abandoned' }, onOpenAccepted: vi.fn(), onCheck: vi.fn(async () => undefined),
      onAbandonAttempt: vi.fn(async () => undefined), onRemoveRecoveryNotice: vi.fn(),
    }
    expect(render(props)).toContain('本次启动尝试已标记为放弃')
  })
})
