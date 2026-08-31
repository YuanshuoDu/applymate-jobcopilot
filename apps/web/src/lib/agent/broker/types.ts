import type { Prisma } from "@prisma/client"

export type WaitKind = "approval" | "question"
export type WaitDecision = "approved" | "rejected"

export interface ApprovalWaitProjectionInput {
  approvalId: string
  turnId: string
  toolCallId: string
  action: string
  title: string
  body: string
  impact: Prisma.InputJsonValue | null | undefined
  scopeHash: string
  receiptRevision: number
  expiresAt: Date
}

export interface QuestionWaitInput {
  questionId: string
  sessionId: string
  userId: string
  turnId: string
  toolCallId?: string | null
  stage: string
  question: string
  options: Prisma.InputJsonValue
  expectedTurnRevision: number
}

export interface WaitCommandInput {
  sessionId: string
  userId: string
  waitId: string
  clientMessageId: string
  expectedTurnId: string
  expectedRevision: number
  now?: Date
}

export interface ApprovalDecisionInput extends WaitCommandInput {
  decision: WaitDecision
}

export interface QuestionAnswerInput extends WaitCommandInput {
  answer: string
}

export interface WaitCommandResult {
  waitKind: WaitKind
  waitId: string
  itemId: string
  turnId: string
  toolCallId: string | null
  disposition: "resolved" | "duplicate"
  status: "approved" | "rejected" | "answered"
  nextTurnRevision: number
  sequence: string
}
