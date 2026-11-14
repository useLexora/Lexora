import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire, isBuiltin } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { expect, test } from '../fixtures/electron.mjs'
import { ROOT } from '../shared.mjs'

const requireBuddy = createRequire(path.join(ROOT, 'apps/buddy/package.json'))
const contentText = '旧版迁移附件 😀 完整字节保留。\n'

test.use({ passwordStore: process.env.LEXORA_TEST_PASSWORD_STORE })

test('installed legacy data migrates with attachments and accepts new work without changing the source', async ({ buddy }, testInfo) => {
  test.skip(!process.env.LEXORA_TEST_LEGACY_EXECUTABLE, 'Set the installed legacy executable to validate its actual data')
  test.setTimeout(240000)
  const requests = []
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    const common = { id: `migration-${requests.length}`, model: 'migration-fixture', object: 'chat.completion.chunk', created: 1 }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: 'assistant', content: '迁移验收固定输出 😀' }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 32, completion_tokens: 8, total_tokens: 40 } })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const source = await buddy.createInstance('installed-legacy', { executablePath: process.env.LEXORA_TEST_LEGACY_EXECUTABLE })
  const candidate = await buddy.createInstance('migration-candidate')
  let success = false
  try {
    const { page } = await source.launch()
    const info = await page.evaluate(() => window.lexoraDesktop.app.getInfo())
    await page.evaluate(async (baseUrl) => {
      const providers = window.lexoraDesktop.localChat.providers
      await providers.upsertCustom({ id: 'migration-fixture', displayName: 'Migration fixture', api: 'openai-completions', baseUrl, enabled: true, models: [{ id: 'migration-fixture', name: 'Migration fixture', input: ['text'], reasoning: false, contextWindow: 128000, maxTokens: 1024 }] })
      const stop = providers.onAuthChallenge((challenge) => {
        if (challenge.providerId === 'migration-fixture' && challenge.type === 'secret')
          void providers.respondToAuth(challenge.challengeId, 'isolated-migration-fixture-key')
      })
      try {
        await providers.login('migration-fixture', 'api_key')
      }
      finally { stop() }
      await providers.setDefaultModel({ providerId: 'migration-fixture', modelId: 'migration-fixture', reasoning: null })
      await window.lexoraDesktop.settings.update({ desktop: { notificationsEnabled: false } })
    }, `http://127.0.0.1:${server.address().port}/v1`)
    await page.reload()
    const editor = page.locator('.desktop-workbench-area__tasks .tiptap:visible').first()
    await expect(editor).toBeVisible()
    await editor.fill('由已安装旧版创建的输入 😀')
    await expect.poll(() => page.evaluate(async () => (await window.lexoraDesktop.localChat.composerDrafts.list()).some(draft => JSON.stringify(draft.content).includes('由已安装旧版创建')))).toBe(true)
    const editorDraftId = await page.evaluate(async () => (await window.lexoraDesktop.localChat.composerDrafts.list()).find(draft => JSON.stringify(draft.content).includes('由已安装旧版创建')).draftId)
    const oldDraft = await createAttachmentDraft(page, '由已安装旧版创建的输入 😀', contentText, editorDraftId)
    const turn = await page.evaluate(async (draftId) => {
      const api = window.lexoraDesktop.localChat
      const draft = await api.composerDrafts.get(draftId)
      return api.chat.startTurn({ draftId, expectedRevision: draft.revision, requestId: crypto.randomUUID() })
    }, (await createAttachmentDraft(page, '旧版带附件任务', contentText)).draftId)
    await expect.poll(() => readRows(source.home, 'SELECT status FROM runs WHERE id = ?', turn.run.id)[0]?.status, { timeout: 45000 }).toBe('completed')
    expect(JSON.stringify(requests)).toContain('旧版迁移附件')
    const originalDraft = await page.evaluate(id => window.lexoraDesktop.localChat.composerDrafts.get(id), oldDraft.draftId)
    await source.stop()
    const reopened = await source.launch()
    expect(await reopened.page.evaluate(id => window.lexoraDesktop.localChat.composerDrafts.get(id), oldDraft.draftId)).toEqual(originalDraft)
    await source.stop()
    await fs.writeFile(path.join(source.home, 'unknown-preserved.bin'), Buffer.from([0, 1, 127, 255]))
    const sourceRows = readRows(source.home, 'SELECT id, conversation_id, branch_id, status, pi_session_file FROM runs ORDER BY id')
    expect(sourceRows.some(row => row.pi_session_file)).toBe(true)
    const original = await fingerprints(source.home)
    const output = testInfo.outputPath('migration-module')
    const { build } = await import(pathToFileURL(requireBuddy.resolve('vite')).href)
    await build({ configFile: false, logLevel: 'error', build: { ssr: path.join(ROOT, '.playwright/scripts/__tests__/prepareProductProfile.ts'), outDir: output, target: 'node26', rolldownOptions: { external: isBuiltin, output: { entryFileNames: 'prepare.mjs', format: 'es' } } } })
    const { activatePersistenceCandidate, importPersistenceCandidate, openBuddySqliteDatabase } = await import(pathToFileURL(path.join(output, 'prepare.mjs')).href)
    expect(() => openBuddySqliteDatabase({ databasePath: path.join(source.home, 'buddy/buddy.sqlite3') })).toThrow('explicit persistence migration required')
    expect(await fingerprints(source.home)).toEqual(original)
    const input = { sourceRoot: source.home, candidateRoot: path.join(candidate.home, 'migration'), leaseDirectory: path.join(buddy.directory, 'leases'), signal: new AbortController().signal }
    for (const point of ['copied', 'run', 'files', 'verified']) {
      await expect(importPersistenceCandidate({ ...input, checkpoint: async (phase) => {
        if (phase === point)
          throw new Error(`Interrupted at ${point}`)
      } })).rejects.toThrow(`Interrupted at ${point}`)
      expect(await fingerprints(source.home)).toEqual(original)
    }
    const migrated = await activatePersistenceCandidate(input)
    expect(await activatePersistenceCandidate(input)).toEqual(migrated)
    expect(await fingerprints(source.home)).toEqual(original)
    expect(readRows(migrated.profileRoot, 'SELECT authority, migration_state FROM storage_profile')).toEqual([{ authority: 'sqlite', migration_state: 'ready' }])
    expect(readRows(migrated.profileRoot, 'SELECT id, conversation_id, branch_id, status, pi_session_file FROM runs ORDER BY id')).toEqual(sourceRows.map(row => ({ ...row, pi_session_file: row.pi_session_file?.replace(source.home, migrated.profileRoot) ?? null })))
    expect(await fs.readFile(path.join(migrated.profileRoot, 'unknown-preserved.bin'))).toEqual(Buffer.from([0, 1, 127, 255]))
    const migratedLaunch = await candidate.launch({ profileRoot: migrated.profileRoot, storageAuthority: 'sqlite' })
    expect(await migratedLaunch.page.evaluate(id => window.lexoraDesktop.localChat.composerDrafts.get(id), oldDraft.draftId)).toMatchObject(originalDraft)
    const attachment = await migratedLaunch.page.evaluate(async (id) => {
      const api = window.lexoraDesktop.localChat
      const resource = (await api.composerResources.list(id))[0]
      return api.composerResources.readText({ draftId: id, resourceId: resource.resourceId })
    }, oldDraft.draftId)
    expect(attachment).toBe(contentText)
    const nextDraft = await createAttachmentDraft(migratedLaunch.page, '迁移后新工作', contentText)
    const next = await migratedLaunch.page.evaluate(async (draftId) => {
      const api = window.lexoraDesktop.localChat
      const draft = await api.composerDrafts.get(draftId)
      const command = { draftId, expectedRevision: draft.revision, requestId: crypto.randomUUID() }
      const first = await api.chat.startTurn(command)
      const retry = await api.chat.startTurn(command)
      return { first, retry }
    }, nextDraft.draftId)
    expect(next.retry.run.id).toBe(next.first.run.id)
    await expect.poll(() => readRows(migrated.profileRoot, 'SELECT status FROM runs WHERE id = ?', next.first.run.id)[0]?.status, { timeout: 45000 }).toBe('completed')
    await candidate.stop()
    const databaseBytes = await fs.readFile(path.join(migrated.profileRoot, 'buddy/buddy.sqlite3'))
    const rejected = await source.launch({ profileRoot: migrated.profileRoot, startupStatus: 'failed' })
    let rejection
    await expect.poll(async () => {
      rejection = await rejected.page.evaluate(() => window.lexoraDesktop.app.startup.getState())
      return rejection.status
    }).toBe('failed')
    expect(rejection.stages).toEqual(expect.arrayContaining([expect.objectContaining({ stage: 'runtime.database', status: 'failed' })]))
    await source.stop()
    expect(await fs.readFile(path.join(migrated.profileRoot, 'buddy/buddy.sqlite3'))).toEqual(databaseBytes)
    expect(await fingerprints(source.home)).toEqual(original)
    await fs.writeFile(testInfo.outputPath('migration-result.json'), JSON.stringify({ installedVersion: info.version, installedExecutable: process.env.LEXORA_TEST_LEGACY_EXECUTABLE, sourceRuns: sourceRows.length, migrated, oldRun: turn.run.id, newRun: next.first.run.id, sourceUnchanged: true, migrationCheckpoints: ['copied', 'run', 'files', 'verified'], oldBinaryRejection: rejection }, null, 2))
    success = true
  }
  finally {
    await source.stop()
    await candidate.stop()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    if (!success)
      await fs.writeFile(testInfo.outputPath('provider-requests.json'), JSON.stringify(requests, null, 2))
  }
})

async function createAttachmentDraft(page, text, attachment, draftId = randomUUID()) {
  return page.evaluate(async ({ text, attachment, draftId, resourceId }) => {
    const api = window.lexoraDesktop.localChat
    const content = { version: 1, body: [{ type: 'paragraph', content: [{ type: 'text', text }] }], panelResourceIds: [] }
    let draft = await api.composerDrafts.open({ draftId, scope: { kind: 'task', draftId, spaceId: null }, initialContent: content, initialExecutionConfig: { approvalPolicy: 'policy', executionProfile: 'workspace_write' }, initialModelSelection: { providerId: 'migration-fixture', modelId: 'migration-fixture', reasoning: null, serviceTier: null } })
    const bytes = new TextEncoder().encode(attachment)
    await api.composerResources.accept({ draftId, resources: [{ resourceId, name: '迁移附件.txt', mimeType: 'text/plain', sizeBytes: bytes.length }] })
    await api.composerResources.complete({ draftId, resourceId, bytes })
    draft = await api.composerDrafts.get(draftId)
    return api.composerDrafts.save({ draftId, expectedRevision: draft.revision, content: { ...content, panelResourceIds: [resourceId] }, modelSelection: draft.modelSelection, executionConfig: draft.executionConfig })
  }, { text, attachment, draftId, resourceId: randomUUID() })
}

function readRows(profileRoot, sql, ...params) {
  const database = new DatabaseSync(path.join(profileRoot, 'buddy/buddy.sqlite3'), { readOnly: true })
  try {
    return database.prepare(sql).all(...params).map(row => ({ ...row }))
  }
  finally { database.close() }
}

async function fingerprints(root) {
  const result = {}
  for (const entry of await fs.readdir(root, { withFileTypes: true, recursive: true })) {
    const absolute = path.join(entry.parentPath, entry.name)
    const relative = path.relative(root, absolute)
    if (relative.startsWith('.runtime/') || relative === 'buddy/buddy.sqlite3-shm')
      continue
    if (entry.isFile())
      result[relative] = createHash('sha256').update(await fs.readFile(absolute)).digest('hex')
    else if (entry.isSymbolicLink())
      result[relative] = await fs.readlink(absolute)
  }
  return result
}
