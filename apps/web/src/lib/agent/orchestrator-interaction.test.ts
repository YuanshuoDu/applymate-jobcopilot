import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() }))
vi.mock('@/lib/db', () => ({
  db: {
    agentRunQuestion: { findFirst: mocks.findFirst, create: mocks.create },
    agentConfig: { updateMany: mocks.updateMany },
  },
}))

describe('OrchestratorInteraction', () => {
  beforeEach(() => {
    mocks.findFirst.mockReset()
    mocks.create.mockReset()
    mocks.updateMany.mockReset()
  })

  async function createInteraction(resumeQuestionId?: string) {
    const { OrchestratorInteraction } = await import('./orchestrator-interaction')
    const emit = vi.fn()
    const history: string[] = []
    const agentCfg = {
      id: 'config_1', userId: 'user_1', isRunning: false, dailyLimit: 10,
      minMatchScore: 70, autoApply: false, requireApproval: true,
      targetLocations: ['Berlin'], targetRoles: ['Engineer'],
      excludeCompanies: [], priorityCompanies: [], autoCoverLetter: true,
      coverTone: 'professional', useTailoredCV: true, model: 'MiniMax-M3', throttleMs: 300,
    }
    const interaction = new OrchestratorInteraction(
      { userId: 'user_1', agentCfg }, 'session_1', emit, history, resumeQuestionId,
    )
    return { interaction, emit, history, agentCfg }
  }

  it('persists an unanswered question, emits it, and signals a durable pause', async () => {
    mocks.findFirst.mockResolvedValue(null)
    mocks.create.mockResolvedValue({ id: 'question_1', answer: null })
    const { interaction, emit } = await createInteraction()
    const options = [{ label: 'Keep current resume', value: 'keep_resume' }]

    await expect(interaction.ask('writer', 'Use this resume?', options)).rejects.toMatchObject({
      name: 'AgentPauseError', questionId: 'question_1', stage: 'writer',
    })
    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'user_1', runId: 'session_1', stage: 'writer', question: 'Use this resume?' }),
    })
    expect(emit).toHaveBeenCalledWith('orchestrator_question', {
      id: 'question_1', stage: 'writer', question: 'Use this resume?', options,
    })
  })

  it('returns a saved answer and records the answer event and history', async () => {
    mocks.findFirst.mockResolvedValue({ id: 'question_1', answer: 'keep_resume' })
    const { interaction, emit, history } = await createInteraction()

    await expect(interaction.ask('writer', 'Use this resume?', [
      { label: 'Keep current resume', value: 'keep_resume' },
    ])).resolves.toBe('keep_resume')
    expect(emit).toHaveBeenCalledWith('orchestrator_answer_received', expect.objectContaining({
      id: 'question_1', stage: 'writer', answer: 'keep_resume', label: 'Keep current resume',
    }))
    expect(history).toEqual(['[Ask/writer] USER: keep_resume'])
  })

  it('persists a selected option before applying it to run config', async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 })
    const { interaction, agentCfg } = await createInteraction()
    const options = [{ label: 'Raise limit', value: 'raise', action: { field: 'dailyLimit', value: 20 } }]

    await interaction.applyOptionAction('raise', options)

    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user_1' }, data: { dailyLimit: 20 },
    })
    expect(agentCfg.dailyLimit).toBe(20)
  })

  it('leaves runtime config unchanged when option persistence fails', async () => {
    mocks.updateMany.mockRejectedValue(new Error('database unavailable'))
    const { interaction, agentCfg } = await createInteraction()

    await interaction.applyOptionAction('raise', [
      { label: 'Raise limit', value: 'raise', action: { field: 'dailyLimit', value: 20 } },
    ])

    expect(agentCfg.dailyLimit).toBe(10)
  })
})
