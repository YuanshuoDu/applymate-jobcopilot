'use client'

import { ArrowUp, ChevronDown, Home, Paperclip, PanelLeftClose, PanelLeftOpen, Sparkles } from 'lucide-react'
import { useState, type CSSProperties } from 'react'
import styles from './AgentPreviewClient.module.css'
import { Sidebar } from '@/components/layout/Sidebar'
import type { Page } from '@/lib/types'
import { useI18n } from '@/lib/i18n'

const previewSession = {
  user: { id: 'agent-preview', email: 'agent-preview@applymate.local', name: 'Agent Preview', plan: 'pro' as const },
  expires: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
}

const rows = [
  ['N26', 'Software Engineer (Backend)', '94', 'Ready'],
  ['Spotify', 'Data Platform Engineer', '88', 'Ready'],
  ['HelloFresh', 'Fullstack Engineer', '86', 'Needs review'],
  ['SAP', 'Cloud Engineer', '82', 'Hold'],
]

export function AgentPreviewClient() {
  const { t } = useI18n()
  const [thinkingExpanded, setThinkingExpanded] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [newChat, setNewChat] = useState(false)

  function startNewChat() {
    setNewChat(true)
    setDrawerOpen(false)
  }

  function resumeLastChat() {
    setNewChat(false)
    setDrawerOpen(false)
  }

  return (
    <div className={`${styles.root} agent-preview-shell`} style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: 'var(--bg-tertiary)' }}>
      <div className="agent-preview-desktop-sidebar">
        <Sidebar active={'agent' as Page} onNav={() => undefined} session={previewSession} jobCount={12} />
      </div>
      <button className={`agent-preview-drawer-scrim${drawerOpen ? ' is-open' : ''}`} type="button" aria-label={t('agentPreview.closeConversations')} tabIndex={drawerOpen ? 0 : -1} onClick={() => setDrawerOpen(false)} />
      <div id="agent-preview-drawer" className={`agent-preview-drawer${drawerOpen ? ' is-open' : ''}`}>
        <div className="agent-preview-drawer-header">
          <span>{t('agentPreview.conversations')}</span>
          <div className="agent-preview-drawer-actions">
            <button className="agent-preview-drawer-home" type="button" aria-label={t('agentPreview.backHome')} onClick={() => { window.location.assign('/?page=dashboard') }}>
              <Home size={15} aria-hidden="true" />
              {t('agentPreview.backHome')}
            </button>
            <button className="agent-preview-drawer-collapse" type="button" aria-label={t('agentPreview.collapseConversations')} onClick={() => setDrawerOpen(false)}>
              <PanelLeftClose size={17} aria-hidden="true" />
            </button>
          </div>
        </div>
        <aside className="agent-preview-console" style={agentSidebar}>
          <div style={{ padding: 14, borderBottom: '1px solid var(--border)' }}>
            <button type="button" style={primaryButton} onClick={startNewChat}>+ {t('agentPreview.newChat')}</button>
          </div>
          <MetricGrid />
          <Section title={t('agentPreview.recentSessions')}>
            <SessionRow active={!newChat} title="Berlin SWE Auto-Apply" meta="Last opened · Running · quality 87% · 09:14" onClick={resumeLastChat} />
            <SessionRow title="Munich Data Engineer Search" meta="Done · quality 91% · Yesterday" />
            <SessionRow title="Gmail Follow-up Batch" meta="Approval · quality pending · May 22" />
          </Section>
          <Section title={t('agentPreview.queuedTasks')}>
            <TaskRow role={t('agentPreview.scout')} status={t('agentPreview.livenessGate')} value="94%" />
            <TaskRow role={t('agentPreview.analyst')} status={t('agentPreview.jobDecision')} value="89%" />
            <TaskRow role={t('agentPreview.executor')} status={t('agentPreview.approval')} value={t('agentPreview.waiting')} warn />
          </Section>
          <Section title={t('agentPreview.agentTeam')}>
            {['Orchestrator', 'Scout', 'Analyst', 'Writer', 'Reviewer', 'Executor', 'Auditor'].map((name, index) => (
              <TaskRow key={name} role={name} status={index < 3 ? t('agentPreview.active') : t('agentPreview.idle')} value={index < 3 ? 'MiniMax' : 'Claude'} />
            ))}
          </Section>
          <Section title={t('agentPreview.automations')}>
            <TaskRow role={t('agentPreview.weekdayScout')} status={t('agentPreview.enabled')} value={t('agentPreview.run')} />
            <TaskRow role={t('agentPreview.autoApply85')} status={t('agentPreview.approvalRequired')} value={t('agentPreview.on')} />
          </Section>
          <Section title={t('agentPreview.sessionQuality')}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <Quality label={t('agentPreview.quality')} value="87%" />
              <Quality label={t('agentPreview.gatePass')} value="92%" />
              <Quality label={t('agentPreview.retry')} value="8%" />
              <Quality label={t('agentPreview.approvals')} value="2" warn />
            </div>
          </Section>
        </aside>
      </div>
      <main className="agent-preview-main" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
        <header style={headerStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <button className="agent-preview-drawer-trigger" type="button" aria-label={t('agentPreview.openConversations')} aria-expanded={drawerOpen} aria-controls="agent-preview-drawer" onClick={() => setDrawerOpen(true)}>
              <PanelLeftOpen size={17} aria-hidden="true" />
            </button>
            {!newChat && <div>
              <h1 style={{ margin: 0, fontSize: 17 }}>Berlin SWE Auto-Apply</h1>
              <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-muted)' }}>
                {t('agentPreview.memory')}
              </div>
            </div>}
          </div>
          <div style={{ display: 'flex', gap: 14, color: 'var(--text-muted)' }}>◴ ⌕ ⋮</div>
        </header>
        <section className="agent-preview-transcript" style={transcriptStyle}>
          {newChat ? <NewChatEmptyState /> : <>
          <Message speaker={t('agentPreview.you')} body={t('agentPreview.userMessage')} time="09:11" />
          <Message speaker={t('agentPreview.orchestratorDraft')} body={t('agentPreview.orchestratorMessage')} time="09:12">
            <Grid rows={[[t('agentPreview.trigger'), t('agentPreview.weekdays')], [t('agentPreview.target'), t('agentPreview.berlinSwe')], [t('agentPreview.score'), '85+'], [t('agentPreview.approval'), t('agentPreview.required')], [t('agentPreview.dailyCap'), t('agentPreview.eightApplications')]]} />
            <ButtonRow labels={[t('agentPreview.createAutomation'), t('agentPreview.edit'), t('agentPreview.cancel')]} />
          </Message>
          <Message
            speaker="Analyst · Thinking"
            body={thinkingExpanded ? t('agentPreview.thinkingExpanded') : t('agentPreview.thinkingCollapsed')}
            time={thinkingExpanded ? '09:12 · expanded' : '09:12 · collapsed'}
            muted={!thinkingExpanded}
          />
          <Message speaker={t('agentPreview.orchestratorOptions')} body={t('agentPreview.strategyMessage')} time="09:13">
            <Option name={t('agentPreview.conservative')} desc={t('agentPreview.conservativeDescription')} />
            <Option name={t('agentPreview.balanced')} desc={t('agentPreview.balancedDescription')} selected />
            <Option name={t('agentPreview.aggressive')} desc={t('agentPreview.aggressiveDescription')} />
          </Message>
          <Message speaker={t('agentPreview.executorApproval')} body={t('agentPreview.executorMessage')} time="09:14" warn>
            <Grid rows={[[t('agentPreview.impact'), t('agentPreview.fourApplications')], ['LinkedIn', t('agentPreview.noLinkedInActions')], [t('agentPreview.sensitiveFields'), t('agentPreview.askUserIfMissing')]]} />
            <ButtonRow labels={[t('agentPreview.approve'), t('agentPreview.reviewJobs'), t('agentPreview.cancel')]} />
          </Message>
          <Message speaker={t('agentPreview.topOpportunities')} body={t('agentPreview.topMatches')} time="09:15">
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <tbody>{rows.map(row => <tr key={row[0]}>{row.map(cell => <td key={cell} style={tdStyle}>{cell}</td>)}</tr>)}</tbody>
            </table>
          </Message>
          </>}
        </section>
        <footer style={composerWrap}>
          <div style={chipRowStyle}>
            {[t('agentPreview.automate'), t('agentPreview.review'), t('agentPreview.explainScore')].map(label => <button key={label} style={composerChipStyle}><Sparkles size={13} color="var(--primary)" aria-hidden="true" />{label}</button>)}
            <button style={composerChipStyle} onClick={() => setThinkingExpanded(value => !value)}>
              <Sparkles size={13} color="var(--primary)" aria-hidden="true" />
              {thinkingExpanded ? t('agentPreview.hideThinking') : t('agentPreview.thinking')}
            </button>
          </div>
          <div style={composerBox}>
            <textarea placeholder={t('agentPreview.composerPlaceholder')} style={textareaStyle} />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', gap: 8 }}><button aria-label={t('agentPreview.addContext')} style={iconButton}><Paperclip size={17} aria-hidden="true" /></button><button style={selectButton}>{t('agentPreview.model')} <ChevronDown size={13} aria-hidden="true" /></button></div>
              <button aria-label={t('agentPreview.sendMessage')} style={sendButton}><ArrowUp size={19} strokeWidth={2.7} aria-hidden="true" /></button>
            </div>
          </div>
        </footer>
      </main>
    </div>
  )
}

function MetricGrid() {
  const { t } = useI18n()
  return <div style={{ padding: '10px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}><Quality label={t('agentPreview.queuedTasks')} value="3" /><Quality label={t('agentPreview.approvals')} value="2" warn /></div>
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <div style={{ padding: '0 10px 12px' }}><div style={sectionTitle}>{title}</div><div style={panelStyle}>{children}</div></div>
}

function SessionRow({ title, meta, active = false, onClick }: { title: string; meta: string; active?: boolean; onClick?: () => void }) {
  return <button type="button" onClick={onClick} style={{ width: '100%', padding: 10, border: 0, borderBottom: '1px solid var(--border)', background: active ? 'var(--bg)' : 'transparent', color: 'var(--text)', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}><div style={{ fontSize: 12, fontWeight: 700 }}>{title}</div><div style={metaText}>{meta}</div></button>
}

function NewChatEmptyState() {
  const { t } = useI18n()
  return <div aria-label={t('agentPreview.newChatWelcome')} style={{ flex: 1, display: 'grid', placeItems: 'center', textAlign: 'center' }}>
    <div style={{ display: 'grid', justifyItems: 'center', gap: 14 }}>
      <span aria-label="ApplyMate AI" style={{ width: 58, height: 58, display: 'grid', placeItems: 'center', borderRadius: 18, background: 'var(--brand-gradient)', color: '#fff', fontSize: 25, fontWeight: 800, boxShadow: '0 12px 28px rgba(79,70,229,0.24)' }}>A</span>
      <div style={{ fontSize: 22, fontWeight: 760, letterSpacing: '-0.03em' }}>{t('agentPreview.welcomeTitle')}</div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{t('agentPreview.welcomeDescription')}</div>
    </div>
  </div>
}

function TaskRow({ role, status, value, warn = false }: { role: string; status: string; value: string; warn?: boolean }) {
  return <div style={taskRow}><div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 11, fontWeight: 650, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{role}</div><div style={metaText}>{status}</div></div><span style={{ fontSize: 10, color: warn ? '#d97706' : 'var(--primary)', fontWeight: 700 }}>{value}</span></div>
}

function Quality({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8, padding: 9 }}><div style={{ fontSize: 16, fontWeight: 800, color: warn ? '#d97706' : 'var(--text)' }}>{value}</div><div style={metaText}>{label}</div></div>
}

function Message({ speaker, body, time, children, muted = false, warn = false }: { speaker: string; body: string; time: string; children?: React.ReactNode; muted?: boolean; warn?: boolean }) {
  const color = warn ? '#d97706' : muted ? 'var(--text-muted)' : 'var(--primary)'
  return <article style={{ border: `1px solid ${warn ? 'rgba(245,158,11,.45)' : 'var(--border)'}`, borderLeft: `3px solid ${color}`, borderRadius: 8, background: warn ? 'rgba(245,158,11,.06)' : 'var(--bg)', padding: 13 }}><div style={{ fontSize: 12, fontWeight: 800, color }}>{speaker}</div><div style={{ marginTop: 7, fontSize: 13, lineHeight: 1.65 }}>{body}</div>{children && <div style={{ marginTop: 10 }}>{children}</div>}<div style={{ marginTop: 9, paddingTop: 7, borderTop: '1px solid var(--border)', fontSize: 10, color: 'var(--text-muted)' }}>{time}</div></article>
}

function Grid({ rows }: { rows: Array<[string, string]> }) {
  return <div style={{ border: '1px solid var(--border)', borderRadius: 7, overflow: 'hidden' }}>{rows.map(row => <div key={row[0]} style={{ display: 'grid', gridTemplateColumns: '120px 1fr', padding: '7px 9px', borderBottom: '1px solid var(--border)', fontSize: 11 }}><span style={metaText}>{row[0]}</span><strong>{row[1]}</strong></div>)}</div>
}

function ButtonRow({ labels }: { labels: string[] }) {
  return <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>{labels.map(label => <button key={label} style={chipStyle}>{label}</button>)}</div>
}

function Option({ name, desc, selected = false }: { name: string; desc: string; selected?: boolean }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 8, border: `1px solid ${selected ? 'var(--primary)' : 'var(--border)'}`, borderRadius: 7, padding: 8, marginTop: 6, fontSize: 11 }}><strong>{selected ? '◉ ' : '○ '}{name}</strong><span style={metaText}>{desc}</span></div>
}

const agentSidebar: CSSProperties = { width: 292, flexShrink: 0, borderRight: '1px solid var(--border)', background: 'var(--bg-secondary)', overflowY: 'auto' }
const primaryButton: CSSProperties = { width: '100%', height: 38, border: 0, borderRadius: 8, background: 'linear-gradient(135deg,#4338CA,#5B21B6)', color: '#fff', fontWeight: 800 }
const sectionTitle: CSSProperties = { fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 800, marginBottom: 6 }
const panelStyle: CSSProperties = { border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg)', overflow: 'hidden' }
const taskRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 10px', borderBottom: '1px solid var(--border)' }
const metaText: CSSProperties = { fontSize: 10, color: 'var(--text-muted)', marginTop: 3 }
const headerStyle: CSSProperties = { height: 64, borderBottom: '1px solid var(--border)', padding: '12px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }
const transcriptStyle: CSSProperties = { flex: 1, overflowY: 'auto', padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12 }
const composerWrap: CSSProperties = { borderTop: '1px solid rgba(79,70,229,.08)', padding: '12px 16px 14px', background: 'linear-gradient(180deg,rgba(248,250,252,.72),var(--bg-secondary))' }
const chipRowStyle: CSSProperties = { display: 'flex', gap: 7, overflowX: 'auto', marginBottom: 10, padding: '1px 1px 3px' }
const composerBox: CSSProperties = { border: '1px solid rgba(99,102,241,.22)', borderRadius: 18, background: 'rgba(255,255,255,.96)', padding: '5px 7px 7px 8px', boxShadow: '0 12px 28px rgba(49,46,129,.10),0 2px 7px rgba(15,23,42,.04)' }
const textareaStyle: CSSProperties = { width: '100%', boxSizing: 'border-box', minHeight: 66, padding: '8px 6px 7px', border: 0, outline: 0, resize: 'none', fontFamily: 'inherit', fontSize: 14, lineHeight: 1.5, background: 'transparent', color: 'var(--text)' }
const iconButton: CSSProperties = { width: 34, height: 34, display: 'grid', placeItems: 'center', borderRadius: 12, border: 0, background: 'rgba(79,70,229,.08)', color: 'var(--primary)' }
const selectButton: CSSProperties = { height: 34, display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 12, border: 0, background: 'rgba(15,23,42,.045)', color: 'var(--text-muted)', padding: '0 10px', fontSize: 11, fontWeight: 700 }
const sendButton: CSSProperties = { width: 38, height: 38, display: 'grid', placeItems: 'center', borderRadius: 14, border: 0, background: 'var(--brand-gradient)', color: '#fff', boxShadow: '0 8px 16px rgba(79,70,229,.28)' }
const composerChipStyle: CSSProperties = { minHeight: 34, flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 7, padding: '0 12px', border: '1px solid rgba(79,70,229,.14)', borderRadius: 999, background: 'rgba(255,255,255,.82)', boxShadow: '0 2px 7px rgba(15,23,42,.035)', color: 'var(--text)', fontSize: 11.5, fontWeight: 650, fontFamily: 'inherit' }
const chipStyle: CSSProperties = { border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg)', color: 'var(--text)', padding: '6px 10px', fontSize: 11 }
const tdStyle: CSSProperties = { borderTop: '1px solid var(--border)', padding: '7px 8px' }
