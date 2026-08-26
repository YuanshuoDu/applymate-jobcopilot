export type ExternalApiProvider = {
  key: string
  label: string
  category: 'infrastructure' | 'email' | 'messaging' | 'oauth' | 'internal'
  access: 'platform' | 'user' | 'public' | 'internal'
  billing: 'metered' | 'free' | 'configurable' | 'unknown'
  telemetry: 'events' | 'snapshot' | 'unavailable'
}

/** Inventory of explicit non-job/model integrations. Keep unknown billing honest. */
export const EXTERNAL_API_PROVIDERS: ExternalApiProvider[] = [
  { key: 'upstash-redis', label: 'Upstash Redis', category: 'infrastructure', access: 'platform', billing: 'metered', telemetry: 'snapshot' },
  { key: 'resend', label: 'Resend Email', category: 'email', access: 'platform', billing: 'configurable', telemetry: 'events' },
  { key: 'gmail', label: 'Gmail API', category: 'messaging', access: 'user', billing: 'free', telemetry: 'events' },
  { key: 'google-oauth', label: 'Google OAuth', category: 'oauth', access: 'user', billing: 'free', telemetry: 'events' },
  { key: 'github', label: 'GitHub API', category: 'oauth', access: 'user', billing: 'free', telemetry: 'events' },
  { key: 'internal-worker', label: 'Worker control API', category: 'internal', access: 'internal', billing: 'unknown', telemetry: 'unavailable' },
  { key: 'neon-postgres', label: 'Neon Postgres', category: 'infrastructure', access: 'platform', billing: 'unknown', telemetry: 'unavailable' },
  { key: 'azure-key-vault', label: 'Azure Key Vault', category: 'infrastructure', access: 'platform', billing: 'configurable', telemetry: 'events' },
  { key: 'vercel-speed-insights', label: 'Vercel Speed Insights', category: 'infrastructure', access: 'platform', billing: 'free', telemetry: 'unavailable' },
]

export function isExternalApiProvider(value: string): boolean {
  return EXTERNAL_API_PROVIDERS.some(provider => provider.key === value)
}
