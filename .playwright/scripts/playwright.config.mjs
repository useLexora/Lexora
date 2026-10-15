import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import process from 'node:process'
import { defineConfig } from '@playwright/test'
import { createRunDirectory } from './run-artifacts.mjs'
import { ROOT } from './shared.mjs'

const runId = process.env.LEXORA_TEST_RUN_ID ??= `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
assert(/^[\w-]{1,100}$/.test(runId), 'Invalid test run ID')
const invocationId = process.env.LEXORA_TEST_INVOCATION_ID ??= randomUUID()
assert(/^[\w-]{1,100}$/.test(invocationId), 'Invalid test invocation ID')
const selected = process.argv.filter(value => value.endsWith('.e2e.mjs'))
const task = process.env.LEXORA_TEST_TASK ?? (selected.length === 1 ? `buddy-${path.basename(selected[0], '.e2e.mjs').replaceAll(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}` : 'buddy-e2e')
const artifacts = process.env.LEXORA_TEST_ARTIFACT_DIR ??= createRunDirectory({ task, runId, invocationId })
const relative = path.relative(path.join(ROOT, '.playwright/runs'), artifacts)
assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Invalid test artifact directory')

export default defineConfig({
  testDir: './__tests__',
  testMatch: '**/*.e2e.mjs',
  outputDir: path.join(artifacts, 'results'),
  reporter: [['list'], ['html', { outputFolder: path.join(artifacts, 'report'), open: 'never' }], [path.join(ROOT, '.playwright/scripts/run-reporter.mjs'), { directory: artifacts }]],
  forbidOnly: !!process.env.CI,
  workers: 1,
  retries: 0,
  timeout: 120000,
  expect: { timeout: 10000 },
  projects: [{ name: 'buddy' }],
})
