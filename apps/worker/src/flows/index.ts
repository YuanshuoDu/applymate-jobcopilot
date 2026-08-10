import { detectAtsSource, type AtsSourceKey } from '@jobcopilot/shared/ats-url'

export type FlowType = AtsSourceKey | null;

export function detectFlow(url: string): FlowType {
  const source = detectAtsSource(url)
  if (source) return source

  // Greenhouse short links are only a routing hint. apply-queue validates the
  // post-redirect page origin before selecting or running a flow.
  try {
    const parsed = new URL(url)
    const segments = parsed.pathname.split('/').filter(Boolean)
    if (parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === 'grnh.se' && segments.length === 1) {
      return 'greenhouse'
    }
  } catch {
    // Unknown/invalid URLs remain unsupported.
  }
  return null
}
