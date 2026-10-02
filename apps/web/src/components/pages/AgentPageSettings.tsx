'use client'

import React, { useState } from 'react'
import { Card } from '@/components/ui'
import { APPLYMATE_BACKING, MODEL_CATALOGUE, PROVIDER_LABELS } from '@/lib/model-router-client'
import { useI18n } from '@/lib/i18n'

function Toggle({ value, onChange, label, sub, disabled = false }: { value: boolean; onChange: (v: boolean) => void; label: string; sub?: string; disabled?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderBottom: '0.5px solid var(--border)' }}>
      <div>
        <div style={{ fontSize: 12, color: 'var(--text)' }}>{label}</div>
        {sub && <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>}
      </div>
      <button type="button" role="switch" aria-label={label} aria-checked={value} disabled={disabled} onClick={() => onChange(!value)} style={{ width: 32, height: 18, border: 0, padding: 0, borderRadius: 9, background: value ? 'var(--primary)' : 'var(--border)', cursor: disabled ? 'not-allowed' : 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0, opacity: disabled ? 0.55 : 1 }}>
        <div style={{ width: 14, height: 14, borderRadius: '50%', background: '#fff', position: 'absolute', top: 2, left: value ? 16 : 2, transition: 'left 0.2s' }} />
      </button>
    </div>
  )
}

function SliderRow({ label, value, min, max, step = 1, onChange, unit = '' }: {
  label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; unit?: string
}) {
  return (
    <div style={{ padding: '10px 0', borderBottom: '0.5px solid var(--border)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontSize: 12, color: 'var(--text)' }}>{label}</span>
        <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--primary)' }}>{value}{unit}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))}
        style={{ width: '100%', accentColor: 'var(--primary)', cursor: 'pointer' }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
        <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>{min}{unit}</span>
        <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>{max}{unit}</span>
      </div>
    </div>
  )
}

function ConfigCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '12px 14px', borderBottom: '0.5px solid var(--border)', background: 'var(--bg-secondary)' }}>
        <span style={{ fontSize: 12, fontWeight: 500 }}>{title}</span>
      </div>
      <div style={{ padding: '0 14px 4px' }}>{children}</div>
    </Card>
  )
}

function PillInput({ values, onChange, placeholder }: { values: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const [input, setInput] = useState('')
  function add() {
    if (input.trim()) { onChange([...values, input.trim()]); setInput('') }
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '6px 0' }}>
      {values.map((v, i) => (
        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'rgba(79,70,229,0.10)', color: 'var(--primary)', borderRadius: 999, padding: '2px 8px', fontSize: 11 }}>
          {v}
          <button onClick={() => onChange(values.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--primary)', fontSize: 11, padding: 0 }}>✕</button>
        </span>
      ))}
      <input value={input} onChange={e => setInput(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add() } }}
        placeholder={placeholder}
        style={{ border: 'none', outline: 'none', fontSize: 11, color: 'var(--text)', background: 'transparent', minWidth: 120, padding: '2px 4px' }} />
    </div>
  )
}

// ── Model selector (from ModelRouter catalogue) ───────────────────────────────

function ModelSelector({ value, onChange }: {
  value: { provider: string; model: string }
  onChange: (v: { provider: string; model: string }) => void
}) {
  const { t } = useI18n()
  const byProvider = MODEL_CATALOGUE.filter(m => m.provider !== 'custom').reduce<Record<string, typeof MODEL_CATALOGUE>>((acc, m) => {
    if (!acc[m.provider]) acc[m.provider] = []
    acc[m.provider].push(m)
    return acc
  }, {})

  return (
    <select
      value={`${value.provider}::${value.model}`}
      onChange={e => {
        const [provider, model] = e.target.value.split('::')
        onChange({ provider, model })
      }}
      style={{ fontSize: 11, padding: '3px 6px', border: '0.5px solid var(--border)', borderRadius: 5, background: 'var(--bg)', color: 'var(--text)', outline: 'none' }}
    >
      {value.provider === 'custom' && (
        <option value={`${value.provider}::${value.model}`}>{t('agent.customEdit')}</option>
      )}
      {Object.entries(byProvider).map(([provider, models]) => (
        <optgroup key={provider} label={PROVIDER_LABELS[provider as keyof typeof PROVIDER_LABELS] ?? provider}>
          {models.map(m => (
            <option key={`${m.provider}::${m.model}`} value={`${m.provider}::${m.model}`}>
              {m.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}

export type UiCfg = {
  minScore:          number
  maxPerDay:         number
  autoApply:         boolean
  requireReview:     boolean
  autoCoverLetter:   boolean
  coverTone:         string
  useTailoredCV:     boolean
  notifyApply:       boolean
  notifyReject:      boolean
  weeklySummary:     boolean
  followUpReminder:  boolean
  followUpDays:      number
  targetRoles:       string[]
  targetLocations:   string[]
  excludeCompanies:  string[]
  priorityCompanies: string[]
  salaryMin:         number
  salaryMax:         number
  aiProvider:        string
  aiModel:           string
  aiApiKey:          string
}

export const DEFAULT_CFG: UiCfg = {
  minScore: 70, maxPerDay: 10,
  autoApply: false, requireReview: true,
  autoCoverLetter: false, coverTone: 'professional', useTailoredCV: false,
  notifyApply: true, notifyReject: true, weeklySummary: false, followUpReminder: true,
  followUpDays: 7,
  targetRoles: [], targetLocations: [], excludeCompanies: [], priorityCompanies: [],
  salaryMin: 55000, salaryMax: 90000,
  aiProvider: APPLYMATE_BACKING.provider, aiModel: APPLYMATE_BACKING.model, aiApiKey: '',
}

export function AgentConfigGrid({ cfg, set }: {
  readonly cfg: UiCfg
  readonly set: <K extends keyof UiCfg>(key: K, value: UiCfg[K]) => void
}) {
  const { t } = useI18n()
  return (
    <>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <ConfigCard title={t('agent.jobMatchingRules')}>
              <SliderRow label={t('agent.minMatchScore')} value={cfg.minScore} min={40} max={100} onChange={v => set('minScore', v)} unit="%" />
              <div style={{ padding: '10px 0', borderBottom: '0.5px solid var(--border)' }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>{t('agent.targetRoles')}</div>
                <PillInput values={cfg.targetRoles} onChange={v => set('targetRoles', v)} placeholder={t('agent.addRole')} />
              </div>
              <div style={{ padding: '10px 0', borderBottom: '0.5px solid var(--border)' }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>{t('agent.targetLocations')}</div>
                <PillInput values={cfg.targetLocations} onChange={v => set('targetLocations', v)} placeholder={t('agent.addLocation')} />
              </div>
              <SliderRow label={t('agent.minSalary')} value={cfg.salaryMin} min={20000} max={150000} step={5000} onChange={v => set('salaryMin', v)} unit="€" />
              <SliderRow label={t('agent.maxSalary')} value={cfg.salaryMax} min={20000} max={150000} step={5000} onChange={v => set('salaryMax', v)} unit="€" />
            </ConfigCard>

            <ConfigCard title={t('agent.applicationLimits')}>
              <div style={{ padding: '10px 0', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 12 }}>{t('agent.maxApplications')}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <button onClick={() => set('maxPerDay', Math.max(1, cfg.maxPerDay - 1))} style={{ width: 24, height: 24, borderRadius: 4, border: '0.5px solid var(--border)', background: 'var(--bg-secondary)', cursor: 'pointer', fontSize: 14 }}>−</button>
                  <span style={{ fontSize: 13, fontWeight: 500, minWidth: 24, textAlign: 'center' }}>{cfg.maxPerDay}</span>
                  <button onClick={() => set('maxPerDay', Math.min(50, cfg.maxPerDay + 1))} style={{ width: 24, height: 24, borderRadius: 4, border: '0.5px solid var(--border)', background: 'var(--bg-secondary)', cursor: 'pointer', fontSize: 14 }}>+</button>
                </div>
              </div>
              <Toggle label={t('agent.skipProcessed')} sub={t('agent.deduplication')} value={true} onChange={() => undefined} disabled />
            </ConfigCard>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <ConfigCard title={t('agent.settings')}>
              <Toggle label={t('agent.autoPrepare')} sub={t('agent.autoPrepareHint')} value={cfg.autoApply} onChange={v => set('autoApply', v)} />
              <Toggle label={t('agent.finalAuthorization')} sub={t('agent.finalAuthorizationHint')} value={true} onChange={() => undefined} disabled />
              <Toggle label={t('agent.autoCoverLetter')} sub={t('agent.coverLetterHint')} value={cfg.autoCoverLetter} onChange={v => set('autoCoverLetter', v)} />
              {cfg.autoCoverLetter && (
                <div style={{ padding: '10px 0', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 12 }}>{t('agent.coverTone')}</span>
                  <select value={cfg.coverTone} onChange={e => set('coverTone', e.target.value)}
                    style={{ fontSize: 11, padding: '3px 6px', border: '0.5px solid var(--border)', borderRadius: 5, background: 'var(--bg)', color: 'var(--text)', outline: 'none' }}>
                    <option value="professional">{t('agent.professional')}</option>
                    <option value="confident">{t('agent.confident')}</option>
                    <option value="concise">{t('agent.concise')}</option>
                  </select>
                </div>
              )}
              <Toggle label={t('agent.tailoredCv')} sub={t('agent.tailoredCvHint')} value={cfg.useTailoredCV} onChange={v => set('useTailoredCV', v)} />
            </ConfigCard>

            <ConfigCard title={t('agent.notifications')}>
              <Toggle label={t('agent.notifyApply')} value={cfg.notifyApply} onChange={v => set('notifyApply', v)} />
              <Toggle label={t('agent.notifyReject')} value={cfg.notifyReject} onChange={v => set('notifyReject', v)} />
              <Toggle label={t('agent.weeklySummary')} value={cfg.weeklySummary} onChange={v => set('weeklySummary', v)} />
              <Toggle label={t('agent.followUpReminders')} value={cfg.followUpReminder} onChange={v => set('followUpReminder', v)} />
              {cfg.followUpReminder && (
                <div style={{ padding: '8px 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t('agent.remindAfter')}</span>
                  <input type="number" value={cfg.followUpDays} min={1} max={30} onChange={e => set('followUpDays', Number(e.target.value))}
                    style={{ width: 48, padding: '3px 6px', fontSize: 11, border: '0.5px solid var(--border)', borderRadius: 5, background: 'var(--bg)', color: 'var(--text)', outline: 'none' }} />
                </div>
              )}
            </ConfigCard>

            <ConfigCard title={t('agent.aiModel')}>
              <div style={{ padding: '10px 0', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 12 }}>{t('agent.activeModel')}</span>
                <ModelSelector
                  value={{ provider: cfg.aiProvider, model: cfg.aiModel }}
                  onChange={v => { set('aiProvider', v.provider); set('aiModel', v.model) }}
                />
              </div>
              <div style={{ padding: '8px 0' }}>
                <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{t('agent.apiKeyOptional')}</div>
                <input type="password" value={cfg.aiApiKey} onChange={e => set('aiApiKey', e.target.value)} placeholder="sk-…"
                  style={{ width: '100%', marginTop: 4, padding: '5px 8px', fontSize: 11, border: '0.5px solid var(--border)', borderRadius: 5, background: 'var(--bg)', color: 'var(--text)', outline: 'none', boxSizing: 'border-box' }} />
              </div>
            </ConfigCard>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <ConfigCard title={t('agent.companiesAvoid')}>
            <div style={{ padding: '10px 0' }}>
              <PillInput values={cfg.excludeCompanies} onChange={v => set('excludeCompanies', v)} placeholder={t('agent.addCompany')} />
            </div>
          </ConfigCard>
          <ConfigCard title={t('agent.priorityCompanies')}>
            <div style={{ padding: '10px 0' }}>
              <PillInput values={cfg.priorityCompanies} onChange={v => set('priorityCompanies', v)} placeholder={t('agent.addCompany')} />
            </div>
          </ConfigCard>
        </div>
    </>
  )
}
