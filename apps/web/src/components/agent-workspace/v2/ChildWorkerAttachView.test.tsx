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
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:05:00.000Z',
}

function item(id: string, taskId: string, text: string, type = 'agent_message', content: unknown = { parts: [{ type: 'text', text }] }): TimelineItem {
  return {
    schemaVersion: 'agent-harness.v2', id, sessionId: 'session-1', turnId: 'turn-2', stepId: null, taskId,
    type, status: 'completed', phase: 'commentary', revision: 1, content,
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

  it('shows the selected running worker summary with its bounded goal and timestamps', () => {
    const markup = renderToStaticMarkup(<ChildWorkerAttachView sessionId="session-1" task={{ ...child, goal: `${'Research roles '.repeat(30)}` }} items={[]} onClose={vi.fn()} onConflict={vi.fn()} />)
    expect(markup).toContain('data-worker-details-task-id="child/one"')
    expect(markup).toContain('data-worker-goal-task-id="child/one"')
    expect(markup).toContain('Running')
    expect(markup).toContain('Attempt 3')
    expect(markup).toContain('Result')
    expect(markup).toContain('Unavailable')
    expect(markup).toContain('Artifact')
    expect(markup).toContain('Created')
    expect(markup).toContain('Updated')
    expect(markup).toContain('2026-10-01 00:00 UTC')
    expect(markup).not.toContain('Research roles '.repeat(30))
  })

  it('redacts sensitive assignments and contact data in the displayed goal', () => {
    const markup = renderToStaticMarkup(<ChildWorkerAttachView sessionId="session-1" task={{ ...child, goal: 'Use API_KEY=sk_live_12345678901234567890 for alice@example.com' }} items={[]} onClose={vi.fn()} onConflict={vi.fn()} />)
    expect(markup).toContain('API_KEY=[REDACTED]')
    expect(markup).not.toContain('sk_live_12345678901234567890')
    expect(markup).not.toContain('alice@example.com')
  })

  it('shows result and artifact availability for a completed worker', () => {
    const completed: ChildWorkerTask = {
      ...child, status: 'completed', hasResult: true,
      artifactRef: { artifactId: 'artifact-1', version: 2, contentHash: 'sha256:hash', sourceDigest: 'sha256:source' },
    }
    const markup = renderToStaticMarkup(<ChildWorkerAttachView sessionId="session-1" task={completed} items={[]} onClose={vi.fn()} onConflict={vi.fn()} />)
    expect(markup).toContain('Completed')
    expect(markup).toContain('Available')
    expect(markup).not.toContain('artifact-1')
    expect(markup).not.toContain('sha256:')
  })

  it('shows only allowlisted failure codes and hides freeform or code-shaped error text', () => {
    const safe = renderToStaticMarkup(<ChildWorkerAttachView sessionId="session-1" task={{ ...child, status: 'failed', failureReason: 'task_graph_verification_unverified' }} items={[]} onClose={vi.fn()} onConflict={vi.fn()} />)
    expect(safe).toContain('Failure summary')
    expect(safe).toContain('task_graph_verification_unverified')
    for (const reason of ['Alice Doe failed at https://private.example/error', 'alice_doe_failed', 'sk_live_12345678901234567890']) {
      const unsafe = renderToStaticMarkup(<ChildWorkerAttachView sessionId="session-1" task={{ ...child, status: 'failed', failureReason: reason }} items={[]} onClose={vi.fn()} onConflict={vi.fn()} />)
      expect(unsafe).toContain('Failure details hidden for privacy')
      expect(unsafe).not.toContain(reason)
    }
  })

  it('handles unavailable legacy summary fields without displaying stale details after selection changes', () => {
    const legacy: ChildWorkerTask = {
      ...child, id: 'child/legacy', status: '', goal: '', hasResult: false, attemptCount: null,
      createdAt: undefined, updatedAt: undefined, artifactRef: undefined, failureReason: null,
    }
    const legacyMarkup = renderToStaticMarkup(<ChildWorkerAttachView sessionId="session-1" task={legacy} items={[item('legacy-event', legacy.id, 'legacy evidence')]} onClose={vi.fn()} onConflict={vi.fn()} />)
    expect(legacyMarkup).toContain('Goal unavailable')
    expect(legacyMarkup).toContain('Unknown')
    expect(legacyMarkup).toContain('Attempt unavailable')
    expect(legacyMarkup).not.toContain('Created')
    expect(legacyMarkup).not.toContain('Updated')
    expect(legacyMarkup).not.toContain('Failure summary')

    const selected = { ...child, id: 'child/two', goal: 'Review selected roles', status: 'waiting_for_user' }
    const selectedMarkup = renderToStaticMarkup(<ChildWorkerAttachView sessionId="session-1" task={selected} items={[item('selected-event', selected.id, 'selected evidence'), item('legacy-event', legacy.id, 'legacy evidence')]} onClose={vi.fn()} onConflict={vi.fn()} />)
    expect(selectedMarkup).toContain('data-worker-details-task-id="child/two"')
    expect(selectedMarkup).toContain('Review selected roles')
    expect(selectedMarkup).toContain('Waiting')
    expect(selectedMarkup).toContain('data-agent-harness-item="selected-event"')
    expect(selectedMarkup).not.toContain('data-agent-harness-item="legacy-event"')
    expect(selectedMarkup).not.toContain('Goal unavailable')
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
    expect(english).toContain('Worker details')
    expect(english).toContain('Goal')
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
    expect(chinese).toContain('工作线程详情')
    expect(chinese).toContain('目标')
    expect(chinese).toContain('创建时间')
    expect(chinese).toContain('尝试 3')
    expect(chinese).toContain('关闭视图')
    language.value = 'en'
  })

  it('projects only allowlisted child item structure and hides private event bodies and types', () => {
    const allowed = [
      item('safe-message', child.id, 'RAW_MESSAGE_BODY'),
      item('safe-call', child.id, 'ignored', 'tool_call', { toolName: 'private-tool', input: 'RAW_TOOL_INPUT' }),
      item('safe-result', child.id, 'ignored', 'tool_result', { output: 'RAW_TOOL_OUTPUT', errorCode: 'SECRET_ERROR' }),
      item('safe-approval', child.id, 'ignored', 'approval_request', { question: 'RAW_APPROVAL_BODY' }),
      item('safe-question', child.id, 'ignored', 'question', { text: 'RAW_QUESTION_BODY' }),
      item('safe-graph', child.id, 'ignored', 'task_graph', { tasks: [{ goal: 'RAW_GRAPH_BODY' }] }),
    ]
    const hidden = ['reasoning_summary', 'subagent_activity', 'artifact', 'error', 'unknown', 'private_event']
      .map(type => item(`hidden-${type}`, child.id, `RAW_${type.toUpperCase()}`, type))
    const projected = taskTimelineItems([...allowed, ...hidden], child.id)
    expect(projected.map(entry => entry.id)).toEqual(allowed.map(entry => entry.id))
    expect(JSON.stringify(projected)).not.toMatch(/RAW_|SECRET_ERROR|private-tool/)

    const markup = renderToStaticMarkup(<ChildWorkerAttachView sessionId="session-1" task={child} items={[...allowed, ...hidden]} onClose={vi.fn()} onConflict={vi.fn()} />)
    for (const entry of allowed) expect(markup).toContain(`data-agent-harness-item="${entry.id}"`)
    for (const entry of hidden) expect(markup).not.toContain(`data-agent-harness-item="${entry.id}"`)
    expect(markup).not.toMatch(/RAW_|SECRET_ERROR|private-tool/)
  })
})
