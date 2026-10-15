import { Buffer } from 'node:buffer'
import { expect, test } from '../fixtures/electron.mjs'

test('legacy caches and diagnostic logs alone do not trigger a startup migration', async ({ buddy }) => {
  const { mkdir, readFile, writeFile } = await import('node:fs/promises')
  const { join, dirname } = await import('node:path')
  const instance = await buddy.createInstance('cache-only')
  const files = ['.runtime/cache/chromium/Cache/data', '.runtime/cache/chromium/Code Cache/data', '.runtime/state/logs/old.log', '.runtime/state/crashes/old-report']
  for (const file of files) {
    await mkdir(dirname(join(instance.home, file)), { recursive: true })
    await writeFile(join(instance.home, file), 'retained-fixture')
  }
  const desktop = await instance.launch()
  const summary = await desktop.page.evaluate(() => window.lexoraDesktop.storage.summary())
  expect(summary.pending).toBeNull()
  expect(summary.history).toEqual([])
  for (const file of files)
    expect(await readFile(join(instance.home, file), 'utf8')).toBe('retained-fixture')
})

test('stopping initial consolidation exits with source data intact and offers retry on next launch', async ({ buddy }) => {
  const { createHash } = await import('node:crypto')
  const { mkdir, open, readFile, stat } = await import('node:fs/promises')
  const { dirname, join } = await import('node:path')
  const instance = await buddy.createInstance('initial-stop')
  const source = join(instance.home, '.runtime', 'cache', 'chromium', 'Local Storage', 'fixture')
  await mkdir(dirname(source), { recursive: true })
  const file = await open(source, 'wx')
  await file.truncate(256 * 1024 ** 2)
  await file.close()
  const migration = await instance.launch({ maintenance: true })
  const child = migration.app.process()
  await migration.page.getByRole('link', { name: '停止整理并退出', exact: true }).click()
  await expect.poll(() => child.exitCode).toBe(0)
  await instance.stop()
  const locator = join(dirname(instance.home), '.lexora-locations', createHash('sha256').update(instance.home).digest('hex').slice(0, 24), 'location.json')
  expect(JSON.parse(await readFile(locator, 'utf8')).pending).toMatchObject({ kind: 'consolidate', phase: 'failed', error: 'STORAGE_CANCELLED' })
  expect((await stat(source)).size).toBe(256 * 1024 ** 2)
  const recovery = await instance.launch({ maintenance: true })
  await expect(recovery.page.getByRole('link', { name: '重试', exact: true })).toBeVisible()
  expect(await recovery.app.evaluate(({ app }) => app.getAppMetrics().some(metric => metric.name === 'Buddy Service'))).toBe(false)
})

test('initial consolidation failure exports safe diagnostics and opens a prefilled issue without changing source data', async ({ buddy }) => {
  const { mkdir, readFile, writeFile } = await import('node:fs/promises')
  const { dirname, join } = await import('node:path')
  const { createRequire } = await import('node:module')
  const { unzipSync, strFromU8 } = createRequire(new URL('../../../apps/buddy/package.json', import.meta.url))('fflate')
  const instance = await buddy.createInstance('initial-diagnostics')
  const source = join(instance.home, '.runtime/cache/chromium/Local Storage/fixture')
  const occupied = join(instance.home, 'device/chromium/keep.txt')
  for (const file of [source, occupied]) {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, 'private-fixture-content')
  }
  const { app, page } = await instance.launch({ maintenance: true })
  await expect(page.locator('#error-code')).toHaveText('STORAGE_TARGET_NOT_EMPTY')
  expect(await app.evaluate(({ app }) => app.getAppMetrics().some(metric => metric.name === 'Buddy Service'))).toBe(false)
  const destination = join(instance.artifactDirectory, 'migration-diagnostics.zip')
  await app.evaluate(({ dialog, shell }) => {
    globalThis.migrationIssueUrl = null
    dialog.showSaveDialog = async () => {
      throw new Error('private-fixture-dialog-error')
    }
    shell.openExternal = async (url) => {
      globalThis.migrationIssueUrl = url
    }
  })
  const action = id => app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(`document.getElementById(${JSON.stringify(id)}).click()`), id)
  const status = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('document.getElementById(\'support-status\').textContent'))
  await action('export')
  await expect.poll(status).toContain('未能导出')
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
  }, destination)
  await action('export')
  await expect.poll(status).toContain('已保存到本机')
  const archive = unzipSync(await readFile(destination))
  const context = strFromU8(archive['context.jsonl']).trim().split('\n').map(line => JSON.parse(line))
  const failure = context.find(record => record.event === 'storage.consolidate.failed')
  expect(failure).toMatchObject({ errorCode: 'STORAGE_TARGET_NOT_EMPTY', level: 'error', attempt: 1 })
  expect(context).toEqual(expect.arrayContaining([expect.objectContaining({ event: 'storage.migration.started', operationId: failure.operationId })]))
  const exported = Object.values(archive).map(value => strFromU8(value)).join('\n')
  expect(exported).not.toContain(instance.home)
  expect(exported).not.toContain('private-fixture')
  expect(await app.evaluate(() => globalThis.migrationIssueUrl)).toBeNull()
  await action('issue')
  await expect.poll(status).toContain('已打开 Issue 页面')
  const issue = new URL(await app.evaluate(() => globalThis.migrationIssueUrl))
  expect(issue.origin + issue.pathname).toBe('https://github.com/useLexora/Lexora/issues/new')
  expect(issue.searchParams.get('body')).toContain(failure.operationId)
  expect(issue.searchParams.get('body')).toContain('STORAGE_TARGET_NOT_EMPTY')
  expect(issue.searchParams.get('body')).not.toContain(instance.home)
  expect(issue.searchParams.get('body')).not.toContain('private-fixture')
  for (const file of [source, occupied])
    expect(await readFile(file, 'utf8')).toBe('private-fixture-content')
})

test('storage settings keep the active path and block backups until a pending move is cancelled', async ({ buddy }) => {
  const instance = await buddy.createInstance('storage')
  const { page, app } = await instance.launch()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('link', { name: '数据存储', exact: true }).click()
  await expect(page.getByTestId('storage-current-root')).toHaveText(instance.home)
  const target = `${instance.home}-moved`
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
  }, target)
  await page.getByRole('button', { name: '更改目录', exact: true }).click()
  await expect(page.getByTestId('storage-current-root')).toHaveText(instance.home)
  await expect(page.getByTestId('storage-pending')).toContainText(target)
  await expect(page.getByRole('button', { name: '创建备份', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.getByTestId('storage-pending')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '创建备份', exact: true })).toBeEnabled()
})

test('local backup limits defer deletion until confirmation or the next successful backup', async ({ buddy }) => {
  test.setTimeout(180000)
  const instance = await buddy.createInstance('backup-retention')
  let { page } = await instance.launch()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('link', { name: '数据存储', exact: true }).click()
  let control = page.getByRole('spinbutton', { name: '本地备份保留数量', exact: true })
  const ids = await page.evaluate(async () => {
    const ids = []
    for (let index = 0; index < 2; index++)
      ids.push((await window.lexoraDesktop.storage.snapshot({ scopes: ['tasks'], credentials: false })).id)
    return ids
  })
  const catalog = () => page.evaluate(async () => (await window.lexoraDesktop.storage.snapshots()).snapshots.map(item => item.id))
  await expect.poll(catalog).toEqual(ids.toReversed())
  await page.reload()
  await page.waitForFunction(async () => (await window.lexoraDesktop.app.startup.getState()).status === 'ready')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('link', { name: '数据存储', exact: true }).click()
  await control.fill('1')
  await control.press('Tab')
  let confirmation = page.getByRole('dialog', { name: '是否立即清理旧备份？', exact: true })
  await expect(confirmation).toContainText('现有备份尚未删除')
  expect(await catalog()).toEqual(ids.toReversed())
  await confirmation.getByRole('button', { name: '下次备份时处理', exact: true }).click()
  await expect(confirmation).toHaveCount(0)
  await instance.stop()
  ;({ page } = await instance.launch())
  confirmation = page.getByRole('dialog', { name: '是否立即清理旧备份？', exact: true })
  expect(await catalog()).toEqual(ids.toReversed())
  const next = await page.evaluate(() => window.lexoraDesktop.storage.snapshot({ scopes: ['tasks'], credentials: false }))
  await expect.poll(catalog).toEqual([next.id])
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('link', { name: '数据存储', exact: true }).click()
  control = page.getByRole('spinbutton', { name: '本地备份保留数量', exact: true })
  await expect(control).toHaveValue('1')
  await control.fill('10')
  await control.press('Tab')
  await expect.poll(() => page.evaluate(async () => (await window.lexoraDesktop.settings.get()).desktop.localBackupLimit)).toBe(10)
  await page.getByRole('button', { name: '创建备份', exact: true }).click()
  await page.locator('.n-modal').getByRole('button', { name: '创建备份', exact: true }).click()
  await expect.poll(catalog).toHaveLength(2)
  await expect(page.locator('.n-modal')).toHaveCount(0)
  await control.fill('1')
  await control.press('Tab')
  await expect(confirmation).toBeVisible()
  expect(await catalog()).toHaveLength(2)
  await confirmation.getByRole('button', { name: '立即清理', exact: true }).click()
  await expect(confirmation).toHaveCount(0)
  await expect.poll(catalog).toHaveLength(1)
  await expect(page.getByRole('button', { name: '查看备份 (1)', exact: true })).toBeVisible()
})

test('preboot migration is visible, keeps runtime stopped, and a second launch uses the verified root', async ({ buddy }) => {
  const { access, readFile, rename, writeFile } = await import('node:fs/promises')
  const { createHash } = await import('node:crypto')
  const { dirname, join } = await import('node:path')
  const instance = await buddy.createInstance('migration')
  const first = await instance.launch()
  const target = `${instance.home}-moved`
  await first.page.evaluate(target => window.lexoraDesktop.storage.relocate(target), target)
  await instance.stop()
  const locator = join(dirname(instance.home), '.lexora-locations', createHash('sha256').update(instance.home).digest('hex').slice(0, 24), 'location.json')
  const pending = JSON.parse(await readFile(locator, 'utf8'))
  pending.pending.phase = 'failed'
  pending.pending.error = 'STORAGE_WORKER_INTERRUPTED'
  await writeFile(locator, JSON.stringify(pending))
  const migration = await instance.launch({ maintenance: true })
  await expect(migration.page.getByRole('heading', { name: '正在搬迁数据' })).toBeVisible()
  expect(await migration.app.evaluate(({ app }) => app.getAppMetrics().some(metric => metric.name === 'Buddy Service'))).toBe(false)
  await migration.app.evaluate(({ app }) => {
    app.relaunch = () => {}
  })
  await migration.page.getByRole('link', { name: '重试', exact: true }).click()
  await expect.poll(async () => JSON.parse(await readFile(locator, 'utf8')).activeRoot).toBe(target)
  await instance.stop()
  const restarted = await instance.launch({ expectedRoot: target })
  await restarted.page.evaluate(() => {
    location.hash = '#/settings/storage'
  })
  await expect(restarted.page.getByTestId('storage-current-root')).toHaveText(target)
  expect(JSON.parse(await readFile(locator, 'utf8')).pending).toBeNull()
  await instance.stop()
  await instance.launch({ expectedRoot: target })
  expect(JSON.parse(await readFile(locator, 'utf8')).history).toHaveLength(1)
  await instance.stop()
  await rename(target, `${target}-offline`)
  const unavailable = await instance.launch({ maintenance: true })
  await expect(unavailable.page.getByRole('heading', { name: '暂时无法打开原有数据' })).toBeVisible()
  expect(await unavailable.app.evaluate(({ app }) => app.getAppMetrics().some(metric => metric.name === 'Buddy Service'))).toBe(false)
  await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' })
  await instance.stop()
  await rename(`${target}-offline`, target)
  await instance.launch({ expectedRoot: target })
})

test('a failed move can return to the original data without retrying', async ({ buddy }) => {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const instance = await buddy.createInstance('migration-cancel')
  const desktop = await instance.launch()
  const target = `${instance.home}-occupied`
  await desktop.page.evaluate(target => window.lexoraDesktop.storage.relocate(target), target)
  await instance.stop()
  await mkdir(target)
  await writeFile(`${target}/keep.txt`, 'unrelated data')
  const migration = await instance.launch({ maintenance: true })
  await migration.app.evaluate(({ app }) => {
    app.relaunch = () => {}
  })
  await expect(migration.page.getByRole('link', { name: '使用原目录', exact: true })).toBeVisible()
  const child = migration.app.process()
  await migration.page.getByRole('link', { name: '使用原目录', exact: true }).click()
  await expect.poll(() => child.exitCode).toBe(0)
  await instance.stop()
  const original = await instance.launch()
  const summary = await original.page.evaluate(() => window.lexoraDesktop.storage.summary())
  expect(summary.root).toBe(instance.home)
  expect(summary.pending).toBeNull()
  const { readFile } = await import('node:fs/promises')
  expect(await readFile(`${target}/keep.txt`, 'utf8')).toBe('unrelated data')
})

test('cloud backup uses one selected target, persists frequency and credentials, and deletes only selected local copies', async ({ buddy }) => {
  test.setTimeout(180000)
  const { createServer } = await import('node:http')
  const { once } = await import('node:events')
  const { readFile, writeFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { useSyntheticCredentialStorage } = await import('../fixtures/electron.mjs')
  const objects = new Map()
  let holdNextRequest = false
  let heldResponse
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname
    if (request.headers.authorization !== `Basic ${Buffer.from('fixture:fixture-only').toString('base64')}`) {
      response.writeHead(401).end()
      return
    }
    if (holdNextRequest) {
      holdNextRequest = false
      heldResponse = response
      return
    }
    if (request.method === 'MKCOL') {
      response.writeHead(201).end()
    }
    else if (request.method === 'PROPFIND') {
      response.writeHead(207, { 'content-type': 'application/xml' }).end(`<d:multistatus xmlns:d="DAV:">${[...objects.keys()].filter(key => key.startsWith(path) && key.endsWith('.json')).map(key => `<d:response><d:href>${key}</d:href></d:response>`).join('')}</d:multistatus>`)
    }
    else if (request.method === 'PUT') {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      if (objects.has(path)) {
        response.writeHead(412).end()
      }
      else {
        objects.set(path, Buffer.concat(chunks))
        response.writeHead(201).end()
      }
    }
    else if (request.method === 'DELETE') {
      objects.delete(path)
      response.writeHead(204).end()
    }
    else if (request.method === 'GET') {
      if (objects.has(path))
        response.writeHead(200).end(objects.get(path))
      else response.writeHead(404).end()
    }
    else {
      response.writeHead(405).end()
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const instance = await buddy.createInstance('single-cloud-backup')
    const desktop = await instance.launch()
    await useSyntheticCredentialStorage(desktop)
    const page = desktop.page
    const endpoint = `http://127.0.0.1:${server.address().port}/dav/`
    await page.evaluate(() => {
      location.hash = '#/settings/storage'
    })
    await page.getByRole('switch', { name: '启用云备份', exact: true }).click()
    await page.getByRole('textbox', { name: '地址', exact: true }).fill(endpoint)
    await page.getByRole('textbox', { name: '账号', exact: true }).fill('fixture')
    await page.getByRole('textbox', { name: '密码', exact: true }).fill('fixture-only')
    await page.getByLabel('备份频率', { exact: true }).click()
    await page.getByText('每周', { exact: true }).click()
    await page.getByRole('button', { name: '保存并备份', exact: true }).click()
    await page.locator('.n-modal').getByRole('button', { name: '取消', exact: true }).click()
    expect((await page.evaluate(() => window.lexoraDesktop.sync.state())).connections).toHaveLength(0)
    expect((await page.evaluate(() => window.lexoraDesktop.storage.snapshots())).snapshots).toHaveLength(0)
    await page.getByRole('button', { name: '保存并备份', exact: true }).click()
    await page.locator('.n-modal').getByRole('button', { name: '保存并备份', exact: true }).click()
    await expect(page.locator('.n-modal')).toHaveCount(0)
    await expect.poll(async () => (await page.evaluate(() => window.lexoraDesktop.sync.state())).schedules[0]?.lastSuccessAt ?? null).not.toBeNull()
    await expect(page.locator('.n-message').filter({ hasText: '云备份已完成' })).toBeVisible()
    const state = await page.evaluate(() => window.lexoraDesktop.sync.state())
    const connectionId = state.activeConnectionId
    expect(state.selectedAdapter).toBe('webdav')
    expect(state.schedules[0].policy.frequency).toBe('weekly')
    const firstBackup = (await page.evaluate(() => window.lexoraDesktop.storage.snapshots())).snapshots
    expect(firstBackup).toHaveLength(1)
    const manual = firstBackup[0]
    expect([...objects.keys()].every(key => key.startsWith('/dav/lexora/'))).toBe(true)
    const password = page.getByRole('textbox', { name: '密码', exact: true })
    await expect(password).toHaveValue('fixture-only')
    await password.fill('wrong-fixture-password')
    await page.getByRole('button', { name: '测试连接', exact: true }).click()
    await expect(page.getByRole('alert').filter({ hasText: '认证失败' })).toBeVisible()
    expect(await page.evaluate(id => window.lexoraDesktop.sync.credential(id), connectionId)).toBe('fixture-only')
    await password.fill('fixture-only')
    await page.getByLabel('备份频率', { exact: true }).click()
    await page.getByText('每小时', { exact: true }).click()
    await expect.poll(async () => (await page.evaluate(() => window.lexoraDesktop.sync.state())).schedules[0].policy.frequency).toBe('hourly')
    expect((await page.evaluate(() => window.lexoraDesktop.storage.snapshots())).snapshots).toHaveLength(1)
    const scheduled = (await page.evaluate(() => window.lexoraDesktop.sync.state())).schedules[0]
    await page.getByRole('button', { name: 'S3 兼容', exact: true }).click()
    await expect.poll(async () => (await page.evaluate(() => window.lexoraDesktop.sync.state())).selectedAdapter).toBe('s3')
    expect((await page.evaluate(() => window.lexoraDesktop.sync.state())).activeConnectionId).toBeNull()
    await page.getByRole('button', { name: 'WebDAV', exact: true }).click()
    await expect.poll(async () => (await page.evaluate(() => window.lexoraDesktop.sync.state())).activeConnectionId).toBe(connectionId)
    expect((await page.evaluate(() => window.lexoraDesktop.sync.state())).schedules[0]).toMatchObject({ nextRunAt: scheduled.nextRunAt, lastSuccessAt: scheduled.lastSuccessAt, status: 'idle' })
    expect((await page.evaluate(() => window.lexoraDesktop.storage.snapshots())).snapshots).toHaveLength(1)
    await expect(page.getByRole('textbox', { name: '密码', exact: true })).toHaveValue('fixture-only')
    const disposable = await page.evaluate(() => window.lexoraDesktop.storage.snapshot({ scopes: ['tasks'], credentials: false }))
    await page.reload()
    await page.waitForFunction(async () => (await window.lexoraDesktop.app.startup.getState()).status === 'ready')
    await page.evaluate(() => {
      location.hash = '#/settings/storage'
    })
    await page.getByRole('button', { name: /^查看备份/ }).click()
    const rows = page.locator('.n-modal li')
    await expect(rows).toHaveCount(2)
    await rows.last().getByRole('button', { name: '删除', exact: true }).click()
    await page.getByRole('button', { name: '删除备份', exact: true }).click()
    await expect(rows).toHaveCount(1)
    expect((await page.evaluate(() => window.lexoraDesktop.storage.snapshots())).snapshots.map(item => item.id)).toEqual([disposable.id])
    const remoteRoot = '/dav/lexora/lexora-backups-v1'
    expect(objects.has(`${remoteRoot}/snapshots/${manual.id}.json`)).toBe(true)
    await page.keyboard.press('Escape')
    await page.evaluate(() => window.lexoraDesktop.settings.update({ desktop: { localBackupLimit: 1 } }))
    const schedulePath = join(instance.home, 'device/backup-schedules.json')
    const saved = JSON.parse(await readFile(schedulePath, 'utf8'))
    await instance.stop()
    saved.records[0].nextRunAt = '2026-01-01T00:00:00Z'
    await writeFile(schedulePath, JSON.stringify(saved))
    const restarted = await instance.launch()
    await useSyntheticCredentialStorage(restarted)
    const previousSuccess = saved.records[0].lastSuccessAt
    await expect.poll(async () => (await restarted.page.evaluate(() => window.lexoraDesktop.sync.state())).schedules[0]?.lastSuccessAt, { timeout: 80000 }).not.toBe(previousSuccess)
    await expect.poll(async () => (await restarted.page.evaluate(() => window.lexoraDesktop.sync.state())).schedules[0]?.status).toBe('idle')
    const local = await restarted.page.evaluate(() => window.lexoraDesktop.storage.snapshots())
    expect(local.snapshots).toHaveLength(1)
    expect(local.snapshots.some(item => item.id === disposable.id)).toBe(false)
    expect(local.snapshots.filter(item => item.automatic)).toHaveLength(1)
    const remoteIds = [...objects.entries()].filter(([key]) => key.startsWith(`${remoteRoot}/snapshots/`)).map(([, value]) => JSON.parse(value.toString()).id)
    expect(remoteIds.sort()).toEqual([...local.snapshots.map(item => item.id), manual.id].sort())
    expect(JSON.stringify(await restarted.page.evaluate(() => window.lexoraDesktop.sync.state()))).not.toContain('fixture-only')
    await restarted.page.evaluate(() => {
      location.hash = '#/settings/storage'
    })
    holdNextRequest = true
    await restarted.page.getByRole('button', { name: '立即备份', exact: true }).click()
    await restarted.page.locator('.n-modal').getByRole('button', { name: '立即备份', exact: true }).click()
    await expect.poll(() => !!heldResponse).toBe(true)
    const readable = await restarted.page.evaluate(async () => ({ summary: await window.lexoraDesktop.storage.summary(), catalog: await window.lexoraDesktop.storage.snapshots() }))
    expect(readable.summary.root).toBe(instance.home)
    expect(readable.catalog.snapshots).toHaveLength(local.snapshots.length)
    await restarted.page.evaluate(() => {
      location.hash = '#/settings/about'
    })
    await expect(restarted.page.getByTestId('storage-current-root')).toHaveCount(0)
    await restarted.page.evaluate(() => {
      location.hash = '#/settings/storage'
    })
    await expect(restarted.page.getByTestId('storage-current-root')).toHaveText(instance.home)
    await restarted.page.getByRole('button', { name: /^查看备份/ }).click()
    await expect(restarted.page.locator('.n-modal li')).toHaveCount(local.snapshots.length)
    await restarted.page.keyboard.press('Escape')
    await restarted.page.evaluate(() => {
      location.hash = '#/settings/about'
    })
    await expect(restarted.page.getByRole('switch', { name: '启用云备份', exact: true })).toHaveCount(0)
    heldResponse.writeHead(401).end()
    await expect(restarted.page.locator('.n-message').filter({ hasText: '云备份未完成：认证失败' })).toBeVisible()
    await restarted.page.evaluate(() => {
      location.hash = '#/settings/storage'
    })
    await restarted.page.getByRole('button', { name: /^查看备份/ }).click()
    await expect(restarted.page.locator('.n-modal li')).toHaveCount(local.snapshots.length)
  }
  finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})

test('a missing initial data root stays absent while recovery is shown', async ({ buddy }) => {
  const { access, rename } = await import('node:fs/promises')
  const instance = await buddy.createInstance('missing-initial-root')
  await instance.launch()
  await instance.stop()
  await rename(instance.home, `${instance.home}-offline`)
  const recovery = await instance.launch({ maintenance: true })
  await expect(recovery.page.getByRole('heading', { name: '暂时无法打开原有数据' })).toBeVisible()
  await expect(access(instance.home)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await recovery.app.evaluate(({ app }) => app.getAppMetrics().some(metric => metric.name === 'Buddy Service'))).toBe(false)
  await instance.stop()
  await rename(`${instance.home}-offline`, instance.home)
  await instance.launch()
})

test('exports an encrypted selective backup and imports it into the configured root with unselected data preserved', async ({ buddy }) => {
  const { createHash, randomUUID } = await import('node:crypto')
  const { mkdir, readFile, writeFile } = await import('node:fs/promises')
  const { dirname, join } = await import('node:path')
  const { useSyntheticCredentialStorage } = await import('../fixtures/electron.mjs')
  const source = await buddy.createInstance('backup-export')
  const desktop = await source.launch()
  await useSyntheticCredentialStorage(desktop)
  const connection = { id: randomUUID(), credentialId: randomUUID(), adapter: 'webdav', name: 'Portable connection', endpoint: 'https://example.invalid/backup/', username: 'fixture' }
  await mkdir(join(source.home, 'buddy/secrets/sync'), { recursive: true })
  await writeFile(join(source.home, 'device/sync.json'), JSON.stringify({ version: 1, enabled: false, selectedAdapter: 'webdav', activeConnectionId: connection.id, connections: [connection] }))
  await writeFile(join(source.home, 'buddy/secrets/sync', `${createHash('sha256').update(connection.credentialId).digest('hex')}.credential`), `offline-fixture:${JSON.stringify({ id: connection.credentialId, value: 'synthetic-key-only', version: 1 })}`)
  const snapshot = await desktop.page.evaluate(() => window.lexoraDesktop.storage.snapshot({ scopes: ['connections'], credentials: true, password: 'fixture-password' }))
  expect(snapshot).toMatchObject({ scopes: ['connections'], credentials: true })
  const exportParent = join(source.home, 'exported')
  await mkdir(exportParent, { recursive: true })
  await desktop.app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
  }, exportParent)
  const exported = await desktop.page.evaluate(id => window.lexoraDesktop.storage.export(id), snapshot.id)
  expect(await readFile(join(exported, 'files/credentials.enc'), 'utf8')).not.toContain('synthetic-key-only')
  const destination = await buddy.createInstance('backup-import')
  const receiving = await destination.launch()
  await useSyntheticCredentialStorage(receiving)
  const space = await receiving.page.evaluate(() => window.lexoraDesktop.localChat.spaces.create({ name: 'Keep my current space', memoryScope: 'space_only', primaryDirectory: null }))
  await receiving.app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
  }, exported)
  expect(await receiving.page.evaluate(() => window.lexoraDesktop.storage.import())).toEqual(snapshot)
  const wrong = await receiving.page.evaluate(async (id) => {
    try {
      await window.lexoraDesktop.storage.restore(id, { scopes: ['connections'], credentials: true, password: 'incorrect-password' })
    }
    catch (error) { return String(error) }
  }, snapshot.id)
  expect(wrong).toContain('SNAPSHOT_PASSWORD_INVALID')
  expect((await receiving.page.evaluate(() => window.lexoraDesktop.storage.summary())).pending).toBeNull()
  await receiving.page.getByRole('button', { name: '设置', exact: true }).click()
  await receiving.page.getByRole('link', { name: '数据存储', exact: true }).click()
  await receiving.page.getByRole('button', { name: /^查看备份/ }).click()
  await receiving.page.getByRole('button', { name: '恢复备份', exact: true }).click()
  await expect(receiving.page.getByRole('checkbox', { name: /^工具与连接配置/ })).toBeChecked()
  await expect(receiving.page.getByRole('checkbox', { name: /^任务与空间/ })).toBeDisabled()
  await expect(receiving.page.locator('.n-modal')).toHaveCount(1)
  await receiving.page.keyboard.press('Escape')
  await receiving.page.evaluate(id => window.lexoraDesktop.storage.restore(id, { scopes: ['connections'], credentials: true, password: 'fixture-password' }), snapshot.id)
  await destination.stop()
  const locator = join(dirname(destination.home), '.lexora-locations', createHash('sha256').update(destination.home).digest('hex').slice(0, 24), 'location.json')
  const state = JSON.parse(await readFile(locator, 'utf8'))
  state.pending.phase = 'failed'
  state.pending.error = 'STORAGE_WORKER_INTERRUPTED'
  await writeFile(locator, JSON.stringify(state))
  const migration = await destination.launch({ maintenance: true })
  await migration.app.evaluate(({ app }) => {
    app.relaunch = () => {}
  })
  await migration.page.getByRole('link', { name: '重试', exact: true }).click()
  await expect.poll(async () => JSON.parse(await readFile(locator, 'utf8')).pending).toBeNull()
  await destination.stop()
  const restored = await destination.launch()
  await useSyntheticCredentialStorage(restored)
  const connections = (await restored.page.evaluate(() => window.lexoraDesktop.sync.state())).connections
  expect(connections).toHaveLength(1)
  expect(connections[0]).toMatchObject({ name: 'Portable connection' })
  const credentialRestored = await restored.app.evaluate(({ safeStorage }, root) => {
    const fs = process.getBuiltinModule('node:fs')
    const path = process.getBuiltinModule('node:path')
    const crypto = process.getBuiltinModule('node:crypto')
    const connection = JSON.parse(fs.readFileSync(path.join(root, 'device/sync.json'), 'utf8')).connections[0]
    const file = path.join(root, 'buddy/secrets/sync', `${crypto.createHash('sha256').update(connection.credentialId).digest('hex')}.credential`)
    return JSON.parse(safeStorage.decryptString(fs.readFileSync(file))).value === 'synthetic-key-only'
  }, destination.home)
  expect(credentialRestored).toBe(true)
  expect(await restored.page.evaluate(() => window.lexoraDesktop.localChat.spaces.list())).toEqual(expect.arrayContaining([expect.objectContaining({ id: space.id })]))
  expect((await restored.page.evaluate(() => window.lexoraDesktop.storage.summary())).root).toBe(destination.home)
})
