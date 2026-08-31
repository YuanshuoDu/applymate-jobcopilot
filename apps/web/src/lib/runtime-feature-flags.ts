import {
  evaluateAgentHarnessFeature,
  evaluateManagedFeature,
  platformEnvironment,
  type AgentHarnessFeatureKey,
  type ManagedFeatureKey,
  type PlatformEnvironment,
} from '@jobcopilot/shared/feature-flags'
import { db } from '@/lib/db'

export async function isRuntimeFeatureEnabled(
  key: ManagedFeatureKey,
  userId: string,
  environment: PlatformEnvironment = platformEnvironment(process.env),
): Promise<boolean> {
  try {
    const [user, flag] = await Promise.all([
      db.user.findUnique({ where: { id: userId }, select: { plan: true } }),
      db.platformFeatureFlag.findUnique({
        where: { key_environment: { key, environment } },
        select: { enabled: true, rolloutPercent: true, targetPlans: true, targetUserIds: true, status: true, rollbackAt: true },
      }),
    ])
    return evaluateManagedFeature(key, {
      environment,
      userId,
      plan: user?.plan ?? null,
      flag,
    })
  } catch (error) {
    if (isMissingFeatureFlagTable(error)) {
      return evaluateManagedFeature(key, { environment, userId, plan: null, flag: null })
    }
    throw error
  }
}

export async function isRuntimeAgentHarnessFeatureEnabled(
  key: AgentHarnessFeatureKey,
  userId: string,
  environment: PlatformEnvironment = platformEnvironment(process.env),
): Promise<boolean> {
  try {
    const [user, flag] = await Promise.all([
      db.user.findUnique({ where: { id: userId }, select: { plan: true } }),
      db.platformFeatureFlag.findUnique({
        where: { key_environment: { key, environment } },
        select: { enabled: true, rolloutPercent: true, targetPlans: true, targetUserIds: true, status: true, rollbackAt: true },
      }),
    ])
    return evaluateAgentHarnessFeature(key, {
      environment,
      userId,
      plan: user?.plan ?? null,
      flag,
    })
  } catch (error) {
    if (isMissingFeatureFlagTable(error)) {
      return evaluateAgentHarnessFeature(key, { environment, userId, plan: null, flag: null })
    }
    throw error
  }
}

function isMissingFeatureFlagTable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2021'
}
