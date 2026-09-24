import type { MessageBoxOptions } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PrivateDirectoryError } from '../../../../platform/windows/privateDirectories'
import { DesktopDiagnosticLogger } from '../../desktopDiagnostics'
import { ApplicationLogReader } from '../../diagnostics/ApplicationLogReader'
import { resolveBuddyRuntimePaths } from '../../paths'
import { DesktopBootstrapError } from '../desktopBootstrap'
import { showDesktopStartupFailure } from '../desktopDialogs'
import { readPreviousLaunchId } from '../desktopRecovery'
import { resolveStartupFailureDirectory } from '../desktopStartupFailure'

const native = vi.hoisted(() => ({
  responses: [] as number[],
  effects: [] as string[],
  messages: [] as MessageBoxOptions[],
  openError: '',
  ready: true,
  relaunchError: false,
  relaunchArgs: [] as string[],
}))

vi.mock('../DesktopRecoveryWindow', () => ({ showRecoveryWindow: async () => {
  throw new Error('Renderer unavailable fixture')
} }))

vi.mock('electron', () => ({
  app: { isReady: () => native.ready, relaunch: ({ args }: { args: string[] }) => {
    if (native.relaunchError)
      throw new Error('fixture-private-restart-path')
    native.relaunchArgs = args
    native.effects.push('restart')
  } },
  dialog: {
    showErrorBox(message: string, detail: string) { native.messages.push({ message, detail }) },
    async showMessageBox(options: MessageBoxOptions) {
      native.messages.push(options)
      const response = native.responses.shift()
      if (response === undefined)
        throw new Error('Unexpected recovery dialog')
      return { response }
    },
  },
  ipcMain: {},
  Notification: {},
  shell: {
    async openPath(path: string) {
      native.effects.push(`logs:${path}`)
      return native.openError
    },
    showItemInFolder(path: string) { native.effects.push(`location:${path}`) },
  },
}))

const paths = resolveBuddyRuntimePaths({
  desktopName: 'fixture',
  defaultUserData: '/fixture/electron',
  isPackaged: true,
  userHome: '/fixture',
  userId: 1000,
  temporaryDirectory: '/tmp',
  platform: 'linux',
})
let environment: { paths: typeof paths, diagnostics: DesktopDiagnosticLogger }
const failure = new PrivateDirectoryError('PRIVATE_DIRECTORIES_UNSAFE', { kind: 'private_directories', operation: 'validate_acl', directoryRole: 'user_data' })

beforeEach(async () => {
  const directory = await createTemporaryDirectory('buddy-recovery-')
  environment = { paths: { ...paths, logs: directory }, diagnostics: new DesktopDiagnosticLogger({ directory, appVersion: '0.6.0', userHome: '/fixture' }) }
  native.responses = []
  native.effects = []
  native.messages = []
  native.openError = ''
  native.ready = true
  native.relaunchError = false
  native.relaunchArgs = []
})

afterEach(async () => {
  await environment.diagnostics.close()
})

async function recoveryRecords() {
  await environment.diagnostics.flush()
  return (await new ApplicationLogReader(environment.paths.logs, environment.diagnostics.launchId, '/fixture').query({})).records.reverse()
}

describe('startup recovery', () => {
  it('keeps recovery available after viewing logs and the affected location until retry is chosen', async () => {
    native.responses = [1, 2, 0]
    await showDesktopStartupFailure(failure, 'zh-CN', environment)
    expect(native.effects).toEqual([`logs:${environment.paths.logs}`, `location:${paths.userData}`, 'restart'])
    expect(native.messages).toHaveLength(3)
    expect(native.messages[0]).toMatchObject({
      buttons: ['重新检查并启动', '打开日志目录', '定位问题目录', '退出应用', '导出诊断包', '复制诊断信息'],
      cancelId: 3,
    })
    expect(native.messages[0]?.detail).toContain(`问题目录: ${paths.userData}`)
    expect(readPreviousLaunchId(native.relaunchArgs)).toBe(environment.diagnostics.launchId)
    const records = (await recoveryRecords()).filter(record => record.event !== 'startup.recovery.window_failed')
    expect(records.map(record => [record.event, record.recoveryAction])).toEqual([
      ['startup.recovery.presented', undefined],
      ['startup.recovery.action_requested', 'open_logs'],
      ['startup.recovery.action_dispatched', 'open_logs'],
      ['startup.recovery.action_requested', 'show_directory'],
      ['startup.recovery.action_dispatched', 'show_directory'],
      ['startup.recovery.action_requested', 'retry'],
      ['startup.recovery.action_dispatched', 'retry'],
    ])
    expect(records[1]?.operationId).toBe(records[2]?.operationId)
    expect(records[1]?.operationId).not.toBe(records[3]?.operationId)
    expect(environment.diagnostics.status.state).toBe('open')
  })

  it('does not close recovery when opening logs fails and never relaunches on cancel', async () => {
    native.responses = [1, 0, 3]
    native.openError = 'fixture-sensitive-path'
    await showDesktopStartupFailure(failure, 'en-US', environment)
    expect(native.effects).toEqual([`logs:${environment.paths.logs}`])
    expect(native.messages).toHaveLength(3)
    expect(native.messages[1]?.type).toBe('warning')
    expect(JSON.stringify(native.messages)).not.toContain('fixture-sensitive-path')
    const records = await recoveryRecords()
    expect(records).toContainEqual(expect.objectContaining({ event: 'startup.recovery.action_failed', recoveryAction: 'open_logs', errorCode: 'DIRECTORY_OPEN_FAILED' }))
    expect(records.at(-1)).toMatchObject({ event: 'startup.recovery.action_dispatched', recoveryAction: 'quit' })
    expect(JSON.stringify(records)).not.toContain('fixture-sensitive-path')
  })

  it('keeps the dialog available after a relaunch dispatch failure', async () => {
    native.relaunchError = true
    native.responses = [0, 0, 3]
    await showDesktopStartupFailure(failure, 'zh-CN', environment)
    expect(native.messages[1]?.message).toContain('手动启动')
    const records = await recoveryRecords()
    expect(records).toContainEqual(expect.objectContaining({ recoveryAction: 'retry', event: 'startup.recovery.action_failed', errorCode: 'RELAUNCH_FAILED' }))
    expect(JSON.stringify(records)).not.toContain('fixture-private')
  })

  it('shows bounded early failure details when logs cannot be saved', async () => {
    const blocked = join(environment.paths.logs, 'blocked')
    await writeFile(blocked, 'preserved')
    await environment.diagnostics.close()
    environment.diagnostics = new DesktopDiagnosticLogger({ directory: blocked, appVersion: '0.6.0', userHome: '/fixture' })
    native.ready = false
    const error = new DesktopBootstrapError({ kind: 'desktop_bootstrap', operation: 'create_directory', directoryRole: 'user_data' }, Object.assign(new Error('fixture-private-path'), { code: 'EEXIST' }))
    await showDesktopStartupFailure(error, 'zh-CN', environment)
    expect(native.messages[0]?.detail).toContain('启动日志未能完整保存')
    expect(native.messages[0]?.detail).toContain('create_directory / user_data / EEXIST')
    expect(native.messages[0]?.detail).not.toContain('fixture-private')
  })

  it('does not promise a log file before an environment exists', async () => {
    native.ready = false
    await showDesktopStartupFailure(new Error('fixture-private-path'), 'en-US')
    expect(native.messages[0]?.detail).toContain('Startup logs could not be fully saved')
    expect(native.messages[0]?.detail).not.toContain('fixture-private')
  })

  it('does not derive a location from arbitrary error fields or a missing directory role', () => {
    expect(resolveStartupFailureDirectory({ directoryRole: 'user_data', path: '/untrusted' }, paths)).toBeUndefined()
    expect(resolveStartupFailureDirectory(new PrivateDirectoryError('PRIVATE_DIRECTORIES_UNSAFE', { kind: 'private_directories', operation: 'validate_acl' }), paths)).toBeUndefined()
  })

  it('does not restart after a failed recheck and preserves the structured cause until a later check succeeds', async () => {
    native.responses = [0, 0, 0]
    let checks = 0
    const blocked = new DesktopBootstrapError({ kind: 'desktop_bootstrap', operation: 'probe_directory', directoryRole: 'user_data' }, Object.assign(new Error('fixture-private-path'), { code: 'EACCES' }))
    await showDesktopStartupFailure(failure, 'zh-CN', environment, async () => {
      expect(native.effects).toEqual([])
      if (++checks === 1)
        throw blocked
    })
    expect(checks).toBe(2)
    expect(native.effects).toEqual(['restart'])
    expect(native.messages[1]?.message).toContain('没有发起重启')
    expect(native.messages[2]?.detail).toContain('probe_directory / user_data / EACCES')
    const records = await recoveryRecords()
    expect(records.filter(record => record.event.startsWith('startup.recovery.recheck')).map(record => record.event)).toEqual([
      'startup.recovery.recheck_started',
      'startup.recovery.recheck_failed',
      'startup.recovery.recheck_started',
      'startup.recovery.recheck_completed',
    ])
    expect(records.find(record => record.event === 'startup.recovery.recheck_failed')?.failure).toMatchObject(blocked.failure)
    expect(JSON.stringify(records)).not.toContain('fixture-private')
  })
})
