'use client'

import React from 'react'
import { SessionProvider } from 'next-auth/react'

import { AgentPlaygroundPage } from '@/components/pages/AgentPlaygroundPage'
import { SettingsPage } from '@/components/pages/SettingsPage'
import { I18nProvider, useI18n, type Lang } from '@/lib/i18n'

import { AgentPreviewClient } from './AgentPreviewClient'

const previewSession = {
  user: {
    id: 'agent-supervisor-fixture',
    email: 'agent-supervisor-fixture@applymate.local',
    name: 'Agent Supervisor Fixture',
    plan: 'pro' as const,
  },
  expires: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
}

/** Dev-only browser fixture for the real Agent page and V2 supervisor panel. */
export function AgentSupervisorPreviewClient({ supervisorMode = false, settingsMode = false, locale, seedApplicationReviewQueue = false }: { supervisorMode?: boolean; settingsMode?: boolean; locale?: Lang; seedApplicationReviewQueue?: boolean }) {
  if (!supervisorMode && !settingsMode) return <AgentPreviewClient />

  const content = (
    <I18nProvider>
      <PreviewLocale locale={locale}>
        {settingsMode ? <SettingsPage /> : <AgentPlaygroundPage seedApplicationReviewQueue={seedApplicationReviewQueue} />}
      </PreviewLocale>
    </I18nProvider>
  )

  // Settings exercises the root provider so browser fixtures can observe session changes.
  return settingsMode ? content : <SessionProvider session={previewSession}>{content}</SessionProvider>
}

function PreviewLocale({ locale, children }: { locale?: Lang; children: React.ReactNode }) {
  const { setLang } = useI18n()
  const [ready, setReady] = React.useState(false)

  React.useEffect(() => {
    setLang(locale ?? 'en')
    setReady(true)
  }, [locale, setLang])

  // Fixture locale must be deterministic even when another preview saved a different language.
  return <div style={{ display: 'flex', height: '100dvh', minWidth: 0, minHeight: 0, overflow: 'hidden' }}>{ready ? children : null}</div>
}
