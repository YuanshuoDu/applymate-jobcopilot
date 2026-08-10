import {
  credentialContext,
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
  maskStoredSecret,
} from '@jobcopilot/shared'

export { credentialContext, decryptSecret, encryptSecret, isEncryptedSecret, maskStoredSecret }

export function accountCredentialContext(provider: string, providerAccountId: string, field: string): string {
  return credentialContext(`account:${provider}:${providerAccountId}:${field}`)
}

export function discoveryCredentialContext(field: string): string {
  return credentialContext(`discovery:${field}`)
}

export function aiProviderCredentialContext(userId: string, provider: string): string {
  return credentialContext(`ai:${userId}:provider:${provider}`)
}

export function aiFeatureCredentialContext(userId: string, feature: string): string {
  return credentialContext(`ai:${userId}:feature:${feature}`)
}

export async function decryptAccountTokens<T extends {
  provider: string
  providerAccountId: string
  access_token?: string | null
  accessTokenEnc?: string | null
  refresh_token?: string | null
  refreshTokenEnc?: string | null
  id_token?: string | null
  idTokenEnc?: string | null
}>(account: T) {
  const scope = (field: string) => accountCredentialContext(account.provider, account.providerAccountId, field)
  return {
    ...account,
    access_token: await decryptSecret(account.accessTokenEnc ?? account.access_token, scope('access')),
    refresh_token: await decryptSecret(account.refreshTokenEnc ?? account.refresh_token, scope('refresh')),
    id_token: await decryptSecret(account.idTokenEnc ?? account.id_token, scope('id')),
  }
}

export async function encryptAccountTokenFields(input: {
  provider: string
  providerAccountId: string
  accessToken?: string | null
  refreshToken?: string | null
  idToken?: string | null
}) {
  const scope = (field: string) => accountCredentialContext(input.provider, input.providerAccountId, field)
  return {
    access_token: null,
    accessTokenEnc: input.accessToken ? await encryptSecret(input.accessToken, scope('access')) : null,
    refresh_token: null,
    refreshTokenEnc: input.refreshToken ? await encryptSecret(input.refreshToken, scope('refresh')) : null,
    id_token: null,
    idTokenEnc: input.idToken ? await encryptSecret(input.idToken, scope('id')) : null,
  }
}
