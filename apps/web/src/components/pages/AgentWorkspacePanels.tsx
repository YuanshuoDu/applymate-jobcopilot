'use client'

import React, { type ReactNode } from 'react'
import { PanelRightClose, PanelRightOpen } from 'lucide-react'
import { useI18n } from '@/lib/i18n'

/** Presentation only: keep the supervisor mounted so closing it preserves drafts. */
export function AgentWorkspacePanels({ sessionId, needsAttention, toolbar, details, children }: {
  sessionId: string | null
  needsAttention: boolean
  toolbar: ReactNode
  details: ReactNode
  children: ReactNode
}) {
  const { t } = useI18n()
  const [selection, setSelection] = React.useState<{ sessionId: string; open: boolean } | null>(null)
  const trigger = React.useRef<HTMLButtonElement>(null)
  const open = Boolean(sessionId && selection?.sessionId === sessionId && selection.open)
  const content = React.useRef<HTMLDivElement>(null)
  const previousView = React.useRef({ sessionId, open })
  React.useEffect(() => {
    const returning = previousView.current.sessionId === sessionId && previousView.current.open && !open
    previousView.current = { sessionId, open }
    if (!returning || !sessionId) return
    // Closing details changes transcript width. Locate the selected evidence after reflow.
    const frame = requestAnimationFrame(() => {
      const workspace = content.current
      if (workspace?.dataset.agentWorkspaceSession !== sessionId) return
      const itemId = workspace.querySelector<HTMLElement>('[data-task-node-id][aria-current="true"]')?.dataset.taskTimelineItem
      if (!itemId) return
      const item = Array.from(workspace.querySelectorAll<HTMLElement>('[data-agent-harness-item]'))
        .find(candidate => candidate.dataset.agentHarnessItem === itemId)
      item?.scrollIntoView({ behavior: 'instant', block: 'center' })
    })
    return () => cancelAnimationFrame(frame)
  }, [open, sessionId])
  const close = () => {
    if (sessionId) setSelection({ sessionId, open: false })
    trigger.current?.focus()
  }

  return <div className="agent-workspace-panels">
    <div className="agent-workspace-toolbar">
      {toolbar}
      {sessionId && <button ref={trigger} type="button" className="agent-details-toggle"
        aria-expanded={open} aria-controls="agent-workspace-details"
        onClick={() => setSelection({ sessionId, open: !open })}>
        {open ? <PanelRightClose size={16} aria-hidden="true" /> : <PanelRightOpen size={16} aria-hidden="true" />}
        {t('agent.taskDetails')}
        {needsAttention && <span role="status" className="agent-attention-label">{t('agent.needsAttention')}</span>}
      </button>}
    </div>
    <div ref={content} className="agent-workspace-content" data-agent-workspace-session={sessionId ?? undefined}>
      {children}
      <div id="agent-workspace-details" className="agent-workspace-details" hidden={!open}
        onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close() } }}>
        <button type="button" className="agent-details-close" onClick={close}>
          <PanelRightClose size={16} aria-hidden="true" />{t('agent.hideDetails')}
        </button>
        {details}
      </div>
    </div>
    <style>{`
      .agent-workspace-panels { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--bg); }
      .agent-workspace-toolbar { flex-shrink: 0; min-height: 48px; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 16px; border-bottom: 1px solid var(--border); }
      .agent-workspace-content { flex: 1; min-height: 0; min-width: 0; display: flex; overflow: hidden; }
      .agent-context-bar { display: flex; align-items: center; flex-shrink: 0; }
      .agent-context-bar [data-agent-current-objective] { flex: 1; min-width: 0; border-bottom: 0 !important; }
      .agent-context-bar [data-agent-session-control] { display: flex !important; flex-wrap: wrap; align-items: center; justify-content: flex-end; border-bottom: 0 !important; font-size: 11px; }
      .agent-workspace-details { display: flex; flex-direction: column; flex-shrink: 0; width: 330px; max-width: 38%; min-height: 0; border-left: 1px solid var(--border); background: var(--bg-secondary); }
      .agent-workspace-details[hidden] { display: none; }
      .agent-workspace-details .agent-supervisor-panel { flex: 1; width: auto; min-width: 0; max-height: none; border: 0; background: transparent; }
      .agent-details-toggle, .agent-details-close { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 34px; padding: 6px 10px; border: 1px solid var(--border); border-radius: 8px; color: var(--text); background: var(--bg); cursor: pointer; font: inherit; font-size: 12px; }
      .agent-details-close { align-self: flex-end; margin: 10px 12px 0; }
      .agent-details-toggle:focus-visible, .agent-details-close:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
      .agent-attention-label { color: #92400e; background: #fef3c7; border-radius: 5px; padding: 2px 5px; font-size: 11px; }
      @media (max-width: 900px) {
        .agent-workspace-content { position: relative; flex-direction: column; }
        .agent-workspace-details { flex: 1; width: auto; max-width: none; border-left: 0; }
        .agent-workspace-content:has(.agent-workspace-details:not([hidden])) > .agent-chat-column { position: absolute; inset: 0; visibility: hidden; }
        .agent-workspace-toolbar { padding: 6px 10px; flex-wrap: wrap; }
        .agent-details-toggle, .agent-details-close { min-height: 40px; }
      }
    `}</style>
  </div>
}
