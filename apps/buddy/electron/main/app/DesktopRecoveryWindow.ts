import type { RecoveryAction, RecoveryPresentation } from './desktopRecoveryPage'
import { randomUUID } from 'node:crypto'
import { app, BrowserWindow, session } from 'electron'
import { readRecoveryAction, recoveryPage } from './desktopRecoveryPage'

export interface RecoveryActionResult {
  done: boolean
  message?: string
  options?: RecoveryPresentation
}

export async function showRecoveryWindow(
  options: RecoveryPresentation,
  checkingMessage: string,
  onAction: (action: RecoveryAction, active: () => boolean, window: BrowserWindow) => Promise<RecoveryActionResult>,
): Promise<void> {
  const isolatedSession = session.fromPartition(`lexora-recovery-${randomUUID()}`, { cache: false })
  isolatedSession.setPermissionRequestHandler((_contents, _permission, respond) => respond(false))
  isolatedSession.setPermissionCheckHandler(() => false)
  isolatedSession.on('will-download', event => event.preventDefault())
  isolatedSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'file://*/*'] }, (_details, respond) => respond({ cancel: true }))
  const window = new BrowserWindow({
    title: options.title,
    width: 640,
    height: 760,
    minWidth: 440,
    minHeight: 400,
    show: false,
    autoHideMenuBar: true,
    webPreferences: { session: isolatedSession, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, spellcheck: false, devTools: false },
  })
  const active = () => !window.isDestroyed()
  const focus = () => {
    if (!active())
      return
    if (window.isMinimized())
      window.restore()
    window.show()
    window.focus()
  }
  app.on('activate', focus)
  app.on('second-instance', focus)
  let pending: Promise<void> | undefined
  let currentOptions = options
  const render = (status = '') => window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(recoveryPage(currentOptions, status))}`)
  try {
    await new Promise<void>((resolve, reject) => {
      window.once('closed', () => {
        void Promise.resolve(pending).then(resolve, reject)
      })
      window.webContents.once('render-process-gone', () => reject(new Error('RECOVERY_RENDERER_EXITED')))
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      window.webContents.on('will-navigate', (event, url) => {
        event.preventDefault()
        const action = readRecoveryAction(url)
        if (!action || !currentOptions.recovery.actions.some(item => item.action === action) || pending)
          return
        pending = (async () => {
          await window.webContents.executeJavaScript(`document.body.setAttribute('aria-busy', 'true'); document.getElementById('status').textContent = ${JSON.stringify(action === 'retry' ? checkingMessage : '')}`)
          const result = await onAction(action, active, window)
          if (!active())
            return
          if (result.done) {
            window.destroy()
            return
          }
          currentOptions = result.options ?? currentOptions
          await render(result.message)
        })().catch((error) => {
          if (active())
            reject(error)
        }).finally(() => { pending = undefined })
      })
      window.webContents.on('will-redirect', event => event.preventDefault())
      void render().then(focus, (error) => {
        if (active())
          reject(error)
      })
    })
  }
  finally {
    app.removeListener('activate', focus)
    app.removeListener('second-instance', focus)
    if (active())
      window.destroy()
  }
}
