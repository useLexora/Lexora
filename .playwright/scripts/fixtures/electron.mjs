import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { test as base } from '@playwright/test'
import { createBuddyTestRun } from '../buddy-test.mjs'
import { ROOT } from '../shared.mjs'

async function startDevelopmentRenderer(cacheDir) {
  const root = path.join(ROOT, 'apps/buddy')
  const require = createRequire(path.join(root, 'package.json'))
  const { resolveConfig } = await import(pathToFileURL(require.resolve('electron-vite')).href)
  const { createServer } = await import(pathToFileURL(require.resolve('vite')).href)
  const cwd = process.cwd()
  let server
  try {
    process.chdir(root)
    const resolved = await resolveConfig({ root, cacheDir, server: { host: '127.0.0.1', port: 0, strictPort: false } }, 'serve')
    server = await createServer(resolved.config.renderer)
    await server.listen()
    return server
  }
  catch (error) {
    await server?.close()
    throw error
  }
  finally {
    process.chdir(cwd)
  }
}

export const test = base.extend({
  passwordStore: [undefined, { option: true }],
  developmentRenderer: [process.env.LEXORA_TEST_DEV_RENDERER === '1', { option: true }],
  rendererUrl: async ({ developmentRenderer }, use, testInfo) => {
    const server = developmentRenderer ? await startDevelopmentRenderer(testInfo.outputPath('vite-cache')) : undefined
    try {
      await use(server?.resolvedUrls.local[0])
    }
    finally {
      await server?.close()
    }
  },
  buddy: [async ({ playwright: _playwright, passwordStore, rendererUrl }, use, testInfo) => {
    const run = await createBuddyTestRun({ artifactRoot: testInfo.outputPath('desktop'), passwordStore, rendererUrl })
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

export async function useSyntheticCredentialStorage({ app, page }) {
  await app.evaluate(({ app, safeStorage }) => {
    if (app.getName() !== 'Lexora Buddy Test')
      throw new Error('Synthetic credentials require an isolated test instance')
    const { Buffer } = process.getBuiltinModule('node:buffer')
    Object.defineProperties(safeStorage, {
      isEncryptionAvailable: { configurable: true, value: () => true },
      getSelectedStorageBackend: { configurable: true, value: () => 'offline-fixture' },
      encryptString: { configurable: true, value: value => Buffer.from(`offline-fixture:${value}`) },
      decryptString: {
        configurable: true,
        value: (value) => {
          const serialized = value.toString('utf8')
          if (!serialized.startsWith('offline-fixture:'))
            throw new Error('Unexpected credential in isolated fixture')
          return serialized.slice('offline-fixture:'.length)
        },
      },
    })
  })
  await page.evaluate(() => window.lexoraDesktop.localChat.runtime.restart())
  await base.expect.poll(async () => (await page.evaluate(() => window.lexoraDesktop.localChat.runtime.getStatus())).status).toBe('ready')
}
