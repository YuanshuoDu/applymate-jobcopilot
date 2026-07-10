import type { AgentConfig } from '@prisma/client'
import type { AgentConfigFull } from '@/lib/agent/types'

export function pipelineAgentConfigFrom(agentCfg: AgentConfig): AgentConfigFull {
  return {
    id: agentCfg.id,
    userId: agentCfg.userId,
    isRunning: agentCfg.isRunning,
    dailyLimit: agentCfg.dailyLimit,
    minMatchScore: agentCfg.minMatchScore,
    autoApply: agentCfg.autoApply,
    requireApproval: agentCfg.requireApproval,
    targetLocations: agentCfg.targetLocations,
    targetRoles: agentCfg.targetRoles,
    excludeCompanies: agentCfg.excludeCompanies,
    priorityCompanies: agentCfg.priorityCompanies,
    autoCoverLetter: agentCfg.autoCoverLetter,
    coverTone: agentCfg.coverTone,
    useTailoredCV: agentCfg.useTailoredCV,
    model: agentCfg.model,
    throttleMs: 300,
  }
}
