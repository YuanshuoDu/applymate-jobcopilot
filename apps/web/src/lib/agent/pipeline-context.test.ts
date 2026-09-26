import { describe, expect, it } from 'vitest'
import type { PipelineCtx as ExistingImportPath } from './types'
import type { PipelineCtx as MovedContract } from './pipeline-context'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2) ? true : false
    : false
type Assert<T extends true> = T
const contextContractMatches: Assert<Equal<ExistingImportPath, MovedContract>> = true

describe('pipeline context contract', () => {
  it('keeps the types.ts import path equivalent to the moved contract', () => {
    expect(contextContractMatches).toBe(true)
  })
})
