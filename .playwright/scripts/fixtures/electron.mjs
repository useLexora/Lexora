import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { test as base } from '@playwright/test'
import { createBuddyTestRun } from '../buddy-test.mjs'

export const test = base.extend({
  buddy: [async ({ playwright: _playwright }, use, testInfo) => {
    const run = await createBuddyTestRun({ artifactRoot: testInfo.outputPath('desktop') })
    try {
      await use(run)
    }
    finally {
      try {
        await run.dispose({ preserve: testInfo.status !== 'passed' || process.env.LEXORA_TEST_KEEP_DATA === '1' })
      }
      finally {
        const metadata = testInfo.outputPath('instances.json')
        await fs.writeFile(metadata, JSON.stringify({ runId: run.runId, instances: run.records }, null, 2), { mode: 0o600 })
        await testInfo.attach('instances', {
          path: metadata,
          contentType: 'application/json',
        })
        for (const record of run.records) {
          for (const file of await fs.readdir(record.artifactDirectory)) {
            await testInfo.attach(`${path.basename(record.home)}-${file}`, {
              path: path.join(record.artifactDirectory, file),
              contentType: file.endsWith('.png') ? 'image/png' : 'application/zip',
            })
          }
        }
      }
    }
  }, { timeout: 180000 }],
})

export { expect } from '@playwright/test'
