import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyStateLoadError,
  classifyStateLoadQuery,
  safeStateLoadCategory,
  withStateLoadQueryDiagnostics,
} from './application-authenticated-state-diagnostics.mjs'

test('maps question recovery failures to fixed source-defined categories', () => {
  const storeCodes = new Map([
    ['question_conflict', 'question_store_conflict'],
    ['question_receipt_missing', 'question_store_receipt_missing'],
    ['question_receipt_malformed', 'question_store_receipt_malformed'],
    ['question_usage_unavailable', 'question_store_usage_unavailable'],
    ['question_invalid_owner', 'question_store_owner_invalid'],
    ['question_not_current', 'question_store_not_current'],
  ])
  for (const [code, expected] of storeCodes) {
    const error = Object.assign(new Error('private detail and identifier'), { name: 'TurnQuestionStoreError', code })
    assert.equal(classifyStateLoadError(error), expected)
  }
  const recoveryCodes = new Map([
    ['question_recovery_start_lineage_invalid', 'question_recovery_start'],
    ['question_recovery_answer_event_ambiguous', 'question_recovery_answer'],
    ['question_recovery_item_scope_invalid', 'question_recovery_item'],
    ['question_recovery_step_missing', 'question_recovery_step'],
    ['question_recovery_tool_lineage_invalid', 'question_recovery_tool'],
    ['question_recovery_history_pair_invalid', 'question_recovery_history'],
    ['question_recovery_sequence_invalid', 'question_recovery_sequence'],
    ['question_recovery_event_scope_invalid', 'question_recovery_other'],
  ])
  for (const [message, expected] of recoveryCodes) assert.equal(classifyStateLoadError(new Error(message)), expected)
  assert.equal(classifyStateLoadError(Object.assign(new Error('private'), { name: 'TurnQuestionStoreError', code: 'private-code' })), 'other')
  assert.equal(classifyStateLoadError(Object.assign(new Error('private'), { name: 'TurnEngineError', code: 'private-code' })), 'other')
  assert.equal(classifyStateLoadError(Object.assign(new Error('private'), { name: 'ContextSnapshotError', code: 'private-code' })), 'other')
  assert.equal(classifyStateLoadError(new Error('private question text')), 'other')
  assert.equal(safeStateLoadCategory('private text'), 'other')
})

test('classifies question and snapshot failures without exposing source text', () => {
  assert.equal(classifyStateLoadError(Object.assign(new Error('Invalid secret field'), { name: 'ContextSnapshotError', code: 'store_conflict' })), 'snapshot_store_conflict')
  assert.equal(classifyStateLoadError(Object.assign(new Error('private snapshot detail'), { name: 'ContextSnapshotError', code: 'checksum_mismatch' })), 'snapshot_checksum_mismatch')
  assert.equal(classifyStateLoadError(new TypeError('private runtime detail')), 'type_error')
  assert.equal(classifyStateLoadError(Object.assign(new Error('private database detail'), { code: '23505' })), 'database_data')
  assert.equal(classifyStateLoadError(Object.assign(new Error('private transport detail'), { code: 'ECONNRESET' })), 'database_transport')
})

test('groups SQL using fixed labels only', () => {
  assert.equal(classifyStateLoadQuery('BEGIN'), 'transaction')
  assert.equal(classifyStateLoadQuery('SELECT * FROM "agent_events" WHERE "type" = \'question.answered\' AND "id" = \'secret-id\''), 'question_lineage')
  assert.equal(classifyStateLoadQuery('SELECT * FROM "agent_events" WHERE "payload"->>\'waitId\' = $1'), 'question_planning')
  assert.equal(classifyStateLoadQuery('SELECT * FROM "agent_context_snapshots" WHERE "id" = $1'), 'snapshot')
  assert.equal(classifyStateLoadQuery('WITH current_start AS (SELECT 1) SELECT * FROM "agent_events"'), 'native_advisory')
  assert.equal(classifyStateLoadQuery('SELECT * FROM "agent_inputs" WHERE "targetTurnId" = $1 AND "acceptedSequence" > 0'), 'root_input')
  assert.equal(classifyStateLoadQuery({ text: 'SELECT private' }), 'other')
})

test('preserves query receivers, arguments, results, release, and rejected error identity', async () => {
  const markers = []
  const values = ['private-id']
  const sql = 'SELECT * FROM "agent_events" WHERE "type" = \'question.answered\' AND "id" = $1'
  const result = { rows: [{ id: 'private-id' }] }
  const queryError = Object.assign(new Error('private query error'), { code: 'ECONNRESET' })
  let queryShouldFail = false
  let queryCount = 0
  let releaseCount = 0
  let poolConnectThis
  let clientQueryThis
  let clientReleaseThis
  const client = {
    query(...args) {
      clientQueryThis = this
      assert.equal(args[0], sql)
      assert.strictEqual(args[1], values)
      queryCount += 1
      return queryShouldFail ? Promise.reject(queryError) : Promise.resolve(result)
    },
    release(...args) { clientReleaseThis = this; assert.deepEqual(args, ['release-private']); releaseCount += 1 },
  }
  const pool = {
    connect(...args) { poolConnectThis = this; assert.deepEqual(args, ['connect-private']); return Promise.resolve(client) },
  }
  const operation = async function (observedPool) {
    const connection = await observedPool.connect('connect-private')
    try { return await connection.query(sql, values) }
    finally { connection.release('release-private') }
  }
  const instrumented = withStateLoadQueryDiagnostics(operation, marker => markers.push(marker))
  const fulfilled = await instrumented(pool)
  assert.strictEqual(fulfilled, result)
  assert.strictEqual(poolConnectThis, pool)
  assert.strictEqual(clientQueryThis, client)
  assert.strictEqual(clientReleaseThis, client)
  assert.equal(releaseCount, 1)
  assert.deepEqual(markers, [
    'SYNTHETIC_STATE_QUERY connection start', 'SYNTHETIC_STATE_QUERY connection pass',
    'SYNTHETIC_STATE_QUERY question_lineage start', 'SYNTHETIC_STATE_QUERY question_lineage pass',
  ])
  queryShouldFail = true
  await assert.rejects(instrumented(pool), error => error === queryError)
  assert.equal(queryCount, 2)
  assert.equal(releaseCount, 2)
  assert.deepEqual(markers.slice(-4), [
    'SYNTHETIC_STATE_QUERY connection start', 'SYNTHETIC_STATE_QUERY connection pass',
    'SYNTHETIC_STATE_QUERY question_lineage start', 'SYNTHETIC_STATE_QUERY question_lineage fail',
  ])
  assert.doesNotMatch(markers.join('\n'), /private-id|private query error|ECONNRESET|SELECT|connect-private|release-private/)
})

test('caps query marker pairs while still running every query', async () => {
  const markers = []
  let count = 0
  const client = { query() { count += 1; return Promise.resolve({ rows: [] }) }, release() {} }
  const pool = { connect() { return Promise.resolve(client) } }
  const operation = async observedPool => {
    const connection = await observedPool.connect()
    try { for (let index = 0; index < 60; index += 1) await connection.query('SELECT 1') }
    finally { connection.release() }
    return count
  }
  const result = await withStateLoadQueryDiagnostics(operation, marker => markers.push(marker))(pool)
  assert.equal(result, 60)
  assert.equal(count, 60)
  assert.ok(markers.length <= 96)
  assert.ok(markers.every(marker => /^SYNTHETIC_STATE_QUERY [a-z_]+ (start|pass|fail)$/.test(marker)))
})

test('preserves synchronous connect and query throws', async () => {
  const connectMarkers = []
  const connectError = new Error('private synchronous connect failure')
  const connectPool = {
    connect() { assert.strictEqual(this, connectPool); throw connectError },
  }
  const connectOperation = async observedPool => observedPool.connect()
  await assert.rejects(
    withStateLoadQueryDiagnostics(connectOperation, marker => connectMarkers.push(marker))(connectPool),
    error => error === connectError,
  )
  assert.deepEqual(connectMarkers, ['SYNTHETIC_STATE_QUERY connection start', 'SYNTHETIC_STATE_QUERY connection fail'])

  const queryMarkers = []
  const queryError = new Error('private synchronous query failure')
  const client = { query() { assert.strictEqual(this, client); throw queryError }, release() {} }
  const pool = { connect() { return Promise.resolve(client) } }
  const operation = async observedPool => {
    const connection = await observedPool.connect()
    try { return await connection.query('SELECT 1') }
    finally { connection.release() }
  }
  await assert.rejects(
    withStateLoadQueryDiagnostics(operation, marker => queryMarkers.push(marker))(pool),
    error => error === queryError,
  )
  assert.deepEqual(queryMarkers, [
    'SYNTHETIC_STATE_QUERY connection start', 'SYNTHETIC_STATE_QUERY connection pass',
    'SYNTHETIC_STATE_QUERY other start', 'SYNTHETIC_STATE_QUERY other fail',
  ])
  assert.doesNotMatch([...connectMarkers, ...queryMarkers].join('\n'), /private synchronous|failure/)
})
