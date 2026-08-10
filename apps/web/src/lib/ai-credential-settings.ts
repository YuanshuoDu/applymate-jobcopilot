import {
  aiFeatureCredentialContext,
  aiProviderCredentialContext,
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
} from '@/lib/credential-secrets'

type ValueRecord = Record<string, unknown>

/** Read AI settings into the in-memory shape expected by the model router. */
export async function decryptAiSettings(value: unknown, userId: string): Promise<ValueRecord> {
  const source = asRecord(value)
  const result: ValueRecord = { ...source }
  const keys: ValueRecord = {}
  for (const [provider, raw] of Object.entries(asRecord(source.keys))) {
    keys[provider] = await decryptSecret(stringValue(raw), aiProviderCredentialContext(userId, provider))
  }
  if (Object.keys(keys).length > 0) result.keys = keys

  const features: ValueRecord = {}
  for (const [feature, raw] of Object.entries(asRecord(source.features))) {
    if (raw === null) {
      features[feature] = null
      continue
    }
    const config = asRecord(raw)
    const apiKey = stringValue(config.apiKey)
    features[feature] = {
      ...config,
      ...(apiKey ? { apiKey: await decryptSecret(apiKey, aiFeatureCredentialContext(userId, feature)) } : {}),
    }
  }
  if (Object.keys(features).length > 0) result.features = features
  return result
}

/** Persist only encrypted AI credentials while retaining all non-secret settings. */
export async function encryptAiSettings(value: unknown, userId: string): Promise<ValueRecord> {
  const source = asRecord(value)
  const result: ValueRecord = { ...source }
  const keys: ValueRecord = {}
  for (const [provider, raw] of Object.entries(asRecord(source.keys))) {
    const key = stringValue(raw)
    if (!key) continue
    keys[provider] = isEncryptedSecret(key)
      ? key
      : await encryptSecret(key, aiProviderCredentialContext(userId, provider))
  }
  if (Object.keys(keys).length > 0) result.keys = keys
  else delete result.keys

  const features: ValueRecord = {}
  for (const [feature, raw] of Object.entries(asRecord(source.features))) {
    if (raw === null) {
      features[feature] = null
      continue
    }
    const config = asRecord(raw)
    const apiKey = stringValue(config.apiKey)
    features[feature] = {
      ...config,
      ...(apiKey
        ? { apiKey: isEncryptedSecret(apiKey) ? apiKey : await encryptSecret(apiKey, aiFeatureCredentialContext(userId, feature)) }
        : {}),
    }
  }
  if (Object.keys(features).length > 0) result.features = features
  return result
}

function asRecord(value: unknown): ValueRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ValueRecord : {}
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}
