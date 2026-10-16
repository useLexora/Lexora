import { randomUUID } from 'node:crypto'
import path from 'node:path'
import process from 'node:process'
import { defineConfig } from '@playwright/test'
import { ROOT } from './shared.mjs'

const databaseUrl = process.env.TEST_DATABASE_URL
if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_test'))
  throw new Error('TEST_DATABASE_URL must point to a disposable database ending in _test')

const artifacts = path.resolve(process.env.LEXORA_TEST_ARTIFACT_DIR ?? path.join(ROOT, '.playwright/runs', randomUUID()))

export default defineConfig({
  outputDir: path.join(artifacts, 'results'),
  reporter: [['list'], ['html', { outputFolder: path.join(artifacts, 'report'), open: 'never' }]],
  forbidOnly: !!process.env.CI,
  testDir: './community/__tests__',
  testMatch: '**/*.e2e.mjs',
  workers: 1,
  retries: 0,
  timeout: 30000,
  use: { baseURL: 'http://localhost:4175', headless: true, trace: 'retain-on-failure' },
  webServer: [
    { command: 'pnpm --filter @uselexora/lexora-api exec node --experimental-strip-types src/main.ts', url: 'http://localhost:4176/api/health', timeout: 30000, env: { DATABASE_URL: databaseUrl, PUBLIC_ORIGIN: 'http://localhost:4175', PORT: '4176', LEXORA_ADMIN_IDENTITIES: 'github:community-e2e-admin' } },
    { command: 'pnpm --filter @uselexora/lexora-web dev --port 4175', url: 'http://localhost:4175', timeout: 30000, env: { LEXORA_API_URL: 'http://127.0.0.1:4176' } },
  ],
})
