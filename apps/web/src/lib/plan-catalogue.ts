import { db } from '@/lib/db'
import {
  DEFAULT_PLAN_CATALOGUE,
  normalizePlanRow,
  toPublicPlan,
  type PlanCatalogueRecord,
  type PublicPlan,
} from './plan-catalogue-shared'

function ordered(rows: PlanCatalogueRecord[]): PlanCatalogueRecord[] {
  return rows.sort((left, right) => left.sortOrder - right.sortOrder || left.key.localeCompare(right.key))
}

export async function getPlanCatalogue(includeInactive = false): Promise<PlanCatalogueRecord[]> {
  const rows = await db.planCatalogue.findMany({
    where: includeInactive ? undefined : { active: true },
    orderBy: [{ sortOrder: 'asc' }, { plan: 'asc' }],
  })
  if (rows.length === 0) return DEFAULT_PLAN_CATALOGUE.map(plan => ({ ...plan, features: [...plan.features], entitlements: [...plan.entitlements] }))
  return ordered(rows.map(row => normalizePlanRow(row)))
}

export async function getPublicPlans(): Promise<PublicPlan[]> {
  try {
    const plans = await getPlanCatalogue(false)
    return plans.map(toPublicPlan)
  } catch {
    // The landing page must remain usable during a first boot or a transient
    // database outage; the catalogue defaults are the documented fallback.
    return DEFAULT_PLAN_CATALOGUE.filter(plan => plan.active).map(toPublicPlan)
  }
}

export async function getAdminPlans(): Promise<PlanCatalogueRecord[]> {
  return getPlanCatalogue(true)
}
