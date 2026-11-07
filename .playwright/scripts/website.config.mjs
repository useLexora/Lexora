import { randomUUID } from 'node:crypto'
import path from 'node:path'
import process from 'node:process'
import { defineConfig } from '@playwright/test'
import { ROOT } from './shared.mjs'

const artifacts = path.resolve(process.env.LEXORA_TEST_ARTIFACT_DIR ?? path.join(ROOT, '.playwright/runs', randomUUID()))
const baseURL = 'http://127.0.0.1:4174'

export default defineConfig({
  testDir: './website/__tests__',
  testMatch: '**/*.spec.mjs',
  outputDir: path.join(artifacts, 'results'),
  reporter: [['list'], ['html', { outputFolder: path.join(artifacts, 'report'), open: 'never' }]],
  forbidOnly: !!process.env.CI,
  workers: 2,
  retries: 0,
  timeout: 30000,
  use: {
    baseURL,
    headless: true,
    viewport: { width: 1280, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { executablePath: process.env.CHROME_EXECUTABLE_PATH },
  },
  webServer: {
    command: 'pnpm --filter @uselexora/lexora-website dev --host 127.0.0.1 --port 4174 --strictPort',
    cwd: ROOT,
    url: baseURL,
    timeout: 30000,
    env: { WEBSITE_BASE_PATH: '' },
  },
})
