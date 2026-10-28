const SOURCE_SELECTORS = ["greenhouse", "lever", "workday", "smartrecruiters"] as const

export type ScheduledMultiScoutPrefixPlan = Readonly<{
  scouts: readonly Readonly<{ nodeKey: string; taskId: string; source: string; candidateJobIds: readonly string[] }>[]
  analystNodeKey: "scheduled-analyst"
  analystTaskId: string
  analystDependencyNodeKeys: readonly string[]
  candidateUnionJobIds: readonly string[]
  analystJobIds: readonly string[]
}>

/** Deterministic fixture plan for a nonempty v2 Analyze prefix; each Scout uses a distinct allowed source selector. */
export function createScheduledMultiScoutPrefixPlan(input: Readonly<{
  scoutTaskIds: readonly string[]
  analystTaskId: string
  jobIds: readonly string[]
  selectedJobIds: readonly string[]
}>): ScheduledMultiScoutPrefixPlan | null {
  const count = input.scoutTaskIds.length
  if (count < 2 || count > SOURCE_SELECTORS.length || !uniqueBounded(input.scoutTaskIds, count)
    || !validId(input.analystTaskId) || input.scoutTaskIds.includes(input.analystTaskId)
    || !uniqueBounded(input.jobIds, 200) || input.jobIds.length < count
    || !uniqueBounded(input.selectedJobIds, 50) || input.selectedJobIds.length === 0
    || input.selectedJobIds.some(id => !input.jobIds.includes(id))) return null
  const scouts = input.scoutTaskIds.map((taskId, index) => ({
    nodeKey: `scheduled-scout-${index + 1}`,
    taskId,
    source: SOURCE_SELECTORS[index]!,
    candidateJobIds: input.jobIds.filter((_id, jobIndex) => jobIndex % count === index),
  }))
  if (scouts.some(source => source.candidateJobIds.length === 0 || source.candidateJobIds.length > 50)) return null
  return { scouts, analystNodeKey: "scheduled-analyst", analystTaskId: input.analystTaskId,
    analystDependencyNodeKeys: scouts.map(source => source.nodeKey),
    candidateUnionJobIds: [...input.jobIds], analystJobIds: [...input.selectedJobIds] }
}

function uniqueBounded(values: readonly string[], maximum: number): boolean {
  return Array.isArray(values) && values.length > 0 && values.length <= maximum
    && values.every(validId) && new Set(values).size === values.length
}
function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value
}
