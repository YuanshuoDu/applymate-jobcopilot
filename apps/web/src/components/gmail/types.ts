export type GmailMessageKind =
  | 'application_received'
  | 'interview_invitation'
  | 'offer'
  | 'rejection'
  | 'application_update'
  | 'recommendation_digest'
  | 'other'

export interface GmailRecommendation {
  id: string
  platform: string | null
  company: string | null
  role: string | null
  location: string | null
  salary: string | null
  url: string | null
  description: string | null
  status: 'pending' | 'saved' | 'dismissed'
  createdAt: string
  sourceMessage: { gmailMessageId: string; gmailThreadId: string | null; subject: string; receivedAt: string; senderName: string | null; senderEmail: string | null; matchConfidence: number | null }
  savedJob: { id: string; company: string; role: string } | null
}

export interface GmailTrackingResponse {
  sync?: {
    importedMessages: number
    matchedMessages: number
    statusUpdates: number
    newRecommendations: number
  }
  recommendations?: GmailRecommendation[]
  pendingRecommendationCount?: number
}
