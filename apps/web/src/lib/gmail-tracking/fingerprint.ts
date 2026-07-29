export interface RecommendationFingerprintInput {
  platform?: string | null
  company?: string | null
  role?: string | null
  location?: string | null
  url?: string | null
}

/** A stable identifier for retry-safe recommendation persistence. */
export function createRecommendationFingerprint(input: RecommendationFingerprintInput): string {
  const identity = recommendationIdentityKey(input)
  return `gmail-rec-${hash(identity)}-${hash(`applymate:${identity}`)}`
}

function hash(value: string): string {
  let result = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) result = Math.imul(result ^ value.charCodeAt(index), 0x01000193)
  return (result >>> 0).toString(16).padStart(8, '0')
}
import { recommendationIdentityKey } from './recommendation-utils'
