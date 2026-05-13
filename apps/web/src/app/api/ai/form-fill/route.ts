import { NextRequest } from 'next/server'
import { prepareAiRoute, ok, err } from '@/lib/api-helpers'
import { modelChat, stripFences } from '@/lib/model-router'
import { FORM_FILL_SYSTEM_PROMPT, buildFormFillPrompt } from '@/lib/form-fill-prompts'

export const maxDuration = 180 // Allow 3 min for multi-field AI analysis

interface FormFieldSchema {
  id: string
  type: string
  label: string
  placeholder?: string
  options?: string[]
  required: boolean
  surroundingText: string
  groupName?: string
}

interface FilledField {
  fieldId: string
  value: string
  confidence: number
  reasoning: string
  skip: boolean
  personaRelevant?: boolean
}

interface FormFillResponse {
  fields: FilledField[]
}

const MAX_FIELDS = 60

export async function POST(req: NextRequest) {
  const prep = await prepareAiRoute(req, 'formFill')
  if ('error' in prep) return prep.error

  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')

  const { fields, persona, jobContext } = body as {
    fields?: FormFieldSchema[]; persona?: string; jobContext?: string
  }

  if (!fields?.length) return err('fields array is required')
  if (!persona) return err('persona is required')

  const limited = fields.slice(0, MAX_FIELDS)
  const fieldsJson = JSON.stringify(limited.map(f => ({
    id: f.id,
    type: f.type,
    label: f.label,
    placeholder: f.placeholder,
    options: f.options,
    required: f.required,
    surroundingText: f.surroundingText?.slice(0, 200),
    groupName: f.groupName,
  })))

  const userPrompt = buildFormFillPrompt(persona, fieldsJson, jobContext)

  try {
    const result = await modelChat(
      [
        { role: 'system', content: FORM_FILL_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      prep.cfg,
      8192, // Larger output for long-form answers + persona classification
    )

    const text = stripFences(result.text).trim()
    let parsed: FormFillResponse
    try {
      parsed = JSON.parse(text) as FormFillResponse
      if (!parsed.fields || !Array.isArray(parsed.fields)) {
        throw new Error('Invalid response format')
      }
    } catch {
      // Fallback: try to extract JSON from text
      const match = text.match(/\{[\s\S]*"fields"[\s\S]*\}/)
      if (match) parsed = JSON.parse(match[0]) as FormFillResponse
      else throw new Error('AI response could not be parsed')
    }

    // Map results back and ensure all fields have answers
    const resultFields = limited.map(f => {
      const found = parsed.fields.find(p => p.fieldId === f.id)
      return found ? { ...found, personaRelevant: found.personaRelevant ?? false } : {
        fieldId: f.id,
        value: '',
        confidence: 0,
        reasoning: 'No AI answer generated',
        skip: f.type === 'file',
        personaRelevant: false,
      }
    })

    return ok({ fields: resultFields })
  } catch (e) {
    console.error('[/api/ai/form-fill]', e)
    return err(`Form fill failed: ${(e as Error).message}`, 500)
  }
}
