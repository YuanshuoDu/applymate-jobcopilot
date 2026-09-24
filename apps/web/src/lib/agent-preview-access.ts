type PreviewEnvironment = {
  readonly NODE_ENV?: string
  readonly AGENT_PREVIEW_FIXTURE?: string
  readonly VERCEL?: string
  readonly VERCEL_ENV?: string
}

type PreviewRequest = {
  readonly environment: PreviewEnvironment
  readonly hostname: string
  readonly hostHeader?: string | null
  readonly forwardedHost?: string | null
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Keeps the supervisor fixture local, even when a production-mode test explicitly enables it. */
export function isAgentPreviewFixtureEnabled(environment: PreviewEnvironment): boolean {
  if (environment.NODE_ENV === 'development') return true
  if (environment.NODE_ENV !== 'production' || environment.AGENT_PREVIEW_FIXTURE !== '1') return false
  return environment.VERCEL === undefined && environment.VERCEL_ENV === undefined
}

/** Requires every host identity supplied by a request to remain on loopback. */
export function isAgentPreviewRequestAllowed(request: PreviewRequest): boolean {
  if (!isAgentPreviewFixtureEnabled(request.environment) || !isLoopbackHost(request.hostname)) return false
  return isLoopbackHeader(request.hostHeader) && isLoopbackHeader(request.forwardedHost)
}

function isLoopbackHeader(value: string | null | undefined): boolean {
  if (value === undefined || value === null) return true
  const hosts = value.split(',').map(host => host.trim()).filter(Boolean)
  return hosts.length > 0 && hosts.every(isLoopbackHost)
}

function isLoopbackHost(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/:\d+$/, '')
  return LOOPBACK_HOSTS.has(normalized)
}
