'use client'

import { useState, type CSSProperties } from 'react'
import { Sidebar } from '@/components/layout/Sidebar'
import type { Page } from '@/lib/types'

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
  const [thinkingExpanded, setThinkingExpanded] = useState(false)

  return (
    <div className="agent-preview-shell" style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: 'var(--bg-tertiary)' }}>
      <style>{`
        @media (max-width: 767px) {
          .agent-preview-shell {
            height: auto !important;
            min-height: 100vh !important;
            flex-direction: column !important;
            overflow-y: auto !important;
          }
          .agent-preview-desktop-sidebar {
            display: none !important;
          }
          .agent-preview-console {
            width: 100% !important;
            height: min(42vh, 340px) !important;
            border-right: none !important;
            border-bottom: 1px solid var(--border) !important;
          }
          .agent-preview-main {
            min-height: 620px !important;
            width: 100% !important;
          }
        }
      `}</style>
      <div className="agent-preview-desktop-sidebar">
        <Sidebar active={'agent' as Page} onNav={() => undefined} session={previewSession} jobCount={12} />
      </div>
      <aside className="agent-preview-console" style={agentSidebar}>
        <div style={{ padding: 14, borderBottom: '1px solid var(--border)' }}>
          <button style={primaryButton}>+ New chat</button>
        </div>
        <MetricGrid />
        <Section title="Recent Sessions">
          <SessionRow active title="Berlin SWE Auto-Apply" meta="Running · quality 87% · 09:14" />
          <SessionRow title="Munich Data Engineer Search" meta="Done · quality 91% · Yesterday" />
          <SessionRow title="Gmail Follow-up Batch" meta="Approval · quality pending · May 22" />
        </Section>
        <Section title="Queued Tasks">
          <TaskRow role="Scout" status="LivenessGate" value="94%" />
          <TaskRow role="Analyst" status="JobDecision" value="89%" />
          <TaskRow role="Executor" status="Approval" value="waiting" warn />
        </Section>
        <Section title="Agent Team">
          {['Orchestrator', 'Scout', 'Analyst', 'Writer', 'Reviewer', 'Executor', 'Auditor'].map((name, index) => (
            <TaskRow key={name} role={name} status={index < 3 ? 'active' : 'idle'} value={index < 3 ? 'MiniMax' : 'Claude'} />
          ))}
        </Section>
        <Section title="Automations">
          <TaskRow role="Weekday 09:00 EU scout" status="enabled" value="run" />
          <TaskRow role="Auto-apply 85+" status="approval required" value="on" />
        </Section>
        <Section title="Session Quality">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Quality label="Quality" value="87%" />
            <Quality label="Gate pass" value="92%" />
            <Quality label="Retry" value="8%" />
            <Quality label="Approvals" value="2" warn />
          </div>
        </Section>
      </aside>
      <main className="agent-preview-main" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
        <header style={headerStyle}>
          <div>
            <h1 style={{ margin: 0, fontSize: 17 }}>Berlin SWE Auto-Apply</h1>
            <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-muted)' }}>
              Memory: Berlin SWE · min score 85 · approval required · no LinkedIn
            </div>
          </div>
          <div style={{ display: 'flex', gap: 14, color: 'var(--text-muted)' }}>◴ ⌕ ⋮</div>
        </header>
        <section style={transcriptStyle}>
          <Message speaker="You" body="每天早上 9 点自动找 Berlin 软件工程岗位，85 分以上自动投，但需要我确认。" time="09:11" />
          <Message speaker="Orchestrator · Automation draft" body="我可以创建一个工作日 09:00 自动化：在 Berlin 搜索软件工程岗位，85 分以上进入投递队列，提交前请求你确认。" time="09:12">
            <Grid rows={[['Trigger', 'Weekdays 09:00'], ['Target', 'Berlin · SWE'], ['Score', '85+'], ['Approval', 'Required'], ['Daily cap', '8 applications']]} />
            <ButtonRow labels={['Create automation', 'Edit', 'Cancel']} />
          </Message>
          <Message
            speaker="Analyst · Thinking"
            body={thinkingExpanded
              ? 'Checked saved preferences, application limits, recent run history, salary constraints, and no-LinkedIn policy. Evidence: 85+ score gate, Berlin SWE target, approval required before submission.'
              : 'Checked saved preferences, application limits, recent run history, and salary constraints.'}
            time={thinkingExpanded ? '09:12 · expanded' : '09:12 · collapsed'}
            muted={!thinkingExpanded}
          />
          <Message speaker="Orchestrator · Options" body="选择投递策略以优化匹配质量和效率。" time="09:13">
            <Option name="Conservative" desc="更高匹配阈值，投递更少但质量更高。" />
            <Option name="Balanced" desc="平衡匹配质量与数量，推荐日常使用。" selected />
            <Option name="Aggressive" desc="更宽松阈值，获取更多机会。" />
          </Message>
          <Message speaker="Executor · Approval Required" body="准备提交以下 4 份申请，请确认是否继续。" time="09:14" warn>
            <Grid rows={[['Impact', '4 applications · 4 cover letters'], ['LinkedIn', 'No LinkedIn actions'], ['Sensitive fields', 'Ask user if missing']]} />
            <ButtonRow labels={['Approve', 'Review jobs', 'Cancel']} />
          </Message>
          <Message speaker="Analyst · Top opportunities" body="Top matches for Berlin, Germany" time="09:15">
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <tbody>{rows.map(row => <tr key={row[0]}>{row.map(cell => <td key={cell} style={tdStyle}>{cell}</td>)}</tr>)}</tbody>
            </table>
          </Message>
        </section>
        <footer style={composerWrap}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            {['Create automation', 'Review pending', 'Explain score'].map(label => <button key={label} style={chipStyle}>{label}</button>)}
            <button style={chipStyle} onClick={() => setThinkingExpanded(value => !value)}>
              {thinkingExpanded ? 'Hide thinking' : 'Show thinking'}
            </button>
          </div>
          <div style={composerBox}>
            <textarea placeholder="Ask ApplyMate to search, score, apply, or create an automation..." style={textareaStyle} />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', gap: 8 }}><button style={iconButton}>+</button><button style={selectButton}>MiniMax M2.7 ▾</button></div>
              <button style={sendButton}>↑</button>
            </div>
          </div>
        </footer>
      </main>
    </div>
  )
}

function MetricGrid() {
  return <div style={{ padding: '10px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}><Quality label="Queued Tasks" value="3" /><Quality label="Approvals" value="2" warn /></div>
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <div style={{ padding: '0 10px 12px' }}><div style={sectionTitle}>{title}</div><div style={panelStyle}>{children}</div></div>
}

function SessionRow({ title, meta, active = false }: { title: string; meta: string; active?: boolean }) {
  return <div style={{ padding: 10, borderBottom: '1px solid var(--border)', background: active ? 'var(--bg)' : 'transparent' }}><div style={{ fontSize: 12, fontWeight: 700 }}>{title}</div><div style={metaText}>{meta}</div></div>
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
const composerWrap: CSSProperties = { borderTop: '1px solid var(--border)', padding: '10px 16px 14px', background: 'var(--bg-secondary)' }
const composerBox: CSSProperties = { border: '1px solid rgba(79,70,229,.35)', borderRadius: 10, background: 'var(--bg)', padding: 9 }
const textareaStyle: CSSProperties = { width: '100%', minHeight: 54, border: 0, outline: 0, resize: 'none', fontFamily: 'inherit', background: 'transparent', color: 'var(--text)' }
const iconButton: CSSProperties = { width: 30, height: 30, borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--primary)' }
const selectButton: CSSProperties = { height: 30, borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', padding: '0 12px' }
const sendButton: CSSProperties = { width: 34, height: 30, borderRadius: 7, border: 0, background: 'var(--primary)', color: '#fff', fontWeight: 900 }
const chipStyle: CSSProperties = { border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg)', color: 'var(--text)', padding: '6px 10px', fontSize: 11 }
const tdStyle: CSSProperties = { borderTop: '1px solid var(--border)', padding: '7px 8px' }
