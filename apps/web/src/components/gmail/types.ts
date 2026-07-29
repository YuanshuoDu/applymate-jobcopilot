import type { JobStatus } from '@/lib/types'

export type GmailMessageKind =
  | 'application_received'
  | 'interview_invitation'
  | 'offer'
  | 'rejection'
  | 'application_update'
  | 'recommendation_digest'
  | 'other'

export interface TrackedGmailMessage {
  id: string
  gmailMessageId: string
  gmailThreadId: string | null
  kind: GmailMessageKind
  senderEmail: string | null
  senderName: string | null
  subject: string
  excerpt: string | null
  inferredCompany: string | null
  inferredRole: string | null
  receivedAt: string
  job: { id: string; company: string; role: string; status: JobStatus } | null
}

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
  sourceMessage: { subject: string; receivedAt: string; senderName: string | null; senderEmail: string | null; matchConfidence: number | null }
  savedJob: { id: string; company: string; role: string } | null
}

export interface LinkableJob {
  id: string
  company: string
  role: string
}

export interface GmailTrackingResponse {
  sync?: {
    importedMessages: number
    matchedMessages: number
    statusUpdates: number
    newRecommendations: number
  }
  messages?: TrackedGmailMessage[]
  recommendations?: GmailRecommendation[]
  pendingRecommendationCount?: number
}
