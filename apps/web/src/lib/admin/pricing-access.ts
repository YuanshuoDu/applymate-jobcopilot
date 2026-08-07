import type { NextRequest } from 'next/server'
import { requireSettingsAdmin, type SettingsAdminActor } from './settings-access'

export type PricingAdminActor = SettingsAdminActor

/** Backward-compatible name for the shared deny-by-default admin guard. */
export function requirePricingAdmin(req?: NextRequest): Promise<PricingAdminActor | Response> {
  return requireSettingsAdmin(req)
}
