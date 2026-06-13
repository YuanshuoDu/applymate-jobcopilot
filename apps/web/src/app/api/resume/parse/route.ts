/**
 * POST /api/resume/parse
 * Body: multipart/form-data with field "file" (PDF or DOCX, ≤ 5 MB)
 * Returns: { content: ResumeContent }
 *
 * Pipeline: extract text → Claude → structured ResumeContent
 */
import { NextRequest } from 'next/server'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { checkRateLimit } from '@/lib/rate-limit'
import { modelChat, parseAiJson, loadUserAiConfig, type AiConfig } from '@/lib/model-router'

const PARSE_FALLBACKS: AiConfig[] = [
  { provider: 'deepseek', model: 'deepseek-chat' },
  { provider: 'minimax',  model: 'MiniMax-M2.7'  },
]
import type { ResumeContent } from '@/lib/types'

const MAX_BYTES = 5 * 1024 * 1024 // 5 MB

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const rl = checkRateLimit(`resume-parse:${auth.userId}`, 10, 60_000)
  if (!rl.ok) return err(`Rate limit exceeded — retry in ${rl.retryAfter}s`, 429)

  let formData: FormData
  try {
    formData = await req.formData()
  } catch {
    return err('Invalid form data')
  }

  const file = formData.get('file') as File | null
  if (!file) return err('No file provided')
  if (file.size > MAX_BYTES) return err('File too large (max 5 MB)')

  const mime = file.type.toLowerCase()
  const name = file.name.toLowerCase()
  const isPdf  = mime === 'application/pdf' || name.endsWith('.pdf')
  const isDocx = mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
              || name.endsWith('.docx')

  if (!isPdf && !isDocx) return err('Unsupported file type — upload PDF or DOCX')

  // ── 1. Extract raw text ───────────────────────────────────────────────────
  let rawText = ''
  try {
    const arrayBuffer = await file.arrayBuffer()

    const buffer = Buffer.from(arrayBuffer)
    if (isPdf) {
      const pdfParse = (await import('pdf-parse')).default
      const result   = await pdfParse(buffer)
      rawText = result.text
    } else {
      const mammoth = await import('mammoth')
      const result  = await mammoth.extractRawText({ buffer })
      rawText = result.value
    }
  } catch (e) {
    console.error('[resume/parse] extraction error', e)
    return err('Could not extract text from file — try re-saving the document')
  }

  rawText = rawText.trim()
  if (rawText.length < 100) return err('Extracted text is too short — ensure the file is not scanned/image-only')
  // Truncate to avoid token overflow (~12 000 chars ≈ 3 000 tokens)
  if (rawText.length > 12_000) rawText = rawText.slice(0, 12_000) + '\n[... truncated]'

  // ── 2. AI parse ───────────────────────────────────────────────────────────
  const primaryCfg = await loadUserAiConfig(auth.userId, 'parsing')

  const systemPrompt = `You are an expert resume parser. Extract structured data from the raw resume text below and return ONLY valid JSON matching this TypeScript interface (no markdown fences, no explanation):

interface ResumeContent {
  contact: {
    name: string
    email: string
    location: string
    phone?: string
    linkedin?: string
    github?: string
    website?: string
  }
  summary: string
  experience: Array<{
    company: string
    role: string
    period: string
    bullets: string[]
  }>
  education: Array<{
    institution: string
    degree: string
    year: string
  }>
  skills: string[]
  languages?: Array<{ lang: string; level: string }>
  projects?: Array<{
    name: string
    role?: string
    period?: string
    url?: string
    bullets: string[]
  }>
  certifications?: Array<{
    name: string
    issuer: string
    date: string
    url?: string
  }>
}

Rules:
- skills: deduplicated concise noun phrases ("React", "Python", "Project Management")
- bullets: complete sentences starting with a strong past-tense verb (present for current roles)
- Omit fields missing from the resume — never invent data
- period format: "Mon YYYY – Mon YYYY" or "YYYY – YYYY"; use "Present" for current roles
- Return [] for sections with no data, not null
- summary: if absent, write a concise 2-sentence professional summary derived from the resume`

  const messages = [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user'   as const, content: `Parse this resume:\n\n${rawText}` },
  ]

  // Try primary model then fallbacks
  async function tryParse(): Promise<string> {
    const attempts = [primaryCfg, ...PARSE_FALLBACKS.filter(f =>
      !(f.provider === primaryCfg.provider && f.model === primaryCfg.model)
    )]
    let lastErr: unknown
    for (const attempt of attempts) {
      try {
        const result = await modelChat(messages, attempt, 4096)
        return result.text
      } catch (e) {
        lastErr = e
        console.warn(`[resume/parse] ${attempt.provider}/${attempt.model} failed:`, (e as Error).message?.slice(0, 100))
      }
    }
    throw lastErr
  }

  let parsed: ResumeContent
  try {
    const rawResponse = await tryParse()
    parsed = parseAiJson<ResumeContent>(rawResponse)
  } catch (e) {
    console.error('[resume/parse] AI error', e)
    return err('AI parsing failed — please try again or fill in manually')
  }

  // ── 3. Sanitise ───────────────────────────────────────────────────────────
  if (!parsed.contact) parsed.contact = { name: '', email: '', location: '' }
  if (!Array.isArray(parsed.experience))    parsed.experience    = []
  if (!Array.isArray(parsed.education))     parsed.education     = []
  if (!Array.isArray(parsed.skills))        parsed.skills        = []
  parsed.summary = parsed.summary ?? ''
  // Deduplicate skills (case-insensitive)
  const seen = new Set<string>()
  parsed.skills = parsed.skills.filter(s => {
    const k = s.toLowerCase().trim()
    if (seen.has(k)) return false
    seen.add(k); return true
  })

  return ok({ content: parsed })
}
