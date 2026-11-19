const VERIFICATION_SCHEMA = 'agent-harness.v2.task-graph-verification.v1'
const CRITERION_ID = /^[a-z][a-z0-9._-]{0,63}$/

type Criterion = { id: string; check: Record<string, unknown> }

/** Maps a valid repair subset to safe positions in the target's ordered verification summary. */
export function projectRepairTargetCheckIndexes(sourceValue: unknown, targetValue: unknown, relationValue: unknown): readonly number[] | null {
  const source = record(sourceValue)
  const target = record(targetValue)
  const relation = record(relationValue)
  if (!source || !target || !relation || !exactKeys(relation, 'criterionIds,graphRootTaskId,nodeKey,taskId')
    || relation.nodeKey !== target.key || relation.taskId !== target.taskId || source.key === target.key
    || source.taskId === target.taskId) return null
  const ids = relation.criterionIds
  const sourceCriteria = typedCriteria(source)
  const targetCriteria = typedCriteria(target)
  if (!criterionIds(ids) || !sourceCriteria || !targetCriteria || source.templateId !== target.templateId
    || sourceCriteria.length !== ids.length || !ids.every(id => sourceCriteria.some(item => item.id === id))) return null
  const targetIndexes = new Map(targetCriteria.map((item, index) => [item.id, index]))
  const sourceById = new Map(sourceCriteria.map(item => [item.id, item.check]))
  if (ids.some(id => {
    const targetIndex = targetIndexes.get(id)
    return targetIndex === undefined || !sameJsonValue(sourceById.get(id), targetCriteria[targetIndex]?.check)
  })) return null
  return ids.map(id => targetIndexes.get(id)!).sort((left, right) => left - right)
}

function typedCriteria(node: Record<string, unknown>): Criterion[] | null {
  const role = node.templateId === 'scout' ? 'scout' : node.templateId === 'analyst' ? 'analyst' : null
  const contract = record(node.verification)
  if (node.verificationDisposition !== 'typed' || !role || !contract
    || !exactKeys(contract, 'criteria,role,schemaVersion') || contract.role !== role
    || contract.schemaVersion !== VERIFICATION_SCHEMA || !denseArray(contract.criteria, 1, 8)) return null
  const criteria: Criterion[] = []
  for (const value of contract.criteria) {
    const item = record(value)
    const check = item && record(item.check)
    if (!item || !check || !exactKeys(item, 'check,id') || typeof item.id !== 'string'
      || !CRITERION_ID.test(item.id) || criteria.some(criterion => criterion.id === item.id)) return null
    criteria.push({ id: item.id, check })
  }
  return criteria
}

function criterionIds(value: unknown): value is string[] {
  return denseArray(value, 1, 8) && value.every(id => typeof id === 'string' && CRITERION_ID.test(id))
    && new Set(value).size === value.length
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  const first = canonicalJson(left)
  return first !== null && first === canonicalJson(right)
}

function canonicalJson(value: unknown): string | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value) ?? null
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : null
  if (Array.isArray(value)) {
    if (!denseArray(value, 0, 8)) return null
    const values = value.map(canonicalJson)
    return values.some(item => item === null) ? null : `[${values.join(',')}]`
  }
  const row = record(value)
  if (!row) return null
  const entries = Object.keys(row).sort().map(key => {
    const item = canonicalJson(row[key])
    return item === null ? null : `${JSON.stringify(key)}:${item}`
  })
  return entries.some(entry => entry === null) ? null : `{${entries.join(',')}}`
}

function exactKeys(value: Record<string, unknown>, expected: string): boolean {
  return Reflect.ownKeys(value).sort().join(',') === expected
}

function denseArray(value: unknown, minimum: number, maximum: number): value is unknown[] {
  return Array.isArray(value) && value.length >= minimum && value.length <= maximum
    && Reflect.ownKeys(value).length === value.length + 1
    && Array.from({ length: value.length }, (_, index) => String(index)).every(key => Object.hasOwn(value, key))
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    const keys = Reflect.ownKeys(value)
    return (prototype === Object.prototype || prototype === null)
      && keys.every(key => typeof key === 'string' && Object.prototype.propertyIsEnumerable.call(value, key))
      ? value as Record<string, unknown> : null
  } catch { return null }
}
