import type { LexoraConfig } from '../../shared/desktopApi'
import type { DesktopEnvironment } from './typing'
import { homedir } from 'node:os'
import { dialog, shell } from 'electron'
import { translateDesktopNative } from '../desktopNativeI18n'
import { ApplicationLogReader } from '../diagnostics/ApplicationLogReader'
import { saveApplicationDiagnosticBundle } from '../diagnostics/saveApplicationDiagnosticBundle'

export async function showDesktopRendererRecovery(
  language: LexoraConfig['desktop']['language'],
  environment: Pick<DesktopEnvironment, 'diagnostics' | 'paths'>,
  restart: () => Promise<boolean>,
  quit: () => Promise<boolean>,
): Promise<void> {
  const t = (key: Parameters<typeof translateDesktopNative>[1]) => translateDesktopNative(language, key)
  const { diagnostics, paths } = environment
  const buttons = [t('rendererRecoveryRestart'), t('exportDiagnostics'), t('openLogs'), t('quitApplication')]
  diagnostics.record({ scope: 'desktop', level: 'error', event: 'renderer.recovery.presented', attempt: 1 })

  while (true) {
    const { response } = await dialog.showMessageBox({
      title: paths.appName,
      type: 'error',
      message: t('rendererRecoveryTitle'),
      detail: `${t('rendererRecoveryReason')}\n\n${t('rendererRecoveryNotice')}\n\n${t('diagnosticReference')}: ${diagnostics.launchId}`,
      buttons,
      defaultId: 0,
      cancelId: 3,
      noLink: true,
    })
    const action = (['retry', 'export_diagnostics', 'open_logs', 'quit'] as const)[response] ?? 'quit'
    diagnostics.record({ scope: 'desktop', level: 'info', event: 'renderer.recovery.action_requested', recoveryAction: action })
    try {
      if (action === 'retry') {
        if (await restart())
          return
        continue
      }
      if (action === 'quit') {
        if (await quit())
          return
        continue
      }
      if (action === 'open_logs') {
        if (await shell.openPath(paths.logs))
          throw new Error('DIRECTORY_OPEN_FAILED')
        continue
      }
      await diagnostics.flushWithin()
      const reader = new ApplicationLogReader(paths.logs, diagnostics.launchId, homedir())
      const result = await saveApplicationDiagnosticBundle(reader, { launch: 'current' })
      if (result.status !== 'canceled')
        await dialog.showMessageBox({ title: paths.appName, message: t(result.status === 'saved' ? 'diagnosticExportSaved' : 'diagnosticExportEmpty') })
    }
    catch {
      diagnostics.record({ scope: 'desktop', level: 'warn', event: 'renderer.recovery.action_failed', recoveryAction: action, errorCode: action === 'retry' ? 'RELAUNCH_FAILED' : action === 'open_logs' ? 'DIRECTORY_OPEN_FAILED' : 'DIAGNOSTIC_ACTION_FAILED' })
      await dialog.showMessageBox({ title: paths.appName, type: 'warning', message: t(action === 'retry' ? 'restartFailed' : action === 'open_logs' ? 'directoryOpenFailed' : 'diagnosticActionFailed') })
    }
  }
}
