import { detectAtsSource, type AtsSourceKey } from '@jobcopilot/shared/ats-url'

export type FlowType = AtsSourceKey | null;

export function detectFlow(url: string): FlowType {
  return detectAtsSource(url)
}
