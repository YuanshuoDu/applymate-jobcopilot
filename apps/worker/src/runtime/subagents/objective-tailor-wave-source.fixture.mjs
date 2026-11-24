import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.ts"

const SOURCES = ["greenhouse", "greenhouse", "greenhouse", "lever", "lever", "lever", "workday", "workday"]

export async function seedObjectiveTailorWaveSource(pool, owner, jobIdForSlot) {
  const jobs = SOURCES.map((source, index) => ({ id: jobIdForSlot(owner.suffix, index), source, index }))
  for (const job of jobs) await pool.query(`INSERT INTO "Job" ("id", "userId", "company", "role", "location", "status", "url", "description", "source", "updatedAt")
    VALUES ($1, $2, $3, 'Software Engineer', 'Dublin', 'saved', $4, $5, $6, CURRENT_TIMESTAMP)
    ON CONFLICT ("id") DO NOTHING`, [job.id, owner.userId, `Synthetic Employer ${job.index + 1}`,
    `https://jobs.example.invalid/objective-tailor/${job.index + 1}`,
    `Synthetic role description ${job.index + 1}: build reliable software systems.`, job.source])
  const resumeId = `p3-1336-tailor-resume-${owner.suffix}`
  await pool.query(`INSERT INTO "Resume" ("id", "userId", "name", "content", "kind", "origin", "isDefault", "updatedAt")
    VALUES ($1, $2, 'Synthetic objective-tailor base', $3::jsonb, 'base', 'manual', TRUE, CURRENT_TIMESTAMP)`,
  [resumeId, owner.userId, JSON.stringify({ text: "Synthetic confirmed software engineering experience." })])
  await pool.query(`INSERT INTO persona_facts
    ("id", "userId", "key", "category", "value", "normalized_value", "source", "source_ref", "confidence", "status", "allowedUses", "updated_at")
    VALUES ($1, $2, 'engineering_experience', 'experience', $3, 'confirmed-synthetic', 'resume', $4, 0.98, 'confirmed', ARRAY['cover_letter']::text[], CURRENT_TIMESTAMP)`,
  [`p3-1336-tailor-fact-${owner.suffix}`, owner.userId,
    "Synthetic confirmed experience building reliable services.", `resume:${resumeId}:experience`])
  return { jobs, resumeId }
}

export function createObjectiveTailorWaveSourceModel({ task, userId, sessionId, turnId, profile, roleResultSchema, say }) {
  if (task?.userId !== userId || task?.sessionId !== sessionId || task?.turnId !== turnId) {
    throw new Error("fixture_source_scope_mismatch")
  }
  const role = task.role
  if (role !== "scout" && role !== "analyst") throw new Error("fixture_source_role_unsupported")
  const goal = String(task.goal ?? ""), source = ["greenhouse", "lever", "workday"].find(value => goal.includes(value))
  if (!source) throw new Error("fixture_source_selector_missing")
  return { id: `objective-tailor-${role}-fixture`, profile, async *stream(request) {
    assertScope(request, { userId, sessionId, turnId, taskId: task.id })
    if (role === "scout") {
      const calls = fixtureToolCalls(request, "jobs.search")
      if (!calls.length) { yield* emit(`search-${task.id}`, "jobs.search", { source, limit: 10 }); return }
      const result = fixtureToolResult(request, calls.at(-1)), jobs = result?.value?.jobs
      if (!result || result.error || !Array.isArray(jobs) || jobs.length < 2
        || jobs.some(job => job?.source !== source || typeof job.id !== "string")) throw new Error("fixture_scout_search_receipt_invalid")
      const evidence = jobs.map((job, index) => ({ id: `scout-${task.id}-${index}`, kind: "job", ref: job.id, source }))
      const value = { schemaVersion: roleResultSchema, role, status: "completed",
        candidates: jobs.map((job, index) => ({ jobId: job.id, source, url: job.url, evidenceIds: [evidence[index].id] })),
        evidence, summary: "Observed synthetic saved roles in the selected source." }
      say(`SOURCE_SCOUT_COMPLETED ${jobs.length}`)
      yield { type: "text_delta", text: JSON.stringify(value) }; yield { type: "completed", finishReason: "stop" }
      return
    }
    yield* analystStream(request, { task, source, roleResultSchema })
  } }
}

async function* analystStream(request, { task, source, roleResultSchema }) {
  const dependency = task.context?.taskGraphDependencyResults?.items?.find(item => item?.role === "scout")
  const candidates = dependency?.result?.role === "scout" ? dependency.result.candidates : undefined
  if (!Array.isArray(candidates) || candidates.some(job => job?.source !== source || typeof job.jobId !== "string")) {
    throw new Error("fixture_analyst_scout_projection_invalid")
  }
  const group = /\bgroup B\b/.test(task.goal) ? 1 : 0
  const selected = source === "greenhouse" ? candidates.slice(group === 0 ? 0 : 2, group === 0 ? 2 : 3)
    : candidates
  if (!selected.length || selected.length > 3) throw new Error("fixture_analyst_candidate_partition_invalid")
  const reads = fixtureToolCalls(request, "jobs.get")
  for (let index = 0; index < selected.length; index += 1) {
    const candidate = selected[index], matching = reads.find(call => call.input?.jobId === candidate.jobId)
    if (!matching) { yield* emit(`analyst-get-${task.id}-${index}`, "jobs.get", { jobId: candidate.jobId }); return }
    const result = fixtureToolResult(request, matching), observed = result?.value?.job
    if (!result || result.error || observed?.id !== candidate.jobId || observed?.source !== source) throw new Error("fixture_analyst_job_receipt_invalid")
  }
  const evidence = selected.map((job, index) => ({ id: `analysis-${task.id}-${index}`, kind: "job", ref: job.jobId, source }))
  const value = { schemaVersion: roleResultSchema, role: "analyst", status: "completed",
    findings: selected.map((job, index) => ({ jobId: job.jobId, score: 8, evidenceIds: [evidence[index].id] })),
    evidence, summary: "Assessed two observed synthetic roles from the required Scout source." }
  yield { type: "text_delta", text: JSON.stringify(value) }; yield { type: "completed", finishReason: "stop" }
}

export function fixtureToolCalls(request, name) {
  return (request.messages ?? []).flatMap(message => (message.content ?? [])
    .filter(part => message.role === "assistant" && part?.type === "tool_use" && part.name === name))
}
export function fixtureToolResult(request, call) {
  for (const message of request.messages ?? []) for (const part of message.content ?? []) {
    if (message.role !== "tool" || part?.type !== "tool_result" || part.toolUseId !== call.id) continue
    if (typeof part.content !== "string") return { error: true }
    try { return { error: part.isError === true, value: JSON.parse(part.content) } } catch { return { error: true } }
  }
  return undefined
}
export function fixtureObservation(request, kind) {
  for (let messageIndex = (request.messages ?? []).length - 1; messageIndex >= 0; messageIndex -= 1) {
    const parts = request.messages[messageIndex]?.content ?? []
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = parts[partIndex]
      if (part?.type !== "text" || typeof part.text !== "string" || !part.text.includes(`\"kind\":\"${kind}\"`)) continue
      const marker = `\"kind\":\"${kind}\"`, start = part.text.lastIndexOf("{", part.text.indexOf(marker))
      const value = start >= 0 ? objectAt(part.text, start) : undefined
      if (value?.kind === kind) return value
    }
  }
  throw new Error("fixture_observation_unavailable")
}

export function diagnoseObjectiveTailorWaveOne(request, expectedRevision, say) {
  const matches = Array.isArray(request?.tools) ? request.tools.filter(tool => tool?.name === "agent.tailor") : []
  say(matches.length === 0 ? "TAILOR_WAVE1_TOOL_ABSENT"
    : matches.length !== 1 ? "TAILOR_WAVE1_TOOL_AMBIGUOUS"
      : matches[0]?.version === "2" ? "TAILOR_WAVE1_TOOL_V2" : "TAILOR_WAVE1_TOOL_VERSION_OTHER")
  let observation
  try { observation = fixtureObservation(request, "objective_tailor_wave_candidate_catalog") }
  catch { say("TAILOR_WAVE1_CATALOG_MISSING"); return undefined }
  const catalog = observation?.catalog
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)
    || catalog.schemaVersion !== "agent-harness.v2.objective-tailor-wave-catalog.v1"
    || !Array.isArray(catalog.candidates)) {
    say("TAILOR_WAVE1_CATALOG_INVALID"); return undefined
  }
  const candidateCount = catalog.candidates.length <= 8 ? catalog.candidates.length : "other"
  say(`TAILOR_WAVE1_CATALOG_CANDIDATES ${candidateCount}`)
  say(catalog.candidates.length === 8 ? "TAILOR_WAVE1_CATALOG_COUNT_MATCH" : "TAILOR_WAVE1_CATALOG_COUNT_MISMATCH")
  const revisionMatches = Number.isSafeInteger(catalog.graphRevision) && catalog.graphRevision === expectedRevision
  say(revisionMatches ? "TAILOR_WAVE1_CATALOG_REVISION_MATCH" : "TAILOR_WAVE1_CATALOG_REVISION_MISMATCH")
  return matches.length === 1 && matches[0]?.version === "2" && revisionMatches && catalog.candidates.length === 8
    ? catalog : undefined
}

export function diagnoseObjectiveTailorWaveOneReceipt(request, call, say) {
  const result = fixtureToolResult(request, call), value = result?.value
  if (!result) { say("TAILOR_WAVE1_RECEIPT_INVALID"); return undefined }
  if (result.error) {
    const code = value && typeof value === "object" ? value.code : undefined
    say(new Set(["revision_mismatch", "objective_tailor_wave_source_stale", "objective_tailor_wave_stale",
      "objective_tailor_wave_not_eligible", "idempotency_conflict"]).has(code)
      ? "TAILOR_WAVE1_RECEIPT_DENIED" : "TAILOR_WAVE1_RECEIPT_DENIED_OTHER")
    return undefined
  }
  const expectedRevision = call.input?.expectedRevision
  const accepted = (value?.status === "accepted" || value?.status === "duplicate")
    && Number.isSafeInteger(expectedRevision) && value.revision === expectedRevision + 1
    && Array.isArray(value.nodes) && value.nodes.length === 8 && value.readyTaskIds?.length === 4
  say(accepted ? "TAILOR_WAVE1_RECEIPT_ACCEPTED" : "TAILOR_WAVE1_RECEIPT_INVALID")
  return accepted ? value : undefined
}
export function fixtureAllTasksCompleted(output, taskIds) {
  return Array.isArray(output.tasks) && output.tasks.length === taskIds.length
    && taskIds.every(id => output.tasks.some(task => task?.taskId === id && task.status === "completed"))
    && Array.isArray(output.matchedTaskIds) && taskIds.every(id => output.matchedTaskIds.includes(id))
}

export function sourcePlan() {
  const scout = (source, objectiveCoverage = false) => ({ key: `scout-${source}`, templateId: "scout", goal: `Search ${source} for saved roles`,
    successCriteria: ["Return observed saved roles"], dependsOn: [], verification: {
      schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout",
      criteria: [{ id: objectiveCoverage ? "candidate-count" : `candidate-count-${source}`,
        check: { kind: "candidate_count_gte", minimum: 1 } }],
    } })
  return { expectedRevision: 0, nodes: [scout("greenhouse", true), scout("lever"), scout("workday"), ...analystPlan(0).nodes] }
}

export function analystPlan(expectedRevision) {
  const analyst = (source, group = "") => {
    const dependencyNodeKey = `scout-${source}`
    const key = `analyst-${source}${group ? `-${group.toLowerCase()}` : ""}`
    return { key, templateId: "analyst",
      goal: `Assess ${source} ${group ? `group ${group}` : "roles"} from its direct Scout`,
      successCriteria: ["Return findings bound to direct Scout candidates"], dependsOn: [dependencyNodeKey], verification: {
        schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst",
        criteria: [{ id: source === "greenhouse" && group === "A" ? "finding-count" : `finding-count-${key}`,
          check: { kind: "finding_count_gte", minimum: 1 } },
          { id: `scout-membership-${key}`, check: { kind: "findings_from_scout_dependency", dependencyNodeKey } }],
      } }
  }
  return { expectedRevision, nodes: [analyst("greenhouse", "A"), analyst("greenhouse", "B"), analyst("lever"), analyst("workday")] }
}
function objectAt(text, start) {
  let depth = 0, quoted = false, escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === "\"") quoted = false; continue }
    if (char === "\"") quoted = true
    else if (char === "{") depth += 1
    else if (char === "}" && --depth === 0) { try { return JSON.parse(text.slice(start, index + 1)) } catch { return undefined } }
  }
  return undefined
}
function emit(id, name, args) {
  return [{ type: "tool_call_completed", callId: id, name, arguments: args }, { type: "completed", finishReason: "tool_calls" }]
}
function assertScope(request, expected) {
  if (request?.metadata?.userId !== expected.userId || request.metadata.sessionId !== expected.sessionId
    || request.metadata.turnId !== expected.turnId || request.metadata.taskId !== expected.taskId) {
    throw new Error("fixture_source_model_scope_mismatch")
  }
}
