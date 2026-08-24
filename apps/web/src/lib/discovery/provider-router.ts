export type QuotaBand = 'green' | 'amber' | 'red' | 'exhausted'
export type ProviderClass = 'free' | 'platform' | 'paid'
export type ProviderAction = 'selected' | 'skipped'

export type DiscoveryProviderState = {
  quotaBand: QuotaBand
  circuitOpen: boolean
  recentErrorRate: number
  remainingRatio: number | null
}

export type ProviderCall = {
  id: string
  params: Record<string, string>
  expectedJobs?: number
}

export type ProviderDecision = {
  provider: string
  action: ProviderAction
  reason: string
  quotaBand: QuotaBand
}

export type ProviderReservation = {
  settle(jobsReturned: number, success: boolean): Promise<void>
}

export type ProviderPlanResult<T> = {
  items: T[]
  decisions: ProviderDecision[]
}

export type ProviderPlanOptions<T> = {
  calls: readonly ProviderCall[]
  availableProviders: ReadonlySet<string>
  states: ReadonlyMap<string, DiscoveryProviderState>
  targetResults: number
  execute: (call: ProviderCall) => Promise<T[]>
  count: (items: readonly T[]) => number
  reserve?: (call: ProviderCall) => Promise<ProviderReservation | null>
}

const FREE_PROVIDERS = new Set(['bundesagentur', 'irishjobs', 'jobicy', 'remotive'])
const PLATFORM_PROVIDERS = new Set(['cleanjobdata', 'fantasticjobs'])
const PREFERRED_ORDER = new Map([
  ['cleanjobdata', 0],
  ['fantasticjobs', 1],
  ['adzuna', 10],
  ['linkedin', 11],
  ['indeed', 12],
  ['ats', 13],
  ['jsearch', 14],
  ['careerjet', 15],
  ['reed', 16],
  ['xing', 17],
  ['mantiks', 18],
])

export function providerClass(provider: string): ProviderClass {
  if (FREE_PROVIDERS.has(provider)) return 'free'
  if (PLATFORM_PROVIDERS.has(provider)) return 'platform'
  return 'paid'
}

export function defaultProviderState(): DiscoveryProviderState {
  return { quotaBand: 'green', circuitOpen: false, recentErrorRate: 0, remainingRatio: null }
}

function stateFor(provider: string, states: ReadonlyMap<string, DiscoveryProviderState>): DiscoveryProviderState {
  return states.get(provider) ?? defaultProviderState()
}

function rank(call: ProviderCall): number {
  const base = PREFERRED_ORDER.get(call.id) ?? 30
  return base + (providerClass(call.id) === 'paid' ? 10 : 0)
}

function ordered(calls: readonly ProviderCall[]): ProviderCall[] {
  return [...calls].sort((a, b) => rank(a) - rank(b))
}

function unavailableReason(call: ProviderCall, state: DiscoveryProviderState, available: boolean): string | null {
  if (!available) return 'credential_unavailable'
  if (state.circuitOpen) return 'circuit_open'
  if (state.quotaBand === 'exhausted') return 'quota_exhausted'
  return null
}

function skip(decisions: ProviderDecision[], call: ProviderCall, state: DiscoveryProviderState, reason: string): void {
  decisions.push({ provider: call.id, action: 'skipped', reason, quotaBand: state.quotaBand })
}

async function executeOne<T>(
  call: ProviderCall,
  state: DiscoveryProviderState,
  execute: (call: ProviderCall) => Promise<T[]>,
  count: (items: readonly T[]) => number,
  reserve: ProviderPlanOptions<T>['reserve'],
  decisions: ProviderDecision[],
): Promise<T[]> {
  const reservation = reserve ? await reserve(call) : null
  if (reserve && !reservation) {
    skip(decisions, call, state, 'quota_reservation_denied')
    return []
  }
  decisions.push({ provider: call.id, action: 'selected', reason: 'eligible', quotaBand: state.quotaBand })
  try {
    const items = await execute(call)
    await reservation?.settle(count(items), true)
    return items
  } catch (error) {
    await reservation?.settle(0, false)
    throw error
  }
}

export async function executeProviderPlan<T>(options: ProviderPlanOptions<T>): Promise<ProviderPlanResult<T>> {
  const decisions: ProviderDecision[] = []
  const usable = options.calls.filter(call => {
    const state = stateFor(call.id, options.states)
    const reason = unavailableReason(call, state, options.availableProviders.has(call.id))
    if (reason) skip(decisions, call, state, reason)
    return !reason
  })
  const free = ordered(usable.filter(call => providerClass(call.id) === 'free'))
  const paid = ordered(usable.filter(call => providerClass(call.id) !== 'free'))
  const items: T[] = []

  const freeResults = await Promise.allSettled(free.map(call => executeOne(call, stateFor(call.id, options.states), options.execute, options.count, options.reserve, decisions)))
  for (const result of freeResults) if (result.status === 'fulfilled') items.push(...result.value)

  for (const call of paid) {
    if (options.count(items) >= options.targetResults) {
      skip(decisions, call, stateFor(call.id, options.states), 'result_target_reached')
      continue
    }
    try {
      items.push(...await executeOne(call, stateFor(call.id, options.states), options.execute, options.count, options.reserve, decisions))
    } catch {
      decisions.push({ provider: call.id, action: 'skipped', reason: 'provider_error', quotaBand: stateFor(call.id, options.states).quotaBand })
    }
  }

  return { items, decisions }
}
