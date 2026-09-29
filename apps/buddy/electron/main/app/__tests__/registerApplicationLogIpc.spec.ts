import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { DesktopDiagnosticEvent } from '../../desktopDiagnostics'
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

async function fixture(record: (event: DesktopDiagnosticEvent) => boolean = () => true) {
  const directory = await createTemporaryDirectory('lexora-diagnostic-export-')
  await writeFile(join(directory, 'application.jsonl'), `${JSON.stringify({ schemaVersion: 1, timestamp: '2026-09-24T00:00:00.000Z', elapsedMs: 1, sequence: 1, launchId: 'launch-current', appVersion: '0.8.7', platform: 'linux', collectorPid: 42, scope: 'local-service', level: 'error', event: 'run.failed', errorCode: 'MODEL_STREAM_INCOMPLETE' })}\n`)
  const frame = {}
  const sender = { mainFrame: frame }
  const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow
  const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent
  registerApplicationLogIpc(new ApplicationLogReader(directory, 'launch-current', '/fixture'), () => window, record, async () => {})
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

describe('renderer diagnostic IPC', () => {
  const diagnostic = { event: 'workbench.copy.saved', level: 'info', workingCopyId: '10000000-0000-4000-8000-000000000001', contentVersion: 3, savedVersion: 2, dirty: true, sourceSequence: 1, occurredAt: '2026-09-28T00:00:00.000Z' }

  it('binds safe producer identities while retaining source sequences and ignores repeated delivery', async () => {
    const records: DesktopDiagnosticEvent[] = []
    const { event } = await fixture((record) => {
      records.push(record)

      return true
    })
    const report = native.handlers.get(DESKTOP_IPC_CHANNELS.appLogsReport)!
    const first = { sourceId: crypto.randomUUID(), diagnostic }
    const second = { sourceId: crypto.randomUUID(), diagnostic }
    await expect(report(event, first)).resolves.toBe(true)
    await expect(report(event, first)).resolves.toBe(true)
    await expect(report(event, second)).resolves.toBe(true)
    expect(records).toHaveLength(2)
    expect(records.map(record => record.sourceSequence)).toEqual([1, 1])
    expect(records[0]).toMatchObject({ component: 'renderer.workbench', scope: 'desktop', workingCopyId: diagnostic.workingCopyId, contentVersion: 3, savedVersion: 2, dirty: true })
    expect(records[0]!.producerInstanceId).not.toBe(records[1]!.producerInstanceId)
    expect(records[0]!.producerInstanceId).not.toBe(first.sourceId)
  })

  it('rejects foreign senders, lifecycle impersonation and arbitrary payloads before recording', async () => {
    const records: DesktopDiagnosticEvent[] = []
    const { event } = await fixture((record) => {
      records.push(record)

      return true
    })
    const report = native.handlers.get(DESKTOP_IPC_CHANNELS.appLogsReport)!
    const input = { sourceId: crypto.randomUUID(), diagnostic }
    await expect(report({ ...event, senderFrame: {} } as IpcMainInvokeEvent, input)).rejects.toThrow('Untrusted')
    for (const extra of [{ event: 'component.ready' }, { key: '/fixture/private' }, { workingCopyId: 'file:/fixture/private' }, { operationId: '/fixture/private' }, { body: 'private content' }, { producerInstanceId: crypto.randomUUID() }])
      await expect(report(event, { ...input, diagnostic: { ...diagnostic, ...extra } })).rejects.toThrow()
    expect(records).toEqual([])
  })

  it('returns a refused acknowledgement when the collector is closed or fails', async () => {
    let throwing = false
    const { event } = await fixture(() => {
      if (throwing)
        throw new Error('fixture-private-collector')
      return false
    })
    const report = native.handlers.get(DESKTOP_IPC_CHANNELS.appLogsReport)!
    const input = { sourceId: crypto.randomUUID(), diagnostic }
    await expect(report(event, input)).resolves.toBe(false)
    await expect(report(event, input)).resolves.toBe(false)
    throwing = true
    await expect(report(event, { ...input, diagnostic: { ...diagnostic, sourceSequence: 2 } })).resolves.toBe(false)
  })
})
