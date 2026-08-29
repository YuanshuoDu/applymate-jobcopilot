export interface SearchCorrection {
  from: string
  to: string
}

export interface RoleConcept {
  id: string
  preferred: string
  aliases: string[]
}

export interface SearchQueryIntent {
  correctedQuery: string
  normalizedQuery: string
  tokens: string[]
  semanticTokens: string[]
  corrections: SearchCorrection[]
  concepts: RoleConcept[]
}

const ROLE_CONCEPTS: RoleConcept[] = [
  { id: 'software-engineering', preferred: 'Software Engineer', aliases: ['software engineer', 'software developer', 'software development engineer', 'application developer', 'swe'] },
  { id: 'backend-engineering', preferred: 'Backend Engineer', aliases: ['backend engineer', 'back end engineer', 'back-end engineer', 'backend developer', 'server side developer', 'api engineer'] },
  { id: 'frontend-engineering', preferred: 'Frontend Engineer', aliases: ['frontend engineer', 'front end engineer', 'front-end engineer', 'frontend developer', 'front end developer', 'ui engineer', 'web developer'] },
  { id: 'full-stack-engineering', preferred: 'Full Stack Developer', aliases: ['full stack engineer', 'full-stack engineer', 'fullstack engineer', 'full stack developer', 'full-stack developer', 'fullstack developer'] },
  { id: 'data-engineering', preferred: 'Data Engineer', aliases: ['data engineer', 'data developer', 'analytics engineer', 'etl developer'] },
  { id: 'data-science', preferred: 'Data Scientist', aliases: ['data scientist', 'applied scientist', 'machine learning scientist'] },
  { id: 'machine-learning', preferred: 'Machine Learning Engineer', aliases: ['machine learning engineer', 'ml engineer', 'ai engineer', 'artificial intelligence engineer', 'machine learning developer', 'mle'] },
  { id: 'devops-platform', preferred: 'DevOps Engineer', aliases: ['devops engineer', 'site reliability engineer', 'sre', 'platform engineer', 'cloud engineer', 'devsecops engineer'] },
  { id: 'security-engineering', preferred: 'Security Engineer', aliases: ['security engineer', 'application security engineer', 'cybersecurity engineer', 'cyber security engineer', 'information security engineer', 'infosec engineer'] },
  { id: 'quality-engineering', preferred: 'QA Engineer', aliases: ['qa engineer', 'quality assurance engineer', 'test engineer', 'software test engineer', 'automation test engineer'] },
  { id: 'product-management', preferred: 'Product Manager', aliases: ['product manager', 'product owner', 'technical product manager'] },
  { id: 'product-design', preferred: 'Product Designer', aliases: ['product designer', 'ux designer', 'user experience designer', 'ui ux designer'] },
]

const ACRONYM_EXPANSIONS: Record<string, string> = {
  swe: 'Software Engineer',
  sre: 'Site Reliability Engineer',
  mle: 'Machine Learning Engineer',
}

const STOP_WORDS = new Set(['and', 'for', 'the', 'with', 'near', 'from', 'jobs', 'job', 'work'])

const SPELLING_WORDS = new Set([
  'software', 'engineer', 'developer', 'development', 'application', 'backend', 'frontend', 'full', 'stack',
  'data', 'analytics', 'scientist', 'machine', 'learning', 'artificial', 'intelligence', 'devops', 'site',
  'reliability', 'platform', 'cloud', 'security', 'cybersecurity', 'information', 'quality', 'assurance',
  'test', 'automation', 'product', 'manager', 'owner', 'designer', 'user', 'experience', 'api', 'server',
  'side', 'etl', 'qa', 'swe', 'sre', 'mle', 'python', 'javascript', 'typescript', 'java', 'kotlin', 'swift',
  'golang', 'rust', 'ruby', 'php', 'csharp', 'cpp', 'dotnet', 'react', 'reactjs', 'angular', 'vue', 'nodejs',
  'docker', 'kubernetes', 'terraform', 'aws', 'azure', 'gcp', 'postgresql', 'postgres', 'mysql', 'sql',
  'snowflake', 'spark', 'scala', 'ireland', 'dublin', 'cork', 'galway', 'limerick', 'berlin', 'munich',
  'hamburg', 'frankfurt', 'dusseldorf', 'amsterdam', 'rotterdam', 'london', 'manchester', 'paris', 'madrid',
  'barcelona', 'milan', 'rome', 'lisbon', 'zurich', 'vienna', 'brussels', 'stockholm', 'copenhagen', 'oslo',
  'helsinki', 'warsaw', 'prague', 'europe', 'remote', 'anywhere', 'worldwide', 'senior', 'junior', 'lead',
  'principal', 'staff', 'contract', 'hybrid', 'onsite', 'internship',
])

function tokenizableText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/c\+\+/gi, ' cpp ')
    .replace(/c#/gi, ' csharp ')
    .replace(/\.net\b/gi, ' dotnet ')
    .replace(/node\.js/gi, ' nodejs ')
    .replace(/react\.js/gi, ' reactjs ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokens(value: string): string[] {
  const text = tokenizableText(value)
  return text ? text.split(' ') : []
}

export function normalizeSearchText(value: string): string {
  return tokenizableText(value).toLowerCase()
}

function editDistance(left: string, right: string): number {
  const matrix = Array.from({ length: left.length + 1 }, (_, row) => {
    const values = new Array<number>(right.length + 1).fill(0)
    values[0] = row
    return values
  })
  for (let column = 0; column <= right.length; column++) matrix[0][column] = column
  for (let row = 1; row <= left.length; row++) {
    for (let column = 1; column <= right.length; column++) {
      const substitution = left[row - 1] === right[column - 1] ? 0 : 1
      matrix[row][column] = Math.min(
        matrix[row - 1][column] + 1,
        matrix[row][column - 1] + 1,
        matrix[row - 1][column - 1] + substitution,
      )
      if (row > 1 && column > 1 && left[row - 1] === right[column - 2] && left[row - 2] === right[column - 1]) {
        matrix[row][column] = Math.min(matrix[row][column], matrix[row - 2][column - 2] + substitution)
      }
    }
  }
  return matrix[left.length][right.length]
}

function maxCorrectionDistance(word: string): number {
  if (word.length < 4) return 0
  return word.length < 7 ? 1 : 2
}

function closestSpelling(word: string): string | null {
  const limit = maxCorrectionDistance(word)
  if (!limit) return null
  let best: string | null = null
  let bestDistance = limit + 1
  let tied = false
  for (const candidate of SPELLING_WORDS) {
    if (Math.abs(candidate.length - word.length) > limit) continue
    const distance = editDistance(word, candidate)
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
      tied = false
    } else if (distance === bestDistance) {
      tied = true
    }
  }
  return best && !tied && bestDistance <= limit ? best : null
}

function preserveCase(replacement: string, original: string): string {
  if (original === original.toUpperCase()) return replacement.toUpperCase()
  if (original[0] === original[0]?.toUpperCase()) return replacement.charAt(0).toUpperCase() + replacement.slice(1)
  return replacement
}

export function correctSearchSpelling(value: string): string {
  return tokens(value).map(token => {
    const lower = token.toLowerCase()
    if (STOP_WORDS.has(lower) || SPELLING_WORDS.has(lower)) return token
    const closest = closestSpelling(lower)
    return closest ? preserveCase(closest, token) : token
  }).join(' ')
}

function phraseInText(text: string, phrase: string): boolean {
  return ` ${text} `.includes(` ${normalizeSearchText(phrase)} `)
}

function roleConceptsFor(value: string): RoleConcept[] {
  const normalized = normalizeSearchText(value)
  return ROLE_CONCEPTS.filter(concept => concept.aliases.some(alias => phraseInText(normalized, alias)))
}

export function canonicalizeJobSearchQuery(value: string): string {
  const corrected = tokens(correctSearchSpelling(value))
  if (corrected.length === 1) return ACRONYM_EXPANSIONS[corrected[0].toLowerCase()] ?? corrected[0]
  return corrected.join(' ')
}

export function createSearchIntent(value: string): SearchQueryIntent {
  const correctedQuery = canonicalizeJobSearchQuery(value)
  const normalizedQuery = normalizeSearchText(correctedQuery)
  const inputTokens = tokens(normalizedQuery)
  const concepts = roleConceptsFor(correctedQuery)
  const semanticTokens = [...new Set(concepts.flatMap(concept => tokens(concept.preferred).map(token => token.toLowerCase())))]
  const originalTokens = tokens(value)
  const corrections = originalTokens.flatMap(token => {
    const corrected = tokens(correctSearchSpelling(token))[0] ?? token
    return corrected.toLowerCase() === token.toLowerCase() ? [] : [{ from: token, to: corrected }]
  })
  return { correctedQuery, normalizedQuery, tokens: inputTokens, semanticTokens, corrections, concepts }
}

export function semanticRoleScore(
  title: string,
  description: string,
  keySkills: string[] | undefined,
  intent: SearchQueryIntent,
): number {
  if (intent.concepts.length === 0) return 0
  const titleText = normalizeSearchText(title)
  const supportingText = normalizeSearchText(`${description} ${(keySkills ?? []).join(' ')}`)
  let score = 0
  for (const concept of intent.concepts) {
    if (concept.aliases.some(alias => phraseInText(titleText, alias))) score += 10
    else if (concept.aliases.some(alias => phraseInText(supportingText, alias))) score += 3
    else if (tokens(concept.preferred).every(token => phraseInText(titleText, token))) score += 6
  }
  return Math.min(score, 16)
}
