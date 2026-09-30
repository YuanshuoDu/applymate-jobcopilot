import { modelChat, stripFences } from '@/lib/model-router'
import type { AiConfig } from '@/lib/model-router'
import type { AgentConfigFull, ScoredJob } from '../types'

const COVER_LETTER_LANGUAGE_NAMES = {
  en: 'English',
  de: 'German',
  fr: 'French',
  nl: 'Dutch',
  es: 'Spanish',
} as const

const COVER_LETTER_FORMALITY_GUIDES: Record<keyof typeof COVER_LETTER_LANGUAGE_NAMES, string> = {
  en: 'Use polished business English and a professional European application style.',
  de: 'Use formal German business conventions, including Sie/Ihnen where appropriate.',
  fr: 'Use formal French business conventions, including vous/votre where appropriate.',
  nl: 'Use formal Dutch business conventions, including u/uw where appropriate.',
  es: 'Use formal Spanish business conventions, including usted/su where appropriate.',
}

type CoverLetterLanguage = keyof typeof COVER_LETTER_LANGUAGE_NAMES

function inferCoverLetterLanguage(sj: ScoredJob): CoverLetterLanguage {
  const haystack = [
    sj.job.location,
    sj.job.url,
    sj.job.description,
  ].filter(Boolean).join(' ').toLowerCase()

  if (/\b(deutschland|germany|berlin|munich|muenchen|hamburg|frankfurt|cologne|köln|\.de\b)/i.test(haystack)) return 'de'
  if (/\b(france|paris|lyon|marseille|toulouse|lille|\.fr\b)/i.test(haystack)) return 'fr'
  if (/\b(netherlands|nederland|amsterdam|rotterdam|utrecht|eindhoven|\.nl\b)/i.test(haystack)) return 'nl'
  if (/\b(spain|españa|espana|madrid|barcelona|valencia|sevilla|\.es\b)/i.test(haystack)) return 'es'
  return 'en'
}

export async function generateTailoredResume(
  sj: ScoredJob,
  resume: unknown,
  aiConfig: AiConfig,
  systemPrompt?: string,
  persona = '',
  evidence = '',
  beforeModelCall?: () => Promise<void>,
) {
  const prompt = `Tailor this resume for the target job. Preserve truthful facts; only improve positioning and add JD keywords supported by the source resume or confirmed Persona. Persona is a hard fact boundary: do not add unsupported employers, education, dates, metrics, tools, achievements, or biography. Return ONLY the complete resume JSON object, with the same structure.\n\nRESUME JSON:\n${JSON.stringify(resume)}\n\nCONFIRMED PERSONA:\n${persona.slice(0, 9000)}\n\n${evidence}\n\nTARGET: ${sj.job.role} at ${sj.job.company}\nJOB DESCRIPTION:\n${sj.job.description?.slice(0, 1800) ?? ''}\nMATCHED: ${sj.matchedKeywords.join(', ')}\nMISSING: ${sj.missingKeywords.join(', ')}`
  const messages = systemPrompt
    ? [{ role: 'system' as const, content: systemPrompt }, { role: 'user' as const, content: prompt }]
    : [{ role: 'user' as const, content: prompt }]
  await beforeModelCall?.()
  const result = await modelChat(messages, aiConfig, 2200)
  const raw = stripFences(result.text)
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}')
  if (start < 0 || end < 0) throw new Error('AI returned no resume JSON')
  return JSON.parse(raw.slice(start, end + 1))
}

export async function generateCoverLetter(
  sj: ScoredJob,
  cfg: AgentConfigFull,
  resume: { contact?: { name?: string }; summary?: string; experience?: { role: string; company: string; period: string }[] },
  aiConfig: AiConfig,
  systemPrompt?: string,
  persona = '',
  evidence = '',
  beforeModelCall?: () => Promise<void>,
): Promise<string> {
  const name       = resume.contact?.name ?? 'the applicant'
  const latestRole = resume.experience?.[0]
  const greeting   = 'Dear Hiring Manager,'
  const toneMap: Record<string, string> = {
    professional: 'formal, confident, and polished',
    confident:    'assertive, results-focused, and direct',
    concise:      'direct and punchy — no filler',
  }
  const toneGuide = toneMap[cfg.coverTone] ?? toneMap.professional
  const languageCode = inferCoverLetterLanguage(sj)
  const languageName = COVER_LETTER_LANGUAGE_NAMES[languageCode]
  const languageGuide = COVER_LETTER_FORMALITY_GUIDES[languageCode]

  const prompt = `Write a cover letter for a job applicant.

APPLICANT: ${name}${latestRole ? `, ${latestRole.role} at ${latestRole.company}` : ''}
MATCHED SKILLS: ${sj.matchedKeywords.join(', ')}
MISSING/ADD THESE: ${sj.missingKeywords.join(', ')}

TARGET: ${sj.job.role} at ${sj.job.company}${sj.job.location ? ` (${sj.job.location})` : ''}
${sj.job.description ? `JD EXCERPT:\n${sj.job.description.slice(0, 1000)}` : ''}

Tone: ${toneGuide}
Language: Write this cover letter in ${languageName}. ${languageGuide}
Structure: ${greeting} | hook | why this role | 2-3 achievements | CTA | Sincerely, ${name}
Rules: 220-280 words, no filler like "I am writing to express", quantify only claims supported by the confirmed Persona below. Never invent experience or qualifications.
CONFIRMED PERSONA:\n${persona.slice(0, 7000)}
${evidence}
Return ONLY the cover letter text.`

  const messages = systemPrompt
    ? [{ role: 'system' as const, content: `${systemPrompt}\nWrite in ${languageName}. ${languageGuide}` }, { role: 'user' as const, content: prompt }]
    : [{ role: 'user' as const, content: prompt }]

  await beforeModelCall?.()
  const result = await modelChat(messages, aiConfig, 800)
  return stripFences(result.text).trim()
}
