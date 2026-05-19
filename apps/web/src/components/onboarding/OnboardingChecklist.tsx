'use client'

import React from 'react'
import { Btn } from '@/components/ui'
import { useNav } from '@/lib/nav-context'

interface Props {
  hasResume: boolean
  hasJobs: boolean
  hasExtension: boolean
  hasRunAgent: boolean
}

const STEPS = [
  {
    key: 'resume',
    icon: '📄',
    title: 'Create your first resume',
    desc: 'AI will help you write and optimize your CV for every application.',
    action: 'Create Resume',
    page: 'resume' as const,
    check: (p: Props) => p.hasResume,
  },
  {
    key: 'jobs',
    icon: '💼',
    title: 'Add your first job',
    desc: 'Save jobs manually or install the extension to auto-capture from LinkedIn and Indeed.',
    action: 'Add Jobs',
    page: 'jobs' as const,
    check: (p: Props) => p.hasJobs,
  },
  {
    key: 'extension',
    icon: '🧩',
    title: 'Install Chrome Extension',
    desc: 'One-click save jobs while browsing. Works on LinkedIn, Indeed, and StepStone.',
    action: 'Install Extension',
    page: 'extension' as const,
    check: (p: Props) => p.hasExtension,
  },
  {
    key: 'agent',
    icon: '🚀',
    title: 'Run the AI Agent',
    desc: 'Let the agent score your matches, tailor your CV, and auto-apply to the best fits.',
    action: 'Go to Agent',
    page: 'agent' as const,
    check: (p: Props) => p.hasRunAgent,
  },
]

export function OnboardingChecklist(props: Props) {
  const { navigate } = useNav()
  const done = STEPS.filter(s => s.check(props)).length

  return (
    <div style={{
      background: 'var(--bg)', border: '0.5px solid var(--border)', borderRadius: 12,
      padding: 20, maxWidth: 480,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 16 }}>👋</span>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>Welcome to ApplyMate</span>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 16 }}>
        {done}/{STEPS.length} steps completed — let&apos;s get your job search automated
      </div>

      {/* Progress bar */}
      <div style={{ height: 3, background: 'var(--bg-tertiary)', borderRadius: 2, marginBottom: 16, overflow: 'hidden' }}>
        <div style={{ height: '100%', background: 'var(--primary)', borderRadius: 2, width: `${(done / STEPS.length) * 100}%`, transition: 'width 0.3s' }} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {STEPS.map((step, i) => {
          const completed = step.check(props)
          return (
            <div key={step.key} style={{
              display: 'flex', alignItems: 'flex-start', gap: 10,
              opacity: completed ? 0.55 : 1,
            }}>
              <div style={{
                width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
                background: completed ? 'var(--c-success)' : 'var(--bg-tertiary)',
                color: completed ? '#fff' : 'var(--text-muted)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 12, fontWeight: 600,
              }}>
                {completed ? '✓' : i + 1}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)', marginBottom: 1 }}>
                  {step.title}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: 6 }}>
                  {step.desc}
                </div>
                {!completed && (
                  <Btn small variant="primary" onClick={() => navigate(step.page)}>
                    {step.action}
                  </Btn>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
