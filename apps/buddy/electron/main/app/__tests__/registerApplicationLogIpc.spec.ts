import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deferred } from '@buddy-tests/deferred'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { unzipSync } from 'fflate'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_IPC_CHANNELS } from '../../../shared/desktopApi'
import { ApplicationLogReader } from '../../diagnostics/ApplicationLogReader'
import { registerApplicationLogIpc } from '../registerApplicationLogIpc'

const native = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>>(),
  save: vi.fn(),
}))
vi.mock('electron', () => ({
  app: {},
  clipboard: {},
  dialog: { showSaveDialog: native.save },
  ipcMain: {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>) => native.handlers.set(channel, handler),
    removeHandler: (channel: string) => native.handlers.delete(channel),
  },
}))

beforeEach(() => {
  native.handlers.clear()
  native.save.mockReset()
})

async function fixture() {
  const directory = await createTemporaryDirectory('lexora-diagnostic-export-')
  await writeFile(join(directory, 'application.jsonl'), `${JSON.stringify({ schemaVersion: 1, timestamp: '2026-09-24T00:00:00.000Z', elapsedMs: 1, sequence: 1, launchId: 'launch-current', appVersion: '0.8.7', platform: 'linux', collectorPid: 42, scope: 'local-service', level: 'error', event: 'run.failed', errorCode: 'MODEL_STREAM_INCOMPLETE' })}\n`)
  const frame = {}
  const sender = { mainFrame: frame }
  const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow
  const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent
  registerApplicationLogIpc(new ApplicationLogReader(directory, 'launch-current', '/fixture'), () => window)
  const handler = native.handlers.get(DESKTOP_IPC_CHANNELS.appLogsExportDiagnostics)!
  return { directory, event, handler }
}

describe('diagnostic export IPC', () => {
  it('rejects foreign frames and renderer-supplied output paths before opening a save dialog', async () => {
    const { handler, event } = await fixture()
    await expect(handler({ ...event, senderFrame: {} } as IpcMainInvokeEvent, { launch: 'current' })).rejects.toThrow('Untrusted')
    await expect(handler(event, { launch: 'current', path: '/untrusted.zip' })).rejects.toThrow()
    expect(native.save).not.toHaveBeenCalled()
  })

  it('writes a valid ZIP only to the destination selected in the native dialog', async () => {
    const { directory, handler, event } = await fixture()
    const destination = join(directory, 'diagnostics.zip')
    native.save.mockResolvedValue({ canceled: false, filePath: destination })
    await expect(handler(event, { launch: 'current' })).resolves.toEqual({ status: 'saved', errorCount: 1, contextCount: 1 })
    expect(Object.keys(unzipSync(await readFile(destination))).sort()).toEqual(['context.jsonl', 'errors.jsonl', 'manifest.json', 'summary.txt'])
  })

  it('does not write on cancellation or open concurrent save dialogs', async () => {
    const { directory, handler, event } = await fixture()
    const save = deferred<{ canceled: boolean }>()
    native.save.mockReturnValue(save.promise)
    const pending = handler(event, { launch: 'current' })
    await vi.waitFor(() => expect(native.save).toHaveBeenCalledOnce())
    await expect(handler(event, { launch: 'current' })).resolves.toEqual({ status: 'canceled' })
    save.resolve({ canceled: true })
    await expect(pending).resolves.toEqual({ status: 'canceled' })
    expect(await readdir(directory)).toEqual(['application.jsonl'])
  })

  it('keeps filesystem details private on a save failure and permits retry', async () => {
    const { directory, handler, event } = await fixture()
    native.save.mockResolvedValueOnce({ canceled: false, filePath: join(directory, 'missing', 'private.zip') })
    await expect(handler(event, { launch: 'current' })).rejects.toThrow(/^APPLICATION_LOG_EXPORT_FAILED$/)
    native.save.mockResolvedValueOnce({ canceled: false, filePath: join(directory, 'retry.zip') })
    await expect(handler(event, { launch: 'current' })).resolves.toMatchObject({ status: 'saved' })
  })
})
