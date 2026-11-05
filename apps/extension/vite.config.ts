import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { execSync } from 'child_process'

function postBuild(development: boolean) {
  return {
    name: 'postbuild',
    closeBundle() {
      try {
        execSync('node build.cjs', {
          cwd: __dirname, stdio: 'inherit',
          env: { ...process.env, APPLYMATE_EXTENSION_BUILD_MODE: development ? 'development' : 'production' },
        })
      } catch (e) {
        console.error('postbuild error:', e)
        throw e
      }
    },
  }
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), postBuild(mode === 'development' || process.argv.includes('--watch'))],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir:     'dist',
    emptyOutDir: true,
    minify:     false,
    sourcemap:  false,
    rollupOptions: {
      input: {
        popup:     path.resolve(__dirname, 'src/popup/index.html'),
        sidepanel: path.resolve(__dirname, 'src/sidepanel/index.html'),
        background: path.resolve(__dirname, 'src/background/index.ts'),
        content:   path.resolve(__dirname, 'src/content/index.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: 'assets/[name].[ext]',
        // Force storage + api into dedicated chunks so build.cjs can inline them cleanly
        manualChunks(id) {
          if (id.includes('/lib/storage')) return 'storage'
          if (id.includes('/lib/api'))     return 'api'
        },
      },
    },
  },
}))
