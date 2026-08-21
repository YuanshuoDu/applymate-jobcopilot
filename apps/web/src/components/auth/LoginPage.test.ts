import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const loginSource = readFileSync(new URL('./LoginPage.tsx', import.meta.url), 'utf8')
const registerSource = readFileSync(new URL('./RegisterPage.tsx', import.meta.url), 'utf8')
const resetPasswordSource = readFileSync(new URL('./ResetPasswordPage.tsx', import.meta.url), 'utf8')
const globalCss = readFileSync(new URL('../../app/globals.css', import.meta.url), 'utf8')

describe('authentication layout safeguards', () => {
  it('uses the canonical public Landing route for authentication branding', () => {
    for (const source of [loginSource, registerSource, resetPasswordSource]) {
      expect(source).toContain('href="/landing"')
    }
  })

  it('associates login labels with stable, named form controls', () => {
    expect(loginSource).toMatch(/<label htmlFor="login-email"/)
    expect(loginSource).toMatch(/id="login-email" name="email"/)
    expect(loginSource).toMatch(/<label htmlFor="login-password"/)
    expect(loginSource).toMatch(/id="login-password" name="password"/)
  })

  it('uses hold-to-reveal for the login password field', () => {
    expect(loginSource).toMatch(/type=\{passwordVisible \? 'text' : 'password'\}/)
    expect(loginSource).toMatch(/onPointerDown=\{handlePasswordPointerDown\}/)
    expect(loginSource).toMatch(/onPointerUp=\{releasePasswordVisibility\}/)
    expect(loginSource).toMatch(/onPointerCancel=\{releasePasswordVisibility\}/)
  })

  it('associates registration labels with stable, named form controls', () => {
    for (const field of ['name', 'email', 'password', 'confirm']) {
      expect(registerSource).toMatch(new RegExp(`<label htmlFor="register-${field}"`))
      expect(registerSource).toMatch(new RegExp(`id="register-${field}" name="${field}"`))
    }
  })

  it('provides click-to-toggle visibility for both registration password fields', () => {
    expect(registerSource).toMatch(/type=\{passwordVisible \? 'text' : 'password'\}/)
    expect(registerSource).toMatch(/type=\{confirmVisible \? 'text' : 'password'\}/)
    expect(registerSource).toMatch(/onClick=\{\(\) => setPasswordVisible\(value => !value\)\}/)
    expect(registerSource).toMatch(/onClick=\{\(\) => setConfirmVisible\(value => !value\)\}/)
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
