import { beforeEach, describe, expect, it, vi } from 'vitest'
import { checkWindowsSandbox, resolveWindowsSandbox, setupWindowsSandbox } from '../windowsSandbox'

const { execute, probe } = vi.hoisted(() => ({ execute: vi.fn(), probe: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: execute }) }))
vi.mock('../../target', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../target')>()
  return { ...actual, currentTarget: { ...actual.currentTarget, platform: 'win32' } }
})
vi.mock('../../windows/powerShell', () => ({ createWindowsHostEnvironment: () => ({}), resolveWindowsPowerShell: async () => 'powershell.exe' }))
vi.mock('../probeWindowsSandbox', () => ({ probeWindowsSandbox: probe }))

const bundled = 'C:\\Buddy\\resources\\lexora-buddy-sandbox.exe'
const installed = 'C:\\Program Files\\Lexora Buddy Sandbox\\lexora-buddy-sandbox.exe'
let status: { protocol: number, installed: boolean, healthy: boolean, path: string }
let installedVersion: unknown
let healthError: Error | undefined
let setupError: unknown

beforeEach(() => {
  status = { protocol: 1, installed: true, healthy: true, path: installed }
  installedVersion = { protocol: 1, version: 1 }
  healthError = undefined
  setupError = undefined
  probe.mockResolvedValue(true)
  execute.mockImplementation(async (path: string, [command]: string[]) => {
    if (command === 'status')
      return { stdout: JSON.stringify(status) }
    if (command === 'version') {
      if (installedVersion instanceof Error && path === installed)
        throw installedVersion
      return { stdout: JSON.stringify(path === bundled ? { protocol: 1, version: 1 } : installedVersion) }
    }
    if (command === 'health' && healthError)
      throw healthError
    if (command === 'setup' && setupError)
      throw setupError
    return { stdout: '' }
  })
})

describe('windows sandbox component compatibility', () => {
  it('reuses the installed component across application builds with the same component version', async () => {
    await expect(checkWindowsSandbox(bundled)).resolves.toBe('available')
    await expect(resolveWindowsSandbox(bundled)).resolves.toBe(installed)
  })

  it.each([
    { protocol: 1, version: 2 },
    { protocol: 2, version: 1 },
    { protocol: 1 },
    { protocol: 1, version: 0 },
    new Error('Legacy component does not support version'),
  ])('requires repair and blocks execution for incompatible or unidentified components: %j', async (version) => {
    installedVersion = version
    await expect(checkWindowsSandbox(bundled)).resolves.toBe('needs_repair')
    await expect(resolveWindowsSandbox(bundled)).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' })
  })

  it('requires setup for a missing component', async () => {
    status.installed = false
    await expect(checkWindowsSandbox(bundled)).resolves.toBe('needs_setup')
    await expect(resolveWindowsSandbox(bundled)).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' })
  })

  it('rejects unsafe installation permissions before executing its binary', async () => {
    status.healthy = false
    await expect(checkWindowsSandbox(bundled)).resolves.toBe('needs_repair')
    await expect(resolveWindowsSandbox(bundled)).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' })
    expect(execute.mock.calls.every(([path]) => path === bundled)).toBe(true)
  })

  it('requires a healthy network service even when versions match', async () => {
    healthError = new Error('Service unavailable')
    await expect(checkWindowsSandbox(bundled)).resolves.toBe('needs_repair')
    await expect(resolveWindowsSandbox(bundled)).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' })
  })

  it('blocks commands when the installed component fails the real-command probe', async () => {
    probe.mockResolvedValue(false)
    await expect(checkWindowsSandbox(bundled)).resolves.toBe('incompatible')
    await expect(resolveWindowsSandbox(bundled)).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' })
    await expect(setupWindowsSandbox(bundled)).resolves.toBe('incompatible')
  })

  it('returns ready only after installation health and command verification succeed', async () => {
    await expect(setupWindowsSandbox(bundled)).resolves.toBe('ready')
    installedVersion = { protocol: 1, version: 2 }
    await expect(setupWindowsSandbox(bundled)).resolves.toBe('failed')
  })

  it.each([
    [{ code: 126 }, 'busy'],
    [{ stderr: JSON.stringify({ nativeCode: 1223 }) }, 'cancelled'],
    [new Error('Installation failed'), 'failed'],
  ])('preserves installation failures: %j', async (error, result) => {
    setupError = error
    await expect(setupWindowsSandbox(bundled)).resolves.toBe(result)
  })
})
