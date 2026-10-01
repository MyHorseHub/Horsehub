import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022'
  },
  optimizeDeps: {
    exclude: ['@powersync/web', '@journeyapps/wa-sqlite']
  },
  worker: {
    format: 'es'
  }
});
