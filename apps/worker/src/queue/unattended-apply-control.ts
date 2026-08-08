import type { Pool } from 'pg'
import { canUseAtsSource, loadEffectiveAtsPolicy } from '../admin/ats-policy.js'
import { isWorkerFeatureEnabled } from '../admin/runtime-feature-flags.js'
import { detectFlow, type FlowType } from '../flows/index.js'

export const UNATTENDED_APPLY_UNAVAILABLE_MESSAGE =
  'Unattended applications are temporarily unavailable. Please continue manually.'

export type UnattendedApplyControl = {
  allowed: boolean
  flow: FlowType
  message: string | null
}

/** Checks all controls that must pass before an unattended browser is opened. */
export async function evaluateUnattendedApplyControl(
  pool: Pick<Pool, 'query'>,
  applyUrl: string,
  userId: string,
): Promise<UnattendedApplyControl> {
  const flow = detectFlow(applyUrl)
  try {
    if (!await isWorkerFeatureEnabled(pool, 'unattended_apply', userId)) return unavailable(flow)
    if (!flow) return { allowed: true, flow, message: null }

    const policy = await loadEffectiveAtsPolicy(pool, flow)
    return canUseAtsSource(policy, userId, 'auto_apply')
      ? { allowed: true, flow, message: null }
      : unavailable(flow)
  } catch (error) {
    console.warn('[apply-worker] Unattended apply control unavailable', {
      flow,
      error: error instanceof Error ? error.message : String(error),
    })
    return unavailable(flow)
  }
}

function unavailable(flow: FlowType): UnattendedApplyControl {
  return { allowed: false, flow, message: UNATTENDED_APPLY_UNAVAILABLE_MESSAGE }
}
