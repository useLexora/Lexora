import type { LexoraConfig } from '../../shared/desktopApi'
import type { BuddyRuntimePaths } from '../paths'
import type { RecoveryPresentation } from './desktopRecoveryPage'
import { dirname } from 'node:path'
import { PowerShellUnavailableError } from '../../../platform/windows/powerShell'
import { PrivateDirectoryError } from '../../../platform/windows/privateDirectories'
import { readDiagnosticError } from '../../../shared/diagnostics/applicationDiagnostic'
import { translateDesktopNative } from '../desktopNativeI18n'
import { DesktopBootstrapError } from './desktopBootstrap'

export function resolveStartupFailureDirectory(error: unknown, paths: BuddyRuntimePaths): string | undefined {
  if (!(error instanceof PrivateDirectoryError) && !(error instanceof DesktopBootstrapError))
    return undefined
  switch (error.failure.directoryRole) {
    case 'lexora_home': return paths.lexoraHome
    case 'user_data': return paths.userData
    case 'session_data': return paths.sessionData
    case 'window_state': return dirname(paths.windowState)
    case 'crash_dumps': return paths.crashDumps
  }
}

export function describeDesktopStartupFailure(error: unknown, language: LexoraConfig['desktop']['language'], launchId?: string, directory?: string, logsAvailable = true, logsPath?: string): RecoveryPresentation {
  const { errorCode: code = 'OPERATION_FAILED', failure } = readDiagnosticError(error)
  const unconfirmedPermissions = error instanceof PrivateDirectoryError && (error.failure.acl?.reason === 'unsupported_ace' || error.failure.acl?.principal === 'other')
  const reason = error instanceof PowerShellUnavailableError
    ? 'powerShellUnavailable'
    : unconfirmedPermissions
      ? 'privateDirectoriesUnconfirmed'
      : code === 'PRIVATE_DIRECTORIES_UNSAFE'
        ? 'privateDirectoriesUnsafe'
        : code.startsWith('PRIVATE_DIRECTORIES_')
          ? 'privateDirectoriesFailed'
          : 'startupFailureHelp'
  const t = (key: Parameters<typeof translateDesktopNative>[1]) => translateDesktopNative(language, key)
  const fields: RecoveryPresentation['recovery']['fields'] = [
    { label: t('startupErrorCode'), value: code },
    ...(launchId ? [{ label: t('diagnosticReference'), value: launchId }] : []),
    ...(failure ? [{ label: t('startupFailureStage'), value: [failure.operation, failure.directoryRole, failure.kind === 'desktop_bootstrap' ? failure.systemCode : undefined].filter(Boolean).join(' / ') }] : []),
    ...(failure?.kind === 'private_directories' && failure.acl ? [{ label: t('startupPermissionCheck'), value: [failure.acl.reason, failure.acl.principal, failure.acl.accessMask === undefined ? undefined : `mask=0x${failure.acl.accessMask.toString(16)}`, failure.acl.aceFlags === undefined ? undefined : `flags=0x${failure.acl.aceFlags.toString(16)}`].filter(Boolean).join(' / ') }] : []),
    ...(directory ? [{ label: t('affectedDirectory'), value: directory, localOnly: true }] : []),
    ...(logsPath ? [{ label: t('startupLogsPath'), value: logsPath, localOnly: true }] : []),
  ]
  const actions: RecoveryPresentation['recovery']['actions'] = [
    { action: 'retry', label: t('retryStartup') },
    { action: 'open_logs', label: t('openLogs') },
    ...(directory ? [{ action: 'show_directory' as const, label: t('openAffectedDirectory') }] : []),
    { action: 'quit', label: t('quitApplication') },
    { action: 'export_diagnostics', label: t('exportDiagnostics') },
    { action: 'copy_details', label: t('copyDiagnosticDetails') },
  ]
  const description = [t(reason), ...(!logsAvailable ? [t('startupLogsUnavailable')] : [])].join('\n')
  return {
    type: 'error',
    title: 'Lexora Buddy',
    message: translateDesktopNative(language, 'startupFailed'),
    detail: [description, t('startupRecoveryIsolation'), ...fields.map(field => `${field.label}: ${field.value}`), t('startupDiagnosticPrivacy')].join('\n\n'),
    recovery: { reason: description, notice: t('startupRecoveryIsolation'), privacy: t('startupDiagnosticPrivacy'), fields, actions, moreActionsLabel: t('moreActions'), copyDetails: ['Lexora Buddy', ...fields.filter(field => !field.localOnly).map(field => `${field.label}: ${field.value}`)].join('\n') },
    buttons: actions.map(item => item.label),
    defaultId: 0,
    cancelId: actions.findIndex(item => item.action === 'quit'),
    noLink: true,
  }
}
