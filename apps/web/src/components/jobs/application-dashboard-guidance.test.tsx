import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { DashboardData } from '@/lib/types'
import { ApplicationDashboardGuidance } from './application-dashboard-guidance'
import { ApplicationTaskCard } from './application-task-card'
import type { ApplicationTaskView } from './application-task-model'

const task = (id: string, status: string): ApplicationTaskView => ({
  id, jobId: `job-${id}`, sessionId: `session-${id}`, status, checkpoint: null,
  company: 'Acme', role: `Role ${id}`, updatedAt: '2026-10-30T00:00:00Z',
})

function elements(value: React.ReactNode): React.ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(value)) return value.flatMap(elements)
  if (!React.isValidElement<Record<string, unknown>>(value)) return []
  return [value, ...elements(value.props.children as React.ReactNode)]
}

function props() {
  return {
    tasks: [] as ApplicationTaskView[], loading: false, error: null, limited: false,
    savedJobs: [{ id: 'saved-27', company: 'Saved Inc', role: 'Engineer' }] as DashboardData['savedJobs'],
    followUps: [{ id: 'follow-19', company: 'Follow Inc', role: 'Developer' }] as DashboardData['followUpsDue'],
    onOpenApplication: vi.fn(), onOpenSession: vi.fn(), onOpenAttention: vi.fn(), onRefresh: vi.fn(), onDiscover: vi.fn(),
    t: (key: string) => key,
  }
}

describe('Dashboard application guidance', () => {
  it('opens the exact saved application and follow-up, rather than the general list', () => {
    const input = props()
    const tree = ApplicationDashboardGuidance(input)
    const buttons = elements(tree).filter(element => element.type === 'button')
    for (const button of buttons) (button.props.onClick as () => void)()
    expect(input.onOpenApplication.mock.calls).toEqual([['follow-19'], ['saved-27']])
    expect(input.onDiscover).not.toHaveBeenCalled()
  })

  it('reuses only the actionable tasks and passes their original session handler', () => {
    const input = { ...props(), tasks: [task('1', 'submitted'), task('2', 'waiting_for_user'), task('3', 'unknown'), task('4', 'filling')] }
    const cards = elements(ApplicationDashboardGuidance(input)).filter(element => element.type === ApplicationTaskCard)
    expect(cards.map(card => (card.props.task as ApplicationTaskView).id)).toEqual(['2', '3'])
    expect(cards.every(card => card.props.onOpenSession === input.onOpenSession)).toBe(true)
    const html = renderToStaticMarkup(<ApplicationDashboardGuidance {...input} />)
    expect(html).toContain('application.taskCoverage')
    expect(html).not.toContain('Role 1')
    expect(html).not.toContain('Role 4')
  })

  it('does not repeat the same job as both saved and due for follow-up', () => {
    const input = props()
    input.savedJobs[0].id = 'follow-19'
    const buttons = elements(ApplicationDashboardGuidance(input)).filter(element => element.type === 'button')
    expect(buttons).toHaveLength(1)
  })

  it('does not show a second saved or follow-up shortcut for a job needing attention', () => {
    const input = { ...props(), tasks: [task('1', 'waiting_for_user')] }
    input.savedJobs[0].id = 'job-1'
    input.followUps[0].id = 'job-1'
    const tree = ApplicationDashboardGuidance(input)
    expect(elements(tree).filter(element => element.type === ApplicationTaskCard)).toHaveLength(1)
    const buttons = elements(tree).filter(element => element.type === 'button')
    expect(buttons).toHaveLength(1)
    ;(buttons[0].props.onClick as () => void)()
    expect(input.onOpenAttention).toHaveBeenCalledOnce()
    expect(input.onOpenApplication).not.toHaveBeenCalled()
  })

  it('excludes every recent attention job from continuation shortcuts, not only the three displayed cards', () => {
    const input = { ...props(), tasks: [task('1', 'waiting_for_user'), task('2', 'unknown'), task('3', 'failed'), task('4', 'waiting_for_authorization')] }
    input.savedJobs[0].id = 'job-4'
    input.followUps[0].id = 'job-4'
    const tree = ApplicationDashboardGuidance(input)
    expect(elements(tree).filter(element => element.type === ApplicationTaskCard)).toHaveLength(3)
    const buttons = elements(tree).filter(element => element.type === 'button')
    expect(buttons).toHaveLength(1)
    expect(renderToStaticMarkup(tree)).toContain('application.viewRecentAttention')
    ;(buttons[0].props.onClick as () => void)()
    expect(input.onOpenAttention).toHaveBeenCalledOnce()
    expect(input.onOpenApplication).not.toHaveBeenCalled()
  })

  it('offers refresh after a query error, without claiming there are no tasks', () => {
    const input = { ...props(), tasks: [], savedJobs: [], followUps: [], error: 'unavailable' as const }
    const tree = ApplicationDashboardGuidance(input)
    const html = renderToStaticMarkup(tree)
    expect(html).toContain('dashboard.momentum.loadErrorDetail')
    expect(html).not.toContain('dashboard.momentum.savePromising')
    const refresh = elements(tree).find(element => element.type === 'button')!
    ;(refresh.props.onClick as () => void)()
    expect(input.onRefresh).toHaveBeenCalledOnce()
    expect(input.onDiscover).not.toHaveBeenCalled()
  })

  it.each(['loading', 'error', 'limited'] as const)('withholds continuation suggestions when task coverage is %s', state => {
    const input = {
      ...props(), loading: state === 'loading',
      error: state === 'error' ? 'unavailable' as const : null,
      limited: state === 'limited',
    }
    const tree = ApplicationDashboardGuidance(input)
    const html = renderToStaticMarkup(tree)
    expect(html).not.toContain('application.savedContinue')
    expect(html).not.toContain('application.followUp')
    expect(html).not.toContain('dashboard.momentum.savePromising')
    if (state === 'limited') expect(html).toContain('application.partialSuggestions')
    expect(input.onOpenApplication).not.toHaveBeenCalled()
    if (state !== 'loading') {
      const refresh = elements(tree).find(element => element.type === 'button')!
      ;(refresh.props.onClick as () => void)()
      expect(input.onRefresh).toHaveBeenCalledOnce()
    }
  })

  it('retains known attention cards when the recent task list is limited', () => {
    const input = { ...props(), limited: true, tasks: [task('1', 'waiting_for_user')] }
    const tree = ApplicationDashboardGuidance(input)
    expect(elements(tree).filter(element => element.type === ApplicationTaskCard)).toHaveLength(1)
    expect(renderToStaticMarkup(tree)).toContain('application.viewRecentAttention')
  })

  it('does not suggest discovery for an empty limited snapshot', () => {
    const input = { ...props(), limited: true, savedJobs: [], followUps: [] }
    const tree = ApplicationDashboardGuidance(input)
    expect(renderToStaticMarkup(tree)).not.toContain('dashboard.momentum.savePromising')
    expect(input.onDiscover).not.toHaveBeenCalled()
  })

  it('offers discovery only when the loaded snapshot has no continuation', () => {
    const input = { ...props(), savedJobs: [], followUps: [] }
    const button = elements(ApplicationDashboardGuidance(input)).find(element => element.type === 'button')!
    ;(button.props.onClick as () => void)()
    expect(input.onDiscover).toHaveBeenCalledOnce()
    expect(input.onOpenApplication).not.toHaveBeenCalled()
  })
})
