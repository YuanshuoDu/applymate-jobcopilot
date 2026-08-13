export type ScoreTone = 'strong' | 'normal' | 'weak'

/** Keep extension match colors aligned with the web ScorePill and MatchScoreRing. */
export const SCORE_COLORS = {
  strong: {
    color: '#059669',
    background: 'rgba(5,150,105,0.12)',
    border: 'rgba(5,150,105,0.25)',
    glow: 'rgba(5,150,105,0.20)',
  },
  normal: {
    color: '#D97706',
    background: 'rgba(217,119,6,0.12)',
    border: 'rgba(217,119,6,0.25)',
    glow: 'rgba(217,119,6,0.20)',
  },
  weak: {
    color: '#DC2626',
    background: 'rgba(220,38,38,0.10)',
    border: 'rgba(220,38,38,0.22)',
    glow: 'rgba(220,38,38,0.18)',
  },
} as const

export function scoreToneFor(score: number): ScoreTone {
  return score >= 80 ? 'strong' : score >= 60 ? 'normal' : 'weak'
}

export function scoreColorsFor(score: number) {
  const tone = scoreToneFor(score)
  return { tone, ...SCORE_COLORS[tone] }
}
