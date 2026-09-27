import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['packages/jev/lib/types/index.js', 'packages/jev/lib/types/selection.js', 'packages/jev/lib/types/instructions.js'],
  outDir: 'packages/jev/lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  external: [/^@deepseek-ai\//, /^@dsh-jev\//, /^react(?:-dom)?(?:\/.*)?$/],
})
