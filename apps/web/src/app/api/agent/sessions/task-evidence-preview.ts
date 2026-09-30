import {
  projectTaskEvidencePreview as projectSharedTaskEvidencePreview,
  type PlanLedgerEvidencePreview,
} from '@jobcopilot/agent-protocol'

export type TaskEvidencePreview = PlanLedgerEvidencePreview

export function projectTaskEvidencePreview(row: { status: string; role: string; result: unknown }): TaskEvidencePreview | null {
  return projectSharedTaskEvidencePreview(row)
}
