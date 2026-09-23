type PreviewEnvironment = {
  readonly NODE_ENV?: string
  readonly AGENT_PREVIEW_FIXTURE?: string
}

type PreviewRequest = {
  readonly environment: PreviewEnvironment
  readonly hostname: string
  readonly hostHeader?: string | null
  readonly forwardedHost?: string | null
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Keeps the local supervisor fixture disabled in production unless explicitly enabled for tests. */
export function isAgentPreviewFixtureEnabled(environment: PreviewEnvironment): boolean {
  return environment.NODE_ENV === 'development'
    || environment.NODE_ENV === 'production' && environment.AGENT_PREVIEW_FIXTURE === '1'
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
