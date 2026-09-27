import { describe, expect, it } from 'vitest'
import { TASK_GRAPH_PLAN_LABELS, taskGraphPlanLabel, type TaskGraphPlanLabelKey } from './task-graph-plan-labels'

const taskGraphPlanLabelKeys = Object.keys(TASK_GRAPH_PLAN_LABELS.en) as TaskGraphPlanLabelKey[]

describe('TaskGraph plan labels', () => {
  it('keeps the English and Chinese label sets aligned', () => {
    expect(taskGraphPlanLabelKeys).toHaveLength(22)
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
})
