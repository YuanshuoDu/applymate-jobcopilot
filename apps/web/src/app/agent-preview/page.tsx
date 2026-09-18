import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { isAgentPreviewFixtureEnabled, isAgentPreviewRequestAllowed } from '@/lib/agent-preview-access'
import { AgentSupervisorPreviewClient } from './AgentSupervisorPreviewClient'

export default async function AgentPreviewPage({ searchParams }: { searchParams: Promise<{ supervisor?: string; locale?: string }> }) {
  const requestHeaders = await headers()
  const hostHeader = requestHeaders.get('host')
  if (!isAgentPreviewFixtureEnabled({ NODE_ENV: process.env.NODE_ENV, AGENT_PREVIEW_FIXTURE: process.env.AGENT_PREVIEW_FIXTURE }) ||
    !isAgentPreviewRequestAllowed({
      environment: { NODE_ENV: process.env.NODE_ENV, AGENT_PREVIEW_FIXTURE: process.env.AGENT_PREVIEW_FIXTURE },
      hostname: hostHeader ?? '', hostHeader, forwardedHost: requestHeaders.get('x-forwarded-host'),
    })) notFound()
  const params = await searchParams

  return (
    <>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        body { margin: 0; }
      `}</style>
      <AgentSupervisorPreviewClient supervisorMode={params.supervisor === '1'} locale={params.locale === 'zh' ? 'zh' : undefined} />
    </>
  )
}
