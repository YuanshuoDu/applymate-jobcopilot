import {
  AgentObjectiveStartCoordinator,
  type ObjectiveStartResult,
} from './agent-objective-start-command'

export type ComposerTaskAttemptTarget =
  | { readonly kind: 'new-session' }
  | { readonly kind: 'selected-session'; readonly sessionId: string }

export interface ComposerTaskAttemptCoordinator {
  start(objectiveDraft: string, contextDraft: string, selectedSessionId?: string): Promise<ObjectiveStartResult>
  discard(): void
}

type AttemptState = 'ready' | 'pending' | 'unresolved' | 'accepted'

interface AttemptEntry {
  readonly target: ComposerTaskAttemptTarget
  readonly objective: string
  readonly aliases: Set<string>
  coordinator: AgentObjectiveStartCoordinator
  port: ComposerTaskAttemptCoordinator
  state: AttemptState
  result: ObjectiveStartResult | null
  pending: Promise<ObjectiveStartResult> | null
  removed: boolean
}

export class ComposerTaskAttemptConflictError extends Error {
  readonly code = 'task_attempt_unresolved'

  constructor() {
    super('Resolve or abandon the existing task attempt for this Session before changing its objective.')
    this.name = 'ComposerTaskAttemptConflictError'
  }
}

/**
 * Keeps uncertain starts retryable for the lifetime of the mounted composer.
 * A page reload or unmount needs a separate durable recovery mechanism.
 */
export class AgentComposerTaskAttemptRegistry {
  private readonly entries = new Set<AttemptEntry>()
  private readonly sessionAliases = new Map<string, Set<AttemptEntry>>()
  private readonly fetcher: typeof fetch
  private readonly makeClientMessageId: () => string

  constructor(options: { readonly fetcher?: typeof fetch; readonly makeClientMessageId?: () => string } = {}) {
    this.fetcher = options.fetcher ?? fetch
    this.makeClientMessageId = options.makeClientMessageId ?? defaultClientMessageId
  }

  /** Returns the coordinator bound to this normalized objective and target. */
  get(target: ComposerTaskAttemptTarget, objectiveDraft: string): ComposerTaskAttemptCoordinator {
    const objective = objectiveDraft.trim()
    if (!objective) throw new Error('Task objective is required.')
    const entry = this.findEntry(target, objective) ?? this.createEntry(target, objective)
    return entry.port
  }

  /** Removes only a matching accepted attempt after its result is consumed. */
  consume(target: ComposerTaskAttemptTarget, objectiveDraft: string): boolean {
    const entry = this.findEntry(target, objectiveDraft.trim())
    return entry ? this.consumeEntry(entry) : false
  }

  /** Explicitly abandons a non-pending attempt after the caller resolves the ambiguity. */
  abandon(target: ComposerTaskAttemptTarget, objectiveDraft: string): boolean {
    const entry = this.findEntry(target, objectiveDraft.trim())
    if (!entry || entry.state === 'pending') return false
    this.removeEntry(entry)
    entry.coordinator.discard()
    return true
  }

  private findEntry(target: ComposerTaskAttemptTarget, objective: string): AttemptEntry | null {
    if (target.kind === 'selected-session') {
      const aliases = this.sessionAliases.get(target.sessionId)
      if (aliases) {
        const activeAliases = [...aliases].filter(entry => !entry.removed)
        if (activeAliases.length > 1) throw new ComposerTaskAttemptConflictError()
        if (activeAliases.length === 1) return this.requireSameObjective(activeAliases[0]!, objective)
        this.sessionAliases.delete(target.sessionId)
      }
    }

    const matches = [...this.entries].filter(entry => !entry.removed && sameTarget(entry.target, target))
    if (matches.length === 0) return null
    const exact = matches.find(entry => entry.objective === objective)
    if (exact && matches.length === 1) return exact
    throw new ComposerTaskAttemptConflictError()
  }

  private requireSameObjective(entry: AttemptEntry, objective: string): AttemptEntry {
    if (entry.removed || entry.objective !== objective) throw new ComposerTaskAttemptConflictError()
    return entry
  }

  private createEntry(target: ComposerTaskAttemptTarget, objective: string): AttemptEntry {
    assertValidTarget(target)
    const entry: AttemptEntry = {
      target,
      objective,
      aliases: new Set(),
      coordinator: null as unknown as AgentObjectiveStartCoordinator,
      port: null as unknown as ComposerTaskAttemptCoordinator,
      state: 'ready',
      result: null,
      pending: null,
      removed: false,
    }
    entry.coordinator = new AgentObjectiveStartCoordinator(
      this.trackCreatedSession(entry),
      this.makeClientMessageId,
    )
    entry.port = {
      start: (draft, context, selectedSessionId) => this.startEntry(entry, draft, context, selectedSessionId),
      discard: () => { this.consumeEntry(entry) },
    }
    this.entries.add(entry)
    return entry
  }

  private startEntry(
    entry: AttemptEntry,
    objectiveDraft: string,
    contextDraft: string,
    selectedSessionId?: string,
  ): Promise<ObjectiveStartResult> {
    if (entry.removed) return Promise.reject(new Error('This task attempt has already been consumed.'))
    if (objectiveDraft.trim() !== entry.objective || contextDraft !== '' || !this.matchesStartTarget(entry, selectedSessionId)) {
      return Promise.reject(new ComposerTaskAttemptConflictError())
    }
    if (entry.state === 'accepted' && entry.result) return Promise.resolve(entry.result)
    if (entry.pending) return entry.pending

    entry.state = 'pending'
    let tracked: Promise<ObjectiveStartResult>
    tracked = Promise.resolve()
      .then(() => entry.coordinator.start(entry.objective, '', selectedSessionId))
      .then(result => {
        if (!entry.removed) {
          entry.state = 'accepted'
          entry.result = result
        }
        return result
      }, error => {
        if (!entry.removed) entry.state = 'unresolved'
        throw error
      })
      .finally(() => {
        if (entry.pending === tracked) entry.pending = null
      })
    entry.pending = tracked
    return tracked
  }

  private matchesStartTarget(entry: AttemptEntry, selectedSessionId?: string): boolean {
    if (selectedSessionId === undefined) return entry.target.kind === 'new-session'
    return (entry.target.kind === 'selected-session' && entry.target.sessionId === selectedSessionId)
      || entry.aliases.has(selectedSessionId)
  }

  private trackCreatedSession(entry: AttemptEntry): typeof fetch {
    return async (input, init) => {
      const response = await this.fetcher(input, init)
      if (response.ok && isSessionCreationRequest(input, init)) {
        const sessionId = readCreatedSessionId(await response.clone().json().catch(() => null))
        if (sessionId) this.aliasSession(entry, sessionId)
      }
      return response
    }
  }

  private aliasSession(entry: AttemptEntry, sessionId: string): void {
    const directEntries = [...this.entries].filter(candidate => !candidate.removed
      && candidate !== entry && candidate.target.kind === 'selected-session'
      && candidate.target.sessionId === sessionId)
    const aliases = this.sessionAliases.get(sessionId) ?? new Set<AttemptEntry>()
    for (const candidate of directEntries) {
      aliases.add(candidate)
      candidate.aliases.add(sessionId)
    }
    aliases.add(entry)
    this.sessionAliases.set(sessionId, aliases)
    entry.aliases.add(sessionId)
  }

  private consumeEntry(entry: AttemptEntry): boolean {
    if (entry.removed || entry.state !== 'accepted') return false
    this.removeEntry(entry)
    entry.coordinator.discard()
    return true
  }

  private removeEntry(entry: AttemptEntry): void {
    entry.removed = true
    this.entries.delete(entry)
    for (const sessionId of entry.aliases) {
      const aliases = this.sessionAliases.get(sessionId)
      aliases?.delete(entry)
      if (aliases?.size === 0) this.sessionAliases.delete(sessionId)
    }
    entry.aliases.clear()
  }
}

function sameTarget(left: ComposerTaskAttemptTarget, right: ComposerTaskAttemptTarget): boolean {
  return left.kind === right.kind && (left.kind === 'new-session'
    || (right.kind === 'selected-session' && left.sessionId === right.sessionId))
}

function assertValidTarget(target: ComposerTaskAttemptTarget): void {
  if (target.kind === 'selected-session'
    && (!target.sessionId || target.sessionId.trim() !== target.sessionId || target.sessionId.length > 256)) {
    throw new Error('Selected Session ID is invalid.')
  }
}

function isSessionCreationRequest(input: RequestInfo | URL, init?: RequestInit): boolean {
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  if (method !== 'POST') return false
  const rawUrl = input instanceof Request ? input.url : String(input)
  try {
    return new URL(rawUrl, 'http://localhost').pathname === '/api/agent/sessions'
  } catch {
    return false
  }
}

function readCreatedSessionId(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.session)) return null
  const id = value.session.id
  return typeof id === 'string' && id.length > 0 && id.trim() === id ? id : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function defaultClientMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `objective-start-${crypto.randomUUID()}`
  return `objective-start-${Date.now()}-${Math.random().toString(36).slice(2)}`
}
