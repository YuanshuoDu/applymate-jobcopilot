import type { ApprovalScope } from './approval.js'
import { serializeApprovalScope } from './approval.js'

interface CryptoLike {
  getRandomValues<T extends ArrayBufferView>(array: T): T
  subtle: { digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer> }
}

interface TextEncoderLike { encode(input: string): Uint8Array }

const runtimeCrypto = (globalThis as typeof globalThis & { crypto?: CryptoLike }).crypto
const runtimeTextEncoder = (globalThis as typeof globalThis & { TextEncoder?: new () => TextEncoderLike }).TextEncoder

function cryptoRuntime(): CryptoLike {
  if (!runtimeCrypto) throw new Error('Web Crypto is required for approval receipt hashing')
  return runtimeCrypto
}

function textEncoder(): TextEncoderLike {
  if (!runtimeTextEncoder) throw new Error('TextEncoder is required for approval receipt hashing')
  return new runtimeTextEncoder()
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function createApprovalNonce(): string {
  const bytes = cryptoRuntime().getRandomValues(new Uint8Array(32))
  return hex(bytes.buffer)
}

export async function sha256Hex(value: string): Promise<string> {
  return hex(await cryptoRuntime().subtle.digest('SHA-256', textEncoder().encode(value)))
}

export async function hashApprovalNonce(nonce: string): Promise<string> {
  return sha256Hex(`applymate.approval-nonce.v1:${nonce}`)
}

export async function hashApprovalScope(scope: ApprovalScope): Promise<string> {
  return sha256Hex(`applymate.approval-scope.v1:${serializeApprovalScope(scope)}`)
}
