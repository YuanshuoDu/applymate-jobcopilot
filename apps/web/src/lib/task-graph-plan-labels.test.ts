import { describe, expect, it } from 'vitest'
import { TASK_GRAPH_PLAN_LABELS, taskGraphPlanLabel, type TaskGraphPlanLabelKey } from './task-graph-plan-labels'

const taskGraphPlanLabelKeys = Object.keys(TASK_GRAPH_PLAN_LABELS.en) as TaskGraphPlanLabelKey[]

describe('TaskGraph plan labels', () => {
  it('keeps the English and Chinese label sets aligned', () => {
    expect(taskGraphPlanLabelKeys).toHaveLength(48)
    expect(Object.keys(TASK_GRAPH_PLAN_LABELS.zh)).toEqual(taskGraphPlanLabelKeys)
  })

  it('resolves all labels in English and Chinese', () => {
    for (const key of taskGraphPlanLabelKeys) {
      expect(taskGraphPlanLabel('en', key), key).toBe(TASK_GRAPH_PLAN_LABELS.en[key])
      expect(taskGraphPlanLabel('zh', key), key).toBe(TASK_GRAPH_PLAN_LABELS.zh[key])
    }
  })

  it('keeps the English fallback for languages without a dedicated translation', () => {
    const fallbackLanguages = ['de', 'fr', 'es', 'nl'] as const

    for (const lang of fallbackLanguages) {
      for (const key of taskGraphPlanLabelKeys) {
        expect(taskGraphPlanLabel(lang, key), `${lang}: ${key}`).toBe(TASK_GRAPH_PLAN_LABELS.en[key])
      }
    }
  })

  it('labels repair lineage without implying a verdict', () => {
    expect(taskGraphPlanLabel('en', 'agent.taskGraph.repairAttemptFor')).toBe('Repair attempt for')
    expect(taskGraphPlanLabel('zh', 'agent.taskGraph.repairAttemptFor')).toBe('修复尝试：')
  })

  it('labels selected historical inspection and safe return in English and Chinese', () => {
    expect(taskGraphPlanLabel('en', 'agent.taskGraph.selectedPlan')).toBe('Plan for selected turn')
    expect(taskGraphPlanLabel('en', 'agent.taskGraph.returnToCurrentPlan')).toBe('Return to current plan')
    expect(taskGraphPlanLabel('en', 'agent.taskGraph.loadingSelectedPlan')).toBe('Loading selected plan…')
    expect(taskGraphPlanLabel('en', 'agent.taskGraph.planUnavailable')).toBe('This selected plan is unavailable.')
    expect(taskGraphPlanLabel('zh', 'agent.taskGraph.selectedPlan')).toBe('所选轮次的计划')
    expect(taskGraphPlanLabel('zh', 'agent.taskGraph.returnToCurrentPlan')).toBe('返回当前计划')
    expect(taskGraphPlanLabel('zh', 'agent.taskGraph.loadingSelectedPlan')).toBe('正在加载所选计划…')
    expect(taskGraphPlanLabel('zh', 'agent.taskGraph.planUnavailable')).toBe('所选计划不可用。')
    expect(taskGraphPlanLabel('fr', 'agent.taskGraph.returnToCurrentPlan')).toBe('Return to current plan')
  })

  it('keeps typed verification labels bilingual and distinct from task status', () => {
    const verificationLabels: Partial<Record<TaskGraphPlanLabelKey, readonly [string, string]>> = {
      'agent.taskGraph.verification.title': ['Verification', '验证结果'],
      'agent.taskGraph.verification.passed': ['Passed', '已通过'],
      'agent.taskGraph.verification.failed': ['Failed', '未通过'],
      'agent.taskGraph.verification.unverified': ['Not verified', '未验证'],
      'agent.taskGraph.verification.unavailable': [
        'Verification unavailable; no valid report was recorded.',
        '验证不可用；未记录有效报告。',
      ],
      'agent.taskGraph.verification.total': ['Checks', '检查项'],
      'agent.taskGraph.verification.passedCount': ['passed', '通过'],
      'agent.taskGraph.verification.failedCount': ['failed', '未通过'],
      'agent.taskGraph.verification.unverifiedCount': ['unverified', '未验证'],
      'agent.taskGraph.verification.candidate_count_gte': ['At least this many candidates', '候选职位数量至少'],
      'agent.taskGraph.verification.finding_count_gte': ['At least this many findings', '分析结果数量至少'],
      'agent.taskGraph.verification.evidence_count_gte': ['At least this many evidence items', '证据项数量至少'],
      'agent.taskGraph.verification.all_candidates_have_evidence': ['All candidates have evidence', '候选职位均有证据'],
      'agent.taskGraph.verification.all_findings_have_evidence': ['All findings have evidence', '分析结果均有证据'],
      'agent.taskGraph.verification.reported_score_gte': ['Reported score threshold', '报告分数阈值'],
      'agent.taskGraph.verification.findings_from_scout_dependency': ['Analysis uses discovered jobs', '分析基于职位发现结果'],
      'agent.taskGraph.verification.findings_cover_scout_candidates_gte': [
        'Findings cover at least this percentage of the declared Scout cohort', '分析结果至少覆盖声明的 Scout 候选集合比例',
      ],
      'agent.taskGraph.verification.minimumFindings': ['minimum findings', '最少分析结果'],
      'agent.taskGraph.verification.minimumItems': ['minimum items', '最少项目数'],
      'agent.taskGraph.verification.aggregation.any': ['any', '任一'],
      'agent.taskGraph.verification.aggregation.all': ['all', '全部'],
    }

    expect(Object.keys(verificationLabels)).toHaveLength(21)
    for (const [key, [english, chinese]] of Object.entries(verificationLabels)) {
      const labelKey = key as TaskGraphPlanLabelKey
      expect(taskGraphPlanLabel('en', labelKey), key).toBe(english)
      expect(taskGraphPlanLabel('zh', labelKey), key).toBe(chinese)
    }

    expect(taskGraphPlanLabel('en', 'agent.taskGraph.status.completed')).toBe('Completed')
    expect(taskGraphPlanLabel('en', 'agent.taskGraph.verification.passed')).toBe('Passed')
    expect(taskGraphPlanLabel('en', 'agent.taskGraph.verification.failed')).toBe('Failed')
    expect(taskGraphPlanLabel('en', 'agent.taskGraph.verification.unverified')).toBe('Not verified')
  })
})
