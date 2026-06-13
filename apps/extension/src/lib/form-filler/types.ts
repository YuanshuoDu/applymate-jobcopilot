// ── Form Auto-Fill shared types ──

export interface FormFieldSchema {
  id: string
  type: 'text' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'date' | 'email' | 'tel' | 'url' | 'number' | 'file'
  label: string
  placeholder?: string
  options?: string[]
  required: boolean
  surroundingText: string
  groupName?: string
  currentValue?: string  // Already filled by user/browser — skip AI, use directly
}

export interface FilledField {
  fieldId: string
  value: string
  confidence: number
  reasoning: string
  skip: boolean
  personaRelevant?: boolean  // AI-classified: is this field worth saving to user persona?
}

export interface FormDetectionResult {
  fields: FormFieldSchema[]
  source: string
  formCount: number
  hasFileUpload: boolean
  hasCaptcha: boolean
}

export interface FormFillRequest {
  fields: FormFieldSchema[]
  persona: string
  jobContext?: string
}

export interface FormFillResponse {
  fields: FilledField[]
}

export interface FormReviseRequest {
  fields: FormFieldSchema[]
  previousFill: FilledField[]
  persona: string
  instruction: string
}
