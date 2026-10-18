import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

const language = vi.hoisted(() => ({ value: 'en' }))
vi.mock('@/lib/i18n', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/i18n')>(),
  useI18n: () => ({ lang: language.value, t: (key: string) => key }),
}))

import { ChildWorkerAttachView, childFollowUpTarget, postChildTaskFollowUp, taskTimelineItems } from './ChildWorkerAttachView'
import type { ChildWorkerTask } from './ChildWorkerAttachView'
import type { TimelineItem } from './timeline-reducer'

const child: ChildWorkerTask = {
  id: 'child/one', sessionId: 'session-1', turnId: 'turn-2', rootTaskId: 'root-1', parentTaskId: 'parent-1',
  role: 'researcher', taskType: 'research', status: 'running', goal: 'Research roles', hasResult: false, attemptCount: 3,
}

function item(id: string, taskId: string, text: string): TimelineItem {
  return {
    schemaVersion: 'agent-harness.v2', id, sessionId: 'session-1', turnId: 'turn-2', stepId: null, taskId,
    type: 'agent_message', status: 'completed', phase: 'commentary', revision: 1, content: { parts: [{ type: 'text', text }] },
    startedAt: null, completedAt: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', source: 'replay', sequence: null,
  }
}

describe('ChildWorkerAttachView', () => {
  it('targets only a running real child with its current positive attempt count', () => {
    expect(childFollowUpTarget(child, 'session-1')).toEqual({ taskId: 'child/one', turnId: 'turn-2', attemptCount: 3 })
    expect(childFollowUpTarget({ ...child, id: 'root-1', parentTaskId: null }, 'session-1')).toBeNull()
    expect(childFollowUpTarget({ ...child, status: 'completed' }, 'session-1')).toBeNull()
    expect(childFollowUpTarget({ ...child, attemptCount: 0 }, 'session-1')).toBeNull()
    expect(childFollowUpTarget(child, 'other-session')).toBeNull()
  })

  it('posts the displayed task, turn, and attempt using the durable follow-up contract', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ taskId: 'child/one', turnId: 'turn-2', targetAttemptCount: 3, messageId: 'message-9' }), { status: 200 }))
    await expect(postChildTaskFollowUp({ ...childFollowUpTarget(child, 'session-1')!, sessionId: 'session-1', clientMessageId: 'client-1', text: 'Please continue' }, vi.fn(), fetcher)).resolves.toBe('accepted')
    expect(fetcher).toHaveBeenCalledWith('/api/agent/sessions/session-1/tasks/child%2Fone/messages', expect.objectContaining({
      method: 'POST', headers: expect.objectContaining({ 'idempotency-key': 'client-1' }),
      body: JSON.stringify({ clientMessageId: 'client-1', expectedAttemptCount: 3, text: 'Please continue' }),
    }))
  })

  it('refreshes task state after a conflict', async () => {
    const refresh = vi.fn(async () => undefined)
    const fetcher = vi.fn(async () => new Response(null, { status: 409 }))
    await expect(postChildTaskFollowUp({ ...childFollowUpTarget(child, 'session-1')!, sessionId: 'session-1', clientMessageId: 'client-2', text: 'Continue' }, refresh, fetcher)).resolves.toBe('conflict')
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('keeps the stale attempt conflicted when refreshing after 409 fails', async () => {
    const refresh = vi.fn(async () => { throw new Error('refresh failed') })
    const fetcher = vi.fn(async () => new Response(null, { status: 409 }))
    await expect(postChildTaskFollowUp({ ...childFollowUpTarget(child, 'session-1')!, sessionId: 'session-1', clientMessageId: 'client-3', text: 'Continue' }, refresh, fetcher)).resolves.toBe('conflict')
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('shows a closed, read-only timeline filtered to the selected child in English and Chinese', () => {
    const own = { ...item('child-event', child.id, 'child evidence'), content: { parts: [
      { type: 'text', text: 'child evidence' }, { type: 'suggested_action', command: 'submit_application', arguments: {} },
    ] } }
    const items = [own, item('root-event', 'root-1', 'root evidence'), item('other-event', 'other-child', 'other evidence')]
    expect(taskTimelineItems(items, child.id).map(entry => entry.id)).toEqual(['child-event'])
    const render = () => renderToStaticMarkup(<ChildWorkerAttachView sessionId="session-1" task={child} items={items} onClose={vi.fn()} onConflict={vi.fn()} />)
    language.value = 'en'
    const english = render()
    expect(english).toContain('Selected worker activity')
    expect(english).toContain('Attempt 3')
    expect(english).toContain('Close view')
    expect(english).toContain('data-agent-harness-item="child-event"')
    expect(english).not.toContain('root-event')
    expect(english).not.toContain('other-event')
    expect(english).not.toContain('data-suggested-action=')
    expect(english).toContain('Send follow-up')
    language.value = 'zh'
    const chinese = render()
    expect(chinese).toContain('所选工作线程活动')
    expect(chinese).toContain('尝试 3')
    expect(chinese).toContain('关闭视图')
    language.value = 'en'
  })
})
