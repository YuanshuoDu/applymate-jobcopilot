import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { isAgentPreviewFixtureEnabled, isAgentPreviewRequestAllowed } from '@/lib/agent-preview-access'
import { AgentSupervisorPreviewClient } from './AgentSupervisorPreviewClient'

export default async function AgentPreviewPage({ searchParams }: { searchParams: Promise<{ supervisor?: string; locale?: string; applicationReview?: string }> }) {
  const requestHeaders = await headers()
  const hostHeader = requestHeaders.get('host')
  const environment = {
    NODE_ENV: process.env.NODE_ENV,
    AGENT_PREVIEW_FIXTURE: process.env.AGENT_PREVIEW_FIXTURE,
    VERCEL: process.env.VERCEL,
    VERCEL_ENV: process.env.VERCEL_ENV,
  }
  if (!isAgentPreviewFixtureEnabled(environment) ||
    !isAgentPreviewRequestAllowed({
      environment,
      hostname: hostHeader ?? '', hostHeader, forwardedHost: requestHeaders.get('x-forwarded-host'),
    })) notFound()
  const params = await searchParams

  return (
    <>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        body { margin: 0; }
      `}</style>
      <AgentSupervisorPreviewClient supervisorMode={params.supervisor === '1'} locale={params.locale === 'zh' ? 'zh' : undefined} seedApplicationReviewQueue={params.applicationReview === '1'} />
    </>
  )
}
