import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { execSync } from 'child_process'

function postBuild() {
  return {
    name: 'postbuild',
    closeBundle() {
      try {
        execSync('node build.cjs', { cwd: __dirname, stdio: 'inherit' })
      } catch (e) {
        console.error('postbuild error:', e)
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), postBuild()],
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
      },
    },
  },
})
