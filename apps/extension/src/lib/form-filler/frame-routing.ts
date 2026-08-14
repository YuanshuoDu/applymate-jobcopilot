import type { FilledField, FormFieldSchema } from './types'

export interface FrameFieldGroup {
  frameId: number
  fields: FilledField[]
  schemas: FormFieldSchema[]
}

/** Keep AI results routed to the frame where each field was discovered. */
export function groupFilledFieldsByFrame(
  filledFields: FilledField[],
  schemas: FormFieldSchema[],
): FrameFieldGroup[] {
  const schemaById = new Map(schemas.map(schema => [schema.id, schema]))
  const groups = new Map<number, FrameFieldGroup>()

  for (const field of filledFields) {
    const frameId = schemaById.get(field.fieldId)?.frameId ?? 0
    const group = groups.get(frameId) ?? { frameId, fields: [], schemas: [] }
    group.fields.push(field)
    const schema = schemaById.get(field.fieldId)
    if (schema) group.schemas.push(schema)
    groups.set(frameId, group)
  }

  return [...groups.values()].sort((a, b) => a.frameId - b.frameId)
}

export function groupFieldIdsByFrame(fieldIds: string[], schemas: FormFieldSchema[]): Map<number, string[]> {
  const schemaById = new Map(schemas.map(schema => [schema.id, schema]))
  const groups = new Map<number, string[]>()
  for (const fieldId of fieldIds) {
    const frameId = schemaById.get(fieldId)?.frameId ?? 0
    const group = groups.get(frameId) ?? []
    group.push(fieldId)
    groups.set(frameId, group)
  }
  return groups
}
