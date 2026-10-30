// Synthetic model used only by the isolated authenticated question fixture.
// This does not prove approval, submission, an employer receipt, or real AI use.
// Its caller must verify the Docker network and fresh services independently.
import { createRequire } from 'node:module'
import path from 'node:path'

const expectedDatabase = 'postgresql://fixture:fixture@db:5432/application_flow_fixture'
const expectedRedis = 'redis://redis:6379/15'
const expectedWeb = 'http://127.0.0.1:3100'
const fixtureSecret = 'fixture-only-worker-secret-at-least-32-bytes'
const goal = 'Fixture native question round'
const question = 'Which synthetic city should the fixture use?'
const answer = 'Fixture Dublin'
const finalText = 'Synthetic question was answered and the canonical turn resumed.'

function requireFixtureEnvironment() {
  if (process.env.CI !== 'true' || process.env.APPLICATION_AUTH_DISPOSABLE !== 'true'
    || process.env.APPLICATION_AUTH_AGENT_REVIEWED_EXECUTION !== 'true'
    || process.env.DATABASE_URL !== expectedDatabase || process.env.DIRECT_URL !== expectedDatabase
    || process.env.REDIS_URL !== expectedRedis || process.env.AGENT_WEB_URL !== expectedWeb
    || process.env.AGENT_WORKER_SECRET !== fixtureSecret || process.env.RLS_RUNTIME_MODE !== 'off'
    || process.env.AGENT_PREVIEW_FIXTURE
    || process.env.ENABLE_AGENT_CHILD_EXECUTION !== '1' || process.env.ENABLE_AGENT_WAIT_RESOLVER !== '1'
    || process.env.ENABLE_AGENT_TASK_GRAPH_PLANNING !== '1') {
    throw new Error('Refusing to start outside the reviewed disposable fixture')
  }
  // No production provider credentials should be inherited into this process.
  for (const [key, value] of Object.entries(process.env)) {
    if (value && /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PRIVATE_KEY)/i.test(key)) {
      throw new Error('Refusing to start with a provider or access credential')
    }
  }
}

requireFixtureEnvironment()
const workerRequire = createRequire(path.resolve('apps/worker/package.json'))
const { Pool } = workerRequire('pg')
const Redis = workerRequire('ioredis')
const pool = new Pool({ connectionString: expectedDatabase, max: 5 })
const redisProbe = new Redis(expectedRedis, { lazyConnect: true, maxRetriesPerRequest: 0, connectTimeout: 5000 })
let bootstrap
let wakeup
let eventOutbox
let redisModule

const profile = {
  // Match the synthetic account's default trusted billing route; this adapter
  // never invokes that provider and its id explicitly marks it as a fixture.
  provider: 'minimax', model: 'MiniMax-M3', nativeTools: true, structuredOutput: true,
  streaming: true, continuationCursor: false, supportsParallelTools: false,
  supportsStreamingToolArgs: true, supportsReasoningSummary: true,
  supportsResponseContinuation: false, supportsProviderConversation: false,
  supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: null, costClass: 'low',
}

async function main() {
  const database = await pool.query('SELECT current_database() AS name')
  const users = await pool.query('SELECT "id", "email" FROM "User" ORDER BY "email"')
  const sessions = await pool.query('SELECT COUNT(*)::int AS count FROM "agent_sessions"')
  if (database.rows[0]?.name !== 'application_flow_fixture' || users.rows.length !== 2
    || users.rows[0]?.email !== 'candidate-a@example.invalid' || users.rows[1]?.email !== 'candidate-b@example.invalid'
    || sessions.rows[0]?.count !== 0) throw new Error('Unexpected database or synthetic identities')
  const userId = users.rows[0].id
  // A malformed request reaches validation only if Web has the same fixture secret.
  // This deliberately performs no usage authorization or billing mutation.
  for (const [secret, expectedStatus] of [[fixtureSecret, 400], ['incorrect-fixture-secret', 401]]) {
    const response = await fetch(`${expectedWeb}/api/internal/agent-runtime/usage`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { 'content-type': 'application/json', 'x-agent-worker-secret': secret }, body: '{}',
    })
    if (response.status !== expectedStatus) throw new Error('Web usage bridge does not use the expected fixture secret')
  }
  await redisProbe.connect()
  if (await redisProbe.dbsize() !== 0) throw new Error('Fixture Redis database is not empty')
  await redisProbe.quit()

  // Dynamic imports occur only after the disposable environment checks.
  const [worker, canonical, flagsModule, graph, graphTemplates, child, usage, production,
    executionProjection, sessionProjection, wakeupModule, eventOutboxModule, redis] = await Promise.all([
    import('../apps/worker/src/queue/production-worker-runtime.ts'),
    import('../apps/worker/src/runtime/canonical-turn-runtime.ts'),
    import('../apps/worker/src/runtime/production-agent-flags.ts'),
    import('../apps/worker/src/runtime/subagents/pg-task-graph-command-port.ts'),
    import('../apps/worker/src/runtime/subagents/task-graph-templates.ts'),
    import('../apps/worker/src/runtime/subagents/production-child-runtime.ts'),
    import('../apps/worker/src/queue/ai-usage-bridge.ts'),
    import('../apps/worker/src/queue/production-bootstrap.ts'),
    import('../apps/worker/src/runtime/canonical-execution-projection.ts'),
    import('../apps/worker/src/runtime/canonical-session-projection.ts'),
    import('../apps/worker/src/runtime/wakeup/consumer.ts'),
    import('../apps/worker/src/runtime/events/outbox-consumer.ts'),
    import('../apps/worker/src/redis.ts'),
  ])
  redisModule = redis
  const flags = flagsModule.resolveProductionAgentFlags()
  if (!flags.childExecutionEnabled || !flags.coordinationEnabled || !flags.taskGraphPlanningEnabled || !flags.consumeWaitOutcomes
    || flags.canonicalAutomationEnabled) throw new Error('Unexpected fixture runtime gates')
  const graphPort = graph.createPgTaskGraphCommandPort(pool)
  let questionIssued = false
  let completed = false
  let capturedSession = null
  let capturedTurn = null
  const modelRuntimeFactory = ({ userId: owner, state }) => {
    if (owner !== userId || state.goal !== goal) throw new Error('Unexpected model owner or goal')
    return {
      adapter: {
        id: 'synthetic-fixture-question-model', profile,
        async *stream(request) {
          if (request.metadata.userId !== userId) throw new Error('Unexpected model request owner')
          if (!capturedTurn) { capturedTurn = request.metadata.turnId; capturedSession = request.metadata.sessionId }
          if (capturedTurn !== request.metadata.turnId || capturedSession !== request.metadata.sessionId || completed) {
            throw new Error('Unexpected fixture model turn')
          }
          const texts = request.messages.flatMap(message => Array.isArray(message.content)
            ? message.content.filter(part => part.type === 'text').map(part => part.text) : [])
          const questionCount = texts.filter(text => text.includes('"type":"question"') && text.includes(question)).length
          const answerCount = texts.filter(text => text.includes('"type":"answer"') && text.includes('"text":"' + answer + '"')).length
          if (!questionIssued && questionCount === 0 && answerCount === 0) {
            if (!request.tools.some(tool => tool && typeof tool === 'object' && tool.name === 'agent.ask_user')) throw new Error('Native question tool unavailable')
            questionIssued = true
            yield { type: 'tool_call_completed', callId: 'fixture-native-question', name: 'agent.ask_user', arguments: { question } }
            yield { type: 'usage', inputTokens: 10, outputTokens: 4, estimatedCostUsd: 0 }
            yield { type: 'completed', finishReason: 'tool_calls' }
            return
          }
          if (!questionIssued || questionCount !== 1 || answerCount !== 1) throw new Error('Synthetic question context was not uniquely resumed')
          completed = true
          yield { type: 'text_delta', text: finalText }
          yield { type: 'usage', inputTokens: 10, outputTokens: 4, estimatedCostUsd: 0 }
          yield { type: 'completed', finishReason: 'stop' }
        },
      },
      registry: {}, candidates: [],
    }
  }
  bootstrap = await worker.startProductionWorkerRuntime({
    pool, workerId: 'synthetic-question-worker', productionFlags: flags,
    // The test exercises canonical turns directly; legacy agent-runs routing is
    // intentionally not started and cannot be claimed as verified.
    startAgentRunWorker() {},
  }, {
    createOptionalProductionChildExecutor: child.createOptionalProductionChildExecutor,
    createCanonicalTurnRuntime: (runtimePool, options) => canonical.createCanonicalTurnRuntime(runtimePool, {
      ...options, ...graphTemplates.taskGraphRuntimeOptions(graphPort), modelRuntimeFactory,
    }),
    createWorkerUsageAuthorizer: usage.createWorkerUsageAuthorizer,
    createCanonicalExecutionProjection: executionProjection.createCanonicalExecutionProjection,
    createCanonicalSessionProjection: sessionProjection.createCanonicalSessionProjection,
    startProductionAgentRuntime: production.startProductionAgentRuntime,
  })
  wakeup = wakeupModule.startAgentWakeupConsumer(pool)
  eventOutbox = eventOutboxModule.startAgentEventOutboxConsumer(pool, redis.redisConnection)
  process.stdout.write('SYNTHETIC_QUESTION_WORKER_READY\n')
  await new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve) })
}

try { await main() } finally {
  await eventOutbox?.close()
  await wakeup?.close()
  await bootstrap?.close()
  redisProbe.disconnect()
  await pool.end()
  await redisModule?.closeSharedRedisConnections()
}
