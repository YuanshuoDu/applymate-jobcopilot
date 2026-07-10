'use client'

import React from 'react'

export function AgentWelcomeTranscript({
  savedCount,
  pendingCount,
  autonomousMode,
  onSelectPrompt,
}: {
  savedCount: number
  pendingCount: number
  autonomousMode: boolean
  onSelectPrompt: (prompt: string) => void
}) {
  const now = new Date()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <WelcomeBlock
        speaker="Orchestrator"
        title="Ready"
        accent="var(--primary)"
        time={now}
      >
        <div style={bodyStyle}>
          我已准备好接管这次求职任务。当前有 {savedCount} 个已保存职位
          {pendingCount > 0 ? `，${pendingCount} 个待审核职位` : ''}；敏感动作会先请求确认。
        </div>
      </WelcomeBlock>

      <WelcomeBlock
        speaker="Analyst"
        title="Thinking summary"
        accent="#64748b"
        time={now}
      >
        <details style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.65 }}>
          <summary style={{ cursor: 'pointer', color: 'var(--text-muted)', fontWeight: 650 }}>
            查看当前判断摘要
          </summary>
          <div style={{ marginTop: 8, display: 'grid', gap: 5 }}>
            <span>审批策略：{autonomousMode ? '自动决策开启，但外部提交仍需过安全门' : '交互确认优先'}</span>
            <span>可用上下文：已保存职位、简历、Agent 配置、自动化规则。</span>
            <span>下一步建议：创建自动化、审核待定职位，或解释最近的评分。</span>
          </div>
        </details>
      </WelcomeBlock>

      <WelcomeBlock
        speaker="Orchestrator"
        title="Options"
        accent="#7c3aed"
        time={now}
      >
        <div style={{ display: 'grid', gap: 7 }}>
          {STARTER_OPTIONS.map(option => (
            <button
              key={option.label}
              type="button"
              onClick={() => onSelectPrompt(option.prompt)}
              style={optionButtonStyle}
            >
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{option.label}</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{option.description}</span>
            </button>
          ))}
        </div>
      </WelcomeBlock>
    </div>
  )
}

function WelcomeBlock({
  speaker,
  title,
  accent,
  time,
  children,
}: {
  speaker: string
  title: string
  accent: string
  time: Date
  children: React.ReactNode
}) {
  return (
    <article style={{
      border: '1px solid var(--border)',
      borderLeft: `3px solid ${accent}`,
      borderRadius: 8,
      background: 'var(--bg)',
      padding: '10px 12px',
      boxShadow: '0 1px 4px rgba(15,23,42,0.04)',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, marginBottom: 7 }}>
        <div style={{ fontSize: 12, fontWeight: 760, color: accent }}>{speaker}</div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{title}</div>
      </div>
      {children}
      <div style={{
        marginTop: 8,
        paddingTop: 7,
        borderTop: '1px solid var(--border)',
        fontSize: 10,
        color: 'var(--text-muted)',
      }}>
        {time.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })}
      </div>
    </article>
  )
}

const STARTER_OPTIONS = [
  {
    label: 'Create automation',
    description: '工作日自动搜索、评分，并按审批规则推进。',
    prompt: '创建一个工作日 09:00 的自动化任务，帮我搜索 Berlin 软件工程职位，85 分以上进入审批。',
  },
  {
    label: 'Review pending',
    description: '查看待审核职位，并给出批准、跳过或补充信息建议。',
    prompt: '审核当前待定职位，并按匹配度、风险和申请准备度给出建议。',
  },
  {
    label: 'Explain score',
    description: '解释最近高分职位为什么值得投，以及缺口在哪里。',
    prompt: '解释最近高分职位的评分依据、证据和简历缺口。',
  },
]

const bodyStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--text)',
  lineHeight: 1.7,
}

const optionButtonStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 42,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  border: '1px solid var(--border)',
  borderRadius: 7,
  background: 'var(--bg-secondary)',
  padding: '8px 10px',
  cursor: 'pointer',
  textAlign: 'left',
  fontFamily: 'inherit',
}
