import { DefaultAzureCredential } from '@azure/identity'

const MANAGEMENT_SCOPE = 'https://management.azure.com/.default'

export type AzureManagementTokenCredential = {
  getToken: (scope: string) => Promise<{ token: string } | null>
}

let defaultCredential: DefaultAzureCredential | null = null

/** Resolve a short-lived ARM token without exposing credentials to callers. */
export async function getAzureManagementToken(dependencies: { credential?: AzureManagementTokenCredential } = {}): Promise<string | null> {
  try {
    const credential = dependencies.credential ?? (defaultCredential ??= new DefaultAzureCredential())
    const token = await credential.getToken(MANAGEMENT_SCOPE)
    return token?.token?.trim() || null
  } catch {
    return null
  }
}

