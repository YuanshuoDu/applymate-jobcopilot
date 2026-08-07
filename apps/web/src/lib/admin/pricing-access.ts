import type { NextRequest } from 'next/server'
import { requireAdmin, type AdminActor } from './authorization'

export type PricingAdminActor = AdminActor

export function requirePricingReadAdmin(req?: NextRequest) {
  return requireAdmin('billing.read', req)
}

export function requirePricingWriteAdmin(req?: NextRequest) {
  return requireAdmin('billing.update', req)
}
