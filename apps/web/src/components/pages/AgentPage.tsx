'use client'

import React, { useState, useEffect } from 'react'
import { TopBar } from '@/components/layout/TopBar'
import { Btn, Card, useToast } from '@/components/ui'
import type { AgentConfig, Activity, NotificationPreferences, UserProfile } from '@/lib/types'
import { useApi, apiMutate } from '@/lib/hooks'
import { APPLYMATE_BACKING, type AiConfig, type UserAiSettings } from '@/lib/model-router-client'
import { readNotificationPreferences } from '@/lib/settings-preferences'
import { useI18n } from '@/lib/i18n'
import { AgentConfigGrid, DEFAULT_CFG, type UiCfg } from './AgentPageSettings'
export function AgentPage() {
  const { t } = useI18n()
  const toast = useToast()

  const { data: agentData, loading: agentLoading } = useApi<AgentConfig>('/api/agent')
  const { data: profileData } = useApi<UserProfile>('/api/me')
  const { data: aiData } = useApi<UserAiSettings>('/api/me/ai-config')
  const { data: activityData } = useApi<Activity[]>('/api/activity?limit=20')

  const [running,      setRunning]      = useState(false)
  const [cfg,          setCfg]          = useState<UiCfg>(DEFAULT_CFG)
  const [saving,       setSaving]       = useState(false)

  useEffect(() => {
    if (!agentData) return
    setRunning(agentData.isRunning)
    setCfg(prev => ({
      ...prev,
      minScore:          agentData.minMatchScore,
      maxPerDay:         agentData.dailyLimit,
      autoApply:         agentData.autoApply,
      requireReview:     agentData.requireApproval,
      autoCoverLetter:   (agentData as any).autoCoverLetter  ?? false,
      coverTone:         (agentData as any).coverTone        ?? 'professional',
      useTailoredCV:     (agentData as any).useTailoredCV    ?? false,
      salaryMin:         agentData.salaryMin                  ?? 55000,
      salaryMax:         agentData.salaryMax                  ?? 90000,
      targetRoles:       agentData.targetRoles               ?? [],
      targetLocations:   agentData.targetLocations           ?? [],
      excludeCompanies:  agentData.excludeCompanies          ?? [],
      priorityCompanies: (agentData as any).priorityCompanies ?? [],
      ...(aiData ? (() => {
        const configured = aiData.features?.agent ?? aiData.features?.autoApply ?? APPLYMATE_BACKING
        return { aiProvider: configured.provider, aiModel: configured.model }
      })() : {}),
      ...(profileData?.preferences ? (() => {
        const preferences = readNotificationPreferences(profileData.preferences)
        return {
          notifyApply: preferences.apply,
          notifyReject: preferences.reject,
          weeklySummary: preferences.weekly,
          followUpReminder: preferences.followUp,
        }
      })() : {}),
    }))
  }, [agentData, profileData, aiData])

  function set<K extends keyof UiCfg>(k: K, v: UiCfg[K]) {
    setCfg(c => ({ ...c, [k]: v }))
  }

  async function toggleRunning() {
    const next = !running
    setRunning(next)
    const { error } = await apiMutate('/api/agent', 'PATCH', { isRunning: next })
    if (error) {
      setRunning(!next)
      toast.error('Error', error)
    } else {
      if (next) toast.success('Agent resumed', 'Scanning for new matches')
      else      toast.warning('Agent paused', 'No more auto-actions until resumed')
    }
  }

  async function saveConfig() {
    setSaving(true)

    // Save agent config
    const { error: agentError } = await apiMutate('/api/agent', 'PATCH', {
      isRunning:         running,
      dailyLimit:        cfg.maxPerDay,
      minMatchScore:     cfg.minScore,
      autoApply:         cfg.autoApply,
      requireApproval:   cfg.requireReview,
      targetLocations:   cfg.targetLocations,
      targetRoles:       cfg.targetRoles,
      excludeCompanies:  cfg.excludeCompanies,
      priorityCompanies: cfg.priorityCompanies,
      autoCoverLetter:   cfg.autoCoverLetter,
      coverTone:         cfg.coverTone,
      useTailoredCV:     cfg.useTailoredCV,
      salaryMin:         cfg.salaryMin,
      salaryMax:         cfg.salaryMax,
      // Compatibility mirror for older workers. The shared User preference
      // below remains the source of truth for notification delivery.
      notifyApply:       cfg.notifyApply,
      notifyReject:      cfg.notifyReject,
      weeklySummary:     cfg.weeklySummary,
      followUpReminder:  cfg.followUpReminder,
      followUpDays:      cfg.followUpDays,
      model:             `${cfg.aiProvider}/${cfg.aiModel}`,
    })

    let preferencesError: string | null = null
    if (!agentError) {
      const notificationPreferences: NotificationPreferences = {
        apply: cfg.notifyApply,
        reject: cfg.notifyReject,
        interview: readNotificationPreferences(profileData?.preferences).interview,
        offer: readNotificationPreferences(profileData?.preferences).offer,
        weekly: cfg.weeklySummary,
        followUp: cfg.followUpReminder,
      }
      const result = await apiMutate('/api/me', 'PATCH', { preferences: { notificationPreferences } })
      preferencesError = result.error
    }

    // Save AI config to user preferences
    let aiError: string | null = null
    if (!agentError && cfg.aiProvider && cfg.aiModel) {
      const aiConfig: Partial<AiConfig> = {
        provider: cfg.aiProvider as AiConfig['provider'],
        model:    cfg.aiModel,
        ...(cfg.aiProvider === 'custom' && (aiData?.features?.agent?.apiBase ?? aiData?.features?.autoApply?.apiBase)
          ? { apiBase: aiData.features.agent?.apiBase ?? aiData.features.autoApply?.apiBase }
          : {}),
        ...(cfg.aiApiKey.trim() ? { apiKey: cfg.aiApiKey.trim() } : {}),
      }
      aiError = (await apiMutate('/api/me/ai-config', 'POST', aiConfig)).error
    }

    setSaving(false)
    const error = agentError ?? preferencesError ?? aiError
    if (error) toast.error('Error', error)
    else       toast.success('Settings saved', 'Agent will use updated configuration')
  }

  const activities = activityData ?? []

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: 'var(--bg-tertiary)', display: 'flex', flexDirection: 'column' }}>
      <TopBar title={t('agent.title')}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: running ? 'var(--c-success)' : 'var(--text-muted)', boxShadow: running ? '0 0 6px var(--c-success)' : 'none' }} />
          <span style={{ fontSize: 11, color: running ? 'var(--c-success)' : 'var(--text-muted)', fontWeight: 500 }}>
            {running ? t('agent.running') : t('agent.paused')}
          </span>
        </div>
        <Btn variant={running ? 'danger' : 'primary'} onClick={toggleRunning}>
          {running ? `⏸ ${t('agent.pause')}` : `▶ ${t('agent.resume')}`}
        </Btn>
      </TopBar>

      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* Status card */}
        <Card style={{ padding: 16 }}>
          {agentLoading ? (
            <div style={{ textAlign: 'center', padding: '16px 0', fontSize: 12, color: 'var(--text-muted)' }}>{t('agent.loading')}</div>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 0, marginBottom: 14 }}>
                {[
                  { label: 'Daily limit',   value: String(cfg.maxPerDay) },
                  { label: 'Min score',     value: `${cfg.minScore}%` },
                  { label: 'Auto-prepare',  value: cfg.autoApply ? 'On' : 'Off' },
                  { label: 'Cover letter',  value: cfg.autoCoverLetter ? 'On' : 'Off' },
                ].map((s, i) => (
                  <div key={s.label} style={{ textAlign: 'center', padding: '0 16px', borderRight: i < 3 ? '0.5px solid var(--border)' : 'none' }}>
                    <div style={{ fontSize: 20, fontWeight: 500, color: 'var(--text)' }}>{s.value}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{s.label}</div>
                  </div>
                ))}
              </div>

              <div style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t('agent.minScore')}</span>
                  <span style={{ fontSize: 11, fontWeight: 500 }}>{cfg.minScore}%</span>
                </div>
                <div style={{ height: 6, background: 'var(--bg-tertiary)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ width: `${cfg.minScore}%`, height: '100%', background: 'linear-gradient(90deg, var(--primary), var(--accent))', borderRadius: 3, transition: 'width 0.3s' }} />
                </div>
              </div>

              {/* Activity log */}
              <div style={{ background: 'var(--bg-secondary)', borderRadius: 6, padding: 10, maxHeight: 140, overflowY: 'auto' }}>
                {activities.length === 0 ? (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', padding: '8px 0' }}>{t('agent.noActivity')}</div>
                ) : activities.map(a => (
                  <div key={a.id} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                      {new Date(a.createdAt).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <span style={{ fontSize: 11, color: a.color ?? 'var(--text)' }}>{a.text}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>

        <AgentConfigGrid cfg={cfg} set={set} />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', paddingBottom: 8 }}>
          <Btn variant="ghost" onClick={() => { setCfg(DEFAULT_CFG); toast.info(t('agent.reset'), t('agent.resetDetail')) }}>{t('agent.resetDefaults')}</Btn>
          <Btn variant="primary" onClick={saveConfig} disabled={saving}>
            {saving ? t('common.saving') : t('agent.saveChanges')}
          </Btn>
        </div>
      </div>
    </div>
  )
}
