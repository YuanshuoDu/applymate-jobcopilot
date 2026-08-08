import { isErrorResponse, ok, requireAuth } from '@/lib/api-helpers'
import { getOAuthStateSecret } from '@/lib/oauth-state'

function isConfigured(clientId: string | undefined, clientSecret: string | undefined, hasStateSecret: boolean): boolean {
  return Boolean(clientId?.trim() && clientSecret?.trim() && hasStateSecret)
}

/** Return only connection capabilities that the current deployment can start. */
export async function GET() {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth

  const hasStateSecret = getOAuthStateSecret() !== null
  return ok({
    providers: {
      gmail: isConfigured(process.env.AUTH_GOOGLE_ID, process.env.AUTH_GOOGLE_SECRET, hasStateSecret),
      github: isConfigured(process.env.AUTH_GITHUB_ID, process.env.AUTH_GITHUB_SECRET, hasStateSecret),
    },
  })
}
