'use client'

import React, { useState } from 'react'
import { Btn, useToast } from '@/components/ui'
import { MODEL_CATALOGUE, PROVIDER_LABELS } from '@/lib/model-router'

export interface CustomAgentRow {
  id: string
  name: string
  icon: string
  description: string | null
  systemPrompt: string | null
  provider: string
  model: string
  insertAfter: string
  enabled: boolean
}

const BUILTIN_STAGE_KEYS = ['scout', 'analyst', 'writer', 'reviewer', 'executor', 'auditor']
const EMOJI_OPTIONS = ['🧩', '🔬', '📌', '🛡', '⚡', '🎯', '🔧', '📊', '🧠', '💡', '🔗', '📋']

function ModelSelect({ provider, model, onChange }: {
  provider: string
  model: string
  onChange: (provider: string, model: string) => void
}) {
  const byProvider = MODEL_CATALOGUE.reduce<Record<string, typeof MODEL_CATALOGUE>>((acc, item) => {
    if (!acc[item.provider]) acc[item.provider] = []
    acc[item.provider].push(item)
    return acc
  }, {})

  return (
    <select
      value={`${provider}::${model}`}
      onChange={event => {
        const [nextProvider, nextModel] = event.target.value.split('::')
        onChange(nextProvider, nextModel)
      }}
      onClick={event => event.stopPropagation()}
      style={{
        fontSize: 10,
        padding: '2px 5px',
        border: '0.5px solid var(--border)',
        borderRadius: 4,
        background: 'var(--bg)',
        color: 'var(--text)',
        outline: 'none',
        maxWidth: 170,
        cursor: 'pointer',
      }}
    >
      {Object.entries(byProvider).map(([providerKey, models]) => (
        <optgroup key={providerKey} label={PROVIDER_LABELS[providerKey as keyof typeof PROVIDER_LABELS] ?? providerKey}>
          {models.map(item => (
            <option key={`${item.provider}::${item.model}`} value={`${item.provider}::${item.model}`}>
              {item.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}

export function AddAgentModal({ onClose, onCreated }: {
  onClose: () => void
  onCreated: (agent: CustomAgentRow) => void
}) {
  const toast = useToast()
  const [name, setName] = useState('')
  const [icon, setIcon] = useState('🧩')
  const [description, setDescription] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [provider, setProvider] = useState('anthropic')
  const [model, setModel] = useState('claude-haiku-4-5-20251001')
  const [insertAfter, setInsertAfter] = useState('auditor')
  const [saving, setSaving] = useState(false)

  async function handleCreate() {
    if (!name.trim()) {
      toast.error('请填写名称', '')
      return
    }

    setSaving(true)
    try {
      const res = await fetch('/api/agent/roles/custom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, icon, description, systemPrompt, provider, model, insertAfter }),
      })

      if (!res.ok) {
        toast.error('创建失败', await res.text())
        return
      }

      const data = await res.json()
      onCreated(data.data ?? data)
      toast.success('自定义 Agent 已创建', `「${name}」将在 ${insertAfter} 阶段后运行`)
      onClose()
    } catch (error) {
      toast.error('创建失败', (error as Error).message || 'Network request failed.')
    } finally {
      setSaving(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '7px 10px',
    fontSize: 12,
    border: '0.5px solid var(--border)',
    borderRadius: 6,
    background: 'var(--bg)',
    color: 'var(--text)',
    outline: 'none',
    boxSizing: 'border-box',
    fontFamily: 'inherit',
  }

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      zIndex: 500,
      background: 'rgba(0,0,0,0.5)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }} onClick={onClose}>
      <div style={{
        background: 'var(--bg)',
        border: '0.5px solid var(--border)',
        borderRadius: 14,
        width: 480,
        maxWidth: '95vw',
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
        overflow: 'hidden',
      }} onClick={event => event.stopPropagation()}>
        <div style={{ padding: '14px 18px', background: 'var(--bg-secondary)', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>＋ 添加自定义 Agent</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: 'var(--text-muted)' }}>✕</button>
        </div>

        <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 5 }}>图标</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, width: 110 }}>
                {EMOJI_OPTIONS.map(option => (
                  <button key={option} onClick={() => setIcon(option)} style={{
                    width: 28,
                    height: 28,
                    borderRadius: 6,
                    border: icon === option ? '2px solid var(--primary)' : '0.5px solid var(--border)',
                    background: icon === option ? 'rgba(79,70,229,0.1)' : 'var(--bg-secondary)',
                    cursor: 'pointer',
                    fontSize: 14,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}>
                    {option}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 5 }}>名称 *</div>
              <input value={name} onChange={event => setName(event.target.value)} placeholder="例如：Remote Filter" style={inputStyle} autoFocus />
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 8, marginBottom: 5 }}>描述（可选）</div>
              <input value={description} onChange={event => setDescription(event.target.value)} placeholder="简短说明此 Agent 的职责" style={inputStyle} />
            </div>
          </div>

          <div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 5 }}>System Prompt（告诉 Agent 怎么分析）</div>
            <textarea
              value={systemPrompt}
              onChange={event => setSystemPrompt(event.target.value)}
              placeholder={'例如：\n你是一个远程工作过滤专家。对于每个职位，判断它是否支持远程工作。\n如果不支持，说明原因。'}
              rows={4}
              style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.6 }}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 5 }}>AI 模型</div>
              <ModelSelect provider={provider} model={model} onChange={(nextProvider, nextModel) => { setProvider(nextProvider); setModel(nextModel) }} />
            </div>
            <div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 5 }}>插入在哪个阶段之后</div>
              <select value={insertAfter} onChange={event => setInsertAfter(event.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
                {BUILTIN_STAGE_KEYS.map(key => (
                  <option key={key} value={key}>{key}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div style={{ padding: '12px 18px', borderTop: '0.5px solid var(--border)', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" onClick={onClose}>取消</Btn>
          <Btn variant="primary" onClick={handleCreate} disabled={saving || !name.trim()}>
            {saving ? '创建中…' : '✓ 创建 Agent'}
          </Btn>
        </div>
      </div>
    </div>
  )
}
