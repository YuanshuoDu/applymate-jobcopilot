import { getAgentHarnessFeatureHealth, platformEnvironment, type PlatformEnvironment } from '@jobcopilot/shared/feature-flags'

export function workerHarnessFeatureHealth(environment?: PlatformEnvironment) {
  return getAgentHarnessFeatureHealth(environment ?? platformEnvironment(process.env))
}
