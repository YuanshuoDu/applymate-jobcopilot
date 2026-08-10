import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['@anthropic-ai/sdk', 'node-fetch', 'pdf-parse', 'mammoth', 'bullmq', 'ioredis', 'pg'],
}

export default nextConfig
