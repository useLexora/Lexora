import type { BrowserWindow, MessageBoxOptions } from 'electron'
import type { LexoraConfig } from '../../shared/desktopApi'
import type { LexoraConfigStore } from '../config/LexoraConfigStore'
import type { RecoveryAction } from './desktopRecoveryPage'
import type { RecoveryActionResult } from './DesktopRecoveryWindow'
import type { DesktopEnvironment, DesktopQuitHost, DesktopQuitOptions } from './typing'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import process from 'node:process'
import { app, clipboard, dialog, ipcMain, Notification, shell } from 'electron'
import { readDiagnosticError } from '../../../shared/diagnostics/applicationDiagnostic'
import { translateDesktopNative } from '../desktopNativeI18n'
import { ApplicationLogReader } from '../diagnostics/ApplicationLogReader'
import { saveApplicationDiagnosticBundle } from '../diagnostics/saveApplicationDiagnosticBundle'
import { confirmDraftFlushBeforeQuit, requestRendererDraftFlush } from '../rendererDraftLifecycle'
import { recoveryRelaunchArgs } from './desktopRecovery'
import { showRecoveryWindow } from './DesktopRecoveryWindow'
import { describeDesktopStartupFailure, resolveStartupFailureDirectory } from './desktopStartupFailure'

export async function showDesktopStartupFailure(error: unknown, language: LexoraConfig['desktop']['language'], environment?: Pick<DesktopEnvironment, 'paths' | 'diagnostics'>, recheck?: () => Promise<void>): Promise<void> {
  let directory = environment ? resolveStartupFailureDirectory(error, environment.paths) : undefined
  const diagnostics = environment?.diagnostics
  diagnostics?.record({ scope: 'desktop', level: 'info', event: 'startup.recovery.presented' })
  const status = await diagnostics?.flushWithin()
  const logsAvailable = !!status && status.written > 0 && status.failed === 0 && status.dropped === 0 && status.pendingBytes === 0 && status.unconfirmed === 0
  let options = describeDesktopStartupFailure(error, language, diagnostics?.launchId, directory, logsAvailable, environment?.paths.logs)
  if (!app.isReady()) {
    try {
      await app.whenReady()
    }
    catch {}
  }
  if (!app.isReady()) {
    dialog.showErrorBox(options.message, options.detail ?? '')
    return
  }
  if (!environment) {
    await dialog.showMessageBox({ ...options, buttons: [translateDesktopNative(language, 'quit')], cancelId: 0 })
    return
  }
  const recoveryOptions = () => ({ ...options, message: translateDesktopNative(language, 'startupRecoveryTitle') })
  const act = async (recoveryAction: RecoveryAction, active: () => boolean, window?: BrowserWindow): Promise<RecoveryActionResult> => {
    const operationId = randomUUID()
    const context = { scope: 'desktop', recoveryAction, operationId } as const
    environment.diagnostics.record({ ...context, level: 'info', event: 'startup.recovery.action_requested' })
    try {
      let message: string | undefined
      if (recoveryAction === 'retry') {
        if (recheck) {
          environment.diagnostics.record({ ...context, level: 'info', event: 'startup.recovery.recheck_started' })
          try {
            await recheck()
          }
          catch (error) {
            environment.diagnostics.record({ ...context, level: 'warn', event: 'startup.recovery.recheck_failed', ...readDiagnosticError(error) })
            directory = resolveStartupFailureDirectory(error, environment.paths)
            options = describeDesktopStartupFailure(error, language, diagnostics?.launchId, directory, logsAvailable, environment.paths.logs)
            return { done: false, message: translateDesktopNative(language, 'startupRecheckFailed'), options: recoveryOptions() }
          }
          environment.diagnostics.record({ ...context, level: 'info', event: 'startup.recovery.recheck_completed' })
        }
        if (!active())
          return { done: false }
        app.relaunch({ args: recoveryRelaunchArgs(process.argv, environment.diagnostics.launchId) })
      }
      else if (recoveryAction === 'open_logs') {
        if (await shell.openPath(environment.paths.logs))
          throw new Error('DIRECTORY_OPEN_FAILED')
      }
      else if (recoveryAction === 'show_directory' && directory) {
        shell.showItemInFolder(directory)
      }
      else if (recoveryAction === 'copy_details') {
        clipboard.writeText(options.recovery.copyDetails)
        message = translateDesktopNative(language, 'diagnosticDetailsCopied')
      }
      else if (recoveryAction === 'export_diagnostics') {
        await environment.diagnostics.flushWithin()
        const reader = new ApplicationLogReader(environment.paths.logs, environment.diagnostics.launchId, homedir())
        const result = await saveApplicationDiagnosticBundle(reader, { launch: 'current' }, window)
        if (result.status !== 'canceled')
          message = translateDesktopNative(language, result.status === 'saved' ? 'diagnosticExportSaved' : 'diagnosticExportEmpty')
      }
      environment.diagnostics.record({ ...context, level: 'info', event: 'startup.recovery.action_dispatched' })
      return { done: recoveryAction === 'retry' || recoveryAction === 'quit', message }
    }
    catch {
      const diagnosticAction = recoveryAction === 'export_diagnostics' || recoveryAction === 'copy_details'
      environment.diagnostics.record({ ...context, level: 'warn', event: 'startup.recovery.action_failed', errorCode: recoveryAction === 'retry' ? 'RELAUNCH_FAILED' : diagnosticAction ? 'DIAGNOSTIC_ACTION_FAILED' : 'DIRECTORY_OPEN_FAILED' })
      return { done: false, message: translateDesktopNative(language, recoveryAction === 'retry' ? 'restartFailed' : diagnosticAction ? 'diagnosticActionFailed' : 'directoryOpenFailed') }
    }
  }
  try {
    await showRecoveryWindow(recoveryOptions(), translateDesktopNative(language, 'startupRechecking'), act)
    return
  }
  catch {
    environment.diagnostics.record({ scope: 'desktop', level: 'warn', event: 'startup.recovery.window_failed', errorCode: 'RECOVERY_WINDOW_FAILED' })
  }
  while (true) {
    const { response } = await dialog.showMessageBox(options)
    const result = await act(options.recovery.actions[response]?.action ?? 'quit', () => true)
    if (result.done)
      return
    if (result.message)
      await dialog.showMessageBox({ type: 'warning', title: options.title, message: result.message })
  }
}

export function confirmDesktopQuit(host: DesktopQuitHost, options: DesktopQuitOptions): Promise<boolean> {
  return confirmDraftFlushBeforeQuit(
    () => requestRendererDraftFlush(host.getWindow(), ipcMain),
    options.discardDraftsOnFailure
      ? async () => 'discard'
      : async () => {
        const language = host.getLanguage()
        const options: MessageBoxOptions = {
          buttons: [
            translateDesktopNative(language, 'retrySave'),
            translateDesktopNative(language, 'cancel'),
            translateDesktopNative(language, 'quitWithoutSaving'),
          ],
          cancelId: 1,
          defaultId: 0,
          detail: translateDesktopNative(language, 'saveBeforeQuitBody'),
          message: translateDesktopNative(language, 'saveBeforeQuitTitle'),
          noLink: true,
          type: 'warning',
        }
        const window = host.getWindow()
        const result = await (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options))
        return result.response === 0 ? 'retry' : result.response === 1 ? 'cancel' : 'discard'
      },
  )
}

export async function showBackgroundCloseNotice(configStore: LexoraConfigStore): Promise<void> {
  const config = await configStore.read()
  if (config.desktop.backgroundCloseNoticeShown || !config.desktop.notificationsEnabled || !Notification.isSupported())
    return
  new Notification({
    body: translateDesktopNative(config.desktop.language, 'backgroundCloseBody'),
    title: translateDesktopNative(config.desktop.language, 'backgroundCloseTitle'),
  }).show()
  await configStore.update({ desktop: { backgroundCloseNoticeShown: true } })
}

export function showLegacyPowerShellNotice(
  window: BrowserWindow,
  getLanguage: () => LexoraConfig['desktop']['language'],
  environment: DesktopEnvironment,
): void {
  const show = () => {
    const language = getLanguage()
    void dialog.showMessageBox(window, {
      type: 'warning',
      title: 'Lexora Buddy',
      message: translateDesktopNative(language, 'powerShellLegacyNotice'),
      buttons: [
        translateDesktopNative(language, 'continueWithLegacyPowerShell'),
        translateDesktopNative(language, 'viewPowerShellInstallGuide'),
      ],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    }).then(async ({ response }) => {
      if (response === 1)
        await shell.openExternal('https://learn.microsoft.com/powershell/scripting/install/install-powershell-on-windows')
    }).catch((error) => {
      environment.diagnostics.record({ scope: 'desktop', level: 'warn', event: 'powershell.notice_failed', error })
    })
  }
  if (window.isVisible())
    show()
  else
    window.once('show', show)
}
