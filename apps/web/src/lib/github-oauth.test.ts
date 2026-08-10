import { describe, expect, it } from 'vitest'
import { githubAuthorizeUrl, safeGithubReturnTo } from './github-oauth'

describe('GitHub account-link OAuth helpers', () => {
  it('keeps return URLs same-origin', () => {
    expect(safeGithubReturnTo('/?page=settings&tab=accounts')).toBe('/?page=settings&tab=accounts')
    expect(safeGithubReturnTo('https://evil.example/steal')).toBe('/?page=settings&tab=accounts')
  })

  it('builds a scoped GitHub authorization URL', () => {
    const url = new URL(githubAuthorizeUrl('client-1', 'https://applymate.test/callback', 'signed-state'))
    expect(url.origin).toBe('https://github.com')
    expect(url.pathname).toBe('/login/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('client-1')
    expect(url.searchParams.get('redirect_uri')).toBe('https://applymate.test/callback')
    expect(url.searchParams.get('state')).toBe('signed-state')
    expect(url.searchParams.get('scope')).toContain('read:user')
    expect(url.searchParams.get('scope')).toContain('user:email')
  })
})
