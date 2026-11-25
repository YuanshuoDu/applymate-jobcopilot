import { parseObjectiveReportScoreFloor } from '@jobcopilot/agent-protocol'
import { normalizeAgentLocationAllowlist } from '@jobcopilot/shared/agent-location-normalization'

export interface ObjectiveContextDraft {
  readonly objective: string
  readonly context: string
}

export class ObjectiveStartCommandError extends Error {
  readonly status: number
  readonly code: string
  readonly details: Readonly<Record<string, unknown>>

  constructor(status: number, code: string, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message)
    this.name = 'ObjectiveStartCommandError'
    this.status = status
    this.code = code
    this.details = details
  }
}

const MAX_OBJECTIVE_BYTES = 2_000
const MAX_CONTEXT_CHARACTERS = 20_000
const MAX_LOCATION_DRAFT_BYTES = 2_000

export function validateObjectiveContextDraft(draft: ObjectiveContextDraft): ObjectiveContextDraft {
  const objective = typeof draft.objective === 'string' ? draft.objective.trim() : ''
  const context = typeof draft.context === 'string' ? draft.context : ''
  if (!objective || new TextEncoder().encode(objective).byteLength > MAX_OBJECTIVE_BYTES) {
    throw invalidInput('Objective must contain 1 to 2,000 UTF-8 bytes')
  }
  if (context.length > MAX_CONTEXT_CHARACTERS) throw invalidInput('Background context must be 20,000 characters or fewer')
  return { objective, context }
}

export function normalizeAllowedLocationDraft(value: string): readonly string[] | undefined {
  if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > MAX_LOCATION_DRAFT_BYTES) {
    throw invalidInput('Allowed locations must be 2,000 UTF-8 bytes or fewer')
  }
  if (value.trim() === '') return undefined
  const locations = normalizeAgentLocationAllowlist(value.split(/\r?\n/).filter(entry => entry.trim() !== ''))
  if (!locations) throw invalidInput('Enter 1 to 8 allowed locations, each 128 UTF-8 bytes or fewer')
  return locations
}

export function parseReportScoreFloorDraft(value: string): number | undefined | null {
  if (value === '') return undefined
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return null
  return parseObjectiveReportScoreFloor(Number(value))
}

function invalidInput(message: string): ObjectiveStartCommandError {
  return new ObjectiveStartCommandError(422, 'invalid_command', message)
}
