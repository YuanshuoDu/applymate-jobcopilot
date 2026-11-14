import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['@anthropic-ai/sdk', 'node-fetch', 'pdf-parse', 'mammoth', 'bullmq', 'ioredis', 'pg'],
  // PDF fonts are loaded from disk at runtime, so trace both download routes.
  outputFileTracingIncludes: {
    '/api/jobs/*/application-pack': ['./public/fonts/NotoSans-Regular.ttf', './public/fonts/NotoSansSC-GB2312-Regular.ttf'],
    '/api/jobs/*/export-local': ['./public/fonts/NotoSans-Regular.ttf', './public/fonts/NotoSansSC-GB2312-Regular.ttf'],
  },
}

export default nextConfig
