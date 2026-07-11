import { describe, expect, it } from 'vitest'
import { agentActionFromText, responseMemory, sessionGoalFrom } from './route-helpers'

describe('agent chat route helpers', () => {
  it('parses supported action commands into client actions', () => {
    expect(agentActionFromText('Done.\nACTION:update_config:minMatchScore:85')).toEqual({
      type: 'update_config',
      field: 'minMatchScore',
      value: 85,
      command: 'update_config:minMatchScore:85',
    })
    expect(agentActionFromText('ACTION:toggle_agent:scout:false')).toEqual({
      type: 'toggle_agent',
      role: 'scout',
      enabled: false,
      command: 'toggle_agent:scout:false',
    })
  })

  it('ignores unsupported or incomplete action commands', () => {
    expect(agentActionFromText('ACTION:delete_everything')).toBeNull()
    expect(agentActionFromText('ACTION:update_config:minMatchScore')).toBeNull()
    expect(agentActionFromText('No command here')).toBeNull()
  })

  it('builds compact session goals and memory summaries', () => {
    expect(sessionGoalFrom('  Find   Berlin   jobs  ')).toBe('Find Berlin jobs')
    expect(responseMemory('I will help.\nACTION:start_run')).toBe('I will help.')
    expect(responseMemory('ACTION:start_run')).toBe('Waiting for the next user instruction.')
  })
})
