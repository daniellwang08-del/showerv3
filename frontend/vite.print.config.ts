import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Print bundle: the resume paginator + templates as a standalone page that the API's
 * headless Chromium loads to produce PDFs. It is the same code the studio renders,
 * so a PDF page is pixel-for-pixel the page the user designed.
 * Output: app/assets/print (served to Chromium from disk, never over the network).
 */
const outDir = path.resolve(__dirname, '../app/assets/print')

function copyResumeFonts(): Plugin {
  return {
    name: 'nao-copy-resume-fonts',
    closeBundle() {
      const src = path.resolve(__dirname, 'public/fonts')
      const dest = path.join(outDir, 'fonts')
      fs.mkdirSync(dest, { recursive: true })
      for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(dest, f))
    },
  }
}

export default defineConfig({
  plugins: [
    react({ babel: { plugins: [['babel-plugin-react-compiler', {}]] } }),
    copyResumeFonts(),
  ],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  publicDir: false,
  base: '/',
  build: {
    outDir,
    emptyOutDir: true,
    assetsDir: 'assets',
    rollupOptions: { input: path.resolve(__dirname, 'print.html') },
  },
})
