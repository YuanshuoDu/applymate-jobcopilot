import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['@anthropic-ai/sdk', 'node-fetch'],
}

export default nextConfig
