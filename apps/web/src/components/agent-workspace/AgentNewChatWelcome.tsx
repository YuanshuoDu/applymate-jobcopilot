'use client'

import React from 'react'
import { BriefcaseBusiness, FilePenLine, SearchCheck, ShieldCheck, Wrench } from 'lucide-react'

type Starter = {
  title: string
  description: string
  prompt: string
  Icon: typeof SearchCheck
  color: string
}

const STARTERS: Starter[] = [
  {
    title: 'Find matching jobs',
    description: 'Search for roles that fit my target and resume.',
    prompt: 'Find the strongest matching jobs for my saved target and explain why each one fits.',
    Icon: SearchCheck,
    color: '#2563EB',
  },
  {
    title: 'Prepare an application',
    description: 'Tailor truthful materials for a specific role.',
    prompt: 'Help me prepare a truthful, role-specific application package for a job I choose.',
    Icon: FilePenLine,
    color: '#7C3AED',
  },
  {
    title: 'Review before applying',
    description: 'Check the job, materials, and approval requirements.',
    prompt: 'Review my application-ready jobs and show what needs my approval before any form is filled.',
    Icon: ShieldCheck,
    color: '#059669',
  },
  {
    title: 'Fix a job-search issue',
    description: 'Investigate a failed, blocked, or unclear task.',
    prompt: 'Investigate my latest failed or blocked job application task and recommend the safest next step.',
    Icon: Wrench,
    color: '#EA580C',
  },
]

export function AgentNewChatWelcome({ onSelectPrompt }: { onSelectPrompt: (prompt: string) => void }) {
  return (
    <section aria-label="New chat welcome" style={{ flex: 1, minHeight: 0, display: 'grid', placeItems: 'center', padding: 'clamp(28px, 7vh, 88px) 20px 28px' }}>
      <div style={{ width: 'min(100%, 920px)', display: 'grid', gap: 'clamp(24px, 4vh, 42px)' }}>
        <div style={{ display: 'grid', justifyItems: 'center', gap: 14, textAlign: 'center' }}>
          <span style={{ width: 54, height: 54, display: 'grid', placeItems: 'center', borderRadius: 18, background: 'rgba(79,70,229,0.09)', color: 'var(--primary)', boxShadow: 'inset 0 0 0 1px rgba(79,70,229,0.12)' }}>
            <BriefcaseBusiness size={28} strokeWidth={1.9} aria-hidden="true" />
          </span>
          <div>
            <h1 style={{ margin: 0, fontSize: 'clamp(26px, 3.1vw, 38px)', lineHeight: 1.16, letterSpacing: '-0.04em', color: 'var(--text)' }}>
              What would you like to do with ApplyMate?
            </h1>
            <p style={{ maxWidth: 610, margin: '11px auto 0', fontSize: 14, lineHeight: 1.6, color: 'var(--text-muted)' }}>
              Start a guided job-search task. ApplyMate will ask before sensitive fields, browser handoff, or final submission.
            </p>
          </div>
        </div>

        <div className="agent-new-chat-starters" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12 }}>
          {STARTERS.map(({ title, description, prompt, Icon, color }) => (
            <button
              key={title}
              type="button"
              onClick={() => onSelectPrompt(prompt)}
              style={{ minHeight: 166, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'space-between', gap: 18, padding: 18, border: '1px solid var(--border)', borderRadius: 14, background: 'var(--bg)', color: 'var(--text)', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', boxShadow: '0 4px 12px rgba(15,23,42,0.04)', transition: 'transform 160ms ease, box-shadow 160ms ease, border-color 160ms ease' }}
              onMouseEnter={event => { event.currentTarget.style.transform = 'translateY(-2px)'; event.currentTarget.style.borderColor = color; event.currentTarget.style.boxShadow = '0 12px 24px rgba(15,23,42,0.10)' }}
              onMouseLeave={event => { event.currentTarget.style.transform = ''; event.currentTarget.style.borderColor = 'var(--border)'; event.currentTarget.style.boxShadow = '0 4px 12px rgba(15,23,42,0.04)' }}
            >
              <Icon size={24} color={color} strokeWidth={2} aria-hidden="true" />
              <span>
                <span style={{ display: 'block', fontSize: 15, lineHeight: 1.3, fontWeight: 760, letterSpacing: '-0.015em' }}>{title}</span>
                <span style={{ display: 'block', marginTop: 7, fontSize: 12, lineHeight: 1.5, color: 'var(--text-muted)' }}>{description}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}
