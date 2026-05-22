/**
 * Smoke tests to ensure LLM exports are present in shared package.
 * These tests exist to prevent the exports from being accidentally removed.
 * If they fail, check packages/shared/src/index.ts — the re-exports may have been dropped.
 */
import { describe, it, expect } from 'vitest'
import { callLlm, loadWorkerAiConfig, callLlmText, closeSharedPool } from './index.js'

describe('shared/llm exports — existence guards', () => {
  it('callLlm is a function', () => {
    expect(typeof callLlm).toBe('function')
  })

  it('loadWorkerAiConfig is a function', () => {
    expect(typeof loadWorkerAiConfig).toBe('function')
  })

  it('callLlmText is a function', () => {
    expect(typeof callLlmText).toBe('function')
  })

  it('closeSharedPool is a function', () => {
    expect(typeof closeSharedPool).toBe('function')
  })
})
