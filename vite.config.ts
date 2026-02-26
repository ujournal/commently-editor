import { defineConfig } from 'vite'

export default defineConfig({
  root: '.',
  base: process.env.BASE_PATH || '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
