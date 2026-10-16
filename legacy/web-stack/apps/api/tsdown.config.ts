import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/main.ts', 'src/cli/reset-system-admin-password.ts', 'src/cli/migrate-crypto-namespace.ts'],
  format: 'esm',
  clean: true,
  sourcemap: true,
  deps: {
    alwaysBundle: [/^@haohaoxue\/lexora-(?:contracts|shared)(?:\/.*)?$/],
  },
  unbundle: true,
})
