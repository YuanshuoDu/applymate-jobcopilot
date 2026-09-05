import { NextResponse } from 'next/server'
import { recordLegacyTraffic } from '@/lib/observability/legacy-counter'

const CANONICAL_MESSAGE_ROUTE = '/api/agent/sessions/:id/messages'

/**
 * The text chat protocol was retired in AH2-047. Keeping a typed response at
 * this URL gives old clients a deterministic migration target without running
 * any model work or mutating a session.
 */
export async function POST() {
  recordLegacyTraffic('agent_chat_endpoint')
  return NextResponse.json({
    error: {
      code: 'agent_chat_route_retired',
      message: 'Agent chat is now handled by the canonical Session message command.',
    },
    link: {
      rel: 'canonical',
      method: 'POST',
      href: CANONICAL_MESSAGE_ROUTE,
    },
  }, {
    status: 410,
    headers: { 'Cache-Control': 'no-store' },
  })
}
