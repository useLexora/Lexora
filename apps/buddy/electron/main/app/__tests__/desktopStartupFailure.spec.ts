import { describe, expect, it } from 'vitest'
import { PowerShellUnavailableError } from '../../../../platform/windows/powerShell'
import { PrivateDirectoryError } from '../../../../platform/windows/privateDirectories'
import { describeDesktopStartupFailure } from '../desktopStartupFailure'

describe('startup failure presentation', () => {
  it('gives a useful private storage explanation and a diagnostic reference', () => {
    const error = new PrivateDirectoryError('PRIVATE_DIRECTORIES_UNSAFE', { kind: 'private_directories', operation: 'validate_acl' })
    const options = describeDesktopStartupFailure(error, 'zh-CN', 'launch-fixture')
    expect(options.detail).toContain('访问权限不符合要求')
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

  it('shows only structured ACL facts and excludes local paths from copied details', () => {
    const error = new PrivateDirectoryError('PRIVATE_DIRECTORIES_UNSAFE', { kind: 'private_directories', operation: 'validate_acl', directoryRole: 'user_data', acl: { reason: 'untrusted_access', principal: 'other', accessMask: 0x1200A9, aceFlags: 0x13 } })
    const options = describeDesktopStartupFailure(error, 'zh-CN', 'launch-fixture', 'C:\\Users\\private-user\\AppData', true, 'C:\\Users\\private-user\\logs')
    expect(options.recovery.reason).toContain('并不一定代表目录不安全')
    expect(options.recovery.fields).toContainEqual(expect.objectContaining({ label: '本机日志目录', localOnly: true }))
    expect(options.recovery.copyDetails).toContain('mask=0x1200a9')
    expect(options.recovery.copyDetails).toContain('flags=0x13')
    expect(options.recovery.copyDetails).not.toContain('private-user')
  })
})
