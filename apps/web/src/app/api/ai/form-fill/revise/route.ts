import { NextRequest } from 'next/server'
import { prepareAiRoute, ok, err } from '@/lib/api-helpers'
import { modelChat, stripFences } from '@/lib/model-router'
import { FORM_REVISE_SYSTEM_PROMPT, buildFormRevisePrompt } from '@/lib/form-fill-prompts'

export const maxDuration = 180 // Allow 3 min for AI revision

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
}

export async function POST(req: NextRequest) {
  const prep = await prepareAiRoute(req, 'formRevise')
  if ('error' in prep) return prep.error

  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')

  const { fields, previousFill, persona, instruction } = body as {
    fields?: FormFieldSchema[]; previousFill?: FilledField[]; persona?: string; instruction?: string
  }

  if (!fields?.length) return err('fields array is required')
  if (!previousFill?.length) return err('previousFill array is required')
  if (!persona) return err('persona is required')
  if (!instruction) return err('instruction is required')

  const fieldsJson = JSON.stringify(fields.map(f => ({
    id: f.id, type: f.type, label: f.label, options: f.options, required: f.required,
  })))
  const previousJson = JSON.stringify(previousFill.map(f => ({
    fieldId: f.fieldId, value: f.value, confidence: f.confidence, reasoning: f.reasoning, skip: f.skip,
  })))

  const userPrompt = buildFormRevisePrompt(persona, fieldsJson, previousJson, instruction)

  try {
    const result = await modelChat(
      [
        { role: 'system', content: FORM_REVISE_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      prep.cfg,
      4096,
    )

    const text = stripFences(result.text).trim()
    let parsed: { fields: FilledField[] }
    try {
      parsed = JSON.parse(text) as { fields: FilledField[] }
      if (!parsed.fields || !Array.isArray(parsed.fields)) throw new Error('Invalid')
    } catch {
      const match = text.match(/\{[\s\S]*"fields"[\s\S]*\}/)
      if (match) parsed = JSON.parse(match[0]) as { fields: FilledField[] }
      else throw new Error('AI response could not be parsed')
    }

    return ok({ fields: parsed.fields })
  } catch (e) {
    console.error('[/api/ai/form-fill/revise]', e)
    return err(`Form revise failed: ${(e as Error).message}`, 500)
  }
}
