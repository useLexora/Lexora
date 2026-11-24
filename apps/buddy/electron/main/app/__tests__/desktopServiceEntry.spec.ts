import { mkdirSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RuntimeRemoteError, RuntimeRequestTimeoutError } from '../../../../platform/ipc/runtimeRpcPeer'
import { startDesktopServiceEntry } from '../desktopServiceEntry'

const f = vi.hoisted(() => ({ root: '', prepare: vi.fn(), connect: vi.fn(), request: vi.fn(), close: vi.fn(), exit: vi.fn(), dialog: vi.fn() }))
vi.mock('electron', () => ({
  app: { isPackaged: true, exit: f.exit, setName() {}, setPath() {}, whenReady: async () => {}, getPath: () => f.root, getAppPath: () => f.root, getLoginItemSettings: () => ({ wasOpenedAtLogin: false }), commandLine: { hasSwitch: () => false } },
  dialog: { showErrorBox: f.dialog },
  powerMonitor: { getSystemIdleState: () => 'active' },
}))
vi.mock('original-fs', () => ({ default: {} }))
vi.mock('../../paths', () => ({ resolveBuddyRuntimePaths: () => ({ lexoraHome: f.root, profile: 'test' }) }))
vi.mock('../../storage/storageBootstrap', () => ({ readStorageBootstrap: () => ({ bootstrapRoot: f.root, state: { activeRoot: f.root } }) }))
vi.mock('../../../../platform/service/launchLocalService', () => ({ prepareLocalServiceLauncher: f.prepare }))
vi.mock('../../../../platform/filesystem/privateDirectories', () => ({ ensurePrivateDirectoriesSync: ([dir]: string[]) => mkdirSync(dir!, { recursive: true, mode: 0o700 }) }))
vi.mock('../../../../platform/native/nativeHost', async original => ({ ...await original<typeof import('../../../../platform/native/nativeHost')>(), resolveBuddyPrivateDirectories: () => undefined }))

const buildId = 'a'.repeat(64)
const visible = { accepted: true, uiReady: true, targetVisible: true, visible: true, focused: false }
const refusal = { accepted: false, uiReady: false, targetVisible: false, visible: false, focused: false }
const recordFile = () => join(f.root, 'launcher', 'foreground-launch.json')
const readRecord = async () => JSON.parse(await readFile(recordFile(), 'utf8'))
const argv = process.argv
const resources = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
beforeEach(async () => {
  f.root = await createTemporaryDirectory('lexora-launcher-')
  process.argv = [process.execPath]
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: f.root })
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  f.prepare.mockResolvedValue({ buildId, connect: f.connect })
  f.connect.mockResolvedValue({ discovery: { process: { pid: 732 }, serviceInstanceId: 'private-id' }, peer: { request: f.request, close: f.close } })
})
afterEach(() => {
  process.argv = argv
  if (resources)
    Object.defineProperty(process, 'resourcesPath', resources)
  else
    Reflect.deleteProperty(process, 'resourcesPath')
})

it.each([
  [visible, 'visible'],
  [refusal, 'refused'],
  [{ ...refusal, reason: 'locked' }, 'locked'],
  [{ ...visible, visible: false }, 'hidden'],
  [{ ...visible, uiReady: false }, 'ui_not_ready'],
  [{ ...visible, targetVisible: false }, 'target_not_visible'],
  [{ visible: true, secret: 'private-value' }, 'invalid_reply'],
  [new Error('private-path'), 'request_failed'],
  [new RuntimeRequestTimeoutError('private-method'), 'timeout'],
  [new RuntimeRemoteError({ code: -32000, data: 'private-value', message: 'private-message' }), 'remote_error'],
] as const)('records the verified foreground outcome without inventing focus or retrying (%#)', async (reply, outcome) => {
  if (reply instanceof Error)
    f.request.mockRejectedValue(reply)
  else
    f.request.mockResolvedValue(reply)
  await startDesktopServiceEntry()
  expect(f.exit).toHaveBeenCalledWith(outcome === 'visible' ? 0 : 1)
  expect(f.dialog).not.toHaveBeenCalled()
  expect(f.request).toHaveBeenCalledTimes(1)
  expect(f.close).toHaveBeenCalledTimes(1)
  expect(await readRecord()).toEqual({ version: 1, buildId, startedAt: expect.any(String), occurredAt: expect.any(String), pid: process.pid, corePid: 732, stage: 'open_desktop', outcome })
  expect(await readdir(join(f.root, 'launcher'))).toEqual(['foreground-launch.json'])
  const metadata = await stat(recordFile())
  expect(metadata.size).toBeLessThan(512)
  if (process.platform !== 'win32')
    expect(metadata.mode & 0o077).toBe(0)
})

it('distinguishes pre-connection failure and does not replace foreground evidence on background launch', async () => {
  f.connect.mockRejectedValueOnce(new Error('private-path'))
  await startDesktopServiceEntry()
  const previous = await readRecord()
  expect(previous).toMatchObject({ stage: 'connect', outcome: 'failed', buildId })
  expect(previous).not.toHaveProperty('corePid')
  process.argv.push('--background')
  await startDesktopServiceEntry()
  expect(f.request).not.toHaveBeenCalled()
  expect(await readRecord()).toEqual(previous)
})

it('does not write before installation admission or turn an unwritable record into a launch failure', async () => {
  f.prepare.mockRejectedValueOnce(new Error('INSTALLATION_GATE_FAILED'))
  await startDesktopServiceEntry()
  expect(await readdir(f.root)).toEqual([])
  await mkdir(join(f.root, 'launcher'), { mode: 0o700 })
  await mkdir(recordFile())
  await writeFile(join(recordFile(), 'keep'), '')
  f.request.mockResolvedValue(visible)
  await startDesktopServiceEntry()
  expect(f.exit).toHaveBeenLastCalledWith(0)
  expect(await readdir(recordFile())).toEqual(['keep'])
})
