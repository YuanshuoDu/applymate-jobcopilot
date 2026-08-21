import React from 'react'
import { LandingPage } from '@/components/landing/LandingPage'
import { getPublicPlans } from '@/lib/plan-catalogue'

export const dynamic = 'force-dynamic'

/**
 * Canonical public marketing entrypoint. Unlike `/`, this route stays public
 * even when a candidate already has an active session.
 */
export default async function Landing() {
  return <LandingPage plans={await getPublicPlans()} />
}
