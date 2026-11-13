import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.ts"
import { ROLE_RESULT_SCHEMA } from "./role-results.ts"
import { PgSubagentTaskStore } from "./pg-store.ts"
import { findExactToolResult, findUniqueWaitInput } from "./nested-scout-fixture-tool-pairs.mjs"

export function createNestedScoutFixtureScripts({ mode, profile, ids, pool, say, pauseSubagentClaims, reportParentJoinState }) {
function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : null }
const discoverInput = { targetRoles: ["Software Engineer"], targetLocations: ["Dublin"], source: "greenhouse", pageSize: 10 }
const deniedSourceInput = { goal: "Try to escape the discovered source", sourceSlice: ["lever"] }
const delegateAlphaInput = { goal: "Read the Fixture Alpha role", sourceSlice: ["greenhouse"] }
const delegateBetaInput = { goal: "Read the Fixture Beta role", sourceSlice: ["greenhouse"] }
function outputFor(request, name, input, errorCode = "p1143_fixture_tool_result_unexpected_error") {
  const result = findExactToolResult(request, { name, input })
  if (result?.isError) throw new Error(errorCode)
  return result?.output ?? null
}

function graphFrom(request) {
  for (const message of [...(request.messages ?? [])].reverse()) for (const part of [...(message.content ?? [])].reverse()) {
    if (part?.type !== "text" || !part.text.includes('"kind":"task_graph_current"')) continue
    try { return JSON.parse(part.text.slice(part.text.indexOf("\n") + 1)) } catch { return null }
  }
  return null
}
function hasTerminalWaitOutcome(waitOutput, expectedTaskIds) {
  const terminal = new Set(["completed", "failed", "interrupted", "cancelled", "closed"])
  if (!waitOutput || expectedTaskIds.length !== 2 || new Set(expectedTaskIds).size !== 2
    || !(waitOutput.status === "ready" || waitOutput.status === "timed_out")) return false
  const taskIds = Array.isArray(waitOutput.taskIds) ? waitOutput.taskIds : []
  const tasks = Array.isArray(waitOutput.tasks) ? waitOutput.tasks.map(object) : []
  const sameIds = values => values.length === expectedTaskIds.length && new Set(values).size === values.length
    && expectedTaskIds.every(id => values.includes(id))
  return sameIds(taskIds) && tasks.length === expectedTaskIds.length
    && sameIds(tasks.map(task => task?.taskId)) && tasks.every(task => terminal.has(task?.status))
}

function toolCall(callId, name, args) { return { type: "tool_call_completed", callId, name, arguments: args } }
function completed() { return { type: "completed", finishReason: "tool_calls" } }
function rootModelRuntime() {
  return { adapter: { id: `p1143-root-${mode}`, profile, async *stream(request) {
    say("P1143_ROOT_MODEL_STREAM_STARTED")
    const graph = graphFrom(request), nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
    if (nodes.length === 0) {
      if (!request.tools.some(tool => tool.name === "agent.plan")) throw new Error("p1143_root_plan_tool_missing")
      say("P1143_ROOT_PLAN_REQUESTED")
      yield toolCall("p1143-root-plan", "agent.plan", { expectedRevision: 0, nodes: [{
        key: "scout", templateId: "scout", goal: "Find Dublin software engineering roles",
        successCriteria: ["Return at least one source-backed candidate after reading it"], dependsOn: [],
        verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout", criteria: [
          { id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } },
        ] },
      }] })
      yield completed(); return
    }
    const scout = object(nodes[0])
    if (scout?.status === "completed") {
      if (object(scout.verificationReport)?.status !== "passed") throw new Error("p1143_root_scout_verification_missing")
      yield { type: "text_delta", text: "Two read-only Scout children completed with current job evidence." }
      yield { type: "completed", finishReason: "stop" }; return
    }
    if (typeof scout?.taskId !== "string") throw new Error("p1143_root_scout_task_missing")
    const waitOrdinal = (request.messages ?? []).flatMap(message => message.content ?? []).filter(part => part?.type === "tool_use" && part.name === "agent.wait").length
    yield toolCall(`p1143-root-wait-${waitOrdinal}`, "agent.wait", {
      idempotencyKey: `p1143-root-wait:${ids.turnId}:${waitOrdinal}`, taskIds: [scout.taskId], mode: "all", timeoutMs: 30_000,
    })
    yield completed()
  } }, registry: {}, candidates: [] }
}

function discoveryClient() {
  const jobs = [ids.alphaJobId, ids.betaJobId].map((id, index) => ({
    id, title: "Software Engineer", company: index ? "Fixture Beta" : "Fixture Alpha", location: "Dublin",
    url: `https://jobs.example.invalid/${id}`, description: "Build reliable software", fullDescription: "Build reliable software",
    salary: null, logo: null, source: "greenhouse", evidenceRefs: [`source:${id}`],
  }))
  return { async discover(request) {
    const evidence = jobs.map(job => ({ evidenceId: `source:${job.id}`, jobId: job.id, kind: "source", source: "greenhouse", url: job.url, summary: "Fixture discovery result" }))
    return { jobs, evidence, nextCursor: null, usage: { ledgerKey: `p1143:${request.taskId}:${request.toolCallId}`,
      toolName: "jobs.discover", toolVersion: "1", toolCallId: request.toolCallId, sessionId: request.sessionId,
      turnId: request.turnId, stepId: request.stepId, requests: 1, jobsProcessed: 2, jobsSucceeded: 2, jobsFailed: 0,
      aiCalls: 0, providers: ["greenhouse"], estimatedCostUsd: 0, durationMs: 0 } }
  } }
}

async function rejectStepReplay(task, manager, callId, stepId) {
  const row = await new PgSubagentTaskStore(pool).get(task.id, task.sessionId)
  if (!row?.leaseOwner || row.status !== "running" || !row.leaseExpiresAt) throw new Error("p1143_parent_lease_unavailable")
  const lease = { ...row, ownerId: row.leaseOwner, signal: new AbortController().signal }
  const before = await pool.query(`SELECT count(*) FROM "sub_agent_tasks" WHERE "parentTaskId" = $1`, [task.id])
  try {
    await manager.spawnFromLease({ userId: row.userId, sessionId: row.sessionId, turnId: row.turnId, parentTaskId: row.id,
      role: "scout", taskType: "job_discovery", goal: "Reject stale step replay", constraints: [], successCriteria: ["Return typed results"],
      allowedActions: ["jobs.discover", "tool_results.read"],
      context: { nestedScoutSourceSlice: ["greenhouse"], nestedScoutQueryScope: [
        { source: "greenhouse", targetRoles: ["Software Engineer"], targetLocations: ["Dublin"], maxPageSize: 10 },
      ] }, expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" } },
    `p1143-negative-${callId}-${stepId}`, lease, { stepId, toolCallId: callId })
    throw new Error("p1143_stale_step_was_accepted")
  } catch (error) {
    if (error instanceof Error && error.message === "p1143_stale_step_was_accepted") throw error
    if (object(error)?.code !== "lost") throw error
  }
  const after = await pool.query(`SELECT count(*) FROM "sub_agent_tasks" WHERE "parentTaskId" = $1`, [task.id]); if (before.rows[0]?.count !== after.rows[0]?.count) throw new Error("p1143_stale_step_created_child")
}
async function waitForTwoRunningChildren(task, markerState) {
  if (markerState.parallelObserved) return
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const result = await pool.query({ text: `SELECT count(*)::int AS count FROM "sub_agent_tasks" sibling
      WHERE sibling."parentTaskId" = $1 AND sibling."sessionId" = $2 AND sibling."turnId" = $3
        AND sibling."rootTaskId" = $4 AND sibling."depth" = 2 AND sibling."role" = 'scout'
        AND sibling."taskType" = 'job_discovery' AND sibling."status" = 'running'
        AND NULLIF(btrim(sibling."leaseOwner"), '') IS NOT NULL AND sibling."leaseExpiresAt" > clock_timestamp()`,
      values: [task.parentTaskId, task.sessionId, task.turnId, task.rootTaskId], query_timeout: 1_000 })
    if (result.rows[0]?.count === 2) { markerState.parallelObserved = true; say("P1143_TWO_CHILDREN_RUNNING_IN_PARALLEL"); return }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error("p1143_children_did_not_overlap_in_running_state")
}

function childModelRuntime({ task, runtime, markerState }) {
  const discoverCall = `p1143-discover:${task.id}`, delegateOne = `p1143-delegate-alpha:${task.id}`
  const delegateTwo = `p1143-delegate-beta:${task.id}`, resultsCall = `p1143-results:${task.id}`
  return { id: `p1143-${task.depth}-${task.id}`, profile, async *stream(request) {
    if (task.depth === 1) { say("P1143_PARENT_MODEL_STREAM_ENTERED"); if (mode === "resume") say(task.attemptCount > 1 ? "P1143_PARENT_RESUME_MODEL_RETRIED" : "P1143_PARENT_RESUME_MODEL_FIRST_ATTEMPT") }
    if (task.depth === 2) {
      if (mode === "resume" && task.attemptCount === 2) say("P1143_CHILD_SCOUT_RECLAIMED")
      await waitForTwoRunningChildren(task, markerState)
      const discoverCall = `p1143-child-discover:${task.id}`
      const receipt = findExactToolResult(request, { name: "jobs.discover", input: discoverInput })
      if (!receipt) {
        if (!request.tools.some(tool => tool.name === "jobs.discover")) throw new Error("p1143_grandchild_discover_tool_missing")
        if (request.tools.some(tool => tool.name === "scout.delegate" || tool.name === "scout.results")) throw new Error("p1143_grandchild_coordination_leaked")
        yield toolCall(discoverCall, "jobs.discover", discoverInput)
        yield completed(); return
      }
      if (receipt.isError) throw new Error("p1143_grandchild_discovery_failed")
      say("P1143_CHILD_DISCOVERY_RESULT_RECEIVED")
      const jobs = Array.isArray(object(receipt.output)?.jobs) ? receipt.output.jobs.map(object) : []
      const wanted = task.goal.includes("Alpha") ? "Fixture Alpha" : "Fixture Beta"
      const job = jobs.find(value => value?.company === wanted && value.source === "greenhouse")
      if (!job) throw new Error("p1143_grandchild_source_bound_job_missing")
      const sourceEvidenceId = Array.isArray(job.evidenceRefs) ? job.evidenceRefs.find(id => typeof id === "string" && id.startsWith("source:")) : null
      if (!sourceEvidenceId) throw new Error("p1143_grandchild_source_evidence_missing")
      const evidence = { id: sourceEvidenceId, kind: "job", ref: job.id, source: job.source }
      yield { type: "text_delta", text: JSON.stringify({ schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed",
        candidates: [{ jobId: job.id, source: job.source, url: job.url, evidenceIds: [sourceEvidenceId] }], evidence: [evidence], summary: "Read the assigned source-bound fixture role" }) }
      say("P1143_CHILD_ROLE_RESULT_STREAMED")
      yield { type: "completed", finishReason: "stop" }; return
    }

    if (mode === "park" && !markerState.subagentClaimsPaused) {
      if (task.depth === 1) say("P1143_PARENT_ADAPTER_STARTED")
      await pauseSubagentClaims()
      markerState.subagentClaimsPaused = true
      say("P1143_SUBAGENT_CLAIMS_PAUSED")
    }
    const discovery = findExactToolResult(request, { name: "jobs.discover", input: discoverInput })
    if (!discovery) {
      if (!request.tools.some(tool => tool.name === "jobs.discover")) throw new Error("p1143_parent_discovery_tool_missing")
      if (task.depth === 1) say("P1143_PARENT_DISCOVER_REQUESTED")
      yield toolCall(discoverCall, "jobs.discover", discoverInput)
      yield completed(); return
    }
    if (discovery.isError) throw new Error("p1143_parent_discovery_failed")
    const deniedSourceCall = `p1143-delegate-lever:${task.id}`
    const deniedSource = findExactToolResult(request, { name: "scout.delegate", input: deniedSourceInput })
    if (!deniedSource) {
      if (!request.tools.some(tool => tool.name === "scout.delegate")) throw new Error("p1143_delegate_tool_missing")
      say("P1143_SOURCE_ESCALATION_REQUESTED")
      yield toolCall(deniedSourceCall, "scout.delegate", deniedSourceInput)
      yield completed(); return
    }
    if (!deniedSource.isError) throw new Error("p1143_source_escalation_was_not_rejected")
    say("P1143_SOURCE_ESCALATION_REJECTED")
    const alphaResult = findExactToolResult(request, { name: "scout.delegate", input: delegateAlphaInput })
    if (!alphaResult) {
      if (!request.tools.some(tool => tool.name === "scout.delegate")) throw new Error("p1143_delegate_tool_missing")
      yield toolCall(delegateOne, "scout.delegate", delegateAlphaInput)
      yield completed(); return
    }
    if (alphaResult.isError) throw new Error("p1143_alpha_delegate_failed")
    if (!markerState.closedStepRejected) {
      const old = await pool.query(`SELECT "stepId" FROM "agent_items" WHERE "taskId" = $1 AND "type" = 'tool_call' AND content->>'toolCallId' = $2`, [task.id, delegateOne])
      const current = await pool.query(`SELECT "id" FROM "agent_steps" WHERE "taskId" = $1 AND "status" = 'streaming' ORDER BY "ordinal" DESC LIMIT 1`, [task.id])
      if (!old.rows[0]?.stepId || !current.rows[0]?.id) throw new Error("p1143_step_fence_fixture_missing_steps")
      await rejectStepReplay(task, runtime.manager, delegateOne, String(old.rows[0].stepId))
      markerState.closedStepRejected = true
      say("P1143_CLOSED_STEP_REPLAY_REJECTED")
      await rejectStepReplay(task, runtime.manager, delegateOne, String(current.rows[0].id))
      say("P1143_FOREIGN_CALL_STEP_REJECTED")
    }
    const betaResult = findExactToolResult(request, { name: "scout.delegate", input: delegateBetaInput })
    if (!betaResult) {
      if (!request.tools.some(tool => tool.name === "scout.delegate")) throw new Error("p1143_second_delegate_tool_missing")
      yield toolCall(delegateTwo, "scout.delegate", delegateBetaInput)
      yield completed(); return
    }
    if (betaResult.isError) throw new Error("p1143_beta_delegate_failed")
    const delegateResults = [alphaResult.output, betaResult.output], childIds = delegateResults.map(value => object(value)?.taskId).filter(id => typeof id === "string")
    const waitInput = findUniqueWaitInput(request, childIds), waitResult = waitInput ? findExactToolResult(request, { name: "wait_subagents", input: waitInput }) : null
    if (waitResult?.isError) throw new Error("p1143_parent_wait_failed")
    const waitOutput = object(waitResult?.output), terminalWaitMatch = hasTerminalWaitOutcome(waitOutput, childIds)
    if (task.depth === 1 && mode === "resume") {
      say(waitInput ? "P1143_PARENT_RESUME_WAIT_INPUT_PRESENT" : "P1143_PARENT_RESUME_WAIT_INPUT_MISSING"); say(waitResult ? "P1143_PARENT_RESUME_WAIT_RESULT_PRESENT" : "P1143_PARENT_RESUME_WAIT_RESULT_MISSING")
      const status = ["ready", "timed_out", "waiting", "failed"].includes(waitOutput?.status) ? waitOutput.status : "other"
      say(`P1143_PARENT_RESUME_WAIT_CONTEXT_${status.toUpperCase()}`)
    }
    const joined = outputFor(request, "scout.results", {}), issueScoutResults = terminalWaitMatch && !joined
    reportParentJoinState({ delegateResultCount: delegateResults.filter(Boolean).length, childIdCount: childIds.length, waitResultPresent: waitResult !== null, terminalWaitMatch, scoutResultsIssued: issueScoutResults })
    if (issueScoutResults) {
      if (!request.tools.some(tool => tool.name === "scout.results")) throw new Error("p1143_scout_results_tool_missing")
      yield toolCall(resultsCall, "scout.results", {})
      yield completed(); return
    }
    if (!joined) {
      yield { type: "text_delta", text: JSON.stringify({ schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed", candidates: [], evidence: [], summary: "Premature candidate before child outcomes" }) }
      yield { type: "completed", finishReason: "stop" }; return
    }
    say("P1143_PARENT_SCOUT_RESULTS_RECEIVED")
    if (object(joined)?.availability !== "available") throw new Error("p1143_scout_results_not_available_after_wait")
    const children = Array.isArray(object(joined)?.children) ? joined.children.map(object) : []
    const candidates = children.flatMap(child => Array.isArray(child?.candidates) ? child.candidates.map(object) : [])
    for (const candidate of candidates) {
      const callId = `p1143-parent-job-get:${task.id}:${candidate?.jobId}`, input = { jobId: candidate?.jobId }
      if (!findExactToolResult(request, { name: "jobs.get", input })) {
        yield toolCall(callId, "jobs.get", input)
        yield completed(); return
      }
    }
    const jobs = candidates.map(candidate => ({
      candidate,
      result: outputFor(request, "jobs.get", { jobId: candidate?.jobId }, "p1143_parent_job_read_failed"),
    }))
    if (jobs.length !== 2 || jobs.some(item => object(object(item.result)?.job)?.id !== item.candidate?.jobId)) throw new Error("p1143_parent_current_reads_missing")
    const evidence = jobs.map(({ candidate, result }) => ({ id: `model-read:${candidate?.jobId}`, kind: "job", ref: candidate?.jobId, source: object(object(result)?.job)?.source }))
    yield { type: "text_delta", text: JSON.stringify({ schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed",
      candidates: jobs.map(({ candidate, result }) => ({ jobId: candidate?.jobId, source: object(object(result)?.job)?.source,
        url: object(object(result)?.job)?.url, evidenceIds: [`model-read:${candidate?.jobId}`] })), evidence, summary: "Joined two bounded read-only Scouts and reread each current job" }) }
    say("P1143_PARENT_ROLE_RESULT_STREAMED")
    yield { type: "completed", finishReason: "stop" }
  } }
}

  return { rootModelRuntime, discoveryClient, childModelRuntime }
}
export function createCrashFixtureExecutor(mode, executeChild, say) {
  return input => mode === "crash-child"
    ? (say("P1143_CRASH_CHILD_BEFORE_MODEL_CALL"), new Promise(() => {})) : executeChild(input)
}
