import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const loginSource = readFileSync(new URL('./LoginPage.tsx', import.meta.url), 'utf8')
const registerSource = readFileSync(new URL('./RegisterPage.tsx', import.meta.url), 'utf8')
const globalCss = readFileSync(new URL('../../app/globals.css', import.meta.url), 'utf8')

describe('authentication layout safeguards', () => {
  it('associates login labels with stable, named form controls', () => {
    expect(loginSource).toMatch(/<label htmlFor="login-email"/)
    expect(loginSource).toMatch(/id="login-email" name="email"/)
    expect(loginSource).toMatch(/<label htmlFor="login-password"/)
    expect(loginSource).toMatch(/id="login-password" name="password"/)
  })

  it('associates registration labels with stable, named form controls', () => {
    for (const field of ['name', 'email', 'password', 'confirm']) {
      expect(registerSource).toMatch(new RegExp(`<label htmlFor="register-${field}"`))
      expect(registerSource).toMatch(new RegExp(`id="register-${field}" name="${field}"`))
    }
  })

  it('uses a tablet breakpoint so the brand panel cannot squeeze the form', () => {
    expect(globalCss).toMatch(/@media \(max-width: 900px\)[\s\S]*\.auth-panel\s*\{\s*display:\s*none\s*!important;/)
  })

  it('keeps auth content reachable on short desktop viewports', () => {
    expect(globalCss).toMatch(/\.auth-layout[\s\S]*overflow-y:\s*auto\s*!important/)
    expect(globalCss).toMatch(/@media \(min-width: 901px\) and \(max-height: 760px\)/)
    expect(globalCss).toMatch(/\.auth-panel[\s\S]*overflow-y:\s*auto\s*!important/)
  })
})
