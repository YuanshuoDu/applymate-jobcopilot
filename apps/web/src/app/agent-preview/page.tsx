import { notFound } from 'next/navigation'
import { AgentSupervisorPreviewClient } from './AgentSupervisorPreviewClient'

export default async function AgentPreviewPage({ searchParams }: { searchParams: Promise<{ supervisor?: string; locale?: string }> }) {
  if (process.env.NODE_ENV !== 'development') notFound()
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
