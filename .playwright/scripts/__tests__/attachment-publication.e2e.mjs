import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { createRequire, isBuiltin } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { expect, test } from '@playwright/test'

const execute = promisify(execFile)
const root = fileURLToPath(new URL('../../../', import.meta.url))
const requireBuddy = createRequire(path.join(root, 'apps/buddy/package.json'))
const checkpoints = ['prepared', 'file-synced', 'renamed', 'directory-synced', 'published', 'bound']

test('interrupted file publication recovers only durable attachment ownership', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lexora-attachment-publication-'))
  const report = []
  try {
    const { build } = await import(pathToFileURL(requireBuddy.resolve('vite')).href)
    await build({ configFile: false, logLevel: 'error', build: {
      ssr: path.join(root, '.playwright/scripts/fixtures/attachment-publication-crash.ts'),
      outDir: path.join(directory, 'harness'),
      target: 'node26',
      rolldownOptions: { external: isBuiltin, output: { entryFileNames: 'publication.mjs', format: 'es' } },
    } })
    const entry = path.join(directory, 'harness/publication.mjs')
    for (const checkpoint of checkpoints) {
      const profile = path.join(directory, checkpoint)
      const unknown = path.join(profile, 'profile/drafts/unknown/keep.txt')
      await fs.mkdir(path.dirname(unknown), { recursive: true })
      await fs.writeFile(unknown, 'unknown files are preserved')
      let interrupted
      try {
        await execute(process.execPath, [entry, 'publish', profile, checkpoint], { timeout: 30000 })
      }
      catch (error) { interrupted = error }
      expect(interrupted, checkpoint).toBeTruthy()
      expect(JSON.parse(interrupted.stdout.trim())).toEqual({ checkpoint })
      const result = await execute(process.execPath, [entry, 'recover', profile], { timeout: 30000 })
      const recovery = JSON.parse(result.stdout.trim())
      const bound = checkpoint === 'bound'
      expect(recovery.files).toHaveLength(1)
      expect(recovery.files[0].state).toBe(bound ? 'ready' : 'deleted')
      expect(recovery.references).toEqual(bound ? [{ kind: 'draft', owner_id: 'crash-draft' }] : [])
      expect(recovery.bytes).toEqual(bound ? ['durable attachment bytes'] : [])
      expect(recovery.preparations).toEqual([{ state: bound ? 'settled' : 'aborted', reserved_bytes: 0 }])
      expect(await fs.readFile(unknown, 'utf8')).toBe('unknown files are preserved')
      const repeat = JSON.parse((await execute(process.execPath, [entry, 'recover', profile], { timeout: 30000 })).stdout.trim())
      expect(repeat.files).toEqual(recovery.files)
      expect(repeat.references).toEqual(recovery.references)
      expect(repeat.recovered.removedOrphanFiles).toBe(0)
      report.push({ checkpoint, ...recovery })
    }
  }
  finally {
    const reportPath = test.info().outputPath('attachment-publication.json')
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2))
    await test.info().attach('attachment-publication.json', { path: reportPath, contentType: 'application/json' })
    await fs.rm(directory, { recursive: true, force: true })
  }
})
