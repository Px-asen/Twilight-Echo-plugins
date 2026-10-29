import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  build: {
    outDir: '../ui-dist',
    emptyOutDir: true,
    target: 'es2022'
  }
})
