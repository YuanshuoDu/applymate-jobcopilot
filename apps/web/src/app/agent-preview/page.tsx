import { notFound } from 'next/navigation'
import { AgentPreviewClient } from './AgentPreviewClient'

export default function AgentPreviewPage() {
  if (process.env.NODE_ENV !== 'development') notFound()

  return (
    <>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        body { margin: 0; }
      `}</style>
      <AgentPreviewClient />
    </>
  )
}
