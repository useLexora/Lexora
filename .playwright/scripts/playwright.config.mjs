import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import process from 'node:process'
import { defineConfig } from '@playwright/test'
import { ROOT } from './shared.mjs'

const runId = process.env.LEXORA_TEST_RUN_ID ??= `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
assert(/^[\w-]{1,100}$/.test(runId), 'Invalid test run ID')
const invocationId = process.env.LEXORA_TEST_INVOCATION_ID ??= randomUUID()
assert(/^[\w-]{1,100}$/.test(invocationId), 'Invalid test invocation ID')
const artifacts = path.join(ROOT, '.playwright/runs', runId, invocationId)

export default defineConfig({
  testDir: './__tests__',
  testMatch: '**/*.e2e.mjs',
  outputDir: path.join(artifacts, 'results'),
  reporter: [['list'], ['html', { outputFolder: path.join(artifacts, 'report'), open: 'never' }]],
  forbidOnly: !!process.env.CI,
  workers: 1,
  retries: 0,
  timeout: 120000,
  expect: { timeout: 10000 },
  projects: [{ name: 'buddy' }],
})
