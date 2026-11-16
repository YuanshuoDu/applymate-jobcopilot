import {
  AgentComposerTaskAttemptStore,
  type AgentComposerTaskAttemptMetadata,
} from './agent-composer-task-attempt-store'
import {
  AgentComposerTaskRecoveryError as RecoveryError,
  canAdvanceRecoveryPhase as phaseChange,
  classifyRecoveryError,
  parseRecoveryAccountIndex as parseAccountIndex,
  parseRecoveryAttempt as parseAttempt,
  parseRecoveryCreate as parseCreate,
  parseRecoveryScopedBody as parseScopedBody,
  recoveryErrorState as errorState,
  validRecoveryId as validId,
  type AgentComposerTaskRecoveryNoticeState,
  type AgentComposerTaskRecoveryServerAttempt as ServerAttempt,
  type AgentComposerTaskRecoveryScopedBody as ScopedBody,
  type AgentComposerTaskRecoveryItem,
  type AgentComposerTaskRecoverySnapshot,
} from './agent-composer-task-recovery-protocol'

export type {
  AgentComposerTaskRecoveryItem,
  AgentComposerTaskRecoveryNoticeState,
  AgentComposerTaskRecoverySnapshot,
} from './agent-composer-task-recovery-protocol'

type Options = Readonly<{ fetcher?: typeof fetch; store?: Pick<AgentComposerTaskAttemptStore, 'list' | 'advance' | 'bindCreatedSession' | 'removeResolved'> }>

export class AgentComposerTaskRecoveryController {
  private readonly fetcher: typeof fetch
  private readonly store: Pick<AgentComposerTaskAttemptStore, 'list' | 'advance' | 'bindCreatedSession' | 'removeResolved'>
  private accountScope: string | null = null
  private generation = 0
  private readonly entries = new Map<string, AgentComposerTaskAttemptMetadata>()
  private readonly busy = new Set<string>()

  constructor(options: Options = {}) {
    this.fetcher = (options.fetcher ?? globalThis.fetch).bind(globalThis)
    this.store = options.store ?? new AgentComposerTaskAttemptStore()
  }

  async load(): Promise<AgentComposerTaskRecoverySnapshot> {
    const generation = ++this.generation
    this.accountScope = null
    this.entries.clear()
    try {
      const scope = await this.readAccountScope(); this.assertGeneration(generation)
      const rows = await this.store.list(scope)
      this.assertGeneration(generation)
      this.accountScope = scope
      for (const row of rows) this.entries.set(row.attemptKey, row)
      const attempts = await Promise.all(rows.map(async row => ({ attemptKey: row.attemptKey, state: await this.reconcile(row, scope, generation) })))
      await this.verifyCurrentScope(scope, generation)
      return { kind: 'ready', accountScope: scope, attempts }
    } catch (error) {
      this.invalidate(generation)
      const reason = classifyRecoveryError(error)
      return { kind: 'unavailable', reason: reason === 'storage' ? 'storage' : 'error' }
    }
  }

  async check(attemptKey: string): Promise<AgentComposerTaskRecoveryNoticeState> {
    if (this.busy.has(attemptKey)) return { kind: 'unknown', busy: true }
    this.busy.add(attemptKey)
    try {
      const { scope, generation, row } = await this.prepare(attemptKey)
      const state = await this.reconcile(row, scope, generation)
      await this.verifyCurrentScope(scope, generation)
      return state
    } catch (error) { return errorState(classifyRecoveryError(error)) }
    finally { this.busy.delete(attemptKey) }
  }

  async abandon(attemptKey: string): Promise<AgentComposerTaskRecoveryNoticeState> {
    if (this.busy.has(attemptKey)) return { kind: 'unknown', busy: true }
    this.busy.add(attemptKey)
    try {
      const { scope, generation, row } = await this.prepare(attemptKey)
      const current = parseAttempt(await this.scopedJson(`/api/agent/objective-start-attempts/${encodeURIComponent(attemptKey)}`, scope, generation))
      if (current.state !== 'unknown') {
        const state = await this.toNotice(current, row, scope, generation)
        await this.verifyCurrentScope(scope, generation)
        return state
      }
      const body = await this.scopedJson(`/api/agent/objective-start-attempts/${encodeURIComponent(attemptKey)}/abandon`, scope, generation,
        { method: 'POST' })
      const state = await this.toNotice(parseAttempt(body), row, scope, generation)
      await this.verifyCurrentScope(scope, generation)
      return state
    } catch (error) { return errorState(classifyRecoveryError(error)) }
    finally { this.busy.delete(attemptKey) }
  }

  /** Consumes a freshly confirmed accepted marker before navigation can change controller identity. */
  async openAccepted(attemptKey: string, open: (sessionId: string, turnId: string) => void | Promise<void>): Promise<'opened' | 'consumed' | false> {
    const scope = this.accountScope, generation = this.generation
    if (!scope) return false
    try {
      await this.verifyCurrentScope(scope, generation)
      this.assertIdentity(scope, generation)
      const state = await this.check(attemptKey)
      this.assertIdentity(scope, generation)
      if (state.kind !== 'accepted') return false
      await this.verifyCurrentScope(scope, generation)
      this.assertIdentity(scope, generation)
      if (!this.entries.has(attemptKey)) return false
      if (!(await this.store.removeResolved(scope, attemptKey))) return false
      this.assertIdentity(scope, generation)
      this.entries.delete(attemptKey)
      // The accepted receipt remains on the server if this local navigation callback fails.
      try { await open(state.sessionId, state.turnId); return 'opened' }
      catch { return 'consumed' }
    } catch { return false }
  }

  /** Removes only a server-confirmed abandoned or accepted-but-unavailable recovery marker. */
  async removeRecoveryNotice(attemptKey: string): Promise<boolean> {
    try {
      const { scope, generation, row } = await this.prepare(attemptKey)
      const result = parseAttempt(await this.scopedJson(`/api/agent/objective-start-attempts/${encodeURIComponent(attemptKey)}`, scope, generation))
      if (result.state === 'abandoned') {
        if (row.phase !== 'abandoned') await this.store.advance(scope, attemptKey, 'abandoned')
      } else if (result.state === 'unavailable') {
        if (row.phase !== 'accepted') await this.store.advance(scope, attemptKey, 'accepted')
      } else return false
      await this.verifyCurrentScope(scope, generation)
      const removed = await this.store.removeResolved(scope, attemptKey)
      this.assertIdentity(scope, generation)
      if (removed) this.entries.delete(attemptKey)
      return removed
    } catch { return false }
  }

  dispose(): void { this.generation += 1; this.accountScope = null; this.entries.clear(); this.busy.clear() }

  private async prepare(attemptKey: string) {
    if (!validId(attemptKey, 128) || !this.accountScope) throw new RecoveryError('error')
    const scope = this.accountScope, generation = this.generation
    await this.verifyCurrentScope(scope, generation)
    let row = this.entries.get(attemptKey)
    if (!row) { row = (await this.store.list(scope)).find(item => item.attemptKey === attemptKey); this.assertIdentity(scope, generation) }
    if (!row) throw new RecoveryError('storage')
    this.remember(scope, generation, row)
    return { scope, generation, row }
  }

  private async reconcile(row: AgentComposerTaskAttemptMetadata, scope: string, generation: number): Promise<AgentComposerTaskRecoveryNoticeState> {
    try {
      let sessionId = row.sessionId ?? undefined
      if (row.createKey) {
        const created = parseCreate(await this.scopedJson('/api/agent/sessions/reconcile-create', scope, generation,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idempotencyKey: row.createKey }) }))
        if (created.state === 'found') {
          if (sessionId && sessionId !== created.sessionId) throw new RecoveryError('error')
          sessionId = created.sessionId
          if (row.targetKind === 'new-session' && row.phase !== 'abandoned') {
            if (row.phase === 'prepared') { row = await this.store.advance(scope, row.attemptKey, 'create-requested'); this.assertIdentity(scope, generation) }
            row = await this.store.bindCreatedSession(scope, row.attemptKey, sessionId)
            this.remember(scope, generation, row)
          }
        }
      }
      const attempt = parseAttempt(await this.scopedJson(`/api/agent/objective-start-attempts/${encodeURIComponent(row.attemptKey)}`, scope, generation))
      return await this.toNotice(attempt, { ...row, sessionId: sessionId ?? row.sessionId }, scope, generation)
    } catch (error) { return errorState(classifyRecoveryError(error)) }
  }

  private async toNotice(attempt: ServerAttempt, row: AgentComposerTaskAttemptMetadata, scope: string,
    generation: number): Promise<AgentComposerTaskRecoveryNoticeState> {
    if (row.phase === 'accepted' && attempt.state !== 'accepted' && attempt.state !== 'unavailable' || row.phase === 'abandoned' && attempt.state !== 'abandoned') return errorState('error')
    if (attempt.state === 'accepted') {
      if (row.sessionId && row.sessionId !== attempt.receipt.sessionId) return errorState('error')
      if (row.targetKind === 'new-session' && row.phase !== 'abandoned' && row.phase !== 'accepted') {
        let current = row
        try {
          if (current.phase === 'prepared') { current = await this.store.advance(scope, row.attemptKey, 'create-requested'); this.assertIdentity(scope, generation) }
          current = await this.store.bindCreatedSession(scope, row.attemptKey, attempt.receipt.sessionId)
        } catch { return errorState('storage') }
        this.remember(scope, generation, current)
        row = current
      }
      if (row.phase !== 'accepted' && phaseChange(row.phase, 'accepted')) {
        try { row = await this.store.advance(scope, row.attemptKey, 'accepted'); this.remember(scope, generation, row) }
        catch { return errorState('storage') }
      }
      await this.verifyCurrentScope(scope, generation)
      return { kind: 'accepted', sessionId: attempt.receipt.sessionId, turnId: attempt.receipt.turnId }
    }
    if (attempt.state === 'unavailable') {
      if (row.phase !== 'accepted' && phaseChange(row.phase, 'accepted')) {
        try { row = await this.store.advance(scope, row.attemptKey, 'accepted'); this.remember(scope, generation, row) } catch { /* keep the marker */ }
      }
      return { kind: 'unavailable', reason: 'accepted-target-missing' }
    }
    if (attempt.state === 'abandoned') {
      if (row.phase !== 'abandoned' && phaseChange(row.phase, 'abandoned')) {
        try { row = await this.store.advance(scope, row.attemptKey, 'abandoned'); this.remember(scope, generation, row) } catch { return errorState('storage') }
      }
      return { kind: 'abandoned', ...(row.sessionId ? { sessionId: row.sessionId } : {}) }
    }
    // A read-only reconciliation can race the writer that is still admitting
    // this attempt. Keep its durable phase unchanged; `unknown` is only the
    // server evidence shown to the user, not proof that admission has stopped.
    return { kind: 'unknown' }
  }

  private async readAccountScope(): Promise<string> {
    const response = await this.fetcher('/api/agent/objective-start-attempts?limit=20', { method: 'GET', cache: 'no-store', credentials: 'same-origin' })
    if (!response.ok) throw new RecoveryError('error')
    return parseAccountIndex(await this.json(response), response)
  }

  private async verifyCurrentScope(scope: string, generation: number): Promise<void> {
    this.assertIdentity(scope, generation)
    if (await this.readAccountScope() !== scope) throw new RecoveryError('error')
    this.assertIdentity(scope, generation)
  }
  private remember(scope: string, generation: number, row: AgentComposerTaskAttemptMetadata): void { this.assertIdentity(scope, generation); this.entries.set(row.attemptKey, row) }
  private async scopedJson(path: string, scope: string, generation: number, init: RequestInit = {}): Promise<ScopedBody> {
    const response = await this.scopedFetch(path, scope, generation, init)
    if (!response.ok) throw new RecoveryError('error')
    const body = await this.json(response); this.assertIdentity(scope, generation)
    return parseScopedBody(body, response, scope)
  }

  private async scopedFetch(path: string, scope: string, generation: number, init: RequestInit): Promise<Response> {
    this.assertIdentity(scope, generation)
    const headers = new Headers(init.headers); headers.set('X-Expected-Account-Scope', scope)
    const response = await this.fetcher(path, { ...init, headers, cache: 'no-store', credentials: 'same-origin' })
    this.assertIdentity(scope, generation)
    return response
  }
  private async json(response: Response): Promise<unknown> { try { return await response.json() } catch { throw new RecoveryError('error') } }

  private assertGeneration(generation: number): void {
    if (generation !== this.generation) throw new RecoveryError('error')
  }
  private assertIdentity(scope: string, generation: number): void {
    if (generation !== this.generation || this.accountScope !== scope) throw new RecoveryError('error')
  }
  private invalidate(generation: number): void {
    if (generation !== this.generation) return
    this.generation += 1; this.accountScope = null; this.entries.clear()
  }
}
