export {
  GMAIL_MESSAGE_KINDS,
  classifyGmailMessage,
  inferApplicationMetadata,
} from './classification'
export type {
  GmailClassificationInput,
  GmailMessageKind,
  InferredApplicationMetadata,
} from './classification'
export {
  createRecommendationFingerprint,
  extractRecommendationCards,
} from './recommendations'
export type {
  GmailRecommendationCard,
  RecommendationExtractionInput,
  RecommendationFingerprintInput,
} from './recommendations'
