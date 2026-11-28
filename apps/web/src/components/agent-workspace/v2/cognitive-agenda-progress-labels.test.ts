import { describe, expect, it } from 'vitest'

import type { Lang } from '@/lib/i18n'

import type { CognitiveAgendaObjectiveProgressRow } from './cognitive-agenda-view'
import { cognitiveAgendaObjectiveProgressLabels as labels } from './cognitive-agenda-progress-labels'

const row: CognitiveAgendaObjectiveProgressRow = { kind: 'candidate_count_gte', status: 'reported_passed', minimum: 3, beforeStatus: 'active' }
const locales: Lang[] = ['en', 'de', 'fr', 'es', 'nl', 'zh']

describe('cognitive agenda objective progress labels', () => {
  it('provides fixed localized labels and advisory status in all supported locales', () => {
    const expected = ['Objective progress', 'Zielfortschritt', 'Progression de l’objectif', 'Progreso del objetivo', 'Doelvoortgang', '目标进度']
    const candidateLabels = ['Candidate jobs', 'Gefundene Stellen', 'Offres repérées', 'Empleos encontrados', 'Gevonden vacatures', '候选职位数']
    const findingLabels = ['Job findings', 'Stellenbefunde', 'Résultats sur les offres', 'Hallazgos sobre empleos', 'Bevindingen over vacatures', '职位分析发现数']
    locales.forEach((lang, index) => {
      expect(labels.title(lang)).toBe(expected[index])
      expect(labels.row(row, lang).requirement).toContain(candidateLabels[index])
      expect(labels.row({ ...row, kind: 'finding_count_gte' }, lang).requirement).toContain(findingLabels[index])
      expect(labels.row(row, lang).beforeStatus).toBeTruthy()
      expect(labels.row(row, lang).status).toBeTruthy()
    })
  })

  it('uses fixed kind labels and shows a change only when the validated statuses differ', () => {
    const location = labels.row({ kind: 'candidate_location_in', status: 'unknown' }, 'en')
    expect(location.requirement).toBe('Location requirement')
    expect(location.status).toBe('Unknown')
    expect(location.beforeStatus).toBeUndefined()

    const unchanged = labels.row({ kind: 'finding_count_gte', status: 'active', minimum: 2, beforeStatus: 'active' }, 'en')
    expect(unchanged).toEqual({ requirement: 'Job findings (≥ 2)', status: 'In progress' })
  })
})
