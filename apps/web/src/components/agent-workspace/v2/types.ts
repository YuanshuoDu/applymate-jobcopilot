export type TaskNodeKind = "turn" | "step" | "tool"

export type TaskTreeNode = {
  readonly id: string
  readonly kind: TaskNodeKind
  readonly label: string
  readonly status: string
  readonly itemId?: string
  readonly children?: readonly TaskTreeNode[]
}

export type PendingApproval = {
  readonly approvalId: string
  readonly scopeHash: string
  readonly expiresAt: string
  readonly evidenceRefs: readonly string[]
  readonly action?: string
  readonly answeredAt?: string | null
}

export type ArtifactSummary = {
  readonly artifactId: string
  readonly version: number
  readonly status: "current" | "stale" | "draft"
  readonly hash?: string
}

export type BudgetUsage = {
  readonly tokensUsed: number
  readonly tokensBudget: number
  readonly percentage: number
}

export type CompactionEvent = {
  readonly lastCompactionAt: string | null
}
