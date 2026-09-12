'use client'

import React from 'react'
import { SessionProvider } from 'next-auth/react'

import { AgentPlaygroundPage } from '@/components/pages/AgentPlaygroundPage'
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
export function AgentSupervisorPreviewClient({ supervisorMode = false, locale }: { supervisorMode?: boolean; locale?: Lang }) {
  if (!supervisorMode) return <AgentPreviewClient />

  return (
    <SessionProvider session={previewSession}>
      <I18nProvider>
        <PreviewLocale locale={locale}>
          <AgentPlaygroundPage />
        </PreviewLocale>
      </I18nProvider>
    </SessionProvider>
  )
}

function PreviewLocale({ locale, children }: { locale?: Lang; children: React.ReactNode }) {
  const { setLang } = useI18n()

  React.useEffect(() => {
    if (locale) setLang(locale)
  }, [locale, setLang])

  return <>{children}</>
}
