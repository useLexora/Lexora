import { describe, expect, it } from 'vitest'
import { PowerShellUnavailableError } from '../../../../platform/windows/powerShell'
import { PrivateDirectoryError } from '../../../../platform/windows/privateDirectories'
import { describeDesktopStartupFailure } from '../desktopStartupFailure'

describe('startup failure presentation', () => {
  it('gives a useful private storage explanation and a diagnostic reference', () => {
    const error = new PrivateDirectoryError('PRIVATE_DIRECTORIES_UNSAFE', { kind: 'private_directories', operation: 'inspect_directory' })
    const options = describeDesktopStartupFailure(error, 'zh-CN', 'launch-fixture')
    expect(options.detail).toContain('路径包含符号链接')
    expect(options.detail).toContain('诊断编号: launch-fixture')
    expect(options.buttons).toEqual(['重新检查并启动', '打开日志目录', '退出应用', '导出诊断包', '复制诊断信息'])
    expect(options.cancelId).toBe(2)
    expect(options.detail).toContain('数据没有被重置')
  })

  it('keeps PowerShell recovery guidance and hides arbitrary error text', () => {
    expect(describeDesktopStartupFailure(new PowerShellUnavailableError(), 'en-US').detail).toContain('Install PowerShell 7')
    const options = describeDesktopStartupFailure(new Error('token=fixture-secret C:\\Users\\fixture'), 'en-US')
    expect(options.message).toBe('Lexora Buddy could not start')
    expect(options.detail).toContain('OPERATION_FAILED')
    expect(options.detail).not.toContain('fixture')
  })

  it('shows preparation failures and excludes local paths from copied details', () => {
    const error = new PrivateDirectoryError('PRIVATE_DIRECTORIES_FAILED', { kind: 'private_directories', operation: 'open_directory', directoryRole: 'lexora_home', systemError: { domain: 'ntstatus', code: 0xC0000022 } })
    const options = describeDesktopStartupFailure(error, 'zh-CN', 'launch-fixture', 'C:\\Users\\private-user\\AppData', true, 'C:\\Users\\private-user\\logs')
    expect(options.recovery.reason).toContain('无法准备应用数据目录')
    expect(options.recovery.fields).toContainEqual(expect.objectContaining({ label: '本机日志目录', localOnly: true }))
    expect(options.recovery.copyDetails).toContain('open_directory / lexora_home')
    expect(options.recovery.copyDetails).not.toContain('private-user')
  })
})
