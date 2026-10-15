import type { DiagnosticError } from '../../../shared/diagnostics/applicationDiagnostic'
import type { StorageProgress } from '../../../shared/storage/storageApi'
import type { DesktopDiagnosticEvent, DesktopDiagnosticLogger } from '../desktopDiagnostics'
import type { DesktopStorage } from './storageBootstrap'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { Worker } from 'node:worker_threads'
import { app, BrowserWindow, session, shell } from 'electron'
import { ApplicationLogReader } from '../diagnostics/ApplicationLogReader'
import { saveApplicationDiagnosticBundle } from '../diagnostics/saveApplicationDiagnosticBundle'
import { createFeedbackIssueUrl } from '../feedbackIssue'
import { storageMigrationErrorCode, storageMigrationIssueBody } from './storageMigrationDiagnostics'
import { storageMigrationPage, storageMigrationProgressScript } from './storageMigrationPage'

export async function showStorageMigration(storage: DesktopStorage, diagnostics: DesktopDiagnosticLogger): Promise<void> {
  await app.whenReady()
  const operation = storage.state.pending!
  const isolated = session.fromPartition(`storage-${randomUUID()}`, { cache: false })
  isolated.setPermissionRequestHandler((_contents, _permission, respond) => respond(false))
  isolated.setPermissionCheckHandler(() => false)
  isolated.on('will-download', event => event.preventDefault())
  isolated.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'file://*/*'] }, (_details, respond) => respond({ cancel: true }))
  const window = new BrowserWindow({ title: 'Lexora · 数据整理', width: 640, height: 640, minWidth: 400, minHeight: 560, show: false, autoHideMenuBar: true, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false } })
  let worker: Worker | null = null
  let starting = false
  let committing = operation.phase === 'ready'
  let cancelled = false
  let exiting = false
  let finalizing = false
  let supportBusy = false
  let attemptNumber = 0
  let lastProgress: StorageProgress | undefined
  let rendering = Promise.resolve()
  const record = (event: string, details: Partial<DesktopDiagnosticEvent> = {}) => diagnostics.record({ scope: 'desktop', component: 'storage.migration', level: 'info', event, operationId: operation.id, attempt: attemptNumber, ...details })
  const focus = () => {
    if (!window.isDestroyed()) {
      window.show()
      window.focus()
    }
  }
  app.on('second-instance', focus)
  const quit = async (relaunch = false) => {
    if (finalizing)
      return
    finalizing = true
    try {
      if (relaunch)
        app.relaunch()
    }
    catch (error) {
      finalizing = false
      throw error
    }
    await diagnostics.close()
    app.exit(0)
  }
  const render = (progress: StorageProgress) => {
    const failure = progress.phase === 'failed' || progress.phase === 'cancelled'
    if (progress.phase !== lastProgress?.phase || progress.error !== lastProgress.error) {
      record(`storage.${operation.kind}.${progress.phase}`, { level: progress.phase === 'failed' ? 'error' : 'info', count: progress.files, ...(failure ? { errorCode: storageMigrationErrorCode(progress.error) } : {}) })
    }
    lastProgress = progress
    rendering = rendering.then(async () => {
      if (window.isDestroyed())
        return
      const state = await storage.store.read().catch((error: unknown) => {
        record('storage.migration.state_failed', { level: 'error', error })
        committing = true
        return null
      })
      committing = committing || state?.pending?.phase === 'ready' || progress.phase === 'activating' || progress.phase === 'completed'
      await window.webContents.executeJavaScript(storageMigrationProgressScript(operation.kind, progress, committing))
    }).catch((error: unknown) => { record('storage.migration.render_failed', { level: 'error', error }) })
    return rendering
  }
  const failed = async (error: unknown, code = 'STORAGE_WORKER_FAILED') => {
    record('storage.migration.worker_failed', { level: 'error', error })
    await render({ phase: 'failed', completedBytes: 0, totalBytes: null, files: 0, error: code })
  }
  const run = async () => {
    if (worker || starting || supportBusy || finalizing || window.isDestroyed())
      return
    starting = true
    cancelled = false
    exiting = false
    const current = await storage.store.read()
    if (!current.pending) {
      starting = false
      await quit(true)
      return
    }
    attemptNumber += 1
    record('storage.migration.started')
    await render({ phase: 'preparing', completedBytes: 0, totalBytes: null, files: 0, error: null })
    worker = new Worker(new URL('./storage-worker.js', import.meta.url), { workerData: { locationPath: storage.store.path, defaultRoot: storage.store.defaultRoot, legacySources: storage.legacySources, leaseDirectory: storage.leaseDirectory, privateDirectoriesExecutable: storage.privateDirectoriesExecutable } })
    starting = false
    let settled = false
    worker.on('message', (message: { progress?: StorageProgress, done?: boolean, failure?: DiagnosticError }) => {
      if (message.progress)
        void render(message.progress)
      if (message.done === undefined)
        return
      settled = true
      void (async () => {
        if (message.failure)
          record('storage.migration.worker_failed', { level: 'error', ...message.failure })
        if (message.done) {
          await rendering
          await quit(true)
        }
        else if (cancelled && operation.kind !== 'consolidate') {
          await storage.store.cancel()
          await quit(true)
        }
        else if (exiting) {
          await rendering
          await quit()
        }
        else if (lastProgress?.phase !== 'failed' && lastProgress?.phase !== 'cancelled') {
          await render({ phase: 'failed', completedBytes: 0, totalBytes: null, files: 0, error: 'STORAGE_MIGRATION_FAILED' })
        }
      })().catch(error => failed(error))
    })
    worker.on('error', (error) => {
      settled = true
      void failed(error)
    })
    worker.on('exit', (code) => {
      worker = null
      if (!settled) {
        record('storage.migration.worker_exited', { level: 'error', processExit: { type: 'other', reason: code === 0 ? 'clean-exit' : 'abnormal-exit', code, expected: false } })
        void failed(undefined, 'STORAGE_WORKER_INTERRUPTED')
      }
    })
  }
  const attempt = () => run().catch(async (error: unknown) => {
    starting = false
    await failed(error)
  })
  const support = async (action: 'export' | 'issue') => {
    if (supportBusy || worker || starting || finalizing || (lastProgress?.phase !== 'failed' && lastProgress?.phase !== 'cancelled'))
      return
    supportBusy = true
    const status = async (message: string) => {
      if (!window.isDestroyed())
        await window.webContents.executeJavaScript(`document.body.dataset.supportBusy = ${JSON.stringify(String(supportBusy))}; document.querySelectorAll('a').forEach(link => link.setAttribute('aria-disabled', ${JSON.stringify(String(supportBusy))})); document.getElementById('support-status').textContent = ${JSON.stringify(message)}`)
    }
    try {
      await status(action === 'export' ? '正在准备诊断日志…' : '正在打开 Issue 页面…')
      record(`storage.migration.${action}.started`)
      let message: string
      if (action === 'export') {
        const state = await diagnostics.flushWithin()
        const reader = new ApplicationLogReader(join(storage.bootstrapRoot, 'logs'), diagnostics.launchId, homedir())
        const result = await saveApplicationDiagnosticBundle(reader, { launch: 'all' }, window)
        const incomplete = state.failed > 0 || state.dropped > 0 || state.pendingBytes > 0 || state.unconfirmed > 0
        message = result.status === 'saved'
          ? `诊断日志已保存到本机，可检查后附到 Issue。${incomplete ? '部分日志未能保存，请同时保留错误码和诊断编号。' : ''}`
          : result.status === 'empty' ? '暂无可导出的日志，请保留错误码和诊断编号并提交 Issue。' : '已取消导出。'
      }
      else {
        await shell.openExternal(createFeedbackIssueUrl(storageMigrationIssueBody({ kind: operation.kind, error: lastProgress.error, launchId: diagnostics.launchId, operationId: operation.id, appVersion: app.getVersion(), platform: `${process.platform} ${process.arch}` })))
        message = '已打开 Issue 页面。请检查预填信息，并手动附上诊断日志后提交。'
      }
      record(`storage.migration.${action}.completed`)
      supportBusy = false
      await status(message)
    }
    catch (error) {
      record(`storage.migration.${action}.failed`, { level: 'error', error })
      supportBusy = false
      await status(action === 'export' ? '未能导出诊断日志，请保留错误码和诊断编号并提交 Issue。' : '未能打开浏览器，请前往 github.com/useLexora/Lexora/issues 反馈，并附上诊断日志。').catch(() => {})
    }
    finally { supportBusy = false }
  }
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    if (supportBusy || finalizing)
      return
    if (url === 'https://storage.lexora.invalid/export' || url === 'https://storage.lexora.invalid/issue') {
      void support(url.endsWith('/export') ? 'export' : 'issue')
    }
    else if (url === 'https://storage.lexora.invalid/retry' && (lastProgress?.phase === 'failed' || lastProgress?.phase === 'cancelled')) {
      void attempt()
    }
    else if (url === 'https://storage.lexora.invalid/cancel' && !committing) {
      if (starting)
        return
      cancelled = true
      exiting = operation.kind === 'consolidate'
      if (worker) {
        void window.webContents.executeJavaScript('document.getElementById(\'cancel\').hidden=true;document.getElementById(\'phase\').textContent=\'正在停止，原数据会保留\'').catch(() => {})
        worker.postMessage('cancel')
      }
      else if (operation.kind !== 'consolidate') {
        void storage.store.cancel().then(() => quit(true)).catch(error => failed(error))
      }
    }
    else if (url === 'https://storage.lexora.invalid/exit' && !worker && !starting) {
      void quit()
    }
  })
  window.webContents.on('will-redirect', event => event.preventDefault())
  window.on('close', (event) => {
    event.preventDefault()
    if (worker || starting) {
      if (!committing) {
        exiting = true
        worker?.postMessage('cancel')
      }
    }
    else {
      void quit()
    }
  })
  window.once('closed', () => app.off('second-instance', focus))
  record('storage.migration.presented')
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(storageMigrationPage(operation, undefined, committing, diagnostics.launchId))}`)
  focus()
  if (operation.phase !== 'pending')
    await render({ phase: 'failed', completedBytes: 0, totalBytes: null, files: 0, error: operation.error ?? 'STORAGE_WORKER_INTERRUPTED' })
  else
    await attempt()
}
