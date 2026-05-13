/**
 * POST /api/ai/interview-prep
 * Body: { jobTitle, jobCompany, jobDescription?, resumeContent? }
 * Returns: { questions, companyResearch, followUpEmail }
 */
import { NextRequest } from 'next/server'
import { prepareAiRoute, ok, err } from '@/lib/api-helpers'
import { modelChat, stripFences } from '@/lib/model-router'
import type { ResumeContent } from '@/lib/types'

export async function POST(req: NextRequest) {
  const prep = await prepareAiRoute(req, 'interviewPrep')
  if ('error' in prep) return prep.error

  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')

  const { jobTitle, jobCompany, jobDescription, resumeContent } = body as {
    jobTitle: string; jobCompany: string; jobDescription?: string; resumeContent?: ResumeContent
  }

  if (!jobTitle)   return err('jobTitle is required')
  if (!jobCompany) return err('jobCompany is required')
  const cfg = prep.cfg

  const resumeText = resumeContent
    ? `SKILLS: ${(resumeContent.skills ?? []).join(', ')}\nEXPERIENCE: ${(resumeContent.experience ?? []).map(e => `${e.role} at ${e.company}`).join('; ')}`
    : '(no resume)'

  const prompt = `You are an expert career coach preparing a candidate for an interview.

TARGET ROLE: ${jobTitle}
COMPANY: ${jobCompany}
${jobDescription ? `JOB DESCRIPTION:\n${jobDescription.slice(0, 2000)}` : ''}

CANDIDATE BACKGROUND:
${resumeText}

Return ONLY a valid JSON object — no markdown, no explanation:
{
  "questions": [
    { "question": "<interview question>", "framework": "<how to structure the answer, key points to hit>" }
  ],
  "companyResearch": "<2-3 paragraph summary of likely company culture, products, market position, recent news — note these are educated guesses based on company name/industry>",
  "followUpEmail": "<thank-you email template the candidate can send within 24 hours>"
}

Rules:
- questions: 6-8 questions mixing behavioral, technical, and company-specific
- framework for each question should be 2-4 sentences of concrete talking points
- followUpEmail should be 80-120 words, warm but professional
- All output in the same language as the job description/job title`

  try {
    const result = await modelChat([{ role: 'user', content: prompt }], cfg, 4096)
    const parsed = JSON.parse(stripFences(result.text))
    return ok({ ...parsed, _model: `${cfg.provider}/${cfg.model}` })
  } catch (e) {
    console.error('[/api/ai/interview-prep]', e)
    return err(`Interview prep failed (${cfg.provider}/${cfg.model}): ${(e as Error).message}`, 500)
  }
}
