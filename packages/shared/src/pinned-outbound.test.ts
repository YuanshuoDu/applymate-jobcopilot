import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pinnedFetch, validatePinnedUrl } from './pinned-outbound.js'

const lookup = vi.hoisted(() => vi.fn())
const requestMock = vi.hoisted(() => vi.fn())

vi.mock('node:dns/promises', () => ({ default: { lookup } }))
vi.mock('node:http', () => ({ default: { request: requestMock } }))

const originalNodeEnv = process.env.NODE_ENV

function mockedRequest(statusCode = 200, body = 'ok') {
  const response = new EventEmitter() as EventEmitter & {
    statusCode: number
    statusMessage: string
    headers: Record<string, string>
  }
  response.statusCode = statusCode
  response.statusMessage = 'OK'
  response.headers = { 'content-type': 'text/plain' }

  const request = new EventEmitter() as EventEmitter & {
    write: ReturnType<typeof vi.fn>
    end: ReturnType<typeof vi.fn>
    destroy: ReturnType<typeof vi.fn>
  }
  request.write = vi.fn()
  request.destroy = vi.fn()
  request.end = vi.fn(() => {
    setTimeout(() => {
      response.emit('data', Buffer.from(body))
      response.emit('end')
    }, 0)
  })
  requestMock.mockImplementationOnce((_options: unknown, callback: (response: typeof response) => void) => {
    callback(response)
    return request
  })
  return request
}

describe('pinned outbound client', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test'
    lookup.mockReset()
    requestMock.mockReset()
  })

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv
  })

  it('rejects a hostname when any DNS answer is private', async () => {
    lookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.7', family: 4 },
    ])

    await expect(validatePinnedUrl('https://jobs.example.test/posting')).resolves.toBeNull()
  })

  it('upgrades legacy HTTP URLs to HTTPS in production', async () => {
    process.env.NODE_ENV = 'production'
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])

    await expect(validatePinnedUrl('http://jobs.example.test/posting')).resolves.toMatchObject({
      protocol: 'https:',
    })
  })

  it('does not allow the local-development exception in production', async () => {
    process.env.NODE_ENV = 'production'

    await expect(validatePinnedUrl('http://127.0.0.1:1234/v1', { allowLocalDevelopment: true }))
      .resolves.toBeNull()
  })

  it('uses the address checked by DNS for the socket lookup', async () => {
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    mockedRequest()

    const response = await pinnedFetch('http://jobs.example.test/posting', { redirect: 'error' })
    expect(response.status).toBe(200)
    const options = requestMock.mock.calls[0]?.[0] as {
      hostname: string
      lookup: (hostname: string, options: object, callback: (error: Error | null, address: string, family: number) => void) => void
    }
    expect(options.hostname).toBe('jobs.example.test')
    await new Promise<void>((resolve, reject) => {
      options.lookup('ignored.example.test', {}, (error, address, family) => {
        try {
          expect(error).toBeNull()
          expect(address).toBe('93.184.216.34')
          expect(family).toBe(4)
          resolve()
        } catch (assertionError) {
          reject(assertionError)
        }
      })
    })
    await expect(response.text()).resolves.toBe('ok')
  })
})
