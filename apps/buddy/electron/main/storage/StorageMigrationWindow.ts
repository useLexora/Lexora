import type { StorageProgress } from '../../../shared/storage/storageApi'
import type { DesktopStorage } from './storageBootstrap'
import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { app, BrowserWindow, session } from 'electron'
import { storageMigrationPage, storageMigrationProgressScript } from './storageMigrationPage'

export async function showStorageMigration(storage: DesktopStorage): Promise<void> {
  await app.whenReady()
  const isolated = session.fromPartition(`storage-${randomUUID()}`, { cache: false })
  isolated.setPermissionRequestHandler((_contents, _permission, respond) => respond(false))
  isolated.setPermissionCheckHandler(() => false)
  isolated.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'file://*/*'] }, (_details, respond) => respond({ cancel: true }))
  const window = new BrowserWindow({ title: 'Lexora · 数据整理', width: 640, height: 600, minWidth: 400, minHeight: 560, show: false, autoHideMenuBar: true, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false } })
  let worker: Worker | null = null
  let starting = false
  let committing = false
  let finished = false
  let cancelled = false
  let exiting = false
  const focus = () => {
    if (!window.isDestroyed()) {
      window.show()
      window.focus()
    }
  }
  app.on('second-instance', focus)
  const render = async (progress: StorageProgress) => {
    if (window.isDestroyed())
      return
    const state = await storage.store.read()
    committing = state.pending?.phase === 'ready' || progress.phase === 'activating' || progress.phase === 'completed'
    await window.webContents.executeJavaScript(storageMigrationProgressScript(storage.state.pending!.kind, progress, committing))
  }
  const run = async () => {
    if (worker || starting || window.isDestroyed())
      return
    starting = true
    cancelled = false
    exiting = false
    const current = await storage.store.read()
    if (!current.pending) {
      starting = false
      return
    }
    await render({ phase: 'preparing', completedBytes: 0, totalBytes: null, files: 0, error: null })
    worker = new Worker(new URL('./storage-worker.js', import.meta.url), { workerData: { locationPath: storage.store.path, defaultRoot: storage.store.defaultRoot, legacySources: storage.legacySources, leaseDirectory: storage.leaseDirectory, privateDirectoriesExecutable: storage.privateDirectoriesExecutable } })
    starting = false
    worker.on('message', (message: {
      progress?: StorageProgress
      done?: boolean
    }) => {
      if (message.progress)
        void render(message.progress).catch(() => { })
      if (message.done !== undefined) {
        finished = true
        void (async () => {
          if (message.done) {
            app.relaunch()
            app.exit(0)
          }
          else if (cancelled && storage.state.pending?.kind !== 'consolidate') {
            await storage.store.cancel()
            app.relaunch()
            app.exit(0)
          }
          else if (exiting) {
            app.exit(0)
          }
        })().catch(() => render({ phase: 'failed', completedBytes: 0, totalBytes: null, files: 0, error: 'STORAGE_WORKER_FAILED' }))
      }
    })
    worker.on('error', () => {
      void render({ phase: 'failed', completedBytes: 0, totalBytes: null, files: 0, error: 'STORAGE_WORKER_FAILED' })
    })
    worker.on('exit', () => {
      worker = null
      if (!finished)
        void render({ phase: 'failed', completedBytes: 0, totalBytes: null, files: 0, error: 'STORAGE_WORKER_INTERRUPTED' })
      finished = false
    })
  }
  const attempt = () => run().catch(async () => {
    starting = false
    await render({ phase: 'failed', completedBytes: 0, totalBytes: null, files: 0, error: 'STORAGE_WORKER_FAILED' })
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    if (url === 'https://storage.lexora.invalid/retry') {
      void attempt()
    }
    else if (url === 'https://storage.lexora.invalid/cancel' && !committing) {
      if (starting)
        return
      cancelled = true
      exiting = storage.state.pending?.kind === 'consolidate'
      if (worker) {
        void window.webContents.executeJavaScript('document.getElementById(\'cancel\').hidden=true;document.getElementById(\'phase\').textContent=\'正在停止，原数据会保留\'').catch(() => {})
        worker.postMessage('cancel')
      }
      else if (storage.state.pending?.kind !== 'consolidate') {
        void (async () => {
          await storage.store.cancel()
          app.relaunch()
          app.exit(0)
        })().catch(() => render({ phase: 'failed', completedBytes: 0, totalBytes: null, files: 0, error: 'STORAGE_WORKER_FAILED' }))
      }
    }
    else if (url === 'https://storage.lexora.invalid/exit' && !worker) {
      app.exit(0)
    }
  })
  window.webContents.on('will-redirect', event => event.preventDefault())
  window.on('close', (event) => {
    if (worker) {
      event.preventDefault()
      if (!committing) {
        exiting = true
        worker.postMessage('cancel')
      }
    }
    else {
      app.exit(0)
    }
  })
  window.once('closed', () => app.off('second-instance', focus))
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(storageMigrationPage(storage.state.pending!))}`)
  focus()
  if (storage.state.pending?.phase !== 'pending')
    await render({ phase: 'failed', completedBytes: 0, totalBytes: null, files: 0, error: storage.state.pending?.error ?? 'STORAGE_WORKER_INTERRUPTED' })
  else
    await attempt()
}
