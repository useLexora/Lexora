import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/main.ts', 'src/cli/import-catalog.ts'],
  format: 'esm',
  clean: true,
  sourcemap: true,
  deps: { alwaysBundle: [/^@uselexora\/lexora-contracts/] },
})
