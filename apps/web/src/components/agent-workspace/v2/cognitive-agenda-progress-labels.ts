import type { Lang } from '@/lib/i18n'

import type { CognitiveAgendaObjectiveProgressRow } from './cognitive-agenda-view'

type ProgressStatus = CognitiveAgendaObjectiveProgressRow['status']
type Copy = Readonly<{
  title: string
  candidateCount: string
  findingCount: string
  location: string
  statuses: Readonly<Record<ProgressStatus, string>>
}>

const COPY: Record<Lang, Copy> = {
  en: {
    title: 'Objective progress', candidateCount: 'Candidate jobs', findingCount: 'Job findings', location: 'Location requirement',
    statuses: { missing: 'Missing', active: 'In progress', failed: 'Failed', unverified: 'Unverified', reported_passed: 'Reported passed (advisory)', unknown: 'Unknown' },
  },
  de: {
    title: 'Zielfortschritt', candidateCount: 'Gefundene Stellen', findingCount: 'Stellenbefunde', location: 'Ortskriterium',
    statuses: { missing: 'Fehlt', active: 'In Bearbeitung', failed: 'Fehlgeschlagen', unverified: 'Nicht verifiziert', reported_passed: 'Als erfüllt gemeldet (unverbindlich)', unknown: 'Unbekannt' },
  },
  fr: {
    title: 'Progression de l’objectif', candidateCount: 'Offres repérées', findingCount: 'Résultats sur les offres', location: 'Critère de lieu',
    statuses: { missing: 'Manquant', active: 'En cours', failed: 'Échec', unverified: 'Non vérifié', reported_passed: 'Réussi selon le rapport (indicatif)', unknown: 'Inconnu' },
  },
  es: {
    title: 'Progreso del objetivo', candidateCount: 'Empleos encontrados', findingCount: 'Hallazgos sobre empleos', location: 'Criterio de ubicación',
    statuses: { missing: 'Falta', active: 'En curso', failed: 'Fallido', unverified: 'Sin verificar', reported_passed: 'Cumplido según el informe (orientativo)', unknown: 'Desconocido' },
  },
  nl: {
    title: 'Doelvoortgang', candidateCount: 'Gevonden vacatures', findingCount: 'Bevindingen over vacatures', location: 'Locatiecriterium',
    statuses: { missing: 'Ontbreekt', active: 'Bezig', failed: 'Mislukt', unverified: 'Niet geverifieerd', reported_passed: 'Volgens melding voldaan (indicatief)', unknown: 'Onbekend' },
  },
  zh: {
    title: '目标进度', candidateCount: '候选职位数', findingCount: '职位分析发现数', location: '地点要求',
    statuses: { missing: '缺失', active: '进行中', failed: '失败', unverified: '未验证', reported_passed: '报告为已满足（仅供参考）', unknown: '未知' },
  },
}

export const cognitiveAgendaObjectiveProgressLabels = {
  title(lang: Lang): string { return COPY[lang].title },
  row(row: CognitiveAgendaObjectiveProgressRow, lang: Lang): Readonly<{ requirement: string; status: string; beforeStatus?: string }> {
    const copy = COPY[lang]
    const minimum = Number.isSafeInteger(row.minimum) && row.minimum !== undefined && row.minimum > 0 ? ` (≥ ${row.minimum})` : ''
    const requirement = row.kind === 'candidate_count_gte' ? `${copy.candidateCount}${minimum}`
      : row.kind === 'finding_count_gte' ? `${copy.findingCount}${minimum}` : copy.location
    const status = Object.hasOwn(copy.statuses, row.status) ? copy.statuses[row.status] : copy.statuses.unknown
    const beforeStatus = row.beforeStatus && row.beforeStatus !== row.status && Object.hasOwn(copy.statuses, row.beforeStatus)
      ? copy.statuses[row.beforeStatus] : undefined
    return { requirement, status, ...(beforeStatus ? { beforeStatus } : {}) }
  },
}
